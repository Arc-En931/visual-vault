import { test, assert } from './harness.js';
import { openDatabase, deleteDatabase, STORE_NAMES } from '../js/db.js';
import { Repository } from '../js/repository.js';
import { parseMoney, formatMoney, coerceValue, toAppError, uuid } from '../js/models.js';

async function withRepo(fn) {
  const name = 'vv-test-' + uuid();
  const repo = new Repository(await openDatabase(name));
  try { await fn(repo); } finally { repo.close(); await deleteDatabase(name); }
}
const blob = (text, type = 'image/png') => new Blob([text], { type });
const valueOf = (values, fieldId) => values.find((v) => v.fieldId === fieldId)?.value;

// ---------- pure helpers ----------
test('money: parse and format use integer hundredths', () => {
  assert.eq(parseMoney('20'), 2000);
  assert.eq(parseMoney(100), 10000);
  assert.eq(parseMoney('19.99'), 1999);
  assert.eq(parseMoney('0.1'), 10);
  assert.eq(parseMoney('-5.5'), -550);
  assert.eq(parseMoney('0.30'), 30);
  assert.eq(formatMoney(1999), '19.99');
  assert.eq(formatMoney(5), '0.05');
  assert.eq(formatMoney(-550), '-5.50');
});
test('money: rejects bad input', () => {
  for (const bad of ['1.234', 'abc', '', '1e3', '1,5', '$5']) {
    let threw = false;
    try { parseMoney(bad); } catch (e) { threw = e.code === 'VALIDATION'; }
    assert.ok(threw, `"${bad}" should be rejected`);
  }
});
test('coerceValue validates each type', () => {
  assert.eq(coerceValue('number', '12.5').numeric, 12.5);
  assert.eq(coerceValue('date', '2024-02-29').value, '2024-02-29');
  assert.eq(coerceValue('boolean', 'true').value, true);
  for (const [t, v] of [['number', 'abc'], ['date', '2023-02-29'], ['date', '2023-13-01'], ['boolean', 'maybe']]) {
    let threw = false;
    try { coerceValue(t, v); } catch (e) { threw = e.code === 'VALIDATION'; }
    assert.ok(threw, `${t}:${v} should be rejected`);
  }
});
test('error mapping: quota and storage-denied errors become friendly AppErrors (mapping only, not a real quota test)', () => {
  assert.eq(toAppError(new DOMException('x', 'QuotaExceededError')).code, 'QUOTA');
  assert.eq(toAppError(new DOMException('x', 'SecurityError')).code, 'UNAVAILABLE');
  assert.eq(toAppError(new DOMException('x', 'VersionError')).code, 'VERSION');
});

// ---------- database ----------
test('db: opens with every store and expected indexes', async () => {
  const name = 'vv-test-' + uuid();
  const db = await openDatabase(name);
  try {
    assert.eq([...db.objectStoreNames].sort(), [...STORE_NAMES].sort());
    const tx = db.transaction(['images', 'customFieldValues'], 'readonly');
    assert.ok(tx.objectStore('images').indexNames.contains('productPosition'));
    assert.ok(tx.objectStore('customFieldValues').indexNames.contains('fieldOwner'));
    assert.ok(tx.objectStore('customFieldValues').index('fieldOwner').unique);
  } finally { db.close(); await deleteDatabase(name); }
});
test('db: storage-denied at open becomes UNAVAILABLE (injected failing factory)', async () => {
  const bad = { open() { throw new DOMException('blocked', 'SecurityError'); } };
  await assert.rejects(openDatabase('x', bad), 'UNAVAILABLE');
  await assert.rejects(openDatabase('x', null), 'UNAVAILABLE');
});
test('db: reopening an existing database keeps its data', async () => {
  const name = 'vv-test-' + uuid();
  let repo = new Repository(await openDatabase(name));
  const p = await repo.createProduct({ name: 'Keep me' });
  repo.close();
  repo = new Repository(await openDatabase(name));
  assert.eq((await repo.getProduct(p.id)).name, 'Keep me');
  repo.close(); await deleteDatabase(name);
});

