// image-service.js — validate images, make thumbnails, track object URLs, open the file/camera picker.
// No IndexedDB here. Output feeds repository.addImage / replaceImageBlob.
import { AppError } from './models.js';

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;      // per file
export const MAX_IMAGE_PIXELS = 120 * 1000 * 1000;    // decoded size guard (~11000 x 11000)
export const THUMB_EDGE = 360;

const TYPE_LABEL = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

/** Identify the real image type from the first bytes (file.type can be empty or wrong on some phones). */
export async function sniffType(blob) {
  return sniffBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
}

/** Same as sniffType, for bytes you already hold (at least the first 12). */
export function sniffBytes(b) {
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)/.test(ascii(8, 12))) return 'image/heic';
  return null;
}

const label = (file) => (file && file.name ? `"${file.name}"` : 'This file');

/**
 * Check a picked file. Returns { blob, type } where blob has the correct MIME type.
 * Throws AppError('VALIDATION') with a message that names the file and says what to do.
 */
export async function validateImageFile(file, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!file || !(file instanceof Blob)) throw new AppError('VALIDATION', 'No file was selected.');
  if (file.size === 0) throw new AppError('VALIDATION', `${label(file)} is empty.`);
  if (file.size > maxBytes) {
    throw new AppError('VALIDATION', `${label(file)} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${(maxBytes / 1048576).toFixed(0)} MB per photo.`);
  }
  const type = await sniffType(file);
  if (type === 'image/heic') throw new AppError('VALIDATION', `${label(file)} is a HEIC photo, which this browser cannot show. Use JPEG, PNG, WebP or GIF.`);
  if (!type || !TYPE_LABEL[type]) throw new AppError('VALIDATION', `${label(file)} is not a supported image. Use JPEG, PNG, WebP or GIF.`);
  const blob = file.type === type ? file : new Blob([file], { type });
  return { blob, type };
}

async function decode(blob, file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new AppError('VALIDATION', `${label(file)} looks damaged and could not be read as an image.`);
  }
  if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    bitmap.close();
    throw new AppError('VALIDATION', `${label(file)} has too many pixels to process on this device.`);
  }
  return bitmap;
}

function drawToBlob(bitmap, w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return c.convertToBlob({ type: 'image/webp', quality: 0.82 });
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/webp', 0.82));
}

/** Scale to fit within maxEdge (never upscales). Honors EXIF rotation. */
export async function makeThumbnail(bitmap, maxEdge = THUMB_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  return drawToBlob(bitmap, w, h);
}

/** Validate + decode + thumbnail. Original bytes are kept untouched (no recompression). */
export async function prepareImage(file, opts = {}) {
  const { blob } = await validateImageFile(file, opts);
  const bitmap = await decode(blob, file);
  try {
    const thumb = await makeThumbnail(bitmap, opts.thumbEdge);
    return { blob, thumb, width: bitmap.width, height: bitmap.height };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('VALIDATION', `${label(file)} could not be prepared. Try a different photo.`);
  } finally { bitmap.close(); }
}

/**
 * Process several files one at a time (low memory on phones). One bad file never blocks the others.
 * `save(prepared, file)` persists one image. Returns { saved: n, failed: [{ name, message }] }.
 */
export async function importFiles(files, save, { onProgress, ...opts } = /** @type {{ onProgress?: (n: number, total: number) => void, [k: string]: any }} */ ({})) {
  const failed = [];
  let saved = 0;
  for (let i = 0; i < files.length; i++) {
    if (onProgress) onProgress(i + 1, files.length);
    try {
      const prepared = await prepareImage(files[i], opts);
      await save(prepared, files[i]);
      saved++;
    } catch (e) {
      failed.push({ name: files[i].name || `file ${i + 1}`, message: (e && e.message) || 'Unknown error' });
      if (e && e.code === 'QUOTA') break; // storage is full: stop instead of failing every remaining file
    }
  }
  return { saved, failed };
}

/** Tracks object URLs so a screen can free them all when it closes. */
export class ObjectUrls {
  constructor() { this.urls = new Set(); }
  for(blob) { const u = URL.createObjectURL(blob); this.urls.add(u); return u; }
  revoke(u) { if (this.urls.delete(u)) URL.revokeObjectURL(u); }
  revokeAll() { for (const u of this.urls) URL.revokeObjectURL(u); this.urls.clear(); }
  get size() { return this.urls.size; }
}

/**
 * Open the gallery (default) or the camera ({ camera: true }). Must be called directly from a tap handler.
 * Resolves with an array of Files (empty if the person cancels).
 */
export function pickImages({ camera = false, multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif,image/*';
    input.multiple = camera ? false : multiple;
    if (camera) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.append(input);
    let done = false;
    const finish = (files) => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...input.files]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}
