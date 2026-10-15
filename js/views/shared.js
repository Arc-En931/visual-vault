// shared.js — typed custom-field inputs used by the product form and the image editor.
import { h, select } from '../dom.js';
import { formatMoney } from '../models.js';

/** Stored value -> the text shown in an input. */
export function toRaw(def, stored) {
  if (stored === undefined || stored === null) return '';
  if (def.type === 'money') return formatMoney(stored);
  if (def.type === 'boolean') return stored ? 'true' : 'false';
  return String(stored);
}

/** Build a labelled input for one custom field. Returns { el, getRaw }. getRaw() is '' when empty (which clears the value). */
export function fieldInput(def, stored) {
  const id = `f-${def.id}`;
  const value = toRaw(def, stored);
  let input;
  let hint = null;
  if (def.type === 'boolean') {
    input = select([['', 'Not set'], ['true', 'Yes'], ['false', 'No']], value, { id });
  } else if (def.type === 'date') {
    input = h('input', { id, type: 'date', value });
  } else if (def.type === 'money') {
    input = h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value });
    hint = 'Up to 2 decimals, for example 19.99.';
  } else if (def.type === 'number') {
    input = h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', value });
  } else {
    input = h('input', { id, type: 'text', autocomplete: 'off', value });
  }
  const label = def.name + (def.unit ? ` (${def.unit})` : '');
  const el = h('div', { class: 'field' }, h('label', { for: id }, label), input, hint && h('p', { class: 'hint' }, hint));
  return { el, getRaw: () => input.value.trim() };
}