// ---------- products ----------
test('product: create, read, update, delete', () => withRepo(async (repo) => {
  const p = await repo.createProduct({ name: ' Steel cup ', description: 'd', notes: 'n', sku: 'SC-1' });
  assert.eq(p.name, 'Steel cup'); assert.eq(p.revision, 1);
  const u = await repo.updateProduct(p.id, { name: 'Steel mug', notes: 'n2' });
  assert.eq([u.name, u.notes, u.description, u.sku, u.revision], ['Steel mug', 'n2', 'd', 'SC-1', 2]);
  assert.eq((await repo.getProduct(p.id)).name, 'Steel mug');
  await repo.deleteProduct(p.id);
  assert.eq(await repo.getProduct(p.id), undefined);
}));
test('product: name is required', () => withRepo(async (repo) => {
  await assert.rejects(repo.createProduct({ name: '   ' }), 'VALIDATION');
}));
test('product: repeating a create with the same id is rejected (no duplicates)', () => withRepo(async (repo) => {
  const id = uuid();
  await repo.createProduct({ id, name: 'A' });
  await assert.rejects(repo.createProduct({ id, name: 'A' }), 'DUPLICATE');
  assert.eq((await repo.listProducts()).length, 1);
}));
test('product: saveProduct called twice with same id updates instead of duplicating', () => withRepo(async (repo) => {
  const id = uuid();
  await repo.saveProduct({ id, name: 'A' });
  await repo.saveProduct({ id, name: 'A2' });
  const all = await repo.listProducts();
  assert.eq(all.length, 1); assert.eq(all[0].name, 'A2');
}));
test('product: stale revision is rejected with CONFLICT', () => withRepo(async (repo) => {
  const p = await repo.createProduct({ name: 'A' });
  await repo.updateProduct(p.id, { name: 'B' }, 1);
  await assert.rejects(repo.updateProduct(p.id, { name: 'C' }, 1), 'CONFLICT');
  assert.eq((await repo.getProduct(p.id)).name, 'B');
}));
test('product: list sorts by name and by dates', () => withRepo(async (repo) => {
  await repo.createProduct({ name: 'banana' }); await repo.createProduct({ name: 'Apple' }); await repo.createProduct({ name: 'cherry' });
  assert.eq((await repo.listProducts()).map((p) => p.name), ['Apple', 'banana', 'cherry']);
  assert.eq((await repo.listProducts({ direction: 'desc' })).map((p) => p.name), ['cherry', 'banana', 'Apple']);
}));

// ---------- images ----------
test('image: multiple images keep order, blobs round-trip, thumbnails optional', () => withRepo(async (repo) => {
  const p = await repo.createProduct({ name: 'P' });
  const a = await repo.addImage({ productId: p.id, blob: blob('AAA'), caption: 'one' });
  const b = await repo.addImage({ productId: p.id, blob: blob('BBB'), thumb: blob('b'), caption: 'two' });
  const imgs = await repo.listImages(p.id);
  assert.eq(imgs.map((i) => i.caption), ['one', 'two']);
  assert.eq(imgs.map((i) => i.position), [0, 1]);
  assert.eq(await (await repo.getImage(a.id)).blob.text(), 'AAA');
  assert.eq(await (await repo.getImage(b.id)).thumb.text(), 'b');
}));
test('image: rejects empty/missing blob and unknown product', () => withRepo(async (repo) => {
  const p = await repo.createProduct({ name: 'P' });
  await assert.rejects(repo.addImage({ productId: p.id, blob: blob(''), caption: 'x' }), 'VALIDATION');
  await assert.rejects(repo.addImage({ productId: p.id, caption: 'x' }), 'VALIDATION');
  await assert.rejects(repo.addImage({ productId: uuid(), blob: blob('A') }), 'NOT_FOUND');
}));

// ---------- Steel cup scenario ----------
async function steelCup(repo) {
  const price = await repo.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
  const p = await repo.createProduct({ name: 'Steel cup' });
  const small = await repo.addImage({ productId: p.id, blob: blob('small'), caption: 'Small cup' });
  const medium = await repo.addImage({ productId: p.id, blob: blob('medium'), caption: 'Medium cup' });
  const large = await repo.addImage({ productId: p.id, blob: blob('large'), caption: 'Large cup' });
  await repo.setValue('image', small.id, price.id, 20);
  await repo.setValue('image', medium.id, price.id, 100);
  await repo.setValue('image', large.id, price.id, 500);
  return { price, p, small, medium, large };
}
const prices = async (repo, ids, fieldId) => Promise.all(ids.map(async (id) => valueOf(await repo.listValues(id), fieldId)));

