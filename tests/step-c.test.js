import { test, assert } from './harness.js';
import { openDatabase, deleteDatabase } from '../js/db.js';
import { Repository } from '../js/repository.js';
import { uuid } from '../js/models.js';
import {
  sniffType, validateImageFile, prepareImage, importFiles, ObjectUrls, THUMB_EDGE,
} from '../js/image-service.js';
import {
  buildIndex, search, compileFieldFilters, summarizeFields, fold, tokenize,
} from '../js/search-service.js';

async function withRepo(fn) {
  const name = 'vv-test-' + uuid();
  const repo = new Repository(await openDatabase(name));
  try { await fn(repo); } finally { repo.close(); await deleteDatabase(name); }
}

// ---------- image fixtures (real encoded images made in the browser) ----------
async function makeImage(w, h, type = 'image/png', color = '#3366cc') {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, Math.ceil(w / 4), Math.ceil(h / 4));
  return c.convertToBlob({ type });
}
const asFile = (blob, name, type = blob.type) => new File([blob], name, { type });
async function dims(blob) { const b = await createImageBitmap(blob); const d = { w: b.width, h: b.height }; b.close(); return d; }

/** Insert an EXIF "Orientation = 6" (rotate 90° clockwise) segment right after the JPEG SOI marker. */
async function withExifOrientation6(jpeg) {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const exif = Uint8Array.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,       // APP1 "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,                   // TIFF big-endian header, IFD at 8
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // 1 entry: Orientation=6
    0x00, 0x00, 0x00, 0x00,                                            // no next IFD
  ]);
  const out = new Uint8Array(bytes.length + exif.length);
  out.set(bytes.slice(0, 2), 0); out.set(exif, 2); out.set(bytes.slice(2), 2 + exif.length);
  return new Blob([out], { type: 'image/jpeg' });
}

// ====================== image-service ======================
test('image: file type is detected from real bytes (png, jpeg, webp, gif) and text is rejected', async () => {
  assert.eq(await sniffType(await makeImage(8, 8, 'image/png')), 'image/png');
  assert.eq(await sniffType(await makeImage(8, 8, 'image/jpeg')), 'image/jpeg');
  assert.eq(await sniffType(await makeImage(8, 8, 'image/webp')), 'image/webp');
  assert.eq(await sniffType(new Blob([Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])])), 'image/gif');
  assert.eq(await sniffType(new Blob(['hello world, not an image'])), null);
});

test('image: validation rejects empty, oversized, fake-extension and HEIC files with clear messages', async () => {
  const e1 = await assert.rejects(validateImageFile(new File([], 'empty.png', { type: 'image/png' })), 'VALIDATION');
  assert.ok(/empty/.test(e1.message) && e1.message.includes('empty.png'), e1.message);
  const big = asFile(await makeImage(64, 64), 'big.png');
  const e2 = await assert.rejects(validateImageFile(big, { maxBytes: 100 }), 'VALIDATION');
  assert.ok(/limit/.test(e2.message), e2.message);
  const e3 = await assert.rejects(validateImageFile(new File(['just text'], 'fake.png', { type: 'image/png' })), 'VALIDATION');
  assert.ok(/not a supported image/.test(e3.message), e3.message);
  const heic = new Uint8Array(16); heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  const e4 = await assert.rejects(validateImageFile(new File([heic], 'IMG_1.HEIC', { type: 'image/heic' })), 'VALIDATION');
  assert.ok(/HEIC/.test(e4.message), e4.message);
});

test('image: wrong or empty MIME type from the phone is corrected from the real bytes', async () => {
  const png = await makeImage(32, 32, 'image/png');
  const { blob, type } = await validateImageFile(new File([png], 'camera.jpg', { type: '' }));
  assert.eq(type, 'image/png');
  assert.eq(blob.type, 'image/png');
  assert.eq(blob.size, png.size);
});

test('image: prepareImage keeps the original bytes and makes a thumbnail within the size limit', async () => {
  const original = await makeImage(1200, 600, 'image/png');
  const p = await prepareImage(asFile(original, 'wide.png'));
  assert.eq({ w: p.width, h: p.height }, { w: 1200, h: 600 });
  assert.eq(p.blob.size, original.size, 'original must not be recompressed');
  const t = await dims(p.thumb);
  assert.eq(t.w, THUMB_EDGE, 'long edge scaled to the thumbnail size');
  assert.eq(t.h, 180);
  assert.ok(p.thumb.size < original.size || p.thumb.size < 20000, 'thumbnail should be small');
});

