/** Form controls for the tool panel. Every one returns an element with a `.value` accessor. */
import { h } from '../util/dom.js';
import { uid } from '../util/format.js';

export function section(title, ...children) {
  return h('section.psection', title ? h('h3.psection__title', title) : null, ...children);
}

export function hint(text) {
  return h('p.hint', text);
}

export function field(label, control, help) {
  const id = control.id || (control.id = uid('ctl'));
  return h('label.field', { for: id },
    label ? h('span.field__label', label) : null,
    control,
    help ? h('span.field__help', help) : null,
  );
}

export function textInput({ value = '', placeholder = '', oninput, onenter } = {}) {
  return h('input.input', {
    type: 'text',
    value,
    placeholder,
    oninput: oninput ? (e) => oninput(e.target.value, e) : null,
    onkeydown: onenter ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onenter(e.target.value); } } : null,
  });
}

export function textArea({ value = '', placeholder = '', rows = 4, oninput } = {}) {
  return h('textarea.input.input--area', {
    rows,
    placeholder,
    value,
    oninput: oninput ? (e) => oninput(e.target.value, e) : null,
  });
}

export function numberInput({ value = 0, min, max, step = 1, oninput } = {}) {
  return h('input.input', {
    type: 'number',
    value: String(value),
    min: min == null ? null : String(min),
    max: max == null ? null : String(max),
    step: String(step),
    oninput: oninput ? (e) => oninput(Number(e.target.value), e) : null,
  });
}

export function select({ options, value, onchange } = {}) {
  const el = h('select.input.select',
    options.map((opt) => h('option', { value: opt.value, selected: opt.value === value }, opt.label)),
  );
  if (onchange) el.addEventListener('change', () => onchange(el.value));
  return el;
}

export function colorInput({ value = '#000000', onchange } = {}) {
  const swatch = h('input.color', { type: 'color', value });
  if (onchange) swatch.addEventListener('input', () => onchange(swatch.value));
  return swatch;
}

/** Colour picker with a "none" state, for highlight / background / border. */
export function optionalColor({ value = null, fallback = '#ffff00', onchange } = {}) {
  const toggle = h('input', { type: 'checkbox', checked: value != null });
  const swatch = h('input.color', { type: 'color', value: value ?? fallback, disabled: value == null });
  const emit = () => onchange?.(toggle.checked ? swatch.value : null);
  toggle.addEventListener('change', () => {
    swatch.disabled = !toggle.checked;
    emit();
  });
  swatch.addEventListener('input', emit);
  const wrap = h('span.optcolor', toggle, swatch);
  Object.defineProperty(wrap, 'value', {
    get: () => (toggle.checked ? swatch.value : null),
    set: (next) => {
      toggle.checked = next != null;
      swatch.disabled = next == null;
      if (next != null) swatch.value = next;
    },
  });
  return wrap;
}

export function slider({ value = 50, min = 0, max = 100, step = 1, format = String, oninput } = {}) {
  const readout = h('span.slider__value', format(value));
  const input = h('input.slider__input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener('input', () => {
    readout.textContent = format(Number(input.value));
    oninput?.(Number(input.value));
  });
  const wrap = h('span.slider', input, readout);
  Object.defineProperty(wrap, 'value', { get: () => Number(input.value) });
  return wrap;
}

export function checkbox({ label, checked = false, onchange } = {}) {
  const input = h('input', { type: 'checkbox', checked });
  if (onchange) input.addEventListener('change', () => onchange(input.checked));
  const wrap = h('label.check', input, h('span', label));
  Object.defineProperty(wrap, 'checked', { get: () => input.checked, set: (v) => { input.checked = v; } });
  return wrap;
}

/**
 * Radio cards — used for compress levels, upscale modes and similar
 * "pick exactly one, with an explanation" choices.
 * @param {{options: {value: string, label: string, description?: string, meta?: string}[]}} opts
 */
export function radioCards({ options, value, name = uid('radio'), onchange } = {}) {
  const cards = options.map((opt) => {
    const input = h('input', { type: 'radio', name, value: opt.value, checked: opt.value === value });
    const meta = h('span.radiocard__meta', opt.meta ?? '');
    const card = h('label.radiocard', input,
      h('span.radiocard__body',
        h('span.radiocard__label', opt.label),
        opt.description ? h('span.radiocard__desc', opt.description) : null,
      ),
      meta,
    );
    card.dataset.value = opt.value;
    input.addEventListener('change', () => { if (input.checked) onchange?.(opt.value); });
    return card;
  });
  const wrap = h('div.radiocards', ...cards);
  Object.defineProperty(wrap, 'value', {
    get: () => wrap.querySelector('input:checked')?.value ?? null,
    set: (next) => {
      const input = wrap.querySelector(`input[value="${next}"]`);
      if (input) input.checked = true;
    },
  });
  /** Updates the right-hand meta text of one card (e.g. an estimated size). */
  wrap.setMeta = (optionValue, text) => {
    const card = cards.find((c) => c.dataset.value === optionValue);
    if (card) card.querySelector('.radiocard__meta').textContent = text;
  };
  return wrap;
}

export function buttonRow(...buttons) {
  return h('div.prow', ...buttons);
}

export function button(label, { tone = '', onclick, disabled = false, title } = {}) {
  return h(`button.btn${tone ? `.btn--${tone}` : ''}`, { type: 'button', onclick, disabled, title }, label);
}

export function primary(label, opts = {}) {
  return button(label, { ...opts, tone: 'primary' });
}

/**
 * The page-range input every page-scoped tool shows, wired to live validation.
 * @returns {HTMLElement} with `.value` (raw string) and `.pages(count)` helpers.
 */
export function rangeField({ value = '', onchange } = {}) {
  const input = textInput({ value, placeholder: 'all, or 1-10, or 1,4,10' });
  const error = h('span.field__error');
  const wrap = h('div.rangefield', input, error);
  input.addEventListener('input', () => onchange?.(input.value));
  Object.defineProperty(wrap, 'value', { get: () => input.value, set: (v) => { input.value = v; } });
  wrap.setError = (message) => {
    error.textContent = message ?? '';
    wrap.classList.toggle('has-error', Boolean(message));
  };
  return wrap;
}