test('Steel cup: three images with sample prices 20 / 100 / 500', () => withRepo(async (repo) => {
  const { price, small, medium, large } = await steelCup(repo);
  assert.eq(await prices(repo, [small.id, medium.id, large.id], price.id), [2000, 10000, 50000]);
}));
test('Steel cup: editing the medium price does not change small or large', () => withRepo(async (repo) => {
  const { price, small, medium, large } = await steelCup(repo);
  await repo.setValue('image', medium.id, price.id, '120.50');
  assert.eq(await prices(repo, [small.id, medium.id, large.id], price.id), [2000, 12050, 50000]);
}));
test('Steel cup: captions edit independently', () => withRepo(async (repo) => {
  const { small, medium, large } = await steelCup(repo);
  await repo.saveImageDetails(medium.id, { caption: 'Medium cup (new)' });
  const caps = (await repo.listImages(small.productId)).map((i) => i.caption);
  assert.eq(caps, ['Small cup', 'Medium cup (new)', 'Large cup']);
}));
test('Steel cup: reordering preserves caption, price and custom attributes', () => withRepo(async (repo) => {
  const { price, p, small, medium, large } = await steelCup(repo);
  const color = await repo.createFieldDefinition({ name: 'Color', type: 'text', scope: 'image' });
  await repo.setValue('image', medium.id, color.id, 'silver');
  await repo.reorderImages(p.id, [medium.id, large.id, small.id]);
  const imgs = await repo.listImages(p.id);
  assert.eq(imgs.map((i) => i.caption), ['Medium cup', 'Large cup', 'Small cup']);
  const vals = await repo.listValues(medium.id);
  assert.eq([valueOf(vals, price.id), valueOf(vals, color.id)], [10000, 'silver']);
  assert.eq(await prices(repo, [small.id, large.id], price.id), [2000, 50000]);
}));
test('Steel cup: reorder rejects a list that does not match the product images', () => withRepo(async (repo) => {
  const { p, small, medium } = await steelCup(repo);
  await assert.rejects(repo.reorderImages(p.id, [small.id, medium.id]), 'VALIDATION');
  await assert.rejects(repo.reorderImages(p.id, [small.id, small.id, medium.id]), 'VALIDATION');
  assert.eq((await repo.listImages(p.id)).map((i) => i.caption), ['Small cup', 'Medium cup', 'Large cup']);
}));
test('Steel cup: replacing an image keeps id, caption, position and values', () => withRepo(async (repo) => {
  const { price, p, medium } = await steelCup(repo);
  await repo.replaceImageBlob(medium.id, { blob: blob('NEW-MEDIUM', 'image/jpeg') });
  const after = await repo.getImage(medium.id);
  assert.eq([after.id, after.caption, after.position, after.mime], [medium.id, 'Medium cup', 1, 'image/jpeg']);
  assert.eq(await after.blob.text(), 'NEW-MEDIUM');
  assert.eq(valueOf(await repo.listValues(medium.id), price.id), 10000);
  assert.eq((await repo.listImages(p.id)).length, 3);
}));
test('Steel cup: invalid replacement leaves the old image untouched', () => withRepo(async (repo) => {
  const { medium } = await steelCup(repo);
  await assert.rejects(repo.replaceImageBlob(medium.id, { blob: blob('') }), 'VALIDATION');
  assert.eq(await (await repo.getImage(medium.id)).blob.text(), 'medium');
}));
test('Steel cup: removing one image keeps the other images and the product', () => withRepo(async (repo) => {
  const { price, p, small, medium, large } = await steelCup(repo);
  await repo.deleteImage(small.id);
  assert.ok(await repo.getProduct(p.id));
  const imgs = await repo.listImages(p.id);
  assert.eq(imgs.map((i) => [i.caption, i.position]), [['Medium cup', 0], ['Large cup', 1]]);
  assert.eq(await prices(repo, [medium.id, large.id], price.id), [10000, 50000]);
  assert.eq((await repo.listValues(small.id)).length, 0);
}));
test('Steel cup: a failed multi-part save rolls back everything (earlier valid change is NOT kept)', () => withRepo(async (repo) => {
  const { price, medium } = await steelCup(repo);
  await assert.rejects(repo.saveImageDetails(medium.id, {
    caption: 'SHOULD NOT PERSIST',
    values: [{ fieldId: price.id, value: '999' }, { fieldId: uuid(), value: 'x' }],
  }), 'REFERENCE');
  const after = await repo.getImage(medium.id);
  assert.eq(after.caption, 'Medium cup');
  assert.eq(valueOf(await repo.listValues(medium.id), price.id), 10000);
}));