test('image: small images are not upscaled', async () => {
  const p = await prepareImage(asFile(await makeImage(100, 50), 'tiny.png'));
  assert.eq(await dims(p.thumb), { w: 100, h: 50 });
});

test('image: a damaged image (valid header, garbage body) is rejected, not stored', async () => {
  const good = new Uint8Array(await (await makeImage(40, 40)).arrayBuffer());
  const damaged = good.slice(0, 40); // cut off in the middle of the PNG
  const e = await assert.rejects(prepareImage(new File([damaged], 'cut.png', { type: 'image/png' })), 'VALIDATION');
  assert.ok(/damaged/.test(e.message), e.message);
});

test('image: phone photos with EXIF rotation get an upright thumbnail and correct dimensions', async () => {
  const landscapeJpeg = await makeImage(200, 100, 'image/jpeg');
  const rotated = await withExifOrientation6(landscapeJpeg);
  const p = await prepareImage(asFile(rotated, 'IMG_0001.jpg'));
  assert.eq({ w: p.width, h: p.height }, { w: 100, h: 200 }, 'dimensions after applying rotation');
  const t = await dims(p.thumb);
  assert.ok(t.h > t.w, `thumbnail should be portrait, got ${t.w}x${t.h}`);
});

test('image: importFiles saves good files, reports bad ones by name, and one bad file does not block the rest', async () => {
  const files = [
    asFile(await makeImage(30, 30), 'a.png'),
    new File(['not an image'], 'b.png', { type: 'image/png' }),
    asFile(await makeImage(30, 30, 'image/jpeg'), 'c.jpg'),
  ];
  const saved = [];
  const progress = [];
  const r = await importFiles(files, async (prepared, f) => { saved.push(f.name); }, { onProgress: (i, n) => progress.push(`${i}/${n}`) });
  assert.eq(r.saved, 2);
  assert.eq(saved, ['a.png', 'c.jpg']);
  assert.eq(r.failed.length, 1);
  assert.eq(r.failed[0].name, 'b.png');
  assert.eq(progress, ['1/3', '2/3', '3/3']);
});

test('image: importFiles stops at the first storage-full error instead of failing every file', async () => {
  const files = [asFile(await makeImage(20, 20), '1.png'), asFile(await makeImage(20, 20), '2.png'), asFile(await makeImage(20, 20), '3.png')];
  let calls = 0;
  const r = await importFiles(files, async () => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('Not enough storage space'), { code: 'QUOTA' });
  });
  assert.eq(r.saved, 1);
  assert.eq(calls, 2, 'third file must not be attempted');
  assert.eq(r.failed.length, 1);
});

test('image: ObjectUrls revokes every URL it created', async () => {
  const urls = new ObjectUrls();
  const a = urls.for(new Blob(['a'])), b = urls.for(new Blob(['b']));
  assert.eq(urls.size, 2);
  assert.ok((await fetch(a)).ok, 'URL works before revoking');
  urls.revoke(a);
  assert.eq(urls.size, 1);
  urls.revokeAll();
  assert.eq(urls.size, 0);
  let failed = false;
  try { await fetch(b); } catch { failed = true; }
  assert.ok(failed, 'revoked URL must no longer load');
});

test('image: stored image + thumbnail round-trip through the repository', async () => {
  await withRepo(async (repo) => {
    const p = await repo.createProduct({ name: 'Round trip' });
    const prepared = await prepareImage(asFile(await makeImage(500, 300), 'x.png'));
    const rec = await repo.addImage({ productId: p.id, blob: prepared.blob, thumb: prepared.thumb, caption: 'x' });
    const got = await repo.getImage(rec.id);
    assert.eq(got.blob.size, prepared.blob.size);
    assert.eq(await dims(got.thumb), { w: THUMB_EDGE, h: 216 });
    assert.eq(await dims(got.blob), { w: 500, h: 300 });
  });
});

// ====================== search-service ======================
const tick = () => new Promise((r) => setTimeout(r, 6));

