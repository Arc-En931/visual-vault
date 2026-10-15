import { test, assert } from './harness.js';
import { openDatabase, deleteDatabase } from '../js/db.js';
import { Repository } from '../js/repository.js';
import { uuid } from '../js/models.js';
import { crc32, ZipWriter, openZip, readEntryBytes, isSafeName } from '../js/zip.js';
import { buildBackup, readBackup, sha256Hex, backupFileName, FORMAT_VERSION } from '../js/backup.js';

async function withRepo(fn) {
  const name = 'vv-test-' + uuid();
  const repo = new Repository(await openDatabase(name));
  try { await fn(repo); } finally { repo.close(); await deleteDatabase(name); }
}
async function makeImage(w, h, type = 'image/png', color = '#3366cc') {
  const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(0, 0, Math.ceil(w / 4), Math.ceil(h / 4));
  return c.convertToBlob({ type });
}
const asFile = (blob, name = 'backup.zip') => new File([blob], name, { type: 'application/zip' });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

/** A realistic catalog: every field type, both scopes, categories, tags, photos with thumbnails, unicode names. */
async function seed(repo, { photos = true } = {}) {
  const price = await repo.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
  const colour = await repo.createFieldDefinition({ name: 'Colour', type: 'text', scope: 'image' });
  const weight = await repo.createFieldDefinition({ name: 'Weight', type: 'number', scope: 'product', unit: 'kg' });
  const made = await repo.createFieldDefinition({ name: 'Made on', type: 'date', scope: 'product' });
  const organic = await repo.createFieldDefinition({ name: 'Organic', type: 'boolean', scope: 'product' });
  const kitchen = await repo.createCategory('Kitchen');
  const decor = await repo.createCategory('Décor');
  const metal = await repo.createTag('Metal');
  const gift = await repo.createTag('Gift');
  const p1 = await repo.saveProduct({ name: 'Steel cup', sku: 'SC-1', description: 'Insulated mug', notes: 'dishwasher safe' },
    { categoryIds: [kitchen.id], tagIds: [metal.id, gift.id], values: [{ fieldId: weight.id, value: '0.35' }, { fieldId: made.id, value: '2025-02-28' }, { fieldId: organic.id, value: 'true' }] });
  const p2 = await repo.saveProduct({ name: 'Café lamp ünïcode 🙂', description: 'Line 1\nLine 2' }, { categoryIds: [decor.id], tagIds: [], values: [] });
  const p3 = await repo.saveProduct({ name: 'No photos yet' }, { categoryIds: [], tagIds: [gift.id], values: [] });
  if (photos) {
    const plan = [[p1, 'png', 'Small', '19.99', 'Blue'], [p1, 'jpeg', 'Large', '24.5', ''], [p2, 'webp', 'Lamp on', '0.05', 'Warm white']];
    for (const [p, ext, caption, money, col] of plan) {
      const type = 'image/' + ext;
      const im = await repo.addImage({ productId: p.id, blob: await makeImage(80 + caption.length * 7, 60, type), thumb: await makeImage(40, 30, 'image/jpeg', '#aa5533'), caption });
      await repo.saveImageDetails(im.id, { values: [{ fieldId: price.id, value: money }, ...(col ? [{ fieldId: colour.id, value: col }] : [])] });
    }
  }
  return { p1, p2, p3 };
}

