// backup.js (view) — "Backup" tab: download a backup ZIP, check a backup file, restore it.
import { h, clear } from '../dom.js';
import { toAppError } from '../models.js';
import { buildBackup, readBackup, backupFileName } from '../backup.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'unknown date' : d.toLocaleString(); };

export async function backupPanel(ctx, body) {
  const { repo } = ctx;
  clear(body);
  let busy = false;

  // ---------------- export ----------------
  const last = await repo.getSetting('lastBackupAt', null);
  const exportStatus = h('p', { id: 'backup-status', role: 'status' });
  const exportBtn = h('button', { type: 'button', id: 'backup-download' }, 'Download backup');
  const lastLine = h('p', {}, last ? `Last backup downloaded: ${when(last)}.` : 'You have not downloaded a backup yet.');
  exportBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true; exportBtn.disabled = true; fileInput.disabled = true;
    try {
      exportStatus.textContent = 'Reading your catalog…';
      const snapshot = await repo.getFullSnapshot();
      const { blob, counts, createdAt } = await buildBackup(snapshot, { onProgress: (n, total) => { exportStatus.textContent = `Checking files ${n} of ${total}…`; } });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: backupFileName(new Date(createdAt)) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      await repo.setSetting('lastBackupAt', createdAt);
      lastLine.textContent = `Last backup downloaded: ${when(createdAt)}.`;
      exportStatus.textContent = `Backup created: ${plural(counts.products, 'product')}, ${plural(counts.images, 'photo')} (${mb(blob.size)}). Check your Downloads folder, then copy the file somewhere safe (cloud drive, computer).`;
    } catch (e) { exportStatus.textContent = ''; ctx.showError(e); }
    finally { busy = false; exportBtn.disabled = false; fileInput.disabled = false; }
  });

  // ---------------- restore ----------------
  const result = h('div', { id: 'restore-result' });
  const fileInput = h('input', { id: 'restore-file', type: 'file', accept: '.zip,application/zip' });
  fileInput.addEventListener('change', () => checkFile(fileInput.files && fileInput.files[0]));

  async function checkFile(file) {
    clear(result);
    if (!file || busy) return;
    busy = true; exportBtn.disabled = true; fileInput.disabled = true;
    const status = h('p', { role: 'status' }, 'Checking the backup…');
    result.append(status);
    let parsed;
    try {
      parsed = await readBackup(file, { onProgress: (n, total) => { status.textContent = `Checking file ${n} of ${total}…`; } });
    } finally { busy = false; exportBtn.disabled = false; fileInput.disabled = false; }
    clear(result);
    if (!parsed.ok) {
      result.append(h('div', { class: 'panel problems', role: 'alert' },
        h('h3', {}, 'This backup cannot be restored'),
        h('p', {}, 'Nothing was changed. Details:'),
        h('ul', {}, parsed.problems.map((p) => h('li', {}, p)))));
      return;
    }
    showReady(/** @type {*} */ (parsed));
  }

  function showReady({ data, summary }) {
    const s = summary;
    const mode = { value: 'skip' };
    const preview = h('p', { id: 'restore-preview', role: 'status' });
    const goBtn = h('button', { type: 'button', id: 'restore-go' }, 'Restore');
    const radio = (value, label, hint) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'restore-mode', value, checked: value === mode.value, onchange: () => { mode.value = value; refreshPreview(); } }),
      h('span', {}, h('strong', {}, label), h('span', { class: 'hint block' }, hint)));

    async function refreshPreview() {
      goBtn.disabled = true; preview.textContent = 'Working out what would change…';
      try {
        const p = await repo.previewImport(data, mode.value);
        const parts = [`Will add ${plural(p.productsAdded, 'product')} with ${plural(p.imagesAdded, 'photo')}`];
        if (p.productsSkipped) parts.push(`leave ${plural(p.productsSkipped, 'product')} that already exist untouched`);
        const extra = [];
        if (p.fieldsAdded) extra.push(`${plural(p.fieldsAdded, 'new field')}`);
        if (p.categoriesAdded) extra.push(`${plural(p.categoriesAdded, 'new category', 'new categories')}`);
        if (p.tagsAdded) extra.push(`${plural(p.tagsAdded, 'new tag')}`);
        preview.textContent = parts.join(', ') + '.' + (extra.length ? ` Also adds ${extra.join(', ')}.` : '') + ' Nothing here is deleted or overwritten.';
        goBtn.disabled = p.productsAdded === 0 && extra.length === 0;
        if (goBtn.disabled) preview.textContent = 'Everything in this backup is already here. Nothing to restore.';
      } catch (e) { preview.textContent = toAppError(e).message; preview.className = 'error-text'; return; }
      preview.className = '';
    }

    goBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true; goBtn.disabled = true; exportBtn.disabled = true; fileInput.disabled = true;
      preview.textContent = 'Restoring… keep this page open.';
      try {
        const r = await repo.importBackup(data, mode.value);
        clear(result);
        result.append(h('div', { class: 'panel', role: 'status', id: 'restore-done' }, h('h3', {}, 'Restore complete'),
          h('p', {}, `Added ${plural(r.productsAdded, 'product')} and ${plural(r.imagesAdded, 'photo')}.` + (r.productsSkipped ? ` Left ${plural(r.productsSkipped, 'existing product')} as they were.` : '')),
          h('p', {}, h('a', { class: 'btn', href: '#/' }, 'Open the catalog'))));
        fileInput.value = '';
        ctx.toast('Backup restored');
      } catch (e) {
        preview.textContent = '';
        ctx.showError(e);
        result.append(h('p', { class: 'error-text', role: 'alert' }, 'The restore failed and nothing was changed. ' + toAppError(e).message));
        goBtn.disabled = false;
      } finally { busy = false; exportBtn.disabled = false; fileInput.disabled = false; }
    });

    clear(result).append(h('div', { class: 'panel', id: 'restore-ready' },
      h('h3', {}, 'Backup is valid'),
      h('p', {}, `${s.createdAt ? 'Made ' + when(s.createdAt) + '. ' : ''}Contains ${plural(s.products, 'product')}, ${plural(s.images, 'photo')}, ${plural(s.fields, 'field')}, ${plural(s.categories, 'category', 'categories')}, ${plural(s.tags, 'tag')} (${mb(s.bytes)}). Every file passed its checksum.`),
      h('fieldset', { class: 'restore-modes' }, h('legend', {}, 'How to restore'),
        radio('skip', 'Skip existing', 'Products already in this catalog (same ID) are left exactly as they are; only the others are added. Best for a new phone or after data loss, and safe to repeat.'),
        radio('new', 'Add as new', 'Every product in the backup is added as a new product, even if a copy already exists here. Restoring twice creates duplicates.')),
      preview, goBtn));
    refreshPreview();
  }

  body.append(
    h('section', { class: 'panel' }, h('h2', {}, 'Back up'),
      h('p', {}, 'Saves all products, photos, fields, categories and tags into one ZIP file that you keep outside the browser. Your catalog lives only in this browser, so a backup is the only protection if the site data is cleared or the phone is lost.'),
      lastLine, exportBtn, exportStatus),
    h('section', { class: 'panel' }, h('h2', {}, 'Restore'),
      h('p', {}, 'Choose a VisualVault backup file. It is fully checked first; nothing is changed until you press Restore, and a restore is all-or-nothing.'),
      h('div', { class: 'field' }, h('label', { for: 'restore-file' }, 'Backup file (.zip)'), fileInput),
      result));
}