// ---------- custom fields ----------
test('field: renaming keeps existing values', () => withRepo(async (repo) => {
  const { price, small } = await steelCup(repo);
  const r = await repo.updateFieldDefinition(price.id, { name: 'Cost' });
  assert.eq(r.name, 'Cost');
  assert.eq(valueOf(await repo.listValues(small.id), price.id), 2000);
}));
test('field: duplicate name in same scope rejected, same name allowed in other scope', () => withRepo(async (repo) => {
  await repo.createFieldDefinition({ name: 'Color', type: 'text', scope: 'image' });
  await assert.rejects(repo.createFieldDefinition({ name: ' color ', type: 'text', scope: 'image' }), 'DUPLICATE');
  await repo.createFieldDefinition({ name: 'Color', type: 'text', scope: 'product' });
}));
test('field: wrong-scope and invalid values are rejected', () => withRepo(async (repo) => {
  const { price, p } = await steelCup(repo);
  await assert.rejects(repo.setValue('product', p.id, price.id, 5), 'VALIDATION'); // image-scoped field on a product
  const img = (await repo.listImages(p.id))[0];
  await assert.rejects(repo.setValue('image', img.id, price.id, 'abc'), 'VALIDATION');
  assert.eq(valueOf(await repo.listValues(img.id), price.id), 2000);
}));
test('field: clearing a value removes only that value', () => withRepo(async (repo) => {
  const { price, small, medium } = await steelCup(repo);
  await repo.setValue('image', small.id, price.id, '');
  assert.eq(valueOf(await repo.listValues(small.id), price.id), undefined);
  assert.eq(valueOf(await repo.listValues(medium.id), price.id), 10000);
}));
test('field: type change money -> text keeps values; text -> number warns about data loss', () => withRepo(async (repo) => {
  const { price, small } = await steelCup(repo);
  const rep = await repo.changeFieldType(price.id, 'text');
  assert.eq([rep.applied, rep.lost], [true, 0]);
  assert.eq(valueOf(await repo.listValues(small.id), price.id), '20.00');

  const note = await repo.createFieldDefinition({ name: 'Note', type: 'text', scope: 'product' });
  const p1 = await repo.createProduct({ name: 'p1' }); const p2 = await repo.createProduct({ name: 'p2' });
  await repo.setValue('product', p1.id, note.id, '42');
  await repo.setValue('product', p2.id, note.id, 'hello');
  const preview = await repo.changeFieldType(note.id, 'number', { dryRun: true });
  assert.eq([preview.convertible, preview.lost, preview.applied], [1, 1, false]);
  const err = await assert.rejects(repo.changeFieldType(note.id, 'number'), 'DATA_LOSS');
  assert.eq(err.details.lost, 1);
  assert.eq(valueOf(await repo.listValues(p2.id), note.id), 'hello'); // nothing changed
  await repo.changeFieldType(note.id, 'number', { acceptDataLoss: true });
  assert.eq(valueOf(await repo.listValues(p1.id), note.id), 42);
  assert.eq(valueOf(await repo.listValues(p2.id), note.id), undefined);
}));
test('field: deleting a field removes its values only', () => withRepo(async (repo) => {
  const { price, p, small } = await steelCup(repo);
  assert.eq(await repo.countFieldValues(price.id), 3);
  const r = await repo.deleteFieldDefinition(price.id);
  assert.eq(r.valuesRemoved, 3);
  assert.eq((await repo.listValues(small.id)).length, 0);
  assert.eq((await repo.listImages(p.id)).length, 3);
}));

