// repository.js — the ONLY module that reads/writes IndexedDB records.
// Every public method is one transaction: it fully succeeds or leaves data untouched.
import {
  AppError, toAppError, uuid, coerceValue, storedToRaw, isEmptyValue, FIELD_TYPES,
  createProductRecord, updateProductRecord, createImageRecord,
  createFieldDefinitionRecord, createNamedRecord, normName,
} from './models.js';

const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/**
 * Run `fn(tx)` inside a transaction. `fn` may only await IndexedDB requests (never fetch/timers),
 * otherwise the transaction auto-commits early. Throwing inside `fn` aborts everything.
 */
function runTx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode); } catch (e) { return reject(toAppError(e)); }
    let result;
    let reason;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(toAppError(reason ?? tx.error));
    Promise.resolve()
      .then(() => fn(tx))
      .then((r) => { result = r; })
      .catch((err) => { reason = err; try { tx.abort(); } catch { /* already finished */ } });
  });
}

async function deleteByIndex(tx, storeName, indexName, key) {
  const store = tx.objectStore(storeName);
  const keys = await rq(store.index(indexName).getAllKeys(key));
  for (const k of keys) store.delete(k);
  return keys.length;
}

const notFound = (what) => new AppError('NOT_FOUND', `${what} no longer exists.`);
const conflict = (what) => new AppError('CONFLICT', `${what} was changed elsewhere since you opened it. Reload it before saving.`);
const ownerStore = (ownerType) => (ownerType === 'product' ? 'products' : 'images');

// ----- shared transaction steps -----

async function applyProductUpdate(tx, id, changes, expectedRevision) {
  const store = tx.objectStore('products');
  const cur = await rq(store.get(id));
  if (!cur) throw notFound('This product');
  if (expectedRevision !== undefined && cur.revision !== expectedRevision) throw conflict('This product');
  const next = updateProductRecord(cur, changes);
  await rq(store.put(next));
  return next;
}

/** Insert or clear one value. Empty raw => the value is removed. */
async function upsertValue(tx, ownerType, ownerId, fieldId, raw) {
  const vStore = tx.objectStore('customFieldValues');
  const prev = await rq(vStore.index('fieldOwner').get([fieldId, ownerId]));
  if (isEmptyValue(raw)) {
    if (prev) vStore.delete(prev.id);
    return null;
  }
  const def = await rq(tx.objectStore('customFieldDefinitions').get(fieldId));
  if (!def) throw new AppError('REFERENCE', 'That field no longer exists.');
  if (def.scope !== ownerType) throw new AppError('VALIDATION', `"${def.name}" applies to ${def.scope}s, not ${ownerType}s.`);
  let c;
  try { c = coerceValue(def.type, raw); } catch (e) {
    if (e instanceof AppError) throw new AppError(e.code, `${def.name}: ${e.message}`);
    throw e;
  }
  const rec = {
    id: prev ? prev.id : uuid(), ownerType, ownerId, fieldId, type: def.type,
    value: c.value, numeric: c.numeric, updatedAt: Date.now(),
  };
  await rq(vStore.put(rec));
  return rec;
}

/** Replace the full set of values for an owner with `values` ([{fieldId, value}]). */
async function writeOwnerValues(tx, ownerType, ownerId, values) {
  const ownerKey = await rq(tx.objectStore(ownerStore(ownerType)).getKey(ownerId));
  if (ownerKey === undefined) throw notFound(`This ${ownerType}`);
  const wanted = new Map();
  for (const { fieldId, value } of values) wanted.set(fieldId, value);
  const vStore = tx.objectStore('customFieldValues');
  const existing = await rq(vStore.index('ownerId').getAll(ownerId));
  for (const [fieldId, value] of wanted) await upsertValue(tx, ownerType, ownerId, fieldId, value);
  // Fields explicitly emptied were already removed by upsertValue; remove fields not mentioned at all.
  for (const v of existing) if (!wanted.has(v.fieldId)) vStore.delete(v.id);
}

async function replaceJoins(tx, joinStore, refStore, refKey, productId, ids) {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if ((await rq(tx.objectStore(refStore).getKey(id))) === undefined) {
      throw new AppError('REFERENCE', 'A selected category or tag no longer exists.');
    }
  }
  const js = tx.objectStore(joinStore);
  const existing = await rq(js.index('productId').getAll(productId));
  const have = new Set(existing.map((j) => j[refKey]));
  for (const j of existing) if (!unique.includes(j[refKey])) js.delete([productId, j[refKey]]);
  for (const id of unique) if (!have.has(id)) js.add({ productId, [refKey]: id });
}


