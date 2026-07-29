import { h, clear } from '../util/dom.js';

function root() {
  return document.getElementById('modalRoot') ?? document.body.appendChild(h('div#modalRoot'));
}

/**
 * Generic modal. `render(close)` returns the body; resolve by calling `close(value)`.
 * @returns {Promise<any>} the value passed to close, or null when dismissed.
 */
export function modal({ title, render, width = 420, dismissable = true }) {
  return new Promise((resolve) => {
    const host = root();
    const close = (value = null) => {
      document.removeEventListener('keydown', onKey);
      backdrop.classList.remove('is-in');
      setTimeout(() => backdrop.remove(), 160);
      resolve(value);
    };

    const onKey = (event) => {
      if (event.key === 'Escape' && dismissable) {
        event.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey);

    const dialog = h('div.modal', { style: { maxWidth: `${width}px` }, role: 'dialog', 'aria-modal': 'true' },
      h('header.modal__head',
        h('h2.modal__title', title),
        dismissable ? h('button.modal__close', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, '×') : null,
      ),
      h('div.modal__body'),
    );
    dialog.querySelector('.modal__body').appendChild(render(close));

    const backdrop = h('div.backdrop', {
      onclick: (event) => {
        if (event.target === backdrop && dismissable) close(null);
      },
    }, dialog);

    host.appendChild(backdrop);
    requestAnimationFrame(() => {
      backdrop.classList.add('is-in');
      dialog.querySelector('input, button, select, textarea')?.focus();
    });
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', tone = 'primary' }) {
  return modal({
    title,
    width: 400,
    render: (close) => h('div',
      h('p.modal__text', message),
      h('div.modal__actions',
        h('button.btn', { type: 'button', onclick: () => close(false) }, 'Cancel'),
        h(`button.btn.btn--${tone}`, { type: 'button', onclick: () => close(true) }, confirmLabel),
      ),
    ),
  }).then(Boolean);
}

/** Prompt used when an imported PDF turns out to be password protected. */
export function passwordPrompt({ title = 'Password required', message, confirmLabel = 'Unlock' }) {
  return modal({
    title,
    width: 400,
    render: (close) => {
      const input = h('input.input', { type: 'password', placeholder: 'Password', autocomplete: 'off' });
      const form = h('form', {
        onsubmit: (event) => {
          event.preventDefault();
          close(input.value);
        },
      },
        message ? h('p.modal__text', message) : null,
        input,
        h('div.modal__actions',
          h('button.btn', { type: 'button', onclick: () => close(null) }, 'Skip'),
          h('button.btn.btn--primary', { type: 'submit' }, confirmLabel),
        ),
      );
      return form;
    },
  });
}

/** Small numeric prompt, used by "move page to position". */
export function numberPrompt({ title, label, value, min = 1, max = 9999, confirmLabel = 'Move' }) {
  return modal({
    title,
    width: 360,
    render: (close) => {
      const input = h('input.input', { type: 'number', value: String(value), min: String(min), max: String(max) });
      return h('form', {
        onsubmit: (event) => {
          event.preventDefault();
          const parsed = Number(input.value);
          close(Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : null);
        },
      },
        h('label.field', h('span.field__label', label), input),
        h('div.modal__actions',
          h('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
          h('button.btn.btn--primary', { type: 'submit' }, confirmLabel),
        ),
      );
    },
  });
}
