// zip.js — minimal ZIP writer/reader. STORE only (no compression): photos are already compressed,
// and a stored archive can be opened by any unzip tool. No IndexedDB, no DOM.
//
// The reader is deliberately strict. It rejects anything it does not fully understand (compression,
// encryption, ZIP64, split archives, unsafe or duplicate names, overlapping or out-of-range entries)
// instead of guessing, so a damaged or hostile file can never be half-read.
import { AppError } from './models.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LIMIT32 = 0xffffffff;
const MAX_ENTRIES = 50000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const bad = (msg) => new AppError('ZIP', msg);

/** Names we will write or accept: relative, forward slashes, no "..", no control characters. */
export function isSafeName(name) {
  if (!name || name.length > 255 || name.startsWith('/') || name.endsWith('/')) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function dosDateTime(d) {
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  constructor(now = new Date()) {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.names = new Set();
    this.stamp = dosDateTime(now);
  }

  /** `data` is a Blob or Uint8Array. The bytes are read once to compute the CRC, then released. */
  async add(name, data) {
    if (!isSafeName(name)) throw bad(`Cannot store a file named "${name}".`);
    if (this.names.has(name)) throw bad(`Duplicate file name "${name}".`);
    const blob = data instanceof Blob ? data : new Blob([data]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length >= LIMIT32 || this.offset >= LIMIT32 - bytes.length - 100000) {
      throw new AppError('ZIP', 'This backup would be larger than 4 GB, which this format does not support. Remove some photos first.');
    }
    const crc = crc32(bytes);
    const nameBytes = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);            // version needed
    local.setUint16(6, 0x0800, true);        // UTF-8 names
    local.setUint16(8, 0, true);             // method: store
    local.setUint16(10, this.stamp.time, true);
    local.setUint16(12, this.stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes, blob);
    this.central.push({ nameBytes, crc, size: bytes.length, offset: this.offset });
    this.names.add(name);
    this.offset += 30 + nameBytes.length + bytes.length;
  }

  finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    const cd = [];
    for (const e of this.central) {
      const v = new DataView(new ArrayBuffer(46));
      v.setUint32(0, SIG_CENTRAL, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, this.stamp.time, true);
      v.setUint16(14, this.stamp.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint32(42, e.offset, true);
      cd.push(v.buffer, e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }
    if (this.central.length >= 0xffff) throw bad('Too many files for one backup.');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, SIG_EOCD, true);
    end.setUint16(8, this.central.length, true);
    end.setUint16(10, this.central.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    return new Blob([...this.parts, ...cd, end.buffer], { type: 'application/zip' });
  }
}

/**
 * Parse the directory of a ZIP Blob/File. Returns { entries: Map(name -> entry) } where each entry is
 * { name, size, crc, start, end }. Nothing is decompressed (STORE only). Use readEntry() to get verified bytes.
 */
export async function openZip(blob) {
  const notZip = () => new AppError('ZIP', 'This is not a VisualVault backup (it is not a readable ZIP file).');
  if (!(blob instanceof Blob) || blob.size < 22) throw notZip();
  const tailLen = Math.min(blob.size, 22 + 0xffff);
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD && i + 22 + tv.getUint16(i + 20, true) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) throw notZip();
  const disk = tv.getUint16(eocd + 4, true);
  const cdDisk = tv.getUint16(eocd + 6, true);
  const countHere = tv.getUint16(eocd + 8, true);
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw bad('Split ZIP archives are not supported.');
  if (count === 0xffff || cdSize === LIMIT32 || cdOffset === LIMIT32) throw bad('ZIP64 archives (over 4 GB) are not supported.');
  if (count > MAX_ENTRIES) throw bad('The backup contains too many files.');
  if (cdOffset + cdSize > blob.size - tail.length + eocd) throw bad('The ZIP directory points outside the file; the file is damaged or incomplete.');

  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer);
  const entries = new Map();
  let p = 0;
  const ranges = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== SIG_CENTRAL) throw bad('The ZIP directory is damaged.');
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    const csize = cv.getUint32(p + 20, true);
    const usize = cv.getUint32(p + 24, true);
    const nlen = cv.getUint16(p + 28, true);
    const xlen = cv.getUint16(p + 30, true);
    const clen = cv.getUint16(p + 32, true);
    const diskNo = cv.getUint16(p + 34, true);
    const lho = cv.getUint32(p + 42, true);
    if (p + 46 + nlen + xlen + clen > cd.length) throw bad('The ZIP directory is damaged.');
    let name;
    try { name = dec.decode(cd.subarray(p + 46, p + 46 + nlen)); } catch { throw bad('A file name in the backup is not valid text.'); }
    p += 46 + nlen + xlen + clen;
    if (!isSafeName(name)) throw bad(`The backup contains an unsafe file name: "${name.slice(0, 60)}".`);
    if (entries.has(name)) throw bad(`The backup lists "${name}" twice.`);
    if (flags & 1) throw bad('The backup is password-protected, which is not supported.');
    if (method !== 0) throw bad('This ZIP is compressed. VisualVault backups are stored uncompressed, so the file was probably re-zipped by another tool. Use the original backup file.');
    if (csize !== usize) throw bad(`"${name}" has inconsistent sizes.`);
    if (diskNo !== 0 || csize === LIMIT32 || lho === LIMIT32) throw bad('ZIP64 archives are not supported.');
    if (lho + 30 > cdOffset) throw bad(`"${name}" points outside the file.`);
    const lhBytes = new Uint8Array(await blob.slice(lho, lho + 30 + nlen).arrayBuffer());   // header + name in ONE read
    if (lhBytes.length < 30 + nlen) throw bad(`"${name}" has a damaged header.`);
    const lh = new DataView(lhBytes.buffer);
    if (lh.getUint32(0, true) !== SIG_LOCAL) throw bad(`"${name}" has a damaged header.`);
    const lnlen = lh.getUint16(26, true);
    const lxlen = lh.getUint16(28, true);
    if (lnlen !== nlen) throw bad(`"${name}" has a damaged header.`);
    const nameStart = p - xlen - clen - nlen;
    for (let k = 0; k < nlen; k++) if (lhBytes[30 + k] !== cd[nameStart + k]) throw bad(`"${name}" has a header that does not match the directory.`);
    const start = lho + 30 + lnlen + lxlen;
    const end = start + csize;
    if (end > cdOffset) throw bad(`"${name}" extends past the end of the data; the file is incomplete.`);
    ranges.push([lho, end]);
    entries.set(name, { name, size: csize, crc, start, end });
  }
  if (p !== cd.length) throw bad('The ZIP directory has unexpected extra data.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw bad('The backup has overlapping files; it is damaged.');
  return { blob, entries };
}

/** Bytes of one entry, CRC-checked. */
export async function readEntryBytes(zip, name) {
  const e = zip.entries.get(name);
  if (!e) throw bad(`"${name}" is missing from the backup.`);
  const bytes = new Uint8Array(await zip.blob.slice(e.start, e.end).arrayBuffer());
  if (bytes.length !== e.size || crc32(bytes) !== e.crc) throw bad(`"${name}" is damaged (checksum mismatch).`);
  return bytes;
}

/** A Blob view of one entry (no copy). Callers must have verified the bytes already. */
export const entryBlob = (zip, name, type = '') => {
  const e = zip.entries.get(name);
  return zip.blob.slice(e.start, e.end, type);
};