// ---------- categories & tags ----------
test('category/tag: unique case-insensitive names; rename keeps product links; delete only unassigns', () => withRepo(async (repo) => {
  const cat = await repo.createCategory('Kitchen');
  await assert.rejects(repo.createCategory('kitchen'), 'DUPLICATE');
  const tag = await repo.createTag('steel');
  const p = await repo.saveProduct({ name: 'Cup' }, { categoryIds: [cat.id], tagIds: [tag.id] });
  await repo.renameCategory(cat.id, 'Kitchenware');
  await repo.renameTag(tag.id, 'stainless');
  let g = await repo.getProductGraph(p.id);
  assert.eq([g.categoryIds, g.tagIds], [[cat.id], [tag.id]]);
  assert.eq((await repo.listCategories())[0].name, 'Kitchenware');
  assert.eq(await repo.countCategoryUsage(cat.id), 1);
  const del = await repo.deleteCategory(cat.id);
  assert.eq(del.unassigned, 1);
  g = await repo.getProductGraph(p.id);
  assert.eq([g.categoryIds, g.tagIds.length, !!g.product], [[], 1, true]);
}));
test('product graph: save replaces categories/tags/values as a set', () => withRepo(async (repo) => {
  const c1 = await repo.createCategory('A'); const c2 = await repo.createCategory('B');
  const f = await repo.createFieldDefinition({ name: 'Material', type: 'text', scope: 'product' });
  const p = await repo.saveProduct({ name: 'X' }, { categoryIds: [c1.id], values: [{ fieldId: f.id, value: 'steel' }] });
  await repo.saveProduct({ id: p.id, name: 'X' }, { categoryIds: [c2.id], values: [] });
  const g = await repo.getProductGraph(p.id);
  assert.eq(g.categoryIds, [c2.id]); assert.eq(g.values.length, 0);
}));
test('product graph: failed save (missing category) changes nothing', () => withRepo(async (repo) => {
  const c1 = await repo.createCategory('A');
  const p = await repo.saveProduct({ name: 'Original' }, { categoryIds: [c1.id] });
  await assert.rejects(repo.saveProduct({ id: p.id, name: 'CHANGED' }, { categoryIds: [uuid()] }), 'REFERENCE');
  const g = await repo.getProductGraph(p.id);
  assert.eq([g.product.name, g.product.revision, g.categoryIds], ['Original', 1, [c1.id]]);
  // and a failed CREATE leaves no half-created product
  await assert.rejects(repo.saveProduct({ name: 'Ghost' }, { categoryIds: [uuid()] }), 'REFERENCE');
  assert.eq((await repo.listProducts()).map((x) => x.name), ['Original']);
}));

// ---------- integrity ----------
test('integrity: deleting a product leaves no orphaned images, values or joins', () => withRepo(async (repo) => {
  const { p } = await steelCup(repo);
  const cat = await repo.createCategory('K'); const tag = await repo.createTag('T');
  const pf = await repo.createFieldDefinition({ name: 'Material', type: 'text', scope: 'product' });
  await repo.saveProduct({ id: p.id, name: 'Steel cup' }, { categoryIds: [cat.id], tagIds: [tag.id], values: [{ fieldId: pf.id, value: 'steel' }] });
  const res = await repo.deleteProduct(p.id);
  assert.eq(res.imagesDeleted, 3);
  for (const s of ['products', 'images', 'customFieldValues', 'productCategories', 'productTags']) {
    assert.eq((await repo.dumpStore(s)).length, 0, `${s} should be empty`);
  }
  assert.eq((await repo.listCategories()).length, 1); // shared reference data survives
  assert.eq((await repo.listFieldDefinitions()).length, 2);
}));
test('settings: round-trip', () => withRepo(async (repo) => {
  assert.eq(await repo.getSetting('x', 'fallback'), 'fallback');
  await repo.setSetting('x', { a: 1 });
  assert.eq(await repo.getSetting('x'), { a: 1 });
}));