// ---------------- backup planning (pure reads; shared by preview and commit) ----------------

const BACKUP_STORES = ['products', 'images', 'customFieldDefinitions', 'customFieldValues', 'categories', 'tags', 'productCategories', 'productTags'];

async function planImport(tx, data, mode) {
  if (mode !== 'new' && mode !== 'skip') throw new AppError('VALIDATION', 'Choose how to restore: add as new, or skip existing.');
  const keysOf = async (n) => new Set(await rq(tx.objectStore(n).getAllKeys()));
  const takenProducts = await keysOf('products');
  const takenImages = await keysOf('images');
  const takenValues = await keysOf('customFieldValues');
  const takenDefs = await keysOf('customFieldDefinitions');
  const takenCats = await keysOf('categories');
  const takenTags = await keysOf('tags');
  const fresh = (taken, old, forceNew) => {
    const id = forceNew || taken.has(old) ? uuid() : old;
    taken.add(id);
    return id;
  };
  const conflicts = [];
  const write = { defs: [], categories: [], tags: [], products: [], images: [], values: [], productCategories: [], productTags: [] };
  const retype = [];
  const summary = {
    mode, productsAdded: 0, productsSkipped: 0, imagesAdded: 0, valuesAdded: 0,
    fieldsAdded: 0, fieldsMatched: 0, fieldsRetyped: 0, categoriesAdded: 0, categoriesMatched: 0, tagsAdded: 0, tagsMatched: 0,
  };

  // Fields: matched by scope + name.
  const existingDefs = await rq(tx.objectStore('customFieldDefinitions').getAll());
  const defByName = new Map(existingDefs.map((d) => [`${d.scope}\u0000${d.nameLower}`, d]));
  const defMap = new Map();
  for (const d of data.customFieldDefinitions) {
    const hit = defByName.get(`${d.scope}\u0000${d.nameLower}`);
    if (!hit) {
      const id = fresh(takenDefs, d.id, false);
      write.defs.push({ ...d, id });
      defMap.set(d.id, id);
      summary.fieldsAdded++;
    } else if (hit.type === d.type) {
      defMap.set(d.id, hit.id);
      summary.fieldsMatched++;
    } else {
      const used = await rq(tx.objectStore('customFieldValues').index('fieldId').count(hit.id));
      if (used === 0) { retype.push({ cur: hit, type: d.type }); defMap.set(d.id, hit.id); summary.fieldsRetyped++; }
      else conflicts.push(`The ${d.scope} field "${d.name}" already exists here as ${hit.type} with ${used} saved value${used === 1 ? '' : 's'}, but the backup has it as ${d.type}. Rename one of them, then try again.`);
    }
  }

  // Categories and tags: matched by name.
  const matchNamed = async (store, backupRows, taken, out, countKey) => {
    const existing = await rq(tx.objectStore(store).getAll());
    const byName = new Map(existing.map((r) => [r.nameLower, r]));
    const map = new Map();
    for (const r of backupRows) {
      const hit = byName.get(r.nameLower);
      if (hit) { map.set(r.id, hit.id); summary[`${countKey}Matched`]++; }
      else { const id = fresh(taken, r.id, false); out.push({ ...r, id }); map.set(r.id, id); summary[`${countKey}Added`]++; }
    }
    return map;
  };
  const catMap = await matchNamed('categories', data.categories, takenCats, write.categories, 'categories');
  const tagMap = await matchNamed('tags', data.tags, takenTags, write.tags, 'tags');
  if (conflicts.length) throw new AppError('CONFLICT', conflicts.join(' '), { conflicts });

  // Products and everything that hangs off them.
  const productMap = new Map();
  for (const p of data.products) {
    if (mode === 'skip' && takenProducts.has(p.id)) { summary.productsSkipped++; continue; }
    const id = fresh(takenProducts, p.id, mode === 'new');
    productMap.set(p.id, id);
    write.products.push({ ...p, id });
    summary.productsAdded++;
  }
  const imageMap = new Map();
  for (const im of data.images) {
    if (!productMap.has(im.productId)) continue;
    const id = fresh(takenImages, im.id, mode === 'new');
    imageMap.set(im.id, id);
    write.images.push({ ...im, id, productId: productMap.get(im.productId) });
    summary.imagesAdded++;
  }
  for (const v of data.customFieldValues) {
    const owner = (v.ownerType === 'product' ? productMap : imageMap).get(v.ownerId);
    if (owner === undefined) continue;
    write.values.push({ ...v, id: fresh(takenValues, v.id, mode === 'new'), ownerId: owner, fieldId: defMap.get(v.fieldId) });
    summary.valuesAdded++;
  }
  for (const j of data.productCategories) if (productMap.has(j.productId)) write.productCategories.push({ productId: productMap.get(j.productId), categoryId: catMap.get(j.categoryId) });
  for (const j of data.productTags) if (productMap.has(j.productId)) write.productTags.push({ productId: productMap.get(j.productId), tagId: tagMap.get(j.tagId) });
  return { summary, write, retype };
}

