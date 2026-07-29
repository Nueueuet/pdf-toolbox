/**
 * The page grid: thumbnails, selection, drag-and-drop reordering and the
 * right-click menu. This is the surface every organise-style tool acts on.
 */
import { h, clear } from '../util/dom.js';
import { renderPageCanvas } from '../core/render.js';
import { pageSize } from '../core/workspace.js';
import { numberPrompt } from './modal.js';
import { contextMenu } from './menu.js';

const THUMB_CONCURRENCY = 3;

export class PageGrid {
  /**
   * @param {HTMLElement} root
   * @param {import('../core/workspace.js').Workspace} ws
   * @param {{onOpenPage: (page) => void, onCommand: (name, payload) => void}} handlers
   */
  constructor(root, ws, handlers) {
    this.root = root;
    this.ws = ws;
    this.handlers = handlers;
    this.zoom = 0.3; // matches the reference tool's default of 30%
    this.view = 'pages'; // 'pages' | 'files'
    this.thumbCache = new Map();
    this.queue = [];
    this.active = 0;
    this.lastClickedId = null;
    this.dragIds = null;

    root.addEventListener('click', (event) => {
      if (event.target === root || event.target.classList.contains('grid__group')) this.clearSelection();
    });
  }

  setZoom(zoom) {
    this.zoom = Math.min(1.5, Math.max(0.12, zoom));
    this.root.style.setProperty('--thumb-width', `${Math.round(this.zoom * 620)}px`);
    this.render();
  }

  setView(view) {
    this.view = view;
    this.render();
  }

  clearSelection() {
    if (this.ws.selection.size === 0) return;
    this.ws.selection.clear();
    this.ws.emit('selection');
    this.syncSelection();
  }

  selectAll() {
    for (const page of this.ws.pages) this.ws.selection.add(page.id);
    this.ws.emit('selection');
    this.syncSelection();
  }

  /** Cheap update that avoids rebuilding cards when only the selection changed. */
  syncSelection() {
    for (const card of this.root.querySelectorAll('.pcard')) {
      card.classList.toggle('is-selected', this.ws.selection.has(card.dataset.id));
    }
  }

  render() {
    const scroll = this.root.scrollTop;
    clear(this.root);
    this.queue.length = 0;

    if (this.ws.pages.length === 0) return;

    if (this.view === 'files') {
      let current = null;
      let group = null;
      for (const [index, page] of this.ws.pages.entries()) {
        if (page.srcId !== current) {
          current = page.srcId;
          const source = this.ws.source(page);
          group = h('div.grid__group',
            h('h4.grid__grouptitle',
              h('span', source?.name ?? 'Unknown file'),
              h('button.linkbtn', {
                type: 'button',
                onclick: () => this.selectSource(current),
              }, 'Select all'),
            ),
            h('div.grid__cards'),
          );
          this.root.appendChild(group);
        }
        group.querySelector('.grid__cards').appendChild(this.card(page, index));
      }
    } else {
      const cards = h('div.grid__cards');
      for (const [index, page] of this.ws.pages.entries()) cards.appendChild(this.card(page, index));
      this.root.appendChild(cards);
    }

    this.root.scrollTop = scroll;
    this.pump();
  }

  selectSource(srcId) {
    for (const page of this.ws.pages) if (page.srcId === srcId) this.ws.selection.add(page.id);
    this.ws.emit('selection');
    this.syncSelection();
  }

