// search-service.js — pure, in-memory search over a catalog snapshot (repository.getCatalogSnapshot()).
// No IndexedDB and no DOM here, so it is fully unit-testable.
//
// Matching rules
//  - The query is split on spaces; EVERY word must match somewhere (AND). Matching is partial
//    (substring), case-insensitive and accent-insensitive: "cup" finds "Steel Cups", "cafe" finds "Café".
//  - Searched text: product name, SKU, description, notes, image captions, custom field NAMES and VALUES
//    (money is searched as shown, e.g. "100" matches "100.00"), category names, tag names.
//  - An image is a "hit" when at least one query word is found in that image's own caption/values
//    and all words are found in that image plus its product. Hits are what the UI deep-links to.
import { displayValue, coerceValue, AppError } from './models.js';

export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const tokenize = (q) => fold(q).split(/\s+/).filter(Boolean);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const SORTABLE_TYPES = ['number', 'money', 'date'];
const FILTERABLE_TYPES = ['number', 'money', 'date', 'boolean'];
export const isSortableField = (def) => SORTABLE_TYPES.includes(def.type);
export const isFilterableField = (def) => FILTERABLE_TYPES.includes(def.type);

const group = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};

/** Build a searchable index (one entry per product) from a snapshot. */
export function buildIndex(snapshot) {
  const defs = new Map(snapshot.fieldDefinitions.map((d) => [d.id, d]));
  const catName = new Map(snapshot.categories.map((c) => [c.id, c.name]));
  const tagName = new Map(snapshot.tags.map((t) => [t.id, t.name]));
  const valuesByOwner = group(snapshot.values, 'ownerId');
  const imagesByProduct = group(snapshot.images, 'productId');
  const catsByProduct = group(snapshot.productCategories, 'productId');
  const tagsByProduct = group(snapshot.productTags, 'productId');

  const fieldsOf = (ownerId) => (valuesByOwner.get(ownerId) || []).flatMap((v) => {
    const def = defs.get(v.fieldId);
    if (!def) return [];
    const shown = displayValue(def.type, v.value);
    return [{ def, fieldId: def.id, value: v.value, numeric: v.numeric, shown, text: fold(`${def.name} ${shown} ${def.unit || ''}`), label: def.name }];
  });

  const entries = snapshot.products.map((product) => {
    const categories = (catsByProduct.get(product.id) || []).map((j) => ({ id: j.categoryId, name: catName.get(j.categoryId) })).filter((c) => c.name);
    const tags = (tagsByProduct.get(product.id) || []).map((j) => ({ id: j.tagId, name: tagName.get(j.tagId) })).filter((t) => t.name);
    const productFields = fieldsOf(product.id);
    const images = (imagesByProduct.get(product.id) || []).slice().sort((a, b) => a.position - b.position).map((image) => {
      const fields = fieldsOf(image.id);
      const pieces = [];
      if (image.caption) pieces.push({ label: 'caption', text: fold(image.caption), weight: 3 });
      for (const f of fields) pieces.push({ label: f.label, text: f.text, weight: 2 });
      return { image, fields, pieces };
    });
    const pieces = [
      { label: 'name', text: fold(product.name), weight: 10 },
      { label: 'SKU', text: fold(product.sku), weight: 8 },
      { label: 'description', text: fold(product.description), weight: 2 },
      { label: 'notes', text: fold(product.notes), weight: 2 },
      ...categories.map((c) => ({ label: 'category', text: fold(c.name), weight: 4 })),
      ...tags.map((t) => ({ label: 'tag', text: fold(t.name), weight: 4 })),
      ...productFields.map((f) => ({ label: f.label, text: f.text, weight: 2 })),
    ].filter((p) => p.text);
    return {
      product, categories, tags, productFields, images, pieces,
      categoryIds: new Set(categories.map((c) => c.id)),
      tagIds: new Set(tags.map((t) => t.id)),
    };
  });
  return { entries, defs };
}