// =====================================================================

export class Repository {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }
  _tx(stores, mode, fn) { return runTx(this.db, stores, mode, fn); }

  // ---------------- Products ----------------

  /** Create a product. Passing the same client-generated `id` twice is rejected (no duplicates). */
  async createProduct(input) {
    const product = createProductRecord(input);
    await this._tx(['products'], 'readwrite', (tx) => rq(tx.objectStore('products').add(product)));
    return product;
  }

  getProduct(id) {
    return this._tx(['products'], 'readonly', (tx) => rq(tx.objectStore('products').get(id)));
  }

  async listProducts({ sortBy = 'nameLower', direction = 'asc' } = {}) {
    if (!['nameLower', 'createdAt', 'updatedAt'].includes(sortBy)) throw new AppError('VALIDATION', 'Unknown sort field.');
    const rows = await this._tx(['products'], 'readonly', (tx) => rq(tx.objectStore('products').index(sortBy).getAll()));
    return direction === 'desc' ? rows.reverse() : rows;
  }

  updateProduct(id, changes, expectedRevision) {
    return this._tx(['products'], 'readwrite', (tx) => applyProductUpdate(tx, id, changes, expectedRevision));
  }

  /**
   * Save a product plus its categories, tags and product-level values in ONE transaction.
   * If `input.id` exists it is updated (revision-checked when expectedRevision is given),
   * otherwise it is created with that id — so a double-tapped Save never duplicates.
   * Omitted category/tag/value arrays are left untouched; provided arrays replace the full set.
   */
  saveProduct(input, { categoryIds, tagIds, values, expectedRevision } = /** @type {{ categoryIds?: string[], tagIds?: string[], values?: any, expectedRevision?: number }} */ ({})) {
    const stores = ['products', 'productCategories', 'productTags', 'categories', 'tags', 'customFieldValues', 'customFieldDefinitions'];
    return this._tx(stores, 'readwrite', async (tx) => {
      const exists = input.id ? await rq(tx.objectStore('products').getKey(input.id)) : undefined;
      let product;
      if (exists !== undefined) {
        product = await applyProductUpdate(tx, input.id, input, expectedRevision);
      } else {
        product = createProductRecord(input);
        await rq(tx.objectStore('products').add(product));
      }
      if (categoryIds) await replaceJoins(tx, 'productCategories', 'categories', 'categoryId', product.id, categoryIds);
      if (tagIds) await replaceJoins(tx, 'productTags', 'tags', 'tagId', product.id, tagIds);
      if (values) await writeOwnerValues(tx, 'product', product.id, values);
      return product;
    });
  }

  /** Delete a product and everything that belongs to it (images, values, joins). */
  deleteProduct(id) {
    const stores = ['products', 'images', 'customFieldValues', 'productCategories', 'productTags'];
    return this._tx(stores, 'readwrite', async (tx) => {
      const pk = await rq(tx.objectStore('products').getKey(id));
      if (pk === undefined) throw notFound('This product');
      const images = await rq(tx.objectStore('images').index('productId').getAllKeys(id));
      for (const imageId of images) {
        await deleteByIndex(tx, 'customFieldValues', 'ownerId', imageId);
        tx.objectStore('images').delete(imageId);
      }
      await deleteByIndex(tx, 'customFieldValues', 'ownerId', id);
      await deleteByIndex(tx, 'productCategories', 'productId', id);
      await deleteByIndex(tx, 'productTags', 'productId', id);
      tx.objectStore('products').delete(id);
      return { imagesDeleted: images.length };
    });
  }

  /** Everything needed to show/edit one product. */
  getProductGraph(id) {
    const stores = ['products', 'images', 'customFieldValues', 'productCategories', 'productTags'];
    return this._tx(stores, 'readonly', async (tx) => {
      const product = await rq(tx.objectStore('products').get(id));
      if (!product) return null;
      const images = await rq(tx.objectStore('images').index('productPosition').getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity])));
      const vStore = tx.objectStore('customFieldValues');
      const values = await rq(vStore.index('ownerId').getAll(id));
      const imageValues = {};
      for (const img of images) imageValues[img.id] = await rq(vStore.index('ownerId').getAll(img.id));
      const categoryIds = (await rq(tx.objectStore('productCategories').index('productId').getAll(id))).map((j) => j.categoryId);
      const tagIds = (await rq(tx.objectStore('productTags').index('productId').getAll(id))).map((j) => j.tagId);
      return { product, images, values, imageValues, categoryIds, tagIds };
    });
  }

  // ---------------- Images ----------------

  /** Append an image to a product (position = last + 1). */
  addImage(input) {
    return this._tx(['products', 'images'], 'readwrite', async (tx) => {
      if ((await rq(tx.objectStore('products').getKey(input.productId))) === undefined) throw notFound('This product');
      const store = tx.objectStore('images');
      const last = await rq(store.index('productPosition').openCursor(IDBKeyRange.bound([input.productId, -Infinity], [input.productId, Infinity]), 'prev'));
      const rec = createImageRecord({ ...input, position: last ? last.value.position + 1 : 0 });
      await rq(store.add(rec));
      return rec;
    });
  }

  getImage(id) {
    return this._tx(['images'], 'readonly', (tx) => rq(tx.objectStore('images').get(id)));
  }

  listImages(productId) {
    return this._tx(['images'], 'readonly', (tx) =>
      rq(tx.objectStore('images').index('productPosition').getAll(IDBKeyRange.bound([productId, -Infinity], [productId, Infinity]))));
  }

  /** Edit caption and/or image-level values atomically. */
  saveImageDetails(imageId, { caption, values, expectedRevision } = /** @type {{ caption?: string, values?: any, expectedRevision?: number }} */ ({})) {
    return this._tx(['images', 'customFieldValues', 'customFieldDefinitions'], 'readwrite', async (tx) => {
      const store = tx.objectStore('images');
      const cur = await rq(store.get(imageId));
      if (!cur) throw notFound('This image');
      if (expectedRevision !== undefined && cur.revision !== expectedRevision) throw conflict('This image');
      const next = { ...cur, updatedAt: Date.now(), revision: cur.revision + 1 };
      if (caption !== undefined) {
        const c = String(caption ?? '').normalize('NFC').trim();
        if (c.length > 2000) throw new AppError('VALIDATION', 'Caption must be 2000 characters or fewer.');
        next.caption = c;
      }
      await rq(store.put(next));
      if (values) await writeOwnerValues(tx, 'image', imageId, values);
      return next;
    });
  }

  /**
   * Replace the image file in place. Same record id, caption, position and values.
   * The old blob is overwritten only if the whole transaction commits.
   */
  replaceImageBlob(imageId, { blob, thumb }) {
    if (!(blob instanceof Blob) || blob.size === 0) return Promise.reject(new AppError('VALIDATION', 'Replacement image is missing or empty.'));
    return this._tx(['images'], 'readwrite', async (tx) => {
      const store = tx.objectStore('images');
      const cur = await rq(store.get(imageId));
      if (!cur) throw notFound('This image');
      const next = {
        ...cur, blob, thumb: thumb ?? null, mime: blob.type || 'application/octet-stream', size: blob.size,
        updatedAt: Date.now(), revision: cur.revision + 1,
      };
      await rq(store.put(next));
      return next;
    });
  }

  /** Remove one image (and its values). Remaining positions are renumbered 0..n-1. */
  deleteImage(imageId) {
    return this._tx(['images', 'customFieldValues'], 'readwrite', async (tx) => {
      const store = tx.objectStore('images');
      const cur = await rq(store.get(imageId));
      if (!cur) throw notFound('This image');
      await deleteByIndex(tx, 'customFieldValues', 'ownerId', imageId);
      store.delete(imageId);
      const rest = await rq(store.index('productPosition').getAll(IDBKeyRange.bound([cur.productId, -Infinity], [cur.productId, Infinity])));
      let pos = 0;
      for (const img of rest.filter((i) => i.id !== imageId)) {
        if (img.position !== pos) store.put({ ...img, position: pos, updatedAt: Date.now(), revision: img.revision + 1 });
        pos++;
      }
      return true;
    });
  }

  /** Reorder: `orderedIds` must contain exactly the product's current image ids. Nothing else changes. */
  reorderImages(productId, orderedIds) {
    return this._tx(['images'], 'readwrite', async (tx) => {
      const store = tx.objectStore('images');
      const imgs = await rq(store.index('productId').getAll(productId));
      const ids = new Set(imgs.map((i) => i.id));
      if (orderedIds.length !== ids.size || new Set(orderedIds).size !== ids.size || !orderedIds.every((i) => ids.has(i))) {
        throw new AppError('VALIDATION', 'The new order does not match the product\'s images. Reload and try again.');
      }
      const byId = new Map(imgs.map((i) => [i.id, i]));
      orderedIds.forEach((id, pos) => {
        const img = byId.get(id);
        if (img.position !== pos) store.put({ ...img, position: pos, updatedAt: Date.now(), revision: img.revision + 1 });
      });
      return true;
    });
  }

  // ---------------- Custom field values ----------------

  /** Set (or clear, with null/'') a single value without touching any other value. */
  setValue(ownerType, ownerId, fieldId, raw) {
    const stores = [ownerStore(ownerType), 'customFieldValues', 'customFieldDefinitions'];
    return this._tx(stores, 'readwrite', async (tx) => {
      if ((await rq(tx.objectStore(ownerStore(ownerType)).getKey(ownerId))) === undefined) throw notFound(`This ${ownerType}`);
      return upsertValue(tx, ownerType, ownerId, fieldId, raw);
    });
  }

  listValues(ownerId) {
    return this._tx(['customFieldValues'], 'readonly', (tx) => rq(tx.objectStore('customFieldValues').index('ownerId').getAll(ownerId)));
  }

  // ---------------- Custom field definitions ----------------

  async createFieldDefinition(input) {
    const def = createFieldDefinitionRecord(input);
    try {
      await this._tx(['customFieldDefinitions'], 'readwrite', (tx) => rq(tx.objectStore('customFieldDefinitions').add(def)));
    } catch (e) { throw e.code === 'DUPLICATE' ? new AppError('DUPLICATE', `A ${def.scope} field named "${def.name}" already exists.`) : e; }
    return def;
  }

  listFieldDefinitions(scope) {
    return this._tx(['customFieldDefinitions'], 'readonly', (tx) => {
      const s = tx.objectStore('customFieldDefinitions');
      return rq(scope ? s.index('scope').getAll(scope) : s.getAll());
    });
  }

  /** Rename / change unit. Values reference the field by id, so they are untouched. */
  async updateFieldDefinition(id, { name, unit }) {
    try {
      return await this._tx(['customFieldDefinitions'], 'readwrite', async (tx) => {
        const s = tx.objectStore('customFieldDefinitions');
        const cur = await rq(s.get(id));
        if (!cur) throw notFound('This field');
        const probe = createFieldDefinitionRecord({ ...cur, name: name ?? cur.name, unit: unit ?? cur.unit });
        const next = { ...cur, name: probe.name, nameLower: probe.nameLower, unit: probe.unit, updatedAt: Date.now(), revision: cur.revision + 1 };
        await rq(s.put(next));
        return next;
      });
    } catch (e) { throw e.code === 'DUPLICATE' ? new AppError('DUPLICATE', 'Another field with that name already exists.') : e; }
  }

  /** How many values use this field (for the delete confirmation). */
  countFieldValues(id) {
    return this._tx(['customFieldValues'], 'readonly', (tx) => rq(tx.objectStore('customFieldValues').index('fieldId').count(id)));
  }

  /** Delete a field AND all its values. The UI must confirm first (use countFieldValues). */
  deleteFieldDefinition(id) {
    return this._tx(['customFieldDefinitions', 'customFieldValues'], 'readwrite', async (tx) => {
      const s = tx.objectStore('customFieldDefinitions');
      if ((await rq(s.getKey(id))) === undefined) throw notFound('This field');
      const removed = await deleteByIndex(tx, 'customFieldValues', 'fieldId', id);
      s.delete(id);
      return { valuesRemoved: removed };
    });
  }

  /**
   * Change a field's data type. Use { dryRun: true } to preview.
   * If any existing value can't convert, throws DATA_LOSS (details = report) unless acceptDataLoss is true,
   * in which case only the unconvertible values are removed.
   */
  changeFieldType(id, newType, { acceptDataLoss = false, dryRun = false } = {}) {
    if (!FIELD_TYPES.includes(newType)) return Promise.reject(new AppError('VALIDATION', 'Choose a valid field type.'));
    return this._tx(['customFieldDefinitions', 'customFieldValues'], dryRun ? 'readonly' : 'readwrite', async (tx) => {
      const defs = tx.objectStore('customFieldDefinitions');
      const def = await rq(defs.get(id));
      if (!def) throw notFound('This field');
      const vs = tx.objectStore('customFieldValues');
      const vals = await rq(vs.index('fieldId').getAll(id));
      const plan = [];
      const lostIds = [];
      for (const v of vals) {
        try { plan.push({ v, c: coerceValue(newType, storedToRaw(def.type, v.value)) }); } catch { lostIds.push(v.id); }
      }
      const report = { fromType: def.type, toType: newType, total: vals.length, convertible: plan.length, lost: lostIds.length };
      if (def.type === newType || dryRun) return { ...report, applied: false };
      if (lostIds.length && !acceptDataLoss) {
        throw new AppError('DATA_LOSS', `${lostIds.length} of ${vals.length} existing values cannot be converted to ${newType} and would be lost.`, report);
      }
      for (const { v, c } of plan) vs.put({ ...v, type: newType, value: c.value, numeric: c.numeric, updatedAt: Date.now() });
      for (const vid of lostIds) vs.delete(vid);
      defs.put({ ...def, type: newType, updatedAt: Date.now(), revision: def.revision + 1 });
      return { ...report, applied: true };
    });
  }

  // ---------------- Categories & tags ----------------

  createCategory(name) { return this._createNamed('categories', name, 'Category'); }
  createTag(name) { return this._createNamed('tags', name, 'Tag'); }
  listCategories() { return this._listNamed('categories'); }
  listTags() { return this._listNamed('tags'); }
  renameCategory(id, name) { return this._renameNamed('categories', id, name, 'Category'); }
  renameTag(id, name) { return this._renameNamed('tags', id, name, 'Tag'); }
  countCategoryUsage(id) { return this._tx(['productCategories'], 'readonly', (tx) => rq(tx.objectStore('productCategories').index('categoryId').count(id))); }
  countTagUsage(id) { return this._tx(['productTags'], 'readonly', (tx) => rq(tx.objectStore('productTags').index('tagId').count(id))); }
  /** Deletes the category and un-assigns it from products. Products themselves are untouched. */
  deleteCategory(id) { return this._deleteNamed('categories', 'productCategories', 'categoryId', id); }
  deleteTag(id) { return this._deleteNamed('tags', 'productTags', 'tagId', id); }

  async _createNamed(store, name, label) {
    const rec = createNamedRecord({ name }, `${label} name`);
    try {
      await this._tx([store], 'readwrite', (tx) => rq(tx.objectStore(store).add(rec)));
    } catch (e) { throw e.code === 'DUPLICATE' ? new AppError('DUPLICATE', `${label} "${rec.name}" already exists.`) : e; }
    return rec;
  }
  _listNamed(store) {
    return this._tx([store], 'readonly', (tx) => rq(tx.objectStore(store).index('nameLower').getAll()));
  }
  async _renameNamed(store, id, name, label) {
    const probe = createNamedRecord({ name }, `${label} name`);
    try {
      return await this._tx([store], 'readwrite', async (tx) => {
        const s = tx.objectStore(store);
        const cur = await rq(s.get(id));
        if (!cur) throw notFound(`This ${label.toLowerCase()}`);
        const next = { ...cur, name: probe.name, nameLower: probe.nameLower, updatedAt: Date.now() };
        await rq(s.put(next));
        return next;
      });
    } catch (e) { throw e.code === 'DUPLICATE' ? new AppError('DUPLICATE', `${label} "${probe.name}" already exists.`) : e; }
  }
  _deleteNamed(store, joinStore, joinKey, id) {
    return this._tx([store, joinStore], 'readwrite', async (tx) => {
      const s = tx.objectStore(store);
      if ((await rq(s.getKey(id))) === undefined) throw notFound('This item');
      const unassigned = await deleteByIndex(tx, joinStore, joinKey, id);
      s.delete(id);
      return { unassigned };
    });
  }

  // ---------------- Catalog snapshot (search, Step C) ----------------

  /**
   * One consistent read of everything the search index needs, in ONE read-only transaction.
   * Image records are returned WITHOUT their blobs (metadata only); the UI loads thumbnails lazily with getImage().
   */
  getCatalogSnapshot() {
    const names = ['products', 'images', 'customFieldDefinitions', 'customFieldValues', 'categories', 'tags', 'productCategories', 'productTags'];
    return this._tx(names, 'readonly', async (tx) => {
      const all = (n) => rq(tx.objectStore(n).getAll());
      const [products, images, fieldDefinitions, values, categories, tags, productCategories, productTags] = await Promise.all(names.map(all));
      return {
        products,
        images: images.map(({ blob, thumb, ...meta }) => ({ ...meta, hasThumb: !!thumb })),
        fieldDefinitions, values, categories, tags, productCategories, productTags,
      };
    });
  }

  // ---------------- Settings ----------------

  async getSetting(key, fallback = null) {
    const rec = await this._tx(['settings'], 'readonly', (tx) => rq(tx.objectStore('settings').get(key)));
    return rec ? rec.value : fallback;
  }
  setSetting(key, value) {
    return this._tx(['settings'], 'readwrite', (tx) => rq(tx.objectStore('settings').put({ key, value, updatedAt: Date.now() })));
  }

  // ---------------- Backup & restore (Step E) ----------------

  /** Every catalog record, including image blobs, read in ONE read-only transaction (a consistent snapshot). */
  getFullSnapshot() {
    return this._tx(BACKUP_STORES, 'readonly', async (tx) => {
      const out = {};
      await Promise.all(BACKUP_STORES.map(async (n) => { out[n] = await rq(tx.objectStore(n).getAll()); }));
      return out;
    });
  }

  /**
   * Exactly what importBackup would do right now, without writing anything.
   * Throws CONFLICT (details.conflicts) if the backup cannot be merged.
   */
  async previewImport(data, mode) {
    const plan = await this._tx(BACKUP_STORES, 'readonly', (tx) => planImport(tx, data, mode));
    return plan.summary;
  }

  /**
   * Merge a validated backup (see backup.js) in ONE transaction: it either all lands or nothing changes.
   * The plan is recomputed inside the transaction, so it is always based on the data as it is at commit time.
   * mode 'new'  : every product, photo and value gets a new id (an exact copy is added again if you restore twice).
   * mode 'skip' : products whose id already exists here are left untouched; the rest keep their ids.
   * Fields, categories and tags are matched by name in both modes; missing ones are created.
   */
  importBackup(data, mode) {
    return this._tx(BACKUP_STORES, 'readwrite', async (tx) => {
      const plan = await planImport(tx, data, mode);
      const put = (store, rec) => rq(tx.objectStore(store).add(rec));
      for (const d of plan.retype) await rq(tx.objectStore('customFieldDefinitions').put({ ...d.cur, type: d.type, updatedAt: Date.now(), revision: d.cur.revision + 1 }));
      for (const r of plan.write.defs) await put('customFieldDefinitions', r);
      for (const r of plan.write.categories) await put('categories', r);
      for (const r of plan.write.tags) await put('tags', r);
      for (const r of plan.write.products) await put('products', r);
      for (const r of plan.write.images) await put('images', r);
      for (const r of plan.write.values) await put('customFieldValues', r);
      for (const r of plan.write.productCategories) await put('productCategories', r);
      for (const r of plan.write.productTags) await put('productTags', r);
      return plan.summary;
    });
  }

  // ---------------- Bulk read (tests, backup in Step E) ----------------

  dumpStore(name) {
    return this._tx([name], 'readonly', (tx) => rq(tx.objectStore(name).getAll()));
  }
}

export { normName };
