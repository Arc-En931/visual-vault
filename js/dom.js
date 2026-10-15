// dom.js — tiny element builder. Text is always set as text (never as HTML), so user content cannot inject markup.
const ATTR_ONLY = new Set(['capture', 'enterkeyhint', 'role', 'list', 'form', 'inputmode']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.includes('-') || ATTR_ONLY.has(k)) el.setAttribute(k, v === true ? '' : v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

/** <select> whose value is set after its options exist. options: [[value, label], ...] */
export function select(options, value, props) {
  const el = h('select', props, options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = value ?? options[0][0];
  return el;
}

export function debounce(fn, ms = 150) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