// ---------- field filters ----------

/**
 * Turn raw UI filter rows into comparable numbers using the same rules as saving a value
 * (money "19.99" -> 1999, date -> UTC ms). Throws AppError('VALIDATION') on bad input.
 * rows: [{ fieldId, min?, max?, equals? }] — blank min/max/equals are ignored.
 */
export function compileFieldFilters(defsById, rows = []) {
  const out = [];
  for (const row of rows) {
    const def = defsById.get(row.fieldId);
    if (!def) continue;
    const f = { fieldId: def.id, scope: def.scope, type: def.type, name: def.name };
    const blank = (v) => v === undefined || v === null || String(v).trim() === '';
    const conv = (raw, what) => {
      try { return coerceValue(def.type, raw).numeric; } catch (e) {
        throw new AppError('VALIDATION', `${def.name} ${what}: ${e.message}`);
      }
    };
    if (def.type === 'boolean') {
      if (!blank(row.equals)) f.equals = row.equals === true || row.equals === 'true';
    } else {
      if (!blank(row.min)) f.min = conv(row.min, 'minimum');
      if (!blank(row.max)) f.max = conv(row.max, 'maximum');
      if (f.min != null && f.max != null && f.min > f.max) throw new AppError('VALIDATION', `${def.name}: the minimum is higher than the maximum.`);
    }
    if (f.min != null || f.max != null || f.equals !== undefined) out.push(f);
  }
  return out;
}

const passes = (f, v) => (f.equals !== undefined
  ? v.value === f.equals
  : v.numeric != null && (f.min == null || v.numeric >= f.min) && (f.max == null || v.numeric <= f.max));

function applyFieldFilters(entry, filters) {
  if (!filters.length) return { ok: true, imageIds: null };
  const productFilters = filters.filter((f) => f.scope === 'product');
  const imageFilters = filters.filter((f) => f.scope === 'image');
  for (const f of productFilters) {
    if (!entry.productFields.some((v) => v.fieldId === f.fieldId && passes(f, v))) return { ok: false };
  }
  if (!imageFilters.length) return { ok: true, imageIds: null };
  // ONE image must satisfy all image-level filters together.
  const hits = entry.images.filter((im) => imageFilters.every((f) => im.fields.some((v) => v.fieldId === f.fieldId && passes(f, v))));
  return hits.length ? { ok: true, imageIds: hits.map((im) => im.image.id) } : { ok: false };
}

// ---------- text matching ----------

function matchText(entry, tokens) {
  const matchedIn = new Set();
  let score = 0;
  for (const tok of tokens) {
    let found = false;
    for (const p of entry.pieces) {
      if (p.text.includes(tok)) {
        found = true; matchedIn.add(p.label);
        score += p.weight + (p.text.startsWith(tok) ? 3 : 0);
      }
    }
    for (const im of entry.images) {
      for (const p of im.pieces) {
        if (p.text.includes(tok)) { found = true; matchedIn.add(p.label); score += p.weight; }
      }
    }
    if (!found) return null;
  }
  const productHas = (tok) => entry.pieces.some((p) => p.text.includes(tok));
  const imageIds = [];
  for (const im of entry.images) {
    const own = tokens.filter((tok) => im.pieces.some((p) => p.text.includes(tok)));
    if (own.length && tokens.every((tok) => own.includes(tok) || productHas(tok))) imageIds.push(im.image.id);
  }
  return { score, matchedIn: [...matchedIn], imageIds };
}

// ---------- sorting ----------

function fieldSortKey(entry, fieldId, direction) {
  const nums = [...entry.productFields, ...entry.images.flatMap((im) => im.fields)]
    .filter((v) => v.fieldId === fieldId && v.numeric != null).map((v) => v.numeric);
  if (!nums.length) return null;
  return direction === 'desc' ? Math.max(...nums) : Math.min(...nums);
}

