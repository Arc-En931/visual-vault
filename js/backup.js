// backup.js — build a backup ZIP from a catalog snapshot, and read one back with full validation.
// No IndexedDB here (repository.js does that). Reading NEVER writes anything: it returns either a list of
// problems or a fully validated, normalised copy of the data that repository.importBackup() can commit.
//
// Layout of the ZIP:
//   manifest.json   format name/version, counts, and {size, sha256} for every other file
//   data.json       all records except image bytes
//   images/img-00001.jpg ...   original photos
//   thumbs/img-00001.jpg ...   thumbnails (optional per photo)
import { AppError, createProductRecord, createImageRecord, createFieldDefinitionRecord, createNamedRecord, coerceValue, storedToRaw, FIELD_SCOPES } from './models.js';
import { sniffBytes } from './image-service.js';
import { ZipWriter, openZip, readEntryBytes, entryBlob } from './zip.js';

export const FORMAT = 'visualvault-backup';
export const FORMAT_VERSION = 1;
export const MAX_REPORTED_PROBLEMS = 40;

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_TYPES = new Set(Object.keys(EXT));
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const enc = new TextEncoder();

export async function sha256Hex(blobOrBytes) {
  if (!globalThis.crypto || !crypto.subtle) throw new AppError('UNAVAILABLE', 'This browser cannot compute checksums here (it needs a secure https page). Backups need that to be trustworthy.');
  const buf = blobOrBytes instanceof Blob ? await blobOrBytes.arrayBuffer() : blobOrBytes;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `visualvault-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

// =====================================================================  export

/** snapshot: repository.getFullSnapshot(). Returns { blob, counts }. */
export async function buildBackup(snapshot, { now = new Date(), onProgress } = /** @type {{ now?: Date, onProgress?: (n: number, total: number) => void }} */ ({})) {
  const files = new Map();        // zip name -> Blob
  const images = [];
  const sorted = [...snapshot.images].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.position - b.position));
  sorted.forEach((im, i) => {
    const ext = EXT[im.mime] || 'bin';
    const n = String(i + 1).padStart(5, '0');
    const { blob, thumb, ...meta } = im;
    const rec = { ...meta, file: `images/img-${n}.${ext}`, thumbFile: null };
    files.set(rec.file, blob);
    if (thumb) { rec.thumbFile = `thumbs/img-${n}.${EXT[thumb.type] || 'bin'}`; files.set(rec.thumbFile, thumb); }
    images.push(rec);
  });
  const data = {
    products: snapshot.products,
    images,
    customFieldDefinitions: snapshot.customFieldDefinitions,
    customFieldValues: snapshot.customFieldValues,
    categories: snapshot.categories,
    tags: snapshot.tags,
    productCategories: snapshot.productCategories,
    productTags: snapshot.productTags,
  };
  const dataBytes = enc.encode(JSON.stringify(data));
  files.set('data.json', new Blob([dataBytes], { type: 'application/json' }));

  const listed = {};
  let done = 0;
  for (const [name, blob] of files) {
    listed[name] = { size: blob.size, sha256: await sha256Hex(blob) };
    if (onProgress) onProgress(++done, files.size);
  }
  const counts = {
    products: data.products.length, images: data.images.length, fields: data.customFieldDefinitions.length,
    values: data.customFieldValues.length, categories: data.categories.length, tags: data.tags.length,
  };
  const manifest = { format: FORMAT, formatVersion: FORMAT_VERSION, createdAt: now.toISOString(), counts, files: listed };

  const zip = new ZipWriter(now);
  await zip.add('manifest.json', new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
  for (const [name, blob] of files) await zip.add(name, blob);
  return { blob: zip.finish(), counts, createdAt: manifest.createdAt };
}

// =====================================================================  import (validate everything first)

class Problems {
  constructor() { this.list = []; this.extra = 0; }
  add(msg) { if (this.list.length < MAX_REPORTED_PROBLEMS) this.list.push(msg); else this.extra++; }
  get any() { return this.list.length > 0; }
  toArray() { return this.extra ? [...this.list, `…and ${this.extra} more problem${this.extra === 1 ? '' : 's'}.`] : this.list; }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isTime = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isRev = (x) => Number.isInteger(x) && x >= 1;
const asArray = (data, key, problems) => {
  if (!Array.isArray(data[key])) { problems.add(`data.json: "${key}" is missing or not a list.`); return []; }
  return data[key];
};

/**
 * Read and fully validate a backup file. Never throws for a bad backup; returns:
 *   { ok:false, problems:[string] }  or
 *   { ok:true, manifest, data, summary }  (data is a clean copy ready for repository.importBackup)
 */
export async function readBackup(file, { onProgress } = /** @type {{ onProgress?: (n: number, total: number) => void }} */ ({})) {
  try { return await readBackupUnsafe(file, onProgress); }
  catch (e) {
    if (e instanceof AppError) return { ok: false, problems: [e.message] };
    return { ok: false, problems: ['This file could not be read as a backup.'] };
  }
}

async function readBackupUnsafe(file, onProgress) {
  const zip = await openZip(file);
  const problems = new Problems();

  // ----- manifest
  if (!zip.entries.has('manifest.json')) throw new AppError('ZIP', 'This ZIP is not a VisualVault backup (manifest.json is missing).');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEntryBytes(zip, 'manifest.json'))); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('ZIP', 'manifest.json is not valid.'); }
  if (!isObj(manifest) || manifest.format !== FORMAT) throw new AppError('ZIP', 'This ZIP is not a VisualVault backup.');
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) throw new AppError('ZIP', 'The backup version is not valid.');
  if (manifest.formatVersion > FORMAT_VERSION) throw new AppError('VERSION', 'This backup was made by a newer version of VisualVault. Update the app, then try again.');
  if (!isObj(manifest.files)) throw new AppError('ZIP', 'manifest.json has no file list.');

  // ----- every file: listed, present, right size, right checksum
  const listed = Object.keys(manifest.files);
  for (const name of zip.entries.keys()) if (name !== 'manifest.json' && !(name in manifest.files)) problems.add(`"${name}" is in the ZIP but not in the manifest.`);
  const heads = new Map();       // first bytes of each file, kept from the checksum pass (saves re-reading to sniff types)
  let done = 0;
  for (const name of listed) {
    const info = manifest.files[name];
    const e = zip.entries.get(name);
    if (!e) { problems.add(`"${name}" is listed in the manifest but missing from the ZIP.`); continue; }
    if (!isObj(info) || info.size !== e.size || typeof info.sha256 !== 'string') { problems.add(`"${name}" has a wrong size or a bad manifest entry.`); continue; }
    try {
      const bytes = await readEntryBytes(zip, name);
      heads.set(name, bytes.slice(0, 16));
      if ((await sha256Hex(bytes)) !== info.sha256.toLowerCase()) problems.add(`"${name}" does not match its checksum; it was changed or damaged.`);
    } catch (err) { problems.add(err instanceof AppError ? err.message : `"${name}" could not be read.`); }
    if (onProgress) onProgress(++done, listed.length);
  }
  if (!zip.entries.has('data.json') || !(manifest.files['data.json'])) throw new AppError('ZIP', 'data.json is missing from the backup.');
  if (problems.any) return { ok: false, problems: problems.toArray() };

  // ----- data.json
  let raw;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readEntryBytes(zip, 'data.json'))); }
  catch { return { ok: false, problems: ['data.json is not valid.'] }; }
  if (!isObj(raw)) return { ok: false, problems: ['data.json is not valid.'] };

  const data = {
    products: [], images: [], customFieldDefinitions: [], customFieldValues: [], categories: [], tags: [], productCategories: [], productTags: [],
  };
  const seen = (set, id, label, i) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) { problems.add(`${label} #${i + 1}: its id is missing or not valid.`); return false; }
    if (set.has(id)) { problems.add(`${label} #${i + 1}: the id "${id}" appears twice.`); return false; }
    set.add(id); return true;
  };
  const guard = (label, i, fn) => { try { return fn(); } catch (e) { problems.add(`${label} #${i + 1}: ${e instanceof AppError ? e.message : 'is not valid.'}`); return null; } };
  const keepStamps = (rec, src, label, i) => {
    if (!isTime(src.createdAt) || !isTime(src.updatedAt)) { problems.add(`${label} #${i + 1}: dates are missing or not valid.`); return false; }
    rec.createdAt = src.createdAt; rec.updatedAt = src.updatedAt;
    if ('revision' in rec) { if (!isRev(src.revision)) { problems.add(`${label} #${i + 1}: revision is not valid.`); return false; } rec.revision = src.revision; }
    return true;
  };

  // products
  const productIds = new Set();
  asArray(raw, 'products', problems).forEach((src, i) => {
    if (!isObj(src)) return problems.add(`Product #${i + 1}: is not valid.`);
    const rec = guard('Product', i, () => createProductRecord({ id: 'x', name: src.name, description: src.description ?? '', notes: src.notes ?? '', sku: src.sku ?? '' }));
    if (!rec || !seen(productIds, src.id, 'Product', i)) return;
    rec.id = src.id;
    if (keepStamps(rec, src, 'Product', i)) data.products.push(rec);
  });

  // field definitions
  const defIds = new Set();
  const defNames = new Set();
  asArray(raw, 'customFieldDefinitions', problems).forEach((src, i) => {
    if (!isObj(src)) return problems.add(`Field #${i + 1}: is not valid.`);
    const rec = guard('Field', i, () => createFieldDefinitionRecord({ name: src.name, type: src.type, scope: src.scope, unit: src.unit ?? '' }));
    if (!rec || !seen(defIds, src.id, 'Field', i)) return;
    rec.id = src.id;
    const key = `${rec.scope}\u0000${rec.nameLower}`;
    if (defNames.has(key)) return problems.add(`Field #${i + 1}: two ${rec.scope} fields are both named "${rec.name}".`);
    defNames.add(key);
    if (keepStamps(rec, src, 'Field', i)) data.customFieldDefinitions.push(rec);
  });
  const defById = new Map(data.customFieldDefinitions.map((d) => [d.id, d]));

  // categories and tags
  const named = (key, label) => {
    const ids = new Set(); const names = new Set(); const out = [];
    asArray(raw, key, problems).forEach((src, i) => {
      if (!isObj(src)) return problems.add(`${label} #${i + 1}: is not valid.`);
      const rec = guard(label, i, () => createNamedRecord({ name: src.name }, `${label} name`));
      if (!rec || !seen(ids, src.id, label, i)) return;
      rec.id = src.id;
      if (names.has(rec.nameLower)) return problems.add(`${label} #${i + 1}: "${rec.name}" appears twice.`);
      names.add(rec.nameLower);
      if (keepStamps(rec, src, label, i)) out.push(rec);
    });
    return out;
  };
  data.categories = named('categories', 'Category');
  data.tags = named('tags', 'Tag');
  const catIds = new Set(data.categories.map((c) => c.id));
  const tagIds = new Set(data.tags.map((t) => t.id));

  // images (bytes are checked against the real file type, never trusted from the record)
  const imageIds = new Set();
  const usedFiles = new Set();
  const list = asArray(raw, 'images', problems);
  for (let i = 0; i < list.length; i++) {
    const src = list[i];
    if (!isObj(src)) { problems.add(`Photo #${i + 1}: is not valid.`); continue; }
    if (!seen(imageIds, src.id, 'Photo', i)) continue;
    if (!productIds.has(src.productId)) { problems.add(`Photo #${i + 1}: belongs to a product that is not in the backup.`); continue; }
    if (typeof src.file !== 'string' || !src.file.startsWith('images/') || !zip.entries.has(src.file)) { problems.add(`Photo #${i + 1}: its image file is missing.`); continue; }
    if (usedFiles.has(src.file)) { problems.add(`Photo #${i + 1}: shares an image file with another photo.`); continue; }
    usedFiles.add(src.file);
    const blob = entryBlob(zip, src.file);
    const type = blob.size ? sniffBytes(heads.get(src.file)) : null;
    if (!IMAGE_TYPES.has(type)) { problems.add(`Photo #${i + 1}: "${src.file}" is not a supported image.`); continue; }
    let thumb = null;
    if (src.thumbFile != null) {
      if (typeof src.thumbFile !== 'string' || !src.thumbFile.startsWith('thumbs/') || !zip.entries.has(src.thumbFile) || usedFiles.has(src.thumbFile)) { problems.add(`Photo #${i + 1}: its thumbnail file is missing.`); continue; }
      usedFiles.add(src.thumbFile);
      const tb = entryBlob(zip, src.thumbFile);
      const tt = tb.size ? sniffBytes(heads.get(src.thumbFile)) : null;
      if (!IMAGE_TYPES.has(tt)) { problems.add(`Photo #${i + 1}: its thumbnail is not a supported image.`); continue; }
      thumb = entryBlob(zip, src.thumbFile, tt);
    }
    if (!Number.isInteger(src.position) || src.position < 0) { problems.add(`Photo #${i + 1}: its position is not valid.`); continue; }
    const rec = guard('Photo', i, () => createImageRecord({ id: 'x', productId: src.productId, blob: entryBlob(zip, src.file, type), thumb, caption: src.caption ?? '', position: src.position }));
    if (!rec) continue;
    rec.id = src.id;
    if (keepStamps(rec, src, 'Photo', i)) data.images.push(rec);
  }
  // Positions: keep the saved order, but make them a clean 0..n-1 per product.
  const byProduct = new Map();
  for (const im of data.images) (byProduct.get(im.productId) || byProduct.set(im.productId, []).get(im.productId)).push(im);
  for (const arr of byProduct.values()) arr.sort((a, b) => a.position - b.position).forEach((im, k) => { im.position = k; });

  // values
  const owners = { product: productIds, image: new Set(data.images.map((x) => x.id)) };
  const valueIds = new Set();
  const pairs = new Set();
  asArray(raw, 'customFieldValues', problems).forEach((src, i) => {
    if (!isObj(src)) return problems.add(`Value #${i + 1}: is not valid.`);
    if (!seen(valueIds, src.id, 'Value', i)) return;
    const def = defById.get(src.fieldId);
    if (!def) return problems.add(`Value #${i + 1}: refers to a field that is not in the backup.`);
    if (!FIELD_SCOPES.includes(src.ownerType) || def.scope !== src.ownerType) return problems.add(`Value #${i + 1}: "${def.name}" does not apply to ${src.ownerType}s.`);
    if (!owners[src.ownerType].has(src.ownerId)) return problems.add(`Value #${i + 1}: belongs to ${src.ownerType === 'image' ? 'a photo' : 'a product'} that is not in the backup.`);
    const pair = `${src.fieldId}\u0000${src.ownerId}`;
    if (pairs.has(pair)) return problems.add(`Value #${i + 1}: "${def.name}" is set twice for the same ${src.ownerType}.`);
    pairs.add(pair);
    let c;
    try { c = coerceValue(def.type, storedToRaw(def.type, src.value)); } catch (e) { return problems.add(`Value #${i + 1} ("${def.name}"): ${e instanceof AppError ? e.message : 'is not valid.'}`); }
    if (c.value !== src.value) return problems.add(`Value #${i + 1} ("${def.name}"): is not stored in the expected form.`);
    if (!isTime(src.updatedAt)) return problems.add(`Value #${i + 1}: date is not valid.`);
    data.customFieldValues.push({ id: src.id, ownerType: src.ownerType, ownerId: src.ownerId, fieldId: src.fieldId, type: def.type, value: c.value, numeric: c.numeric, updatedAt: src.updatedAt });
  });

  // joins
  const joins = (key, refKey, refSet, label, out) => {
    const pairsSeen = new Set();
    asArray(raw, key, problems).forEach((src, i) => {
      if (!isObj(src) || !productIds.has(src.productId) || !refSet.has(src[refKey])) return problems.add(`${label} link #${i + 1}: refers to something that is not in the backup.`);
      const k = `${src.productId}\u0000${src[refKey]}`;
      if (pairsSeen.has(k)) return problems.add(`${label} link #${i + 1}: appears twice.`);
      pairsSeen.add(k); out.push({ productId: src.productId, [refKey]: src[refKey] });
    });
  };
  joins('productCategories', 'categoryId', catIds, 'Category', data.productCategories);
  joins('productTags', 'tagId', tagIds, 'Tag', data.productTags);

  // every file in the ZIP must be accounted for by a record
  for (const name of listed) if (name !== 'data.json' && !usedFiles.has(name)) problems.add(`"${name}" is not used by any photo.`);

  if (problems.any) return { ok: false, problems: problems.toArray() };
  const summary = {
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
    products: data.products.length, images: data.images.length, fields: data.customFieldDefinitions.length,
    values: data.customFieldValues.length, categories: data.categories.length, tags: data.tags.length,
    bytes: file.size,
  };
  return { ok: true, manifest, data, summary };
}