/** Id-independent description of the whole catalog, including image bytes (hashed). */
async function describe(repo) {
  const snap = await repo.getFullSnapshot();
  const defs = new Map(snap.customFieldDefinitions.map((d) => [d.id, d]));
  const cats = new Map(snap.categories.map((c) => [c.id, c.name]));
  const tags = new Map(snap.tags.map((c) => [c.id, c.name]));
  const valsOf = (id) => snap.customFieldValues.filter((v) => v.ownerId === id).map((v) => `${defs.get(v.fieldId).name}=${v.value}`).sort();
  const products = [];
  for (const p of snap.products) {
    const imgs = snap.images.filter((i) => i.productId === p.id).sort((a, b) => a.position - b.position);
    products.push({
      name: p.name, sku: p.sku, description: p.description, notes: p.notes, createdAt: p.createdAt, updatedAt: p.updatedAt, revision: p.revision,
      values: valsOf(p.id),
      categories: snap.productCategories.filter((j) => j.productId === p.id).map((j) => cats.get(j.categoryId)).sort(),
      tags: snap.productTags.filter((j) => j.productId === p.id).map((j) => tags.get(j.tagId)).sort(),
      images: await Promise.all(imgs.map(async (i) => ({
        caption: i.caption, position: i.position, mime: i.mime, size: i.size, values: valsOf(i.id),
        blob: await sha256Hex(i.blob), thumb: i.thumb ? await sha256Hex(i.thumb) : null,
      }))),
    });
  }
  products.sort((a, b) => a.name.localeCompare(b.name));
  return {
    products,
    defs: snap.customFieldDefinitions.map((d) => `${d.scope}:${d.name}:${d.type}:${d.unit}`).sort(),
    categories: [...cats.values()].sort(), tags: [...tags.values()].sort(),
  };
}
async function dumpAll(repo) {
  const out = {};
  for (const n of ['products', 'images', 'customFieldDefinitions', 'customFieldValues', 'categories', 'tags', 'productCategories', 'productTags']) {
    const rows = await repo.dumpStore(n);
    out[n] = await Promise.all(rows.map(async ({ blob, thumb, ...r }) => ({ ...r, blob: blob ? await sha256Hex(blob) : undefined, thumb: thumb ? await sha256Hex(thumb) : undefined })));
    out[n].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}
async function backupOf(repo) { return asFile((await buildBackup(await repo.getFullSnapshot())).blob); }
async function read(file) { return readBackup(file); }
async function mustRead(file) { const r = await read(file); assert.ok(r.ok, 'backup should be valid: ' + (r.problems || []).join(' | ')); return r; }

/** Rebuild a backup after changing data.json / the manifest, re-signing checksums so only the intended fault remains. */
async function rebuild(file, { mutateData, mutateManifest, drop, add = {}, wrongHashFor } = {}) {
  const zip = await openZip(file);
  const files = new Map();
  for (const name of zip.entries.keys()) if (name !== 'manifest.json') files.set(name, await readEntryBytes(zip, name));
  if (mutateData) {
    const d = JSON.parse(new TextDecoder().decode(files.get('data.json')));
    files.set('data.json', new TextEncoder().encode(JSON.stringify(mutateData(d) || d)));
  }
  if (drop) files.delete(drop);
  const manifest = JSON.parse(new TextDecoder().decode(await readEntryBytes(zip, 'manifest.json')));
  manifest.files = {};
  for (const [n, b] of files) manifest.files[n] = { size: b.length, sha256: n === wrongHashFor ? '0'.repeat(64) : await sha256Hex(b) };
  if (drop) { /* manifest still lists it on purpose when asked via mutateManifest */ }
  if (mutateManifest) mutateManifest(manifest);
  const w = new ZipWriter();
  await w.add('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  for (const [n, b] of files) await w.add(n, b);
  for (const [n, b] of Object.entries(add)) await w.add(n, b);
  return asFile(w.finish());
}
const problemsOf = async (file) => { const r = await read(file); assert.ok(!r.ok, 'expected the backup to be rejected'); return r.problems.join(' | '); };

// ====================== zip layer ======================
test('zip: CRC-32 matches the standard check value and file names are vetted', () => {
  assert.eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  for (const bad of ['', '/abs', '../x', 'a/../b', 'a//b', 'a\\b', 'dir/', 'a\u0000b', '.']) assert.ok(!isSafeName(bad), JSON.stringify(bad));
  for (const ok of ['a.txt', 'images/img-00001.png', 'données/é.txt']) assert.ok(isSafeName(ok), ok);
});

test('zip: round trip keeps every byte (empty file, unicode name, 1.5 MB of random data)', async () => {
  const random = new Uint8Array(1.5 * 1024 * 1024); for (let i = 0; i < random.length; i += 65536) crypto.getRandomValues(random.subarray(i, Math.min(i + 65536, random.length)));
  const w = new ZipWriter();
  await w.add('empty.bin', new Uint8Array(0)); await w.add('données/é🙂.txt', new TextEncoder().encode('héllo')); await w.add('big.bin', random);
  const z = await openZip(w.finish());
  assert.eq([...z.entries.keys()], ['empty.bin', 'données/é🙂.txt', 'big.bin']);
  assert.eq((await readEntryBytes(z, 'empty.bin')).length, 0);
  assert.eq(new TextDecoder().decode(await readEntryBytes(z, 'données/é🙂.txt')), 'héllo');
  const back = await readEntryBytes(z, 'big.bin');
  assert.ok(back.length === random.length && back.every((b, i) => b === random[i]), 'big file differs');
});

test('zip: writer refuses unsafe and duplicate names', async () => {
  const w = new ZipWriter();
  await assert.rejects(w.add('../evil', new Uint8Array(1)), 'ZIP');
  await w.add('a', new Uint8Array(1));
  await assert.rejects(w.add('a', new Uint8Array(1)), 'ZIP');
});

test('zip: reader rejects garbage, truncation, flipped bytes, compression, encryption, traversal names, duplicates', async () => {
  await assert.rejects(openZip(new Blob(['this is not a zip file at all, just text'])), 'ZIP');
  await assert.rejects(openZip(new Blob([])), 'ZIP');
  const w = new ZipWriter();
  await w.add('aa/evil.txt', new TextEncoder().encode('payload-payload')); await w.add('b.txt', new TextEncoder().encode('second'));
  const good = await bytesOf(w.finish());
  await openZip(new Blob([good]));                                                      // sanity: the unmodified file opens
  await assert.rejects(openZip(new Blob([good.slice(0, good.length - 30)])), 'ZIP');    // truncated: directory cut off
  await assert.rejects(openZip(new Blob([good.slice(0, 40)])), 'ZIP');
  const z = await openZip(new Blob([good]));
  const flipped = good.slice(); flipped[z.entries.get('b.txt').start] ^= 0xff;           // data damage -> CRC
  const zf = await openZip(new Blob([flipped]));
  const e = await assert.rejects(readEntryBytes(zf, 'b.txt'), 'ZIP'); assert.ok(/damaged/.test(e.message), e.message);
  const find = (needle) => { const n = new TextEncoder().encode(needle); const hits = []; for (let i = 0; i + n.length <= good.length; i++) if (n.every((b, k) => good[i + k] === b)) hits.push(i); return hits; };
  const traversal = good.slice(); for (const at of find('aa/')) { traversal[at] = 0x2e; traversal[at + 1] = 0x2e; }   // "../evil.txt" in local + central header
  const t = await assert.rejects(openZip(new Blob([traversal])), 'ZIP'); assert.ok(/unsafe/.test(t.message), t.message);
  const cdAt = (name) => { const hits = find(name); return hits[hits.length - 1]; };
  const dv = (arr) => new DataView(arr.buffer);
  const comp = good.slice(); dv(comp).setUint16(cdAt('b.txt') - 46 + 10, 8, true);       // method = deflate in the directory
  const c = await assert.rejects(openZip(new Blob([comp])), 'ZIP'); assert.ok(/compressed/.test(c.message), c.message);
  const crypt = good.slice(); dv(crypt).setUint16(cdAt('b.txt') - 46 + 8, 1, true);      // encrypted flag
  const x = await assert.rejects(openZip(new Blob([crypt])), 'ZIP'); assert.ok(/password/.test(x.message), x.message);
  const w2 = new ZipWriter(); await w2.add('abcde', new Uint8Array([1])); await w2.add('abcdf', new Uint8Array([2]));
  const two = await bytesOf(w2.finish()); await openZip(new Blob([two]));               // distinct names open fine
  const dupName = two.slice(); const n = new TextEncoder().encode('abcdf');
  for (let i = 0; i + 5 <= dupName.length; i++) if (n.every((b, k) => dupName[i + k] === b)) dupName[i + 4] = 0x65;   // second name becomes "abcde" in both headers
  const d = await assert.rejects(openZip(new Blob([dupName])), 'ZIP'); assert.ok(/twice/.test(d.message), d.message);
  const overlap = two.slice(); const z2 = await openZip(new Blob([two]));
  const cd2 = (() => { const hits = []; const sig = [0x50, 0x4b, 0x01, 0x02]; for (let i = 0; i + 4 <= two.length; i++) if (sig.every((b, k) => two[i + k] === b)) hits.push(i); return hits; })();
  dv(overlap).setUint32(cd2[1] + 42, 0, true);                                           // second entry claims the first entry's position
  await assert.rejects(openZip(new Blob([overlap])), 'ZIP'); void z2;
});

// ====================== backup round trip ======================
test('backup: file name is dated; manifest lists every file with a checksum; counts are right', async () => {
  assert.eq(backupFileName(new Date(2026, 9, 14, 9, 5)), 'visualvault-backup-2026-10-14-0905.zip');
  await withRepo(async (repo) => {
    await seed(repo);
    const { blob, counts } = await buildBackup(await repo.getFullSnapshot());
    assert.eq(counts, { products: 3, images: 3, fields: 5, values: 8, categories: 2, tags: 2 });
    const z = await openZip(blob);
    const m = JSON.parse(new TextDecoder().decode(await readEntryBytes(z, 'manifest.json')));
    assert.eq([m.format, m.formatVersion], ['visualvault-backup', FORMAT_VERSION]);
    assert.eq(Object.keys(m.files).sort(), [...z.entries.keys()].filter((n) => n !== 'manifest.json').sort());
    assert.eq(Object.keys(m.files).length, 1 + 3 + 3);
    for (const [name, info] of Object.entries(m.files)) assert.eq(await sha256Hex(await readEntryBytes(z, name)), info.sha256, name);
  });
});

test('restore into an empty catalog (skip mode) reproduces everything: products, photos, thumbnails, values, links, ids', async () => {
  let file; let before;
  await withRepo(async (repo) => { await seed(repo); file = await backupOf(repo); before = await describe(repo); });
  await withRepo(async (fresh) => {
    const parsed = await mustRead(file);
    assert.eq([parsed.summary.products, parsed.summary.images, parsed.summary.fields], [3, 3, 5]);
    const r = await fresh.importBackup(parsed.data, 'skip');
    assert.eq([r.productsAdded, r.imagesAdded, r.valuesAdded, r.fieldsAdded, r.categoriesAdded, r.tagsAdded], [3, 3, 8, 5, 2, 2]);
    assert.eq(await describe(fresh), before);
    assert.ok(parsed.data.products.every((p) => p.id), 'ids kept');
    for (const p of parsed.data.products) assert.ok(await fresh.getProduct(p.id), 'same product id exists');
    // photo order and caption still right through the real graph API
    const steel = parsed.data.products.find((p) => p.name === 'Steel cup');
    const g = await fresh.getProductGraph(steel.id);
    assert.eq(g.images.map((i) => i.caption), ['Small', 'Large']);
    assert.eq(g.images.map((i) => i.mime), ['image/png', 'image/jpeg']);
    assert.ok((await createImageBitmap(g.images[0].blob)).width > 0, 'restored photo decodes');
  });
});

test('restoring the same backup twice in skip mode changes nothing the second time', async () => {
  await withRepo(async (repo) => {
    await seed(repo);
    const file = await backupOf(repo);
    const snap = await dumpAll(repo);
    const r = await repo.importBackup((await mustRead(file)).data, 'skip');
    assert.eq([r.productsAdded, r.productsSkipped, r.imagesAdded, r.valuesAdded, r.fieldsAdded, r.fieldsMatched], [0, 3, 0, 0, 0, 5]);
    assert.eq(await dumpAll(repo), snap);
  });
});

test('"Add as new" adds copies with new ids, leaves originals byte-identical, and does not duplicate fields/categories/tags', async () => {
  await withRepo(async (repo) => {
    await seed(repo);
    const file = await backupOf(repo);
    const original = await dumpAll(repo);
    const origIds = new Set((await repo.listProducts()).map((p) => p.id));
    const r = await repo.importBackup((await mustRead(file)).data, 'new');
    assert.eq([r.productsAdded, r.imagesAdded, r.valuesAdded, r.fieldsAdded, r.fieldsMatched, r.categoriesAdded, r.tagsAdded], [3, 3, 8, 0, 5, 0, 0]);
    const all = await repo.listProducts();
    assert.eq(all.length, 6);
    const added = all.filter((p) => !origIds.has(p.id));
    assert.eq(added.length, 3);
    const after = await dumpAll(repo);
    for (const p of original.products) assert.ok(after.products.some((q) => JSON.stringify(q) === JSON.stringify(p)), 'original product changed: ' + p.name);
    assert.eq((await repo.listFieldDefinitions()).length, 5);
    assert.eq((await repo.listCategories()).length, 2);
    // a copy is complete: its photos and values belong to the NEW product ids only
    const d = await describe(repo);
    assert.eq(d.products.filter((p) => p.name === 'Steel cup').map((p) => p.images.length), [2, 2]);
    const newImageProducts = new Set((await repo.dumpStore('images')).map((i) => i.productId));
    for (const id of newImageProducts) assert.ok(await repo.getProduct(id), 'image points at an existing product');
  });
});

test('skip mode with partial overlap: only the missing product is added; edited products are left as they are', async () => {
  await withRepo(async (repo) => {
    const { p1, p2 } = await seed(repo);
    const file = await backupOf(repo);
    await repo.deleteProduct(p2.id);
    await repo.updateProduct(p1.id, { name: 'Steel cup (edited after backup)' });
    const edited = await repo.getProduct(p1.id);
    const r = await repo.importBackup((await mustRead(file)).data, 'skip');
    assert.eq([r.productsAdded, r.productsSkipped, r.imagesAdded], [1, 2, 1]);
    assert.eq(await repo.getProduct(p1.id), edited);
    assert.ok(await repo.getProduct(p2.id), 'deleted product is back');
    assert.eq((await repo.listImages(p1.id)).length, 2);
  });
});

test('preview reports exactly what the restore then does, and writes nothing', async () => {
  await withRepo(async (repo) => {
    const { p3 } = await seed(repo);
    const file = await backupOf(repo);
    await repo.deleteProduct(p3.id);
    const data = (await mustRead(file)).data;
    const snap = await dumpAll(repo);
    const preview = await repo.previewImport(data, 'skip');
    assert.eq(await dumpAll(repo), snap);
    assert.eq(await repo.importBackup(data, 'skip'), preview);
  });
});

test('fields match by name: fresh app\'s unused default Price (money) adopts the backup type; a USED field with another type is a conflict and nothing changes', async () => {
  let file;
  await withRepo(async (repo) => {                  // backup where Price is a NUMBER
    const f = await repo.createFieldDefinition({ name: 'Price', type: 'number', scope: 'image' });
    const p = await repo.saveProduct({ name: 'Thing' }, {});
    const im = await repo.addImage({ productId: p.id, blob: await makeImage(30, 30), caption: 'x' });
    await repo.saveImageDetails(im.id, { values: [{ fieldId: f.id, value: '12.5' }] });
    file = await backupOf(repo);
  });
  await withRepo(async (fresh) => {                 // a new phone: the app already created Price as money, unused
    await fresh.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
    const r = await fresh.importBackup((await mustRead(file)).data, 'skip');
    assert.eq(r.fieldsRetyped, 1);
    const defs = await fresh.listFieldDefinitions();
    assert.eq(defs.map((d) => `${d.name}:${d.type}`), ['Price:number']);
    assert.eq((await fresh.dumpStore('customFieldValues'))[0].value, 12.5);
  });
  await withRepo(async (busy) => {                  // Price as money WITH data: must not be altered
    const f = await busy.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
    const p = await busy.saveProduct({ name: 'Mine' }, {});
    const im = await busy.addImage({ productId: p.id, blob: await makeImage(30, 30) });
    await busy.saveImageDetails(im.id, { values: [{ fieldId: f.id, value: '3' }] });
    const snap = await dumpAll(busy);
    const e = await assert.rejects(busy.importBackup((await mustRead(file)).data, 'skip'), 'CONFLICT');
    assert.ok(/Price/.test(e.message) && /money/.test(e.message) && /number/.test(e.message), e.message);
    assert.eq(await dumpAll(busy), snap);
  });
});

test('atomic: a failure in the middle of a restore (22nd write) leaves the catalog exactly as it was', async () => {
  let file;
  await withRepo(async (repo) => { await seed(repo); file = await backupOf(repo); });
  await withRepo(async (target) => {
    await target.createCategory('Pre-existing');
    const p = await target.saveProduct({ name: 'Already here' }, {});
    await target.addImage({ productId: p.id, blob: await makeImage(20, 20), caption: 'keep me' });
    const snap = await dumpAll(target);
    const data = (await mustRead(file)).data;
    const realAdd = IDBObjectStore.prototype.add;
    let calls = 0;
    IDBObjectStore.prototype.add = function (...a) { if (++calls === 22) throw new DOMException('simulated disk full', 'QuotaExceededError'); return realAdd.apply(this, a); };
    try {
      const e = await assert.rejects(target.importBackup(data, 'new'), 'QUOTA');
      assert.ok(/Nothing was changed/.test(e.message), e.message);
    } finally { IDBObjectStore.prototype.add = realAdd; }
    assert.ok(calls >= 22, 'the failure point was reached mid-restore: ' + calls);
    assert.eq(await dumpAll(target), snap);
    // and the very same restore works once the fault is gone
    assert.eq((await target.importBackup(data, 'new')).productsAdded, 3);
  });
});

test('empty catalog: backup and restore work, and restoring it reports nothing to add', async () => {
  await withRepo(async (repo) => {
    const file = await backupOf(repo);
    const r = await mustRead(file);
    assert.eq([r.summary.products, r.summary.images], [0, 0]);
    assert.eq((await repo.importBackup(r.data, 'skip')).productsAdded, 0);
  });
});

test('photo positions in a backup are normalised to 0..n-1 in saved order', async () => {
  await withRepo(async (repo) => {
    const { p1 } = await seed(repo);
    const file = await rebuild(await backupOf(repo), { mutateData: (d) => { const ims = d.images.filter((i) => i.productId === p1.id); ims[0].position = 7; ims[1].position = 3; } });
    const data = (await mustRead(file)).data;
    const mine = data.images.filter((i) => i.productId === p1.id).sort((a, b) => a.position - b.position);
    assert.eq(mine.map((i) => [i.caption, i.position]), [['Large', 0], ['Small', 1]]);
  });
});

// ====================== validation (everything is checked before anything is written) ======================
test('validate: a damaged photo byte, a wrong checksum, a missing file and an unlisted file are each caught with a clear message', async () => {
  await withRepo(async (repo) => {
    await seed(repo);
    const good = await backupOf(repo);
    const z = await openZip(good);
    const img = [...z.entries.keys()].find((n) => n.startsWith('images/'));
    const bytes = await bytesOf(good); bytes[z.entries.get(img).start + 12] ^= 0x55;
    assert.ok(/damaged/.test(await problemsOf(asFile(new Blob([bytes])))), 'flipped byte');
    assert.ok(/checksum/.test(await problemsOf(await rebuild(good, { wrongHashFor: img }))), 'wrong sha');
    assert.ok(/missing from the ZIP/.test(await problemsOf(await rebuild(good, { drop: img, mutateManifest: (m) => { m.files[img] = { size: 1, sha256: '0'.repeat(64) }; } }))), 'missing file');
    assert.ok(/not in the manifest/.test(await problemsOf(await rebuild(good, { add: { 'images/sneaky.png': new Uint8Array([1, 2, 3]) } }))), 'unlisted');
  });
});

test('validate: wrong format, newer version and non-backup ZIPs are refused', async () => {
  await withRepo(async (repo) => {
    await seed(repo);
    const good = await backupOf(repo);
    assert.ok(/newer version/.test(await problemsOf(await rebuild(good, { mutateManifest: (m) => { m.formatVersion = 99; } }))));
    assert.ok(/not a VisualVault backup/.test(await problemsOf(await rebuild(good, { mutateManifest: (m) => { m.format = 'something-else'; } }))));
    const w = new ZipWriter(); await w.add('notes.txt', new TextEncoder().encode('hi'));
    assert.ok(/manifest\.json is missing/.test(await problemsOf(asFile(w.finish()))));
    assert.ok(/not a VisualVault backup|readable ZIP/.test(await problemsOf(new File(['plain text'], 'x.zip'))));
    assert.ok(/data\.json is missing/.test(await problemsOf(await rebuild(good, { drop: 'data.json' }))));
  });
});

test('validate: broken references, bad values, duplicates and fake images are all reported TOGETHER, and nothing is imported', async () => {
  await withRepo(async (repo) => {
    const { p1 } = await seed(repo);
    const good = await backupOf(repo);
    const bad = await rebuild(good, {
      mutateData: (d) => {
        d.images[0].productId = 'ghost';                                             // dangling product
        d.customFieldValues.find((v) => v.type === 'money').value = 'abc';          // not money
        d.customFieldValues.find((v) => v.type === 'date').value = '2025-02-31';    // no such date
        d.products.push({ ...d.products[0] });                                      // duplicate id
        d.customFieldDefinitions.find((f) => f.name === 'Colour').type = 'colour';                                // unknown type
        d.productTags.push({ productId: p1.id, tagId: 'nope' });                    // dangling tag
        d.categories.push({ ...d.categories.find((c) => c.name === 'Kitchen'), id: 'other-id' });                  // same name twice
      },
    });
    const text = await problemsOf(bad);
    for (const re of [/not in the backup/, /Enter an amount|not valid|expected form/, /date/i, /appears twice/, /valid field type|not valid/, /refers to something that is not in the backup/, /"Kitchen" appears twice/]) assert.ok(re.test(text), `${re} missing from: ${text}`);
    assert.ok((await read(bad)).problems.length >= 6, 'several problems in a single pass');
    assert.eq((await repo.listProducts()).length, 3);
  });
});

test('validate: a photo whose bytes are not an image, or a value on the wrong kind of owner, is rejected', async () => {
  await withRepo(async (repo) => {
    await seed(repo);
    const good = await backupOf(repo);
    const zip = await openZip(good);
    const imgName = [...zip.entries.keys()].find((n) => n.startsWith('images/'));
    const fake = await rebuild(good, { mutateData: () => {}, add: {} });
    const z2 = await openZip(fake); void z2;
    // replace the first photo's bytes with text, re-signed so only "not an image" remains
    const files = new Map(); for (const n of zip.entries.keys()) files.set(n, await readEntryBytes(zip, n));
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))); files.delete('manifest.json');
    files.set(imgName, new TextEncoder().encode('<script>alert(1)</script> definitely not a picture'));
    manifest.files = {}; for (const [n, b] of files) manifest.files[n] = { size: b.length, sha256: await sha256Hex(b) };
    const w = new ZipWriter(); await w.add('manifest.json', new TextEncoder().encode(JSON.stringify(manifest))); for (const [n, b] of files) await w.add(n, b);
    assert.ok(/not a supported image/.test(await problemsOf(asFile(w.finish()))));
    const wrongOwner = await rebuild(good, { mutateData: (d) => { const v = d.customFieldValues.find((x) => x.ownerType === 'image'); v.ownerType = 'product'; } });
    assert.ok(/does not apply to products/.test(await problemsOf(wrongOwner)));
  });
});

