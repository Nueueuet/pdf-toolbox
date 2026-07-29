import { h, clear } from '../util/dom.js';

let host = null;

function hostEl() {
  if (!host) {
    host = document.getElementById('toasts') ?? document.body.appendChild(h('div#toasts'));
  }
  return host;
}

/**
 * @param {string} message
 * @param {{tone?: 'info'|'success'|'error', timeout?: number, action?: {label: string, onClick: () => void}}} opts
 */
export function toast(message, { tone = 'info', timeout = 4200, action = null } = {}) {
  const el = h(`div.toast.toast--${tone}`, h('span.toast__text', message));
  if (action) {
    el.appendChild(
      h('button.toast__action', {
        type: 'button',
        onclick: () => {
          action.onClick();
          dismiss();
        },
      }, action.label),
    );
  }
  el.appendChild(h('button.toast__close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() }, '×'));

  hostEl().appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  let timer = timeout ? setTimeout(dismiss, timeout) : null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    timer = null;
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 220);
  }
  return dismiss;
}

/** A toast that stays put and reports progress; returns handles to update it. */
export function progressToast(label) {
  const bar = h('i.progress__bar');
  const text = h('span.toast__text', label);
  const el = h('div.toast.toast--progress', text, h('span.progress', bar));
  hostEl().appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  return {
    update(fraction, message) {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
      if (message) clear(text).appendChild(document.createTextNode(message));
    },
    done(message, tone = 'success') {
      el.remove();
      if (message) toast(message, { tone });
    },
    fail(message) {
      el.remove();
      toast(message, { tone: 'error', timeout: 8000 });
    },
  };
}
