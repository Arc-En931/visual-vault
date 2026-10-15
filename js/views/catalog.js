// catalog.js — search, filter, sort and browse products as a contact sheet.
import { h, clear, select, debounce } from '../dom.js';
import { buildIndex, search, compileFieldFilters, summarizeFields, isSortableField, isFilterableField } from '../search-service.js';
import { ObjectUrls } from '../image-service.js';

// Kept while the app is open so going into a product and back keeps your search.
const state = { query: '', categoryIds: [], tagIds: [], match: 'any', rows: [], sort: 'auto', open: false };

export async function catalogView(ctx) {
  const { repo } = ctx;
  const index = buildIndex(await repo.getCatalogSnapshot());
  const categories = (await repo.listCategories());
  const tags = (await repo.listTags());
  const filterable = [...index.defs.values()].filter(isFilterableField).sort((a, b) => a.name.localeCompare(b.name));
  const sortable = [...index.defs.values()].filter(isSortableField).sort((a, b) => a.name.localeCompare(b.name));
  const urls = new ObjectUrls();
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      loadThumb(en.target);
    }
  }, { rootMargin: '300px' });

  async function loadThumb(img) {
    try {
      const rec = await repo.getImage(img.dataset.imageId);
      if (!rec || !img.isConnected) return;
      img.src = urls.for(rec.thumb || rec.blob);
    } catch { img.replaceWith(document.createTextNode('Photo unavailable')); }
  }

  // ----- controls -----
  const q = h('input', { id: 'q', type: 'search', placeholder: 'Search names, captions, prices, tags…', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search catalog', value: state.query });
  const status = h('p', { class: 'status', role: 'status' });
  const results = h('div');
  const filters = h('details', { class: 'filters' });
  filters.open = state.open;
  filters.addEventListener('toggle', () => { state.open = filters.open; });

  const sortOptions = [['auto', 'Best match / name A–Z'], ['name:asc', 'Name A–Z'], ['name:desc', 'Name Z–A'], ['created:desc', 'Newest first'], ['created:asc', 'Oldest first'], ['updated:desc', 'Recently changed'],
    ...sortable.flatMap((d) => [[`field:${d.id}:asc`, `${d.name}: low to high`], [`field:${d.id}:desc`, `${d.name}: high to low`]])];
  if (!sortOptions.some(([v]) => v === state.sort)) state.sort = 'auto';
  const sortSel = select(sortOptions, state.sort, { id: 'sort' });
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; run(); });

  const chipGroup = (items, selected, label) => h('fieldset', {}, h('legend', {}, label),
    h('div', { class: 'chips' }, items.map((it) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(selected.includes(it.id)) }, it.name);
      b.addEventListener('click', () => {
        const i = selected.indexOf(it.id);
        if (i >= 0) selected.splice(i, 1); else selected.push(it.id);
        b.setAttribute('aria-pressed', String(i < 0));
        run();
      });
      return b;
    })));

  const rowsBox = h('div');
  function renderRows() {
    clear(rowsBox);
    state.rows.forEach((row, i) => {
      const def = index.defs.get(row.fieldId);
      const fieldSel = select(filterable.map((d) => [d.id, d.name]), row.fieldId, { 'aria-label': 'Field to filter' });
      fieldSel.addEventListener('change', () => { Object.assign(row, { fieldId: fieldSel.value, min: '', max: '', equals: '' }); renderRows(); run(); });
      const rm = h('button', { type: 'button', class: 'quiet', 'aria-label': `Remove ${def ? def.name : ''} filter`, onclick: () => { state.rows.splice(i, 1); renderRows(); run(); } }, 'Remove');
      let inputs;
      if (def && def.type === 'boolean') {
        const eq = select([['', 'Any'], ['true', 'Yes'], ['false', 'No']], row.equals || '', { 'aria-label': 'Yes or no' });
        eq.addEventListener('change', () => { row.equals = eq.value; run(); });
        inputs = [h('div', {}, eq), h('div'), rm];
      } else {
        const t = def && def.type === 'date' ? 'date' : 'text';
        const mk = (key, ph) => {
          const el = h('input', { type: t, inputmode: t === 'text' ? 'decimal' : null, placeholder: ph, 'aria-label': `${def ? def.name : ''} ${ph}`, value: row[key] || '', autocomplete: 'off' });
          el.addEventListener('input', () => { row[key] = el.value; debRun(); });
          return el;
        };
        inputs = [mk('min', 'Min'), mk('max', 'Max'), rm];
      }
      rowsBox.append(h('div', { class: 'filter-row' }, h('div', { class: 'name' }, fieldSel), ...inputs.map((x) => (x instanceof HTMLElement && x.tagName === 'DIV' ? x : h('div', {}, x)))));
    });
  }

  let matchField = null;
  function buildFilters() {
    matchField = null;
    clear(filters);
    filters.append(h('summary', {}, filterSummary()));
    const body = h('div', { class: 'panel' });
    if (categories.length) body.append(chipGroup(categories, state.categoryIds, 'Categories'));
    if (tags.length) body.append(chipGroup(tags, state.tagIds, 'Tags'));
    if (categories.length || tags.length) {
      const m = select([['any', 'any of the selected'], ['all', 'all of the selected']], state.match, { id: 'match' });
      m.addEventListener('change', () => { state.match = m.value; run(); });
      matchField = h('div', { class: 'field' }, h('label', { for: 'match' }, 'Products must match'), m);
      body.append(matchField);
    }
    if (filterable.length) {
      body.append(h('div', { class: 'label' }, 'Field ranges'), rowsBox, h('button', { type: 'button', class: 'secondary', onclick: () => {
        state.rows.push({ fieldId: filterable[0].id, min: '', max: '', equals: '' }); renderRows(); filters.open = true; } }, 'Add a field filter'));
    }
    body.append(h('div', { class: 'field', style: 'margin-top:1rem' }, h('label', { for: 'sort' }, 'Sort by'), sortSel),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => { filters.open = false; results.scrollIntoView({ block: 'start' }); } }, 'Show results'),
        h('button', { type: 'button', class: 'secondary', onclick: clearAll }, 'Clear search and filters')));
    filters.append(body);
  }
  const filterSummary = () => {
    const n = state.categoryIds.length + state.tagIds.length + state.rows.filter((r) => r.min || r.max || r.equals).length + (state.sort !== 'auto' ? 1 : 0);
    return n ? `Filters and sort (${n})` : 'Filters and sort';
  };
  function clearAll() {
    Object.assign(state, { query: '', categoryIds: [], tagIds: [], match: 'any', rows: [], sort: 'auto' });
    q.value = ''; sortSel.value = 'auto'; buildFilters(); renderRows(); run();
  }

  // ----- results -----
  function parseSort() {
    if (state.sort === 'auto') return undefined;
    const [by, a, b] = state.sort.split(':');
    return by === 'field' ? { by, fieldId: a, direction: b } : { by, direction: a };
  }

  function run() {
    state.query = q.value;
    let fieldFilters;
    try { fieldFilters = compileFieldFilters(index.defs, state.rows); } catch (e) {
      status.textContent = e.message; status.className = 'status error'; return;
    }
    status.className = 'status';
    const res = search(index, { query: state.query, categoryIds: state.categoryIds, tagIds: state.tagIds, match: state.match, fieldFilters, sort: parseSort() });
    const sum = filters.querySelector('summary'); if (sum) sum.textContent = filterSummary();
    if (matchField) matchField.hidden = state.categoryIds.length + state.tagIds.length < 2;
    renderResults(res);
  }
  const debRun = debounce(run, 150);
  q.addEventListener('input', debRun);

  function renderResults(res) {
    observer.disconnect(); urls.revokeAll(); clear(results);
    const all = index.entries.length;
    if (!all) {
      status.textContent = '';
      results.append(h('div', { class: 'empty' }, h('h2', {}, 'Your catalog is empty'),
        h('p', {}, 'Add a product, then attach photos with prices, captions and notes. Everything is stored on this device.'),
        h('a', { class: 'btn', href: '#/product/new' }, 'Add your first product')));
      return;
    }
    status.textContent = res.total === all ? `${all} product${all === 1 ? '' : 's'}` : `${res.total} of ${all} products`;
    if (!res.total) {
      results.append(h('div', { class: 'empty' }, h('h2', {}, 'No products match'), h('p', {}, 'Try fewer words, or remove a filter.'),
        h('button', { type: 'button', onclick: clearAll }, 'Clear search and filters')));
      return;
    }
    const ul = h('ul', { class: 'sheet' });
    for (const r of res.results) ul.append(card(r));
    results.append(ul);
    for (const img of ul.querySelectorAll('img[data-image-id]')) observer.observe(img);
  }

  function card(r) {
    const { product: p, entry } = r;
    const coverId = (r.matchedImageIds[0]) || (entry.images[0] && entry.images[0].image.id);
    const thumb = h('div', { class: 'thumb' },
      coverId ? h('img', { alt: '', 'data-image-id': coverId, loading: 'lazy', decoding: 'async' }) : 'No photo',
      entry.images.length > 1 ? h('span', { class: 'count' }, `${entry.images.length} photos`) : null);
    const sums = summarizeFields(entry);
    const labels = [...entry.categories, ...entry.tags].map((x) => x.name).join(', ');
    const meta = h('div', { class: 'meta' }, h('strong', {}, p.name),
      p.sku ? h('span', { class: 'small muted' }, p.sku) : null,
      sums.map((s) => h('div', { class: 'price' }, `${s.name} ${s.text}`)),
      labels ? h('div', { class: 'small muted' }, labels) : null,
      state.query.trim() && r.matchedIn.length ? h('div', { class: 'small muted' }, 'Matched in ' + r.matchedIn.join(', ')) : null);
    const byId = new Map(entry.images.map((im, i) => [im.image.id, { im, n: i + 1 }]));
    const shown = r.matchedImageIds.slice(0, 3);
    const hits = shown.length ? h('div', { class: 'hits' },
      shown.map((id) => { const { im, n } = byId.get(id); return h('a', { class: 'hit', href: `#/product/${p.id}/image/${id}` }, im.image.caption || `Photo ${n}`); }),
      r.matchedImageIds.length > 3 ? h('span', { class: 'small muted' }, `+${r.matchedImageIds.length - 3} more`) : null) : null;
    return h('li', { class: 'card' }, h('a', { class: 'cardlink', href: `#/product/${p.id}` }, thumb, meta), hits);
  }

  // ----- assemble -----
  buildFilters(); renderRows(); run();
  const el = h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Catalog'), h('a', { class: 'btn', href: '#/product/new' }, 'Add product')),
    h('div', { class: 'searchbar' }, q), status, filters, results);
  return { el, title: 'Catalog', dispose() { observer.disconnect(); urls.revokeAll(); debRun.cancel(); } };
}
