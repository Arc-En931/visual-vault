// manage.js — custom fields, categories, tags, and storage info.
import { h, clear, select } from '../dom.js';
import { FIELD_TYPES } from '../models.js';
import { getStorageEstimate, requestPersistentStorage } from '../db.js';
import { backupPanel } from './backup.js';

const TYPE_LABEL = { text: 'Text', number: 'Number', date: 'Date', boolean: 'Yes/No', money: 'Money' };
const SCOPE_LABEL = { product: 'Whole product', image: 'Each photo' };

export async function manageView(ctx, { tab }) {
  const body = h('div');
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Manage' },
    [['fields', 'Fields'], ['categories', 'Categories'], ['tags', 'Tags'], ['backup', 'Backup']].map(([k, t]) =>
      h('a', { href: `#/manage/${k}`, 'aria-current': k === tab ? 'page' : null }, t)));
  const el = h('div', {}, h('h1', {}, 'Manage'), tabs, body);
  await (tab === 'fields' ? fields(ctx, body) : tab === 'backup' ? backupPanel(ctx, body) : named(ctx, body, tab));
  if (tab === 'fields') body.append(await storagePanel());
  return { el, title: 'Manage' };
}

async function storagePanel() {
  const est = await getStorageEstimate();
  const mb = (n) => (n / 1048576 >= 100 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1)) + ' MB';
  const box = h('section', { class: 'panel' }, h('h2', {}, 'Storage'),
    h('p', {}, 'Everything is stored only on this device, in this browser. Clearing the browser\'s site data deletes it.'));
  if (est) {
    const persisted = h('span', {}, est.persisted === true ? 'Protected from automatic clean-up.' : est.persisted === false ? 'Not yet protected from automatic clean-up.' : '');
    box.append(h('p', {}, `Using ${mb(est.usage)} of about ${mb(est.quota)} available. `, persisted));
    if (est.persisted === false) {
      box.append(h('button', { type: 'button', class: 'secondary', onclick: async (e) => {
        const ok = await requestPersistentStorage();
        persisted.textContent = ok ? 'Protected from automatic clean-up.' : 'The browser did not grant protection (it decides based on how often you use the app).';
        e.target.remove();
      } }, 'Ask the browser to keep my data'));
    }
  }
  return box;
}

// ---------------- custom fields ----------------
async function fields(ctx, body) {
  const { repo } = ctx;
  async function draw() {
    clear(body);
    const defs = (await repo.listFieldDefinitions()).sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    const counts = new Map(await Promise.all(defs.map(async (d) => [d.id, await repo.countFieldValues(d.id)])));
    body.append(h('p', { class: 'muted' }, 'Fields add your own information to a product or to each photo, for example Price on each photo or Weight on the product.'));

    const ul = h('ul', { class: 'list' });
    if (!defs.length) ul.append(h('li', {}, h('span', { class: 'muted' }, 'No fields yet.')));
    for (const d of defs) ul.append(fieldRow(d, counts.get(d.id), draw));
    body.append(ul);

    const nameI = h('input', { id: 'nf-name', type: 'text', maxlength: 80, autocomplete: 'off' });
    const typeS = select(FIELD_TYPES.map((t) => [t, TYPE_LABEL[t]]), 'text', { id: 'nf-type' });
    const scopeS = select([['image', SCOPE_LABEL.image], ['product', SCOPE_LABEL.product]], 'image', { id: 'nf-scope' });
    const unitI = h('input', { id: 'nf-unit', type: 'text', maxlength: 20, placeholder: 'optional, e.g. kg', autocomplete: 'off' });
    const add = h('button', { type: 'submit' }, 'Add field');
    body.append(h('form', { class: 'panel', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault(); add.disabled = true;
      try { await repo.createFieldDefinition({ name: nameI.value, type: typeS.value, scope: scopeS.value, unit: unitI.value }); ctx.toast('Field added'); await draw(); }
      catch (e) { ctx.showError(e); add.disabled = false; }
    } }, h('h2', {}, 'New field'),
    h('div', { class: 'field' }, h('label', { for: 'nf-name' }, 'Name'), nameI),
    h('div', { class: 'field' }, h('label', { for: 'nf-type' }, 'Type'), typeS, h('p', { class: 'hint' }, 'Money keeps exact amounts with up to 2 decimals and no currency.')),
    h('div', { class: 'field' }, h('label', { for: 'nf-scope' }, 'Applies to'), scopeS),
    h('div', { class: 'field' }, h('label', { for: 'nf-unit' }, 'Unit'), unitI),
    add));
  }

  function fieldRow(d, count, redraw) {
    const li = h('li');
    const view = () => {
      clear(li);
      li.append(
        h('div', { class: 'info' }, h('strong', {}, d.name), h('div', { class: 'small muted' }, `${TYPE_LABEL[d.type]} · ${SCOPE_LABEL[d.scope]}${d.unit ? ' · ' + d.unit : ''} · used ${count} time${count === 1 ? '' : 's'}`)),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'secondary', onclick: edit }, 'Edit'),
          h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete')));
    };
    const edit = () => {
      clear(li);
      const nameI = h('input', { type: 'text', value: d.name, maxlength: 80, 'aria-label': 'Field name' });
      const unitI = h('input', { type: 'text', value: d.unit || '', maxlength: 20, 'aria-label': 'Unit' });
      const typeS = select(FIELD_TYPES.map((t) => [t, TYPE_LABEL[t]]), d.type, { 'aria-label': 'Field type' });
      const saveB = h('button', { type: 'submit' }, 'Save');
      li.append(h('form', { class: 'edit-form', novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault(); saveB.disabled = true;
        try {
          if (nameI.value !== d.name || unitI.value !== (d.unit || '')) await repo.updateFieldDefinition(d.id, { name: nameI.value, unit: unitI.value });
          if (typeS.value !== d.type && !(await changeType(d, typeS.value))) { saveB.disabled = false; return; }
          ctx.toast('Field updated'); await redraw();
        } catch (e) { ctx.showError(e); saveB.disabled = false; }
      } }, h('div', { class: 'grow' }, h('label', {}, 'Name'), nameI), h('div', {}, h('label', {}, 'Unit'), unitI), h('div', {}, h('label', {}, 'Type'), typeS), saveB,
      h('button', { type: 'button', class: 'secondary', onclick: view }, 'Cancel')));
      nameI.focus();
    };
    async function changeType(def, newType) {
      const dry = await repo.changeFieldType(def.id, newType, { dryRun: true });
      let acceptDataLoss = false;
      if (dry.lost > 0) {
        if (!confirm(`${dry.lost} of ${dry.total} existing values cannot be converted from ${TYPE_LABEL[dry.fromType]} to ${TYPE_LABEL[newType]} and will be DELETED. ${dry.convertible} will be kept. Continue?`)) return false;
        acceptDataLoss = true;
      } else if (dry.total > 0 && !confirm(`Convert ${dry.total} existing value${dry.total === 1 ? '' : 's'} from ${TYPE_LABEL[dry.fromType]} to ${TYPE_LABEL[newType]}? All can be converted.`)) return false;
      await repo.changeFieldType(def.id, newType, { acceptDataLoss });
      return true;
    }
    async function del() {
      if (!confirm(`Delete the field "${d.name}"${count ? ` and its ${count} saved value${count === 1 ? '' : 's'}` : ''}? Products and photos are not deleted. This cannot be undone.`)) return;
      try { await repo.deleteFieldDefinition(d.id); ctx.toast('Field deleted'); await redraw(); } catch (e) { ctx.showError(e); }
    }
    view();
    return li;
  }
  await draw();
}

