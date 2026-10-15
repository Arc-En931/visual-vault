// product-form.js — create/edit a product, its categories, tags, product-level fields, and its photos.
import { h, clear } from '../dom.js';
import { uuid, AppError } from '../models.js';
import { fieldInput } from './shared.js';
import { pickImages, importFiles, ObjectUrls } from '../image-service.js';

/** @param {*} ctx @param {{ id?: string }} params  (no id = a new product) */
export async function productFormView(ctx, { id }) {
  const { repo } = ctx;
  const isNew = !id;
  const productId = isNew ? uuid() : id;     // fixed for this screen: a double-tapped Save can never create two products
  const [defs, categories, tags] = await Promise.all([repo.listFieldDefinitions('product'), repo.listCategories(), repo.listTags()]);
  const graph = isNew ? null : await repo.getProductGraph(id);
  if (!isNew && !graph) {
    return { title: 'Not found', el: h('div', { class: 'empty' }, h('h1', {}, 'Product not found'), h('p', {}, 'It may have been deleted.'), h('a', { class: 'btn', href: '#/' }, 'Back to the catalog')) };
  }
  defs.sort((a, b) => a.name.localeCompare(b.name));
  const p = graph ? graph.product : { name: '', sku: '', description: '', notes: '' };
  const valueByField = new Map(graph ? graph.values.map((v) => [v.fieldId, v.value]) : []);
  const selCats = new Set(graph ? graph.categoryIds : []);
  const selTags = new Set(graph ? graph.tagIds : []);
  const urls = new ObjectUrls();
  let revision = graph ? graph.product.revision : undefined;
  let saving = false;
  let busyPhotos = false;

  // ----- basic fields -----
  const name = h('input', { id: 'name', type: 'text', value: p.name, maxlength: 200, autocomplete: 'off', required: true });
  const sku = h('input', { id: 'sku', type: 'text', value: p.sku, maxlength: 100, autocomplete: 'off' });
  const description = h('textarea', { id: 'description', maxlength: 10000 }, p.description);
  const notes = h('textarea', { id: 'notes', maxlength: 10000 }, p.notes);
  const custom = defs.map((d) => ({ def: d, ...fieldInput(d, valueByField.get(d.id)) }));

  // ----- categories & tags -----
  function picker(label, singular, items, selected, create) {
    const chips = h('div', { class: 'chips' });
    const newInput = h('input', { type: 'text', placeholder: `New ${singular}`, maxlength: 80, 'aria-label': `New ${singular} name`, autocomplete: 'off' });
    const addBtn = h('button', { type: 'button', class: 'secondary' }, 'Add');
    const draw = () => {
      clear(chips);
      if (!items.length) chips.append(h('span', { class: 'muted small' }, `No ${label.toLowerCase()} yet. Add one below.`));
      for (const it of items) {
        const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(selected.has(it.id)) }, it.name);
        b.addEventListener('click', () => { if (selected.has(it.id)) selected.delete(it.id); else selected.add(it.id); b.setAttribute('aria-pressed', String(selected.has(it.id))); });
        chips.append(b);
      }
    };
    addBtn.addEventListener('click', async () => {
      const text = newInput.value.trim();
      if (!text) return;
      addBtn.disabled = true;
      try {
        let rec;
        try { rec = await create(text); items.push(rec); items.sort((a, b) => a.name.localeCompare(b.name)); }
        catch (e) {
          if (e instanceof AppError && e.code === 'DUPLICATE') {
            rec = items.find((x) => x.name.toLowerCase() === text.toLowerCase());
            if (!rec) throw e;
            ctx.toast(`"${rec.name}" already exists, so it was selected.`);
          } else throw e;
        }
        selected.add(rec.id); newInput.value = ''; draw();
      } catch (e) { ctx.showError(e); } finally { addBtn.disabled = false; }
    });
    newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
    draw();
    return h('fieldset', {}, h('legend', {}, label), chips, h('div', { class: 'row', style: 'margin-top:.5rem' }, h('div', { class: 'grow' }, newInput), addBtn));
  }

  // ----- dirty tracking -----
  const snapshot = () => JSON.stringify([name.value, sku.value, description.value, notes.value, [...selCats].sort(), [...selTags].sort(), custom.map((c) => c.getRaw())]);
  let baseline = snapshot();
  const isDirty = () => !saving && snapshot() !== baseline;

  // ----- save / delete -----
  const saveBtn = h('button', { type: 'submit' }, isNew ? 'Save product' : 'Save changes');
  async function save(ev) {
    ev.preventDefault();
    if (saving) return;
    saving = true; saveBtn.disabled = true;
    try {
      await repo.saveProduct(
        { id: productId, name: name.value, sku: sku.value, description: description.value, notes: notes.value },
        { categoryIds: [...selCats], tagIds: [...selTags], values: custom.map((c) => ({ fieldId: c.def.id, value: c.getRaw() })), expectedRevision: revision });
      baseline = snapshot();
      ctx.toast('Saved');
      if (isNew) ctx.navigate(`#/product/${productId}`, { replace: true }); else await ctx.refresh();
    } catch (e) {
      ctx.showError(e);
      if (!name.value.trim()) name.focus();
    } finally { saving = false; saveBtn.disabled = false; }
  }

  async function remove() {
    const n = graph.images.length;
    if (!confirm(`Delete "${p.name}"${n ? ` and its ${n} photo${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return;
    try {
      baseline = snapshot();
      await repo.deleteProduct(productId);
      ctx.toast('Product deleted');
      ctx.navigate('#/');
    } catch (e) { ctx.showError(e); }
  }

  // ----- photos -----
  const photoStatus = h('p', { class: 'status', role: 'status' });
  const photoGrid = h('div');
  const addBtns = [];
  async function drawPhotos() {
    urls.revokeAll(); clear(photoGrid);
    const images = await repo.listImages(productId);
    if (!images.length) { photoGrid.append(h('p', { class: 'muted' }, 'No photos yet.')); return; }
    const ul = h('ul', { class: 'photos' });
    images.forEach((im, i) => {
      ul.append(h('li', {}, h('a', { href: `#/product/${productId}/image/${im.id}`, 'aria-label': `Photo ${i + 1}${im.caption ? ': ' + im.caption : ''}` },
        h('div', { class: 'thumb' }, h('img', { alt: im.caption || `Photo ${i + 1}`, src: urls.for(im.thumb || im.blob), decoding: 'async' })),
        h('div', { class: 'cap' }, im.caption || h('span', { class: 'muted' }, 'No caption')))));
    });
    photoGrid.append(ul);
  }
  async function addPhotos(camera) {
    if (busyPhotos) return;
    const files = await pickImages({ camera });
    if (!files.length) return;
    busyPhotos = true; addBtns.forEach((b) => { b.disabled = true; });
    try {
      const r = await importFiles(files, (prepared) => repo.addImage({ productId, blob: prepared.blob, thumb: prepared.thumb, caption: '' }),
        { onProgress: (i, n) => { photoStatus.textContent = `Adding photo ${i} of ${n}…`; } });
      photoStatus.textContent = '';
      if (r.saved) ctx.toast(`${r.saved} photo${r.saved === 1 ? '' : 's'} added`);
      if (r.failed.length) {
        const first = r.failed.slice(0, 3).map((f) => f.message).join(' ');
        ctx.toast(`${r.failed.length} photo${r.failed.length === 1 ? '' : 's'} not added. ${first}${r.failed.length > 3 ? ' …' : ''}`, { error: true });
      }
      await drawPhotos();
    } catch (e) { ctx.showError(e); } finally { busyPhotos = false; addBtns.forEach((b) => { b.disabled = false; }); photoStatus.textContent = ''; }
  }

  let photosSection;
  if (isNew) {
    photosSection = h('section', { class: 'panel' }, h('h2', {}, 'Photos'), h('p', { class: 'muted' }, 'Save the product first, then add photos, prices and captions.'));
  } else {
    const gallery = h('button', { type: 'button', class: 'secondary', onclick: () => addPhotos(false) }, 'Add photos');
    const camera = h('button', { type: 'button', class: 'secondary', onclick: () => addPhotos(true) }, 'Take photo');
    addBtns.push(gallery, camera);
    photosSection = h('section', { 'aria-labelledby': 'photos-h' }, h('h2', { id: 'photos-h' }, 'Photos'), photoGrid, photoStatus, h('div', { class: 'row' }, gallery, camera));
    drawPhotos().catch(ctx.showError);
  }

  const form = h('form', { novalidate: true, onsubmit: save },
    h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), name),
    h('div', { class: 'field' }, h('label', { for: 'sku' }, 'SKU or code'), sku),
    h('div', { class: 'field' }, h('label', { for: 'description' }, 'Description'), description),
    h('div', { class: 'field' }, h('label', { for: 'notes' }, 'Notes'), notes),
    picker('Categories', 'category', categories, selCats, (t) => repo.createCategory(t)),
    picker('Tags', 'tag', tags, selTags, (t) => repo.createTag(t)),
    custom.length ? h('fieldset', {}, h('legend', {}, 'Product details'), custom.map((c) => c.el)) : null,
    h('div', { class: 'actions' }, saveBtn, h('a', { class: 'btn secondary', href: '#/' }, 'Cancel'),
      isNew ? null : h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete product')));

  const el = h('div', {},
    h('p', { class: 'crumbs' }, h('a', { href: '#/' }, '← Catalog')),
    h('h1', {}, isNew ? 'New product' : p.name),
    isNew ? null : photosSection,
    isNew ? null : h('h2', {}, 'Details'),
    h('div', { class: 'panel' }, form),
    isNew ? photosSection : null,
    defs.length === 0 ? null : h('p', { class: 'hint' }, 'Fields that apply to each photo (like Price) are edited on the photo.'));
  return { el, title: isNew ? 'New product' : p.name, isDirty, focus: () => { if (isNew) name.focus(); }, dispose() { urls.revokeAll(); } };
}
