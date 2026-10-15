// models.js — data shapes, validation, value coercion, money helpers, error type.
// Pure functions only: no IndexedDB access here.

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;       // VALIDATION, NOT_FOUND, CONFLICT, DUPLICATE, REFERENCE, DATA_LOSS, QUOTA, UNAVAILABLE, VERSION, STORAGE
    this.details = details;
  }
}

/** Convert any thrown value (DOMException etc.) to an AppError with a user-readable message. */
export function toAppError(e) {
  if (e instanceof AppError) return e;
  const name = e && e.name;
  if (name === 'QuotaExceededError') return new AppError('QUOTA', 'Not enough storage space on this device. Nothing was changed. Free some space or export a backup and remove old items.');
  if (name === 'ConstraintError') return new AppError('DUPLICATE', 'That record already exists.');
  if (name === 'VersionError') return new AppError('VERSION', 'This catalog was created by a newer version of VisualVault. Please update the app.');
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'UnknownError') return new AppError('UNAVAILABLE', 'Browser storage is unavailable (private mode, blocked, or disabled). Changes cannot be saved.');
  return new AppError('STORAGE', 'A storage error occurred. Nothing was changed.', { cause: name || String(e) });
}

export const FIELD_TYPES = Object.freeze(['text', 'number', 'date', 'boolean', 'money']);
export const FIELD_SCOPES = Object.freeze(['product', 'image']);

export const uuid = () => crypto.randomUUID();
export const normName = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();

function cleanName(s, label, max = 120) {
  const v = String(s ?? '').normalize('NFC').trim();
  if (!v) throw new AppError('VALIDATION', `${label} is required.`);
  if (v.length > max) throw new AppError('VALIDATION', `${label} must be ${max} characters or fewer.`);
  return v;
}
function cleanText(s, label, max) {
  const v = String(s ?? '').normalize('NFC').trim();
  if (v.length > max) throw new AppError('VALIDATION', `${label} must be ${max} characters or fewer.`);
  return v;
}

// ---------- Money: integer hundredths, no currency, no floats ----------

/** "19.99" | 20 -> 1999 | 2000. Rejects more than 2 decimals, exponents, junk. */
export function parseMoney(input) {
  let s = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : String(input ?? '');
  s = s.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new AppError('VALIDATION', 'Enter an amount like 20 or 19.99 (max 2 decimals).');
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new AppError('VALIDATION', 'That amount is too large.');
  return m[1] && minor !== 0 ? -minor : minor;
}

/** 1999 -> "19.99" (integer math only). */
export function formatMoney(minor) {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ---------- Typed custom-field values ----------

/**
 * Validate raw user input for a field type.
 * Returns { value, numeric }: `value` is what is stored/displayed,
 * `numeric` is the comparable number used for range filters (or null).
 */
export function coerceValue(type, raw) {
  switch (type) {
    case 'text': {
      const v = cleanText(raw, 'Text value', 5000);
      return { value: v, numeric: null };
    }
    case 'number': {
      const s = typeof raw === 'string' ? raw.trim() : raw;
      if (s === '' || s === null || typeof s === 'boolean') throw new AppError('VALIDATION', 'Enter a valid number.');
      const n = Number(s);
      if (!Number.isFinite(n)) throw new AppError('VALIDATION', 'Enter a valid number.');
      return { value: n, numeric: n };
    }
    case 'money': {
      const minor = parseMoney(raw);
      return { value: minor, numeric: minor };
    }
    case 'date': {
      const s = String(raw ?? '').trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) throw new AppError('VALIDATION', 'Enter a date as YYYY-MM-DD.');
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      const d = new Date(ms);
      if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
        throw new AppError('VALIDATION', 'That date does not exist.');
      }
      return { value: s, numeric: ms };
    }
    case 'boolean': {
      if (raw === true || raw === false) return { value: raw, numeric: null };
      if (raw === 'true') return { value: true, numeric: null };
      if (raw === 'false') return { value: false, numeric: null };
      throw new AppError('VALIDATION', 'Choose yes or no.');
    }
    default:
      throw new AppError('VALIDATION', `Unknown field type "${type}".`);
  }
}

/** Stored value -> the raw form coerceValue accepts (used when changing a field's type). */
export function storedToRaw(type, stored) {
  return type === 'money' ? formatMoney(stored) : stored;
}

/** Stored value -> display string. */
export function displayValue(type, stored) {
  if (type === 'money') return formatMoney(stored);
  if (type === 'boolean') return stored ? 'Yes' : 'No';
  return String(stored);
}

export const isEmptyValue = (raw) => raw === null || raw === undefined || raw === '';

// ---------- Record factories ----------

export function createProductRecord(input = {}) {
  const t = Date.now();
  const name = cleanName(input.name, 'Product name', 200);
  return {
    id: input.id ?? uuid(),
    name,
    nameLower: normName(name),
    description: cleanText(input.description, 'Description', 10000),
    notes: cleanText(input.notes, 'Notes', 10000),
    sku: cleanText(input.sku, 'SKU', 100),
    createdAt: t,
    updatedAt: t,
    revision: 1,
  };
}

export function updateProductRecord(cur, changes = {}) {
  const next = { ...cur };
  const has = (k) => Object.prototype.hasOwnProperty.call(changes, k);
  if (has('name')) { next.name = cleanName(changes.name, 'Product name', 200); next.nameLower = normName(next.name); }
  if (has('description')) next.description = cleanText(changes.description, 'Description', 10000);
  if (has('notes')) next.notes = cleanText(changes.notes, 'Notes', 10000);
  if (has('sku')) next.sku = cleanText(changes.sku, 'SKU', 100);
  next.updatedAt = Date.now();
  next.revision = cur.revision + 1;
  return next;
}

export function createImageRecord(input = {}) {
  if (!input.productId) throw new AppError('VALIDATION', 'Image must belong to a product.');
  if (!(input.blob instanceof Blob) || input.blob.size === 0) throw new AppError('VALIDATION', 'Image data is missing or empty.');
  if (input.thumb != null && !(input.thumb instanceof Blob)) throw new AppError('VALIDATION', 'Thumbnail must be a Blob.');
  const t = Date.now();
  return {
    id: input.id ?? uuid(),
    productId: input.productId,
    blob: input.blob,
    thumb: input.thumb ?? null,
    mime: input.blob.type || 'application/octet-stream',
    size: input.blob.size,
    caption: cleanText(input.caption, 'Caption', 2000),
    position: input.position ?? 0,
    createdAt: t,
    updatedAt: t,
    revision: 1,
  };
}

export function createFieldDefinitionRecord(input = {}) {
  if (!FIELD_TYPES.includes(input.type)) throw new AppError('VALIDATION', 'Choose a valid field type.');
  if (!FIELD_SCOPES.includes(input.scope)) throw new AppError('VALIDATION', 'Choose product or image for the field scope.');
  const name = cleanName(input.name, 'Field name', 80);
  const t = Date.now();
  return {
    id: input.id ?? uuid(),
    name,
    nameLower: normName(name),
    type: input.type,
    unit: cleanText(input.unit, 'Unit', 20),
    scope: input.scope,
    createdAt: t,
    updatedAt: t,
    revision: 1,
  };
}

export function createNamedRecord(input = {}, label = 'Name') {
  const name = cleanName(input.name, label, 80);
  const t = Date.now();
  return { id: input.id ?? uuid(), name, nameLower: normName(name), createdAt: t, updatedAt: t };
}
