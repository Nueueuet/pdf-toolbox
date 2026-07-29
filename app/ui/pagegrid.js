/**
 * The page grid: thumbnails, selection, drag-and-drop reordering, split marks
 * and the right-click menu. This is the surface every organise-style tool acts
 * on.
 *
 * Two views share the grid:
 *   pages  every page as its own card, with split marks sitting in the gaps
 *   files  one cover per imported file, so whole files can be reordered
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
    this.dragCut = null; // { from, to } while a split mark is being dragged

    root.addEventListener('click', (event) => {
      if (event.target === root || event.target.classList.contains('grid__cards')) this.clearSelection();
    });
    ws.on('cuts', () => this.syncCutMarks());
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
    for (const card of this.root.querySelectorAll('.filecard')) {
      const pages = this.ws.pages.filter((p) => p.srcId === card.dataset.src);
      card.classList.toggle('is-selected', pages.length > 0 && pages.every((p) => this.ws.selection.has(p.id)));
    }
  }

  render() {
    const scroll = this.root.scrollTop;
    clear(this.root);
    this.queue.length = 0;

    if (this.ws.pages.length === 0) return;

    const cards = h('div.grid__cards', { class: this.view === 'files' ? 'grid__cards--files' : '' });
    if (this.view === 'files') {
      for (const group of this.ws.fileGroups()) cards.appendChild(this.fileCard(group));
    } else {
      for (const [index, page] of this.ws.pages.entries()) cards.appendChild(this.card(page, index));
    }
    this.root.appendChild(cards);

    this.root.scrollTop = scroll;
    if (this.view === 'pages') this.syncCutMarks();
    this.pump();
  }

  // ------------------------------------------------------------- page cards

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

  // ------------------------------------------------------------- file cards

  fileCard(group) {
    const cover = group.pages[0];
    const { w, h: ph } = pageSize(cover);
    const shell = h('div.pcard__shell', { style: { aspectRatio: `${w} / ${ph}` } });
    const count = group.pages.length;

    const card = h('div.filecard', {
      dataset: { src: group.srcId },
      draggable: 'true',
      tabindex: '0',
      title: group.source?.name ?? '',
    },
      h('div.pcard__frame', shell,
        h('span.filecard__count', `${count} ${count === 1 ? 'page' : 'pages'}`),
      ),
      h('div.filecard__name', group.source?.name ?? 'Unknown file'),
    );

    card.addEventListener('click', () => {
      // Selecting a cover selects the whole file, which is what the page tools
      // then act on when the user switches back to the Pages view.
      const all = group.pages.every((p) => this.ws.selection.has(p.id));
      for (const page of group.pages) {
        if (all) this.ws.selection.delete(page.id);
        else this.ws.selection.add(page.id);
      }
      this.ws.emit('selection');
      this.syncSelection();
    });
    card.addEventListener('dblclick', () => this.handlers.onOpenPage(cover));
    card.addEventListener('dragstart', (event) => {
      this.dragSrcId = group.srcId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', group.srcId);
      requestAnimationFrame(() => this.root.classList.add('is-dragging'));
    });
    card.addEventListener('dragend', () => this.onDragEnd());
    card.addEventListener('dragover', (event) => {
      if (!this.dragSrcId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      this.clearDropHints();
      card.classList.add(after ? 'is-dropafter' : 'is-dropbefore');
    });
    card.addEventListener('drop', (event) => {
      if (!this.dragSrcId) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      this.handlers.onCommand('move-file', { srcId: this.dragSrcId, targetSrcId: group.srcId, after });
      this.onDragEnd();
    });

    this.queue.push({ page: cover, shell });
    return card;
  }

  // -------------------------------------------------------------- split cuts

  /**
   * Draws the split marks into the gaps between cards. Kept separate from
   * `render` so dragging a mark does not rebuild every thumbnail.
   */
  syncCutMarks() {
    if (this.view !== 'pages') return;
    for (const mark of this.root.querySelectorAll('.cutmark')) mark.remove();

    const shown = new Set(this.ws.cutList());
    if (this.dragCut) {
      shown.delete(this.dragCut.from);
      shown.add(this.dragCut.to);
    }

    for (const afterPage of shown) {
      const card = this.root.querySelector(`.pcard[data-index="${afterPage - 1}"]`);
      if (card) card.appendChild(this.cutMark(afterPage));
    }
  }

  cutMark(afterPage) {
    const grip = h('button.cutmark__grip', {
      type: 'button',
      title: 'Drag to move this split · click to remove it',
      'aria-label': `Split after page ${afterPage}`,
    }, scissorsIcon());

    const mark = h('div.cutmark', { dataset: { after: String(afterPage) } },
      h('span.cutmark__line'), grip);

    grip.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.suppressCutClick) return; // the click that ends a drag
      this.handlers.onCommand('toggle-cut', { afterPage });
    });
    grip.addEventListener('pointerdown', (event) => this.onCutPointerDown(event, afterPage));

    return mark;
  }

  onCutPointerDown(event, afterPage) {
    event.preventDefault();
    event.stopPropagation();
    this.suppressCutClick = false;
    let moved = false;

    const onMove = (move) => {
      const target = this.gapUnder(move.clientX, move.clientY);
      if (target == null) return;
      moved = true;
      if (this.dragCut?.to === target) return;
      this.dragCut = { from: afterPage, to: target };
      this.root.classList.add('is-cutdragging');
      this.syncCutMarks();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.root.classList.remove('is-cutdragging');
      const drag = this.dragCut;
      this.dragCut = null;
      if (moved && drag && drag.to !== drag.from) {
        this.suppressCutClick = true;
        setTimeout(() => { this.suppressCutClick = false; }, 0);
        this.handlers.onCommand('move-cut', { from: drag.from, to: drag.to });
      } else {
        this.syncCutMarks();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Which gap (as "cut after page N") the cursor is currently nearest to. */
  gapUnder(clientX, clientY) {
    const card = document.elementFromPoint(clientX, clientY)?.closest?.('.pcard')
      ?? this.nearestCard(clientX, clientY);
    if (!card) return null;
    const index = Number(card.dataset.index);
    const rect = card.getBoundingClientRect();
    const after = clientX > rect.left + rect.width / 2;
    const target = after ? index + 1 : index;
    return Math.min(this.ws.pageCount - 1, Math.max(1, target));
  }

  nearestCard(clientX, clientY) {
    let best = null;
    let bestDistance = Infinity;
    for (const card of this.root.querySelectorAll('.pcard')) {
      const rect = card.getBoundingClientRect();
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = card;
      }
    }
    return best;
  }

  // ------------------------------------------------------------- interactions

  onCardClick(event, page) {
    if (event.target.closest('.pcard__tools') || event.target.closest('.cutmark')) return;
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
    const index = this.ws.indexOf(page.id);
    const hasCut = this.ws.cuts.has(index + 1);
    const canCut = index + 1 < this.ws.pageCount;

    contextMenu(event, [
      { label: count > 1 ? `Move ${count} pages to position…` : 'Move to position…', onClick: () => this.promptMove(page) },
      { label: 'Edit page…', onClick: () => this.handlers.onOpenPage(page) },
      { separator: true },
      { label: 'Rotate left', onClick: () => this.handlers.onCommand('rotate', { pages, delta: -90 }) },
      { label: 'Rotate right', onClick: () => this.handlers.onCommand('rotate', { pages, delta: 90 }) },
      { label: 'Duplicate', onClick: () => this.handlers.onCommand('duplicate', { pages }) },
      { separator: true },
      {
        label: hasCut ? 'Remove split after this page' : 'Split after this page',
        disabled: !canCut,
        onClick: () => this.handlers.onCommand('toggle-cut', { afterPage: index + 1 }),
      },
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
    this.dragSrcId = null;
    this.root.classList.remove('is-dragging');
    this.clearDropHints();
  }

  clearDropHints() {
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
    this.clearDropHints();
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

function svgIcon(paths, strokeWidth = 1.8) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function scissorsIcon() {
  return svgIcon([
    'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M20 4 8.12 15.88',
    'M14.47 14.48 20 20',
    'M8.12 8.12 12 12',
  ], 1.9);
}

function iconBtn(title, path, onclick) {
  return h('button.pcard__tool', { type: 'button', title, 'aria-label': title, onclick }, svgIcon(path));
}