// ---------------- categories & tags ----------------
async function named(ctx, body, kind) {
  const { repo } = ctx;
  const isCat = kind === 'categories';
  const one = isCat ? 'category' : 'tag';
  const api = isCat
    ? { list: () => repo.listCategories(), create: (n) => repo.createCategory(n), rename: (i, n) => repo.renameCategory(i, n), del: (i) => repo.deleteCategory(i), usage: (i) => repo.countCategoryUsage(i) }
    : { list: () => repo.listTags(), create: (n) => repo.createTag(n), rename: (i, n) => repo.renameTag(i, n), del: (i) => repo.deleteTag(i), usage: (i) => repo.countTagUsage(i) };

  async function draw() {
    clear(body);
    const items = (await api.list()).sort((a, b) => a.name.localeCompare(b.name));
    const used = new Map(await Promise.all(items.map(async (x) => [x.id, await api.usage(x.id)])));
    const ul = h('ul', { class: 'list' });
    if (!items.length) ul.append(h('li', {}, h('span', { class: 'muted' }, `No ${kind} yet.`)));
    for (const it of items) ul.append(row(it, used.get(it.id)));
    const nameI = h('input', { id: 'new-name', type: 'text', maxlength: 80, autocomplete: 'off' });
    const add = h('button', { type: 'submit' }, `Add ${one}`);
    body.append(ul, h('form', { class: 'panel', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault(); add.disabled = true;
      try { await api.create(nameI.value); ctx.toast(`${isCat ? 'Category' : 'Tag'} added`); await draw(); } catch (e) { ctx.showError(e); add.disabled = false; }
    } }, h('div', { class: 'field' }, h('label', { for: 'new-name' }, `New ${one}`), nameI), add));
  }

  function row(it, count) {
    const li = h('li');
    const view = () => {
      clear(li);
      li.append(h('div', { class: 'info' }, h('strong', {}, it.name), h('div', { class: 'small muted' }, `${count} product${count === 1 ? '' : 's'}`)),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: edit }, 'Rename'), h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete')));
    };
    const edit = () => {
      clear(li);
      const nameI = h('input', { type: 'text', value: it.name, maxlength: 80, 'aria-label': `New name for ${it.name}` });
      const saveB = h('button', { type: 'submit' }, 'Save');
      li.append(h('form', { class: 'edit-form', novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault(); saveB.disabled = true;
        try { await api.rename(it.id, nameI.value); ctx.toast('Renamed'); await draw(); } catch (e) { ctx.showError(e); saveB.disabled = false; }
      } }, h('div', { class: 'grow' }, nameI), saveB, h('button', { type: 'button', class: 'secondary', onclick: view }, 'Cancel')));
      nameI.focus();
    };
    async function del() {
      if (!confirm(`Delete the ${one} "${it.name}"${count ? ` and remove it from ${count} product${count === 1 ? '' : 's'}` : ''}? The products themselves are kept.`)) return;
      try { await api.del(it.id); ctx.toast(`${isCat ? 'Category' : 'Tag'} deleted`); await draw(); } catch (e) { ctx.showError(e); }
    }
    view();
    return li;
  }
  await draw();
}