/** The shared catalog used by the search tests (built through the real repository). */
async function buildCatalog(repo) {
  const price = await repo.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
  const weight = await repo.createFieldDefinition({ name: 'Weight', type: 'number', scope: 'product', unit: 'kg' });
  const released = await repo.createFieldDefinition({ name: 'Released', type: 'date', scope: 'product' });
  const fragile = await repo.createFieldDefinition({ name: 'Fragile', type: 'boolean', scope: 'product' });
  const kitchen = await repo.createCategory('Kitchen');
  const office = await repo.createCategory('Office');
  const metal = await repo.createTag('Metal');
  const sale = await repo.createTag('Sale');
  const ceramic = await repo.createTag('Ceramic');
  const png = () => new Blob(['px'], { type: 'image/png' });

  const steel = await repo.saveProduct({ name: 'Steel cup', sku: 'SC-1', description: 'Insulated travel mug', notes: 'dishwasher safe' },
    { categoryIds: [kitchen.id], tagIds: [metal.id, sale.id] });
  const imgs = {};
  for (const [key, caption, p] of [['small', 'Small cup', 20], ['medium', 'Medium cup', 100], ['large', 'Large cup', 500]]) {
    const im = await repo.addImage({ productId: steel.id, blob: png(), caption });
    await repo.setValue('image', im.id, price.id, p);
    imgs[key] = im.id;
  }
  await tick();
  const mug = await repo.saveProduct({ name: 'Café mug', description: 'Hand made' },
    { categoryIds: [kitchen.id], tagIds: [ceramic.id], values: [{ fieldId: fragile.id, value: 'true' }] });
  const mugImg = await repo.addImage({ productId: mug.id, blob: png(), caption: 'Blue glaze' });
  await repo.setValue('image', mugImg.id, price.id, '15.5');
  await tick();
  const lamp = await repo.saveProduct({ name: 'Desk lamp' }, {
    categoryIds: [office.id],
    values: [{ fieldId: weight.id, value: '1.5' }, { fieldId: released.id, value: '2024-05-01' }, { fieldId: fragile.id, value: 'false' }],
  });
  await tick();
  const notebook = await repo.saveProduct({ name: 'Notebook' });
  await tick();
  const flask = await repo.saveProduct({ name: 'Travel flask', description: 'fits any cup holder' });
  return { price, weight, released, fragile, kitchen, office, metal, sale, ceramic, steel, imgs, mug, mugImg, lamp, notebook, flask };
}
const loadIndex = async (repo) => buildIndex(await repo.getCatalogSnapshot());
const names = (r) => r.results.map((x) => x.product.name);
const filtersFor = (index, rows) => compileFieldFilters(index.defs, rows);

test('snapshot: contains all records, with image metadata but no image data', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const snap = await repo.getCatalogSnapshot();
    assert.eq(snap.products.length, 5);
    assert.eq(snap.images.length, 4);
    assert.ok(snap.images.every((i) => !('blob' in i) && !('thumb' in i)), 'no blobs in snapshot');
    assert.eq(snap.fieldDefinitions.length, 4);
    assert.eq(snap.categories.length, 2);
    assert.eq(snap.tags.length, 3);
    assert.ok(snap.values.some((v) => v.ownerId === c.imgs.medium && v.value === 10000));
  });
});

test('search helpers: fold and tokenize ignore case and accents', () => {
  assert.eq(fold('CAFÉ Crème'), 'cafe creme');
  assert.eq(tokenize('  Steel   CUP '), ['steel', 'cup']);
});

test('search: empty query lists everything sorted by name', async () => {
  await withRepo(async (repo) => {
    await buildCatalog(repo);
    const r = search(await loadIndex(repo), {});
    assert.eq(names(r), ['Café mug', 'Desk lamp', 'Notebook', 'Steel cup', 'Travel flask']);
    assert.eq(r.total, 5);
  });
});

test('search: partial, case-insensitive and accent-insensitive', async () => {
  await withRepo(async (repo) => {
    await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { query: 'STE' })), ['Steel cup']);
    assert.eq(names(search(idx, { query: 'cafe' })), ['Café mug']);
    assert.eq(names(search(idx, { query: 'CAFÉ' })), ['Café mug']);
    assert.eq(names(search(idx, { query: 'ee' })), ['Steel cup']);
  });
});

