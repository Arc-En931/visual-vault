// app.js — start-up, router, toasts. Screens live in js/views/.
import { openDatabase, requestPersistentStorage } from './db.js';
import { Repository } from './repository.js';
import { AppError, toAppError } from './models.js';
import { h, clear } from './dom.js';
import { catalogView } from './views/catalog.js';
import { productFormView } from './views/product-form.js';
import { imageEditorView } from './views/image-editor.js';
import { manageView } from './views/manage.js';
import { registerServiceWorker } from './pwa.js';

const main = document.getElementById('main');
const toastBox = document.getElementById('toasts');

function toast(message, { error = false, ms, action = null } = /** @type {{ error?: boolean, ms?: number, action?: { label: string, onClick: () => void } | null }} */ ({})) {
  // action: { label, onClick } adds a button and keeps the message until it is used or dismissed.
  const el = h('div', { class: 'toast' + (error ? ' error' : ''), role: error ? 'alert' : 'status' },
    h('span', {}, message),
    action ? h('button', { type: 'button', onclick: () => { el.remove(); action.onClick(); } }, action.label) : null,
    action ? h('button', { type: 'button', onclick: () => el.remove() }, 'Later')
      : error ? h('button', { type: 'button', 'aria-label': 'Dismiss message', onclick: () => el.remove() }, 'OK') : null);
  toastBox.append(el);
  if (!action) setTimeout(() => el.remove(), ms ?? (error ? 12000 : 3500));
}
const showError = (e) => toast(toAppError(e).message, { error: true });

const ctx = { repo: null, toast, showError, navigate, refresh };
let current = null;      // the open view: { dispose, isDirty }
let currentHash = '';
let suppress = false;
let renderSeq = 0;

function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash); else location.hash = hash;
}
function refresh() { return render(); }

/** @type {Array<[RegExp, (m: RegExpExecArray) => any, string]>} */
const routes = [
  [/^#\/?$/, () => catalogView(ctx), 'catalog'],
  [/^#\/product\/new$/, () => productFormView(ctx, {}), 'new'],
  [/^#\/product\/([^/]+)$/, (m) => productFormView(ctx, { id: decodeURIComponent(m[1]) }), 'catalog'],
  [/^#\/product\/([^/]+)\/image\/([^/]+)$/, (m) => imageEditorView(ctx, { productId: decodeURIComponent(m[1]), imageId: decodeURIComponent(m[2]) }), 'catalog'],
  [/^#\/manage(?:\/(fields|categories|tags|backup))?$/, (m) => manageView(ctx, { tab: m[1] || 'fields' }), 'manage'],
];

async function render() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  currentHash = hash;
  if (current && current.dispose) current.dispose();
  current = null;
  let nav = 'catalog';
  let view;
  try {
    const route = routes.find(([re]) => re.test(hash));
    if (!route) view = notFound();
    else { nav = route[2]; view = await route[1](route[0].exec(hash)); }
  } catch (e) {
    const err = toAppError(e);
    view = { el: h('div', { class: 'panel' }, h('h1', {}, 'Something went wrong'), h('p', {}, err.message), h('p', {}, h('a', { href: '#/' }, 'Back to the catalog'))) };
  }
  if (seq !== renderSeq) { if (view.dispose) view.dispose(); return; }  // a newer navigation won
  current = view;
  clear(main).append(view.el);
  document.title = (view.title ? view.title + ' · ' : '') + 'VisualVault';
  for (const a of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-nav]'))) {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (view.focus) view.focus(); else { window.scrollTo(0, 0); }
}

function notFound() {
  return { title: 'Not found', el: h('div', { class: 'empty' }, h('h1', {}, 'Page not found'), h('p', {}, h('a', { class: 'btn', href: '#/' }, 'Go to the catalog'))) };
}

window.addEventListener('hashchange', () => {
  if (suppress) { suppress = false; return; }
  if (current && current.isDirty && current.isDirty() && !confirm('You have unsaved changes. Leave without saving?')) {
    suppress = true; location.hash = currentHash; return;
  }
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (current && current.isDirty && current.isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

/** First run only: create the default "Price" field (money, per image). Deleting it later does not bring it back. */
async function seedDefaults(repo) {
  if (await repo.getSetting('seededDefaults', false)) return;
  try {
    await repo.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
  } catch (e) { if (!(e instanceof AppError && e.code === 'DUPLICATE')) throw e; }
  await repo.setSetting('seededDefaults', true);
}

async function start() {
  try {
    const db = await openDatabase();
    ctx.repo = new Repository(db);
    await seedDefaults(ctx.repo);
    requestPersistentStorage();
  } catch (e) {
    const err = toAppError(e);
    clear(main).append(h('div', { class: 'fatal' }, h('h1', {}, 'VisualVault cannot open its storage'), h('p', {}, err.message),
      h('p', { class: 'muted' }, 'Close private/incognito tabs, make sure site data is allowed for this page, then reload.'),
      h('button', { type: 'button', onclick: () => location.reload() }, 'Reload')));
    return;
  }
  if (!location.hash) history.replaceState(null, '', '#/');
  render();
  registerServiceWorker({
    onOfflineReady: () => toast('Ready to work offline. VisualVault now opens without a connection.', { ms: 6000 }),
    onUpdateReady: (apply) => toast('A new version of VisualVault is ready.', { action: { label: 'Update now', onClick: apply } }),
    onError: (e) => console.warn('Offline support is unavailable:', e),
  });
}
start();