  card(page, index) {
    const { w, h: ph } = pageSize(page);
    const shell = h('div.pcard__shell', { style: { aspectRatio: `${w} / ${ph}` } });

    const card = h('div.pcard', {
      dataset: { id: page.id, index: String(index) },
      draggable: 'true',
      tabindex: '0',
      class: this.ws.selection.has(page.id) ? 'is-selected' : '',
    },
      h('div.pcard__frame', shell, h('span.pcard__badge', String(index + 1))),
      h('div.pcard__label', page.meta?.note ?? ''),
      h('div.pcard__tools',
        iconBtn('Rotate left', 'M9 14 4 9l5-5 M4 9h7a6 6 0 0 1 6 6v4', () => this.handlers.onCommand('rotate', { pages: [page], delta: -90 })),
        iconBtn('Rotate right', 'M15 14l5-5-5-5 M20 9h-7a6 6 0 0 0-6 6v4', () => this.handlers.onCommand('rotate', { pages: [page], delta: 90 })),
        iconBtn('Edit page', 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z', () => this.handlers.onOpenPage(page)),
        iconBtn('Remove', 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6', () => this.handlers.onCommand('remove', { pages: [page] })),
      ),
    );

    card.addEventListener('click', (event) => this.onCardClick(event, page));
    card.addEventListener('dblclick', () => this.handlers.onOpenPage(page));
    card.addEventListener('contextmenu', (event) => this.onCardMenu(event, page));
    card.addEventListener('dragstart', (event) => this.onDragStart(event, page));
    card.addEventListener('dragend', () => this.onDragEnd());
    card.addEventListener('dragover', (event) => this.onDragOver(event, card));
    card.addEventListener('drop', (event) => this.onDrop(event, card));

    this.queue.push({ page, shell });
    return card;
  }

  // ------------------------------------------------------------- interactions

  onCardClick(event, page) {
    if (event.target.closest('.pcard__tools')) return;
    const selection = this.ws.selection;

    if (event.shiftKey && this.lastClickedId) {
      const from = this.ws.indexOf(this.lastClickedId);
      const to = this.ws.indexOf(page.id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        for (let i = lo; i <= hi; i++) selection.add(this.ws.pages[i].id);
      }
    } else if (event.ctrlKey || event.metaKey) {
      selection.has(page.id) ? selection.delete(page.id) : selection.add(page.id);
      this.lastClickedId = page.id;
    } else {
      const onlyThis = selection.size === 1 && selection.has(page.id);
      selection.clear();
      if (!onlyThis) selection.add(page.id);
      this.lastClickedId = page.id;
    }

    this.ws.emit('selection');
    this.syncSelection();
  }

  onCardMenu(event, page) {
    event.preventDefault();
    // Right-clicking outside the selection acts on that page alone.
    if (!this.ws.selection.has(page.id)) {
      this.ws.selection.clear();
      this.ws.selection.add(page.id);
      this.ws.emit('selection');
      this.syncSelection();
    }
    const pages = this.ws.targetPages();
    const count = pages.length;

    contextMenu(event, [
      { label: count > 1 ? `Move ${count} pages to position…` : 'Move to position…', onClick: () => this.promptMove(page) },
      { label: 'Edit page…', onClick: () => this.handlers.onOpenPage(page) },
      { separator: true },
      { label: 'Rotate left', onClick: () => this.handlers.onCommand('rotate', { pages, delta: -90 }) },
      { label: 'Rotate right', onClick: () => this.handlers.onCommand('rotate', { pages, delta: 90 }) },
      { label: 'Duplicate', onClick: () => this.handlers.onCommand('duplicate', { pages }) },
      { separator: true },
      { label: 'Split after this page', onClick: () => this.handlers.onCommand('split-here', { page }) },
      { label: count > 1 ? `Remove ${count} pages` : 'Remove page', danger: true, onClick: () => this.handlers.onCommand('remove', { pages }) },
    ]);
  }

  async promptMove(page) {
    const ids = this.ws.selection.size ? [...this.ws.selection] : [page.id];
    const target = await numberPrompt({
      title: 'Move to position',
      label: `New page number (1–${this.ws.pageCount})`,
      value: this.ws.indexOf(page.id) + 1,
      min: 1,
      max: this.ws.pageCount,
    });
    if (target == null) return;
    this.handlers.onCommand('move-to', { ids, target });
  }

  // --------------------------------------------------------- drag and drop

  onDragStart(event, page) {
    if (!this.ws.selection.has(page.id)) {
      this.ws.selection.clear();
      this.ws.selection.add(page.id);
      this.ws.emit('selection');
      this.syncSelection();
    }
    this.dragIds = [...this.ws.selection];
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload; the value is unused.
    event.dataTransfer.setData('text/plain', this.dragIds.join(','));
    requestAnimationFrame(() => this.root.classList.add('is-dragging'));
  }

  onDragEnd() {
    this.dragIds = null;
    this.root.classList.remove('is-dragging');
    for (const el of this.root.querySelectorAll('.is-dropbefore, .is-dropafter')) {
      el.classList.remove('is-dropbefore', 'is-dropafter');
    }
  }

  onDragOver(event, card) {
    if (!this.dragIds) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    for (const el of this.root.querySelectorAll('.is-dropbefore, .is-dropafter')) {
      el.classList.remove('is-dropbefore', 'is-dropafter');
    }
    card.classList.add(after ? 'is-dropafter' : 'is-dropbefore');
  }

  onDrop(event, card) {
    if (!this.dragIds) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    const targetId = card.dataset.id;
    this.handlers.onCommand('reorder', { ids: this.dragIds, targetId, after });
    this.onDragEnd();
  }

  // ------------------------------------------------------ thumbnail pipeline

  signatureOf(page) {
    return JSON.stringify([
      page.id, page.rotate, page.angle, page.crop, page.bg, page.rasterId,
      page.annots.map((a) => [a.id, a.x, a.y, a.w, a.h, a.text, a.size, a.color, a.family, a.bold, a.italic,
        a.align, a.valign, a.highlight, a.bgColor, a.border, a.rotate, a.opacity]),
      Math.round(this.zoom * 100),
    ]);
  }

  pump() {
    while (this.active < THUMB_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.renderThumb(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async renderThumb({ page, shell }) {
    if (!shell.isConnected) return;
    const signature = this.signatureOf(page);
    const cached = this.thumbCache.get(signature);
    if (cached) {
      shell.replaceChildren(cloneCanvas(cached));
      return;
    }

    try {
      const targetWidth = Math.max(80, Math.round(this.zoom * 620 * (window.devicePixelRatio || 1)));
      const { w } = pageSize(page);
      const { canvas } = await renderPageCanvas(this.ws, page, { scale: targetWidth / w });
      canvas.classList.add('pcard__canvas');
      this.thumbCache.set(signature, canvas);
      if (this.thumbCache.size > 400) {
        this.thumbCache.delete(this.thumbCache.keys().next().value);
      }
      if (shell.isConnected) shell.replaceChildren(cloneCanvas(canvas));
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      shell.replaceChildren(h('div.pcard__error', 'Preview failed'));
      console.error('thumbnail failed', err);
    }
  }
}

function cloneCanvas(source) {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.className = source.className;
  copy.getContext('2d').drawImage(source, 0, 0);
  return copy;
}

function iconBtn(title, path, onclick) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return h('button.pcard__tool', { type: 'button', title, 'aria-label': title, onclick }, svg);
}