test('search: matches SKU, description, notes, categories, tags', async () => {
  await withRepo(async (repo) => {
    await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { query: 'sc-1' })), ['Steel cup']);
    assert.eq(names(search(idx, { query: 'insulated' })), ['Steel cup']);
    assert.eq(names(search(idx, { query: 'dishwasher' })), ['Steel cup']);
    assert.eq(names(search(idx, { query: 'office' })), ['Desk lamp']);
    assert.eq(names(search(idx, { query: 'ceram' })), ['Café mug']);
    const r = search(idx, { query: 'metal' });
    assert.eq(r.results[0].matchedIn, ['tag']);
  });
});

test('search: every word must match (AND); unknown word returns nothing', async () => {
  await withRepo(async (repo) => {
    await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { query: 'steel kitchen' })), ['Steel cup']);
    assert.eq(names(search(idx, { query: 'steel zzz' })), []);
    assert.eq(names(search(idx, { query: 'kitchen' })), ['Café mug', 'Steel cup']);
  });
});

test('search: image captions match and deep-link to the right image', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    let r = search(idx, { query: 'medium' });
    assert.eq(names(r), ['Steel cup']);
    assert.eq(r.results[0].matchedImageIds, [c.imgs.medium]);
    assert.ok(r.results[0].matchedIn.includes('caption'));
    r = search(idx, { query: 'steel medium' });
    assert.eq(r.results[0].matchedImageIds, [c.imgs.medium], 'product words + image word still points at the one image');
    r = search(idx, { query: 'cup' });
    assert.eq(r.results[0].product.name, 'Steel cup');
    assert.eq(r.results[0].matchedImageIds.length, 3, 'all three captions contain "cup"');
    r = search(idx, { query: 'steel' });
    assert.eq(r.results[0].matchedImageIds, [], 'a product-level match does not pick images');
  });
});

test('search: custom field names and values are searchable, money by its shown amount', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { query: 'weight' })), ['Desk lamp']);
    assert.eq(names(search(idx, { query: '1.5' })), ['Desk lamp']);
    let r = search(idx, { query: '100.00' });
    assert.eq(names(r), ['Steel cup']);
    assert.eq(r.results[0].matchedImageIds, [c.imgs.medium]);
    r = search(idx, { query: '500' });
    assert.eq(r.results[0].matchedImageIds, [c.imgs.large]);
    r = search(idx, { query: 'price 15.50' });
    assert.eq(names(r), ['Café mug']);
    assert.eq(r.results[0].matchedImageIds, [c.mugImg.id]);
    assert.eq(names(search(idx, { query: 'kg' })), ['Desk lamp']);
  });
});

test('search: relevance puts name matches ahead of description-only matches', async () => {
  await withRepo(async (repo) => {
    await buildCatalog(repo);
    const r = search(await loadIndex(repo), { query: 'cup' });
    assert.eq(names(r), ['Steel cup', 'Travel flask']);
  });
});

test('search: category and tag filters, match any vs all', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { categoryIds: [c.kitchen.id] })), ['Café mug', 'Steel cup']);
    assert.eq(names(search(idx, { categoryIds: [c.kitchen.id, c.office.id] })), ['Café mug', 'Desk lamp', 'Steel cup']);
    assert.eq(names(search(idx, { categoryIds: [c.kitchen.id, c.office.id], match: 'all' })), []);
    assert.eq(names(search(idx, { tagIds: [c.metal.id, c.ceramic.id] })), ['Café mug', 'Steel cup']);
    assert.eq(names(search(idx, { tagIds: [c.metal.id, c.sale.id], match: 'all' })), ['Steel cup']);
    assert.eq(names(search(idx, { tagIds: [c.metal.id, c.ceramic.id], match: 'all' })), []);
    assert.eq(names(search(idx, { query: 'cup', categoryIds: [c.office.id] })), []);
  });
});

test('Steel cup scenario: price filter finds the right images (small 20 / medium 100 / large 500)', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    let r = search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.price.id, min: '100', max: '500' }]) });
    assert.eq(names(r), ['Steel cup']);
    assert.eq(r.results[0].matchedImageIds, [c.imgs.medium, c.imgs.large]);
    r = search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.price.id, min: '101', max: '499' }]) });
    assert.eq(names(r), [], 'no image priced between 101 and 499');
    r = search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.price.id, max: '20' }]) });
    assert.eq(names(r), ['Café mug', 'Steel cup']);
    assert.eq(r.results.find((x) => x.product.name === 'Steel cup').matchedImageIds, [c.imgs.small]);
    r = search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.price.id, min: '600' }]) });
    assert.eq(names(r), []);
    r = search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.price.id, min: '15.50', max: '15.50' }]) });
    assert.eq(names(r), ['Café mug'], 'exact amount with decimals, integer-cents comparison');
  });
});