/**
 * Run a search.
 * options: {
 *   query: string,
 *   categoryIds: [], tagIds: [], match: 'any'|'all' (applies to both categories and tags),
 *   fieldFilters: compiled filters (see compileFieldFilters),
 *   sort: { by: 'relevance'|'name'|'created'|'updated'|'field', direction: 'asc'|'desc', fieldId }
 * }
 * Returns { total, results: [{ entry, product, score, matchedIn, matchedImageIds }] }
 */
export function search(index, options = {}) {
  const tokens = tokenize(options.query);
  const categoryIds = options.categoryIds || [];
  const tagIds = options.tagIds || [];
  const all = options.match === 'all';
  const fieldFilters = options.fieldFilters || [];
  const sort = options.sort || { by: tokens.length ? 'relevance' : 'name', direction: 'asc' };
  const dir = sort.direction === 'desc' ? -1 : 1;

  const hasSel = (ids, set) => !ids.length || (all ? ids.every((i) => set.has(i)) : ids.some((i) => set.has(i)));

  let rows = [];
  for (const entry of index.entries) {
    if (!hasSel(categoryIds, entry.categoryIds) || !hasSel(tagIds, entry.tagIds)) continue;
    const ff = applyFieldFilters(entry, fieldFilters);
    if (!ff.ok) continue;
    let text = { score: 0, matchedIn: [], imageIds: [] };
    if (tokens.length) {
      text = matchText(entry, tokens);
      if (!text) continue;
    }
    // Deep-link targets: images that satisfy both text and filters; otherwise whichever side has images.
    let matchedImageIds = [];
    if (ff.imageIds && tokens.length) {
      const both = ff.imageIds.filter((id) => text.imageIds.includes(id));
      matchedImageIds = both.length ? both : ff.imageIds;
    } else if (ff.imageIds) matchedImageIds = ff.imageIds;
    else matchedImageIds = text.imageIds;
    rows.push({ entry, product: entry.product, score: text.score, matchedIn: text.matchedIn, matchedImageIds });
  }

  const byName = (a, b) => collator.compare(a.product.name, b.product.name);
  switch (sort.by) {
    case 'relevance': rows.sort((a, b) => b.score - a.score || byName(a, b)); break;
    case 'created': rows.sort((a, b) => dir * (a.product.createdAt - b.product.createdAt) || byName(a, b)); break;
    case 'updated': rows.sort((a, b) => dir * (a.product.updatedAt - b.product.updatedAt) || byName(a, b)); break;
    case 'field': {
      const keyed = rows.map((r) => ({ r, k: fieldSortKey(r.entry, sort.fieldId, sort.direction) }));
      keyed.sort((a, b) => {
        if (a.k === null && b.k === null) return byName(a.r, b.r);
        if (a.k === null) return 1;            // products without a value always go last
        if (b.k === null) return -1;
        return dir * (a.k - b.k) || byName(a.r, b.r);
      });
      rows = keyed.map((x) => x.r);
      break;
    }
    default: rows.sort((a, b) => dir * collator.compare(a.product.name, b.product.name)); // 'name'
  }
  return { total: rows.length, results: rows };
}

/** Compact "Price 20.00–500.00" style summaries for result cards (number/money fields only). */
export function summarizeFields(entry, max = 2) {
  const byField = new Map();
  for (const v of [...entry.productFields, ...entry.images.flatMap((im) => im.fields)]) {
    if (v.def.type !== 'money' && v.def.type !== 'number') continue;
    if (!byField.has(v.fieldId)) byField.set(v.fieldId, { def: v.def, vals: [] });
    byField.get(v.fieldId).vals.push(v);
  }
  return [...byField.values()].slice(0, max).map(({ def, vals }) => {
    const sorted = vals.slice().sort((a, b) => a.numeric - b.numeric);
    const lo = sorted[0].shown, hi = sorted[sorted.length - 1].shown;
    const unit = def.unit ? ` ${def.unit}` : '';
    return { name: def.name, text: (lo === hi ? lo : `${lo}–${hi}`) + unit };
  });
}
