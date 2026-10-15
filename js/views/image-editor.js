// image-editor.js — one photo: caption, per-photo fields (e.g. Price), replace, reorder, delete.
import { h, clear } from '../dom.js';
import { fieldInput } from './shared.js';
import { pickImages, prepareImage, ObjectUrls } from '../image-service.js';

export async function imageEditorView(ctx, { productId, imageId }) {
  const { repo } = ctx;
  const graph = await repo.getProductGraph(productId);
  const back = `#/product/${encodeURIComponent(productId)}`;
  if (!graph) return missing('That product no longer exists.', '#/');
  let order = graph.images.map((i) => i.id);
  const image = graph.images.find((i) => i.id === imageId);
  if (!image) { ctx.toast('That photo no longer exists.', { error: true }); ctx.navigate(back, { replace: true }); return missing('That photo no longer exists.', back); }

  const defs = (await repo.listFieldDefinitions('image')).sort((a, b) => a.name.localeCompare(b.name));
  const valueByField = new Map((graph.imageValues[imageId] || []).map((v) => [v.fieldId, v.value]));
  const urls = new ObjectUrls();
  let revision = image.revision;
  let saving = false;
  let busy = false;

  const preview = h('img', { alt: image.caption || 'Photo', src: urls.for(image.blob), decoding: 'async' });
  const caption = h('textarea', { id: 'caption', maxlength: 2000 }, image.caption);
  const custom = defs.map((d) => ({ def: d, ...fieldInput(d, valueByField.get(d.id)) }));
  const snapshot = () => JSON.stringify([caption.value, custom.map((c) => c.getRaw())]);
  let baseline = snapshot();
  const isDirty = () => !saving && snapshot() !== baseline;

  const saveBtn = h('button', { type: 'submit' }, 'Save photo details');
  async function save(ev) {
    ev.preventDefault();
    if (saving) return;
    saving = true; saveBtn.disabled = true;
    try {
      const rec = await repo.saveImageDetails(imageId, { caption: caption.value, values: custom.map((c) => ({ fieldId: c.def.id, value: c.getRaw() })), expectedRevision: revision });
      revision = rec.revision; baseline = snapshot();
      ctx.toast('Saved');
    } catch (e) { ctx.showError(e); } finally { saving = false; saveBtn.disabled = false; }
  }

  async function refreshRevision() { const rec = await repo.getImage(imageId); if (rec) revision = rec.revision; }

  async function replace(camera) {
    if (busy) return;
    const files = await pickImages({ camera, multiple: false });
    if (!files.length) return;
    busy = true;
    try {
      const prepared = await prepareImage(files[0]);
      const rec = await repo.replaceImageBlob(imageId, { blob: prepared.blob, thumb: prepared.thumb });
      revision = rec.revision;
      urls.revokeAll(); preview.src = urls.for(rec.blob);
      ctx.toast('Photo replaced. Caption and details were kept.');
    } catch (e) { ctx.showError(e); } finally { busy = false; }
  }

  async function move(delta) {
    const i = order.indexOf(imageId), j = i + delta;
    if (j < 0 || j >= order.length || busy) return;
    busy = true;
    const next = order.slice(); [next[i], next[j]] = [next[j], next[i]];
    try { await repo.reorderImages(productId, next); order = next; await refreshRevision(); drawPager(); ctx.toast(`Moved to position ${j + 1}`); }
    catch (e) { ctx.showError(e); } finally { busy = false; }
  }

  async function remove() {
    if (!confirm('Delete this photo and its details? This cannot be undone.')) return;
    try {
      baseline = snapshot();
      await repo.deleteImage(imageId);
      ctx.toast('Photo deleted');
      ctx.navigate(back, { replace: true });
    } catch (e) { ctx.showError(e); }
  }

  const pager = h('div', { class: 'pager' });
  function drawPager() {
    clear(pager);
    const i = order.indexOf(imageId);
    const link = (idx, text) => (idx >= 0 && idx < order.length
      ? h('a', { class: 'btn secondary', href: `${back}/image/${order[idx]}` }, text) : h('span'));
    pager.append(link(i - 1, '← Previous'), h('span', { class: 'muted' }, `Photo ${i + 1} of ${order.length}`), link(i + 1, 'Next →'));
  }
  drawPager();

  const form = h('form', { novalidate: true, onsubmit: save },
    h('div', { class: 'field' }, h('label', { for: 'caption' }, 'Caption'), caption),
    custom.length ? h('fieldset', {}, h('legend', {}, 'Photo details'), custom.map((c) => c.el))
      : h('p', { class: 'hint' }, 'No per-photo fields yet. Add one (like Price) under Manage → Fields.'),
    h('div', { class: 'actions' }, saveBtn, h('a', { class: 'btn secondary', href: back }, 'Back to product')));

  const el = h('div', {},
    h('p', { class: 'crumbs' }, h('a', { href: back }, `← ${graph.product.name}`)),
    h('h1', {}, image.caption || 'Photo'),
    h('div', { class: 'photo-view' }, preview), pager,
    h('div', { class: 'panel' }, form),
    h('section', { 'aria-labelledby': 'tools-h' }, h('h2', { id: 'tools-h' }, 'Photo tools'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'secondary', onclick: () => replace(false) }, 'Replace photo'),
        h('button', { type: 'button', class: 'secondary', onclick: () => replace(true) }, 'Retake with camera'),
        h('button', { type: 'button', class: 'secondary', onclick: () => move(-1) }, 'Move earlier'),
        h('button', { type: 'button', class: 'secondary', onclick: () => move(1) }, 'Move later'),
        h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete photo'))));
  return { el, title: image.caption || 'Photo', isDirty, dispose() { urls.revokeAll(); } };

  function missing(msg, href) {
    return { title: 'Not found', el: h('div', { class: 'empty' }, h('h1', {}, 'Not found'), h('p', {}, msg), h('a', { class: 'btn', href }, 'Go back')) };
  }
}