test('search: text + price filter combine; "steel" with min 400 points to the large image', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    const f = filtersFor(idx, [{ fieldId: c.price.id, min: '400' }]);
    let r = search(idx, { query: 'steel', fieldFilters: f });
    assert.eq(names(r), ['Steel cup']);
    assert.eq(r.results[0].matchedImageIds, [c.imgs.large]);
    r = search(idx, { query: 'cafe', fieldFilters: f });
    assert.eq(names(r), [], 'Café mug (15.50) fails the price filter');
    r = search(idx, { query: 'medium', fieldFilters: f });
    assert.eq(names(r), ['Steel cup']);
    assert.eq(r.results[0].matchedImageIds, [c.imgs.large], 'filter images win when the caption image does not fit the filter');
  });
});

test('search: product-level number, date and yes/no filters', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.weight.id, min: '1', max: '2' }]) })), ['Desk lamp']);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.weight.id, min: '1.6' }]) })), []);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.released.id, min: '2024-01-01' }]) })), ['Desk lamp']);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.released.id, max: '2023-12-31' }]) })), []);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.fragile.id, equals: 'true' }]) })), ['Café mug']);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.fragile.id, equals: 'false' }]) })), ['Desk lamp']);
    assert.eq(names(search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.weight.id, min: '1' }, { fieldId: c.released.id, min: '2025-01-01' }]) })), [], 'two filters are ANDed');
  });
});

test('search: bad filter input is rejected with a field-specific message', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    for (const [row, re] of [
      [{ fieldId: c.price.id, min: 'abc' }, /Price minimum/],
      [{ fieldId: c.price.id, max: '1.234' }, /Price maximum/],
      [{ fieldId: c.price.id, min: '50', max: '10' }, /minimum is higher/],
      [{ fieldId: c.released.id, min: '2024-13-01' }, /Released minimum/],
    ]) {
      let err = null;
      try { compileFieldFilters(idx.defs, [row]); } catch (e) { err = e; }
      assert.ok(err && err.code === 'VALIDATION' && re.test(err.message), JSON.stringify(row) + ' -> ' + (err && err.message));
    }
    assert.eq(compileFieldFilters(idx.defs, [{ fieldId: c.price.id, min: '', max: '  ' }]), [], 'blank bounds are ignored');
  });
});

test('search: sorting by name, by price (asc/desc, empties last) and by last updated', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { sort: { by: 'name', direction: 'desc' } })), ['Travel flask', 'Steel cup', 'Notebook', 'Desk lamp', 'Café mug']);
    assert.eq(names(search(idx, { sort: { by: 'field', fieldId: c.price.id, direction: 'asc' } })),
      ['Café mug', 'Steel cup', 'Desk lamp', 'Notebook', 'Travel flask']);
    assert.eq(names(search(idx, { sort: { by: 'field', fieldId: c.price.id, direction: 'desc' } })),
      ['Steel cup', 'Café mug', 'Desk lamp', 'Notebook', 'Travel flask']);
    await tick();
    await repo.updateProduct(c.notebook.id, { notes: 'edited' });
    const idx2 = await loadIndex(repo);
    assert.eq(names(search(idx2, { sort: { by: 'updated', direction: 'desc' } }))[0], 'Notebook');
    assert.eq(names(search(idx2, { sort: { by: 'created', direction: 'asc' } }))[0], 'Steel cup');
  });
});

test('search: editing the medium price changes only that image; index reflects the new value', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    await repo.setValue('image', c.imgs.medium, c.price.id, '150');
    const idx = await loadIndex(repo);
    const r = search(idx, { fieldFilters: filtersFor(idx, [{ fieldId: c.price.id, min: '100', max: '200' }]) });
    assert.eq(r.results[0].matchedImageIds, [c.imgs.medium]);
    assert.eq(names(search(idx, { query: '100.00' })), [], 'old price no longer searchable');
    assert.eq(summarizeFields(r.results[0].entry), [{ name: 'Price', text: '20.00–500.00' }]);
  });
});

