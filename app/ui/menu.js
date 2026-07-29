import { h } from '../util/dom.js';

/**
 * Right-click menu.
 * @param {MouseEvent} event
 * @param {({label: string, onClick: () => void, danger?: boolean}|{separator: true})[]} items
 */
export function contextMenu(event, items) {
  close();

  const menu = h('div.ctxmenu', { role: 'menu' },
    items.map((item) => item.separator
      ? h('hr.ctxmenu__sep')
      : h(`button.ctxmenu__item${item.danger ? '.is-danger' : ''}`, {
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled,
        onclick: () => {
          close();
          item.onClick();
        },
      }, item.label)),
  );

  document.body.appendChild(menu);

  // Flip the menu when it would run off the viewport.
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  menu.classList.add('is-in');

  setTimeout(() => {
    document.addEventListener('pointerdown', close, { once: true });
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close, { once: true });
  }, 0);

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    for (const el of document.querySelectorAll('.ctxmenu')) el.remove();
  }
}