test('validate: unknown extra properties and __proto__ in data.json are never copied into the catalog', async () => {
  await withRepo(async (repo) => {
    await seed(repo);
    const hostile = await rebuild(await backupOf(repo), {
      mutateData: (d) => { d.products[0].isAdmin = true; d.products[0].blob = 'x'; d.images[0].extra = { evil: 1 }; return JSON.parse(JSON.stringify(d).replace('"products":[{', '"products":[{"__proto__":{"polluted":true},')); },
    });
    const r = await mustRead(hostile);
    assert.ok(({}).polluted === undefined, 'prototype was polluted');
    for (const p of r.data.products) assert.eq(Object.keys(p).sort(), ['createdAt', 'description', 'id', 'name', 'nameLower', 'notes', 'revision', 'sku', 'updatedAt']);
    for (const i of r.data.images) assert.ok(!('extra' in i) && !('file' in i), 'image record is clean');
  });
});

// ====================== scale ======================
test('performance: 300 products x 3 photos back up, validate and restore correctly (timings printed)', async () => {
  await withRepo(async (repo) => {
    const png = await makeImage(240, 180); const jpg = await makeImage(120, 90, 'image/jpeg');
    const price = await repo.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
    for (let i = 0; i < 300; i++) {
      const p = await repo.saveProduct({ name: `Product ${String(i).padStart(3, '0')}`, sku: `S${i}` }, {});
      for (let k = 0; k < 3; k++) {
        const im = await repo.addImage({ productId: p.id, blob: new Blob([png, new Uint8Array([i % 251, k])], { type: 'image/png' }), thumb: jpg, caption: `c${k}` });
        await repo.saveImageDetails(im.id, { values: [{ fieldId: price.id, value: String(i + k) }] });
      }
    }
    const t0 = performance.now();
    const { blob } = await buildBackup(await repo.getFullSnapshot());
    const t1 = performance.now();
    const parsed = await mustRead(asFile(blob));
    const t2 = performance.now();
    await withRepo(async (fresh) => {
      const r = await fresh.importBackup(parsed.data, 'skip');
      assert.eq([r.productsAdded, r.imagesAdded, r.valuesAdded], [300, 900, 900]);
      assert.eq((await fresh.dumpStore('images')).length, 900);
    });
    const t3 = performance.now();
    console.log(`PERF backup: ${(blob.size / 1048576).toFixed(1)} MB zip; export ${Math.round(t1 - t0)} ms, validate ${Math.round(t2 - t1)} ms, restore ${Math.round(t3 - t2)} ms`);
  });
});