test('search: result summaries show price ranges and number units', async () => {
  await withRepo(async (repo) => {
    await buildCatalog(repo);
    const idx = await loadIndex(repo);
    const byName = Object.fromEntries(idx.entries.map((e) => [e.product.name, e]));
    assert.eq(summarizeFields(byName['Steel cup']), [{ name: 'Price', text: '20.00–500.00' }]);
    assert.eq(summarizeFields(byName['Café mug']), [{ name: 'Price', text: '15.50' }]);
    assert.eq(summarizeFields(byName['Desk lamp']), [{ name: 'Weight', text: '1.5 kg' }]);
    assert.eq(summarizeFields(byName['Notebook']), []);
  });
});

test('search: deleting a product, field, category or tag is reflected in results', async () => {
  await withRepo(async (repo) => {
    const c = await buildCatalog(repo);
    await repo.deleteProduct(c.steel.id);
    await repo.deleteCategory(c.office.id);
    await repo.deleteTag(c.ceramic.id);
    await repo.deleteFieldDefinition(c.weight.id);
    const idx = await loadIndex(repo);
    assert.eq(names(search(idx, { query: 'steel' })), []);
    assert.eq(names(search(idx, { query: 'office' })), []);
    assert.eq(names(search(idx, { query: 'ceramic' })), []);
    assert.eq(names(search(idx, { query: 'weight' })), []);
    assert.eq(names(search(idx, { query: 'glaze' })), ['Café mug']);
  });
});

test('performance: 3000 products x 3 images search in memory (timing printed)', async () => {
  const products = [], images = [], values = [];
  for (let i = 0; i < 3000; i++) {
    const id = 'p' + i;
    products.push({ id, name: `Product ${i} ${i % 7 ? 'widget' : 'gadget'}`, nameLower: '', description: 'Some description text '.repeat(5), notes: '', sku: 'SKU-' + i, createdAt: i, updatedAt: i, revision: 1 });
    for (let k = 0; k < 3; k++) {
      images.push({ id: `${id}-i${k}`, productId: id, caption: `Photo ${k} of ${i}`, position: k, hasThumb: true });
      values.push({ id: `${id}-v${k}`, ownerType: 'image', ownerId: `${id}-i${k}`, fieldId: 'price', value: (i + k) * 100, numeric: (i + k) * 100 });
    }
  }
  const snap = {
    products, images, values, categories: [], tags: [], productCategories: [], productTags: [],
    fieldDefinitions: [{ id: 'price', name: 'Price', type: 'money', scope: 'image', unit: '' }],
  };
  const t0 = performance.now();
  const idx = buildIndex(snap);
  const t1 = performance.now();
  const r = search(idx, { query: 'gadget photo 2' });
  const t2 = performance.now();
  const f = search(idx, { fieldFilters: compileFieldFilters(idx.defs, [{ fieldId: 'price', min: '1000', max: '2000' }]), sort: { by: 'field', fieldId: 'price', direction: 'desc' } });
  const t3 = performance.now();
  console.log(`PERF index-build ${Math.round(t1 - t0)}ms, text-search ${Math.round(t2 - t1)}ms (${r.total} hits), filter+sort ${Math.round(t3 - t2)}ms (${f.total} hits)`);
  assert.ok(r.total > 0 && f.total > 0);
  assert.ok(t1 - t0 < 3000 && t2 - t1 < 1000 && t3 - t2 < 1000, 'too slow');
});

test('performance: snapshot of 150 products x 3 real images from IndexedDB (timing printed)', async () => {
  await withRepo(async (repo) => {
    const png = await makeImage(40, 40);
    for (let i = 0; i < 150; i++) {
      const p = await repo.createProduct({ name: 'Item ' + i });
      for (let k = 0; k < 3; k++) await repo.addImage({ productId: p.id, blob: png, thumb: png, caption: `c${k}` });
    }
    const t0 = performance.now();
    const snap = await repo.getCatalogSnapshot();
    const t1 = performance.now();
    console.log(`PERF snapshot(150 products, 450 images) ${Math.round(t1 - t0)}ms`);
    assert.eq(snap.images.length, 450);
    assert.ok(t1 - t0 < 3000);
  });
});
