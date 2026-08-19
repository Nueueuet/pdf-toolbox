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
import { renderPageCanvas, viewportFor } from '../core/render.js';
import { pageSize } from '../core/workspace.js';
import { makeMapper, totalQuarter } from '../core/geometry.js';
import { numberPrompt } from './modal.js';
import { contextMenu } from './menu.js';
import { ocrStatusOf, OCR_STATUS_LABEL } from '../tools/ocr.js';
import { appendOcrText, sortIntoReadingOrder } from './ocrlayer.js';
import { TextLayer } from '../../vendor/pdf.mjs';

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

    /*
     * A thumbnail's width comes from the grid's column sizing, so it is only
     * known once laid out — and it changes with the window. The text layer is
     * built once at page scale and re-fitted here whenever that width moves.
     */
    this.shellSizes = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this.fitTextLayer(entry.target, entry.contentRect.width);
        /*
         * The inspection overlay is sized in pixels, so it can only be drawn
         * once the thumbnail has a width. Drawing it from here means it lands
         * whenever that happens — including on the first layout after switching
         * back from the single-page view, which is otherwise too early.
         */
        const page = this.ws.pageById(entry.target.closest('.pcard')?.dataset.id);
        if (page) this.drawOcrInspection(entry.target, page);
      }
    });
  }

  /** Scales and shifts a thumbnail's text layer onto its bitmap. */
  fitTextLayer(shell, width) {
    const layer = shell.querySelector('.textlayer');
    if (!layer || !width) return;
    const winW = Number(shell.dataset.winW);
    if (!winW) return;
    const scale = width / winW;
    const x = Number(shell.dataset.winX) || 0;
    const y = Number(shell.dataset.winY) || 0;
    layer.style.transform = `translate(${-x * scale}px, ${-y * scale}px) scale(${scale})`;
  }

  setZoom(zoom) {
    this.zoom = Math.min(1.5, Math.max(0.12, zoom));
    this.root.style.setProperty('--thumb-width', `${Math.round(this.zoom * 620)}px`);
    this.render();
  }

  /**
   * Text selection and drag-to-reorder cannot both be live: Chrome turns off
   * selection inside a draggable element, so the two have to take turns.
   */
  setTextMode(on) {
    this.textMode = Boolean(on);
    this.root.classList.toggle('is-textmode', this.textMode);
    for (const card of this.root.querySelectorAll('.pcard')) card.draggable = !this.textMode;
    if (this.textMode) this.clearSelection();
  }

  /** Shows per-page OCR status and a button to recognise just that page. */
  setOcrMode(on) {
    this.ocrMode = Boolean(on);
    this.root.classList.toggle('is-ocrmode', this.ocrMode);
    this.render();
  }

  /** Colours in what was already text against what OCR contributed. */
  setOcrInspect(on) {
    this.ocrInspect = Boolean(on);
    this.root.classList.toggle('is-ocrinspect', this.ocrInspect);
    for (const shell of this.root.querySelectorAll('.pcard__shell')) {
      const page = this.ws.pageById(shell.closest('.pcard')?.dataset.id);
      if (page) this.drawOcrInspection(shell, page);
    }
  }

  /**
   * Paints the two kinds of text over a thumbnail so the result can be checked
   * at a glance: what the PDF already carried, and what recognition added.
   */
  drawOcrInspection(shell, page) {
    shell.querySelector('.pcard__ocrlayer')?.remove();
    if (!this.ocrInspect) return;

    const width = shell.clientWidth;
    const height = shell.clientHeight;
    if (!width || !height) return;

    const layer = document.createElement('canvas');
    layer.className = 'pcard__ocrlayer';
    layer.width = width;
    layer.height = height;
    const ctx = layer.getContext('2d');

    const boxes = [
      ['rgba(22, 163, 74, .18)', 'rgba(22, 163, 74, .7)', page.meta?.ocrTextBoxesList ?? []],
      ['rgba(245, 158, 11, .22)', 'rgba(217, 119, 6, .85)', page.ocr?.words ?? []],
    ];
    for (const [fill, stroke, list] of boxes) {
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      for (const box of list) {
        // A run written at an angle gets its mark turned with it. Drawn as the
        // upright box it fits inside, a watermark set corner to corner covers
        // most of the thumbnail and hides what the marks are there to show.
        const turned = box.angle ? box.turned : null;
        const x = (turned ?? box).x * width;
        const y = (turned ?? box).y * height;
        const w = Math.max(1, (turned ? turned.w * width : box.w * width));
        const hgt = Math.max(1, (turned ? turned.h * height : box.h * height));
        ctx.save();
        if (turned) {
          ctx.translate(x, y);
          ctx.rotate((box.angle * Math.PI) / 180);
          ctx.fillRect(0, 0, w, hgt);
          ctx.strokeRect(0.5, 0.5, w - 1, hgt - 1);
        } else {
          ctx.fillRect(x, y, w, hgt);
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
        }
        ctx.restore();
      }
    }
    shell.appendChild(layer);
  }

  setView(view) {
    this.view = view;
    // Announced so panels that show pages or files can follow the main view.
    this.ws.emit('view', view);
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
    // Adding more is the one thing the grid could not do without going back to
    // the toolbar, so the slot after the last page offers it in place.
    cards.appendChild(this.addCard());
    this.root.appendChild(cards);

    this.root.scrollTop = scroll;
    if (this.view === 'pages') this.syncCutMarks();
    this.pump();
  }

  // ------------------------------------------------------------- page cards

  card(page, index) {
    const { w, h: ph } = pageSize(page);
    const shell = h('div.pcard__shell', { style: { aspectRatio: `${w} / ${ph}` } });
    // Thumbnails are canvases, so their text has to be laid over them too if it
    // is to be selectable here and not only in the single-page editor.
    this.shellSizes.observe(shell);

    const card = h('div.pcard', {
      dataset: { id: page.id, index: String(index) },
      // Cards rendered while the Copy text tool is open must not be draggable
      // either, or selection dies on them the moment the grid re-renders.
      // A real boolean, not a string: `draggable="false"` is a non-empty string
      // and would set the property to true.
      draggable: !this.textMode,
      tabindex: '0',
      class: this.ws.selection.has(page.id) ? 'is-selected' : '',
    },
      h('div.pcard__frame', shell,
        this.ocrMode ? this.ocrBadge(page) : null,
        h('span.pcard__badge', String(index + 1)),
      ),
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

  /**
   * Status dot and per-page trigger, top left. Clicking it recognises this one
   * page — the range field in the panel is for doing many at once.
   */
  ocrBadge(page) {
    const status = ocrStatusOf(page);
    const runnable = status === 'pending' || status === 'unknown' || status === 'done';
    const label = OCR_STATUS_LABEL[status];

    return h(`button.ocrbadge.ocrbadge--${status}`, {
      type: 'button',
      title: runnable ? `${label} — click to recognise this page` : label,
      'aria-label': `${label}. Page ${this.ws.indexOf(page.id) + 1}`,
      onclick: (event) => {
        event.stopPropagation();
        if (!runnable) return;
        this.handlers.onCommand('ocr-page', { page });
      },
    },
      svgIcon(['M7 3H5a2 2 0 0 0-2 2v2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M7 21H5a2 2 0 0 1-2-2v-2',
        'M17 21h2a2 2 0 0 0 2-2v-2', 'M7 9h10', 'M7 13h7'], 1.7),
    );
  }

  /** The "add more files" slot that closes out the grid, page-shaped. */
  addCard() {
    const last = this.ws.pages[this.ws.pages.length - 1];
    const { w, h: ph } = last ? pageSize(last) : { w: 595, h: 842 };

    return h('button.addcard', {
      type: 'button',
      title: 'Add PDFs or images to this document',
      onclick: () => this.handlers.onCommand('add-files', {}),
    },
      // Mirrors the page card's frame/shell nesting so both end up the same
      // height in the row.
      h('span.addcard__frame',
        h('span.addcard__shell', { style: { aspectRatio: `${w} / ${ph}` } },
          svgIcon(['M12 5v14', 'M5 12h14'], 1.6),
          h('span.addcard__label', 'Add files'),
        ),
      ),
    );
  }

  // ------------------------------------------------------------- file cards

  fileCard(group) {
    const cover = group.pages[0];
    const { w, h: ph } = pageSize(cover);
    const shell = h('div.pcard__shell', { style: { aspectRatio: `${w} / ${ph}` } });
    const count = group.pages.length;

    const remove = h('button.filecard__remove', {
      type: 'button',
      title: `Remove ${group.source?.name ?? 'this file'}`,
      'aria-label': `Remove ${group.source?.name ?? 'this file'}`,
      onclick: (event) => {
        event.stopPropagation();
        this.handlers.onCommand('remove-file', { srcId: group.srcId });
      },
    }, svgIcon(['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6']));

    const card = h('div.filecard', {
      dataset: { src: group.srcId },
      draggable: true,
      tabindex: '0',
      title: group.source?.name ?? '',
    },
      h('div.pcard__frame', shell,
        remove,
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

  /** Highlights every possible cut position, so the Split tool is discoverable. */
  setSplitHint(on) {
    this.root.classList.toggle('is-splithint', Boolean(on));
  }

  /**
   * Draws a slot into every gap between pages — one per card except the last.
   * A slot carrying a cut is drawn in full; an empty one is a click target that
   * only shows itself on hover. Kept separate from `render` so dragging a cut
   * does not rebuild every thumbnail.
   */
  syncCutMarks() {
    if (this.view !== 'pages') return;
    for (const mark of this.root.querySelectorAll('.cutmark')) mark.remove();

    const active = new Set(this.ws.cutList());
    if (this.dragCut) {
      active.delete(this.dragCut.from);
      active.add(this.dragCut.to);
    }

    for (let afterPage = 1; afterPage < this.ws.pageCount; afterPage++) {
      const card = this.root.querySelector(`.pcard[data-index="${afterPage - 1}"]`);
      if (card) card.appendChild(this.cutMark(afterPage, active.has(afterPage)));
    }
  }

  cutMark(afterPage, isActive) {
    const grip = h('span.cutmark__grip', scissorsIcon());
    const mark = h(`div.cutmark${isActive ? '.is-active' : ''}`, {
      dataset: { after: String(afterPage) },
      draggable: 'false',
      title: isActive
        ? 'Drag to move this split · click to remove it'
        : `Click to split after page ${afterPage}`,
    }, h('span.cutmark__line'), grip);

    // The card underneath is draggable; a gesture that starts in the gap must
    // move the split, never the page.
    mark.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    mark.addEventListener('click', (event) => event.stopPropagation());
    mark.addEventListener('pointerdown', (event) => this.onCutPointerDown(event, afterPage, isActive));

    return mark;
  }

  /**
   * One gesture handles all three actions, because `preventDefault` on
   * pointerdown (needed to stop the card being dragged) also suppresses the
   * click event — so click cannot be relied on here.
   */
  onCutPointerDown(event, afterPage, isActive) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    const onMove = (move) => {
      // A few pixels of slop, so a slightly shaky click still counts as a click.
      if (!moved && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
      if (!isActive) return; // an empty slot has nothing to drag yet
      moved = true;
      const target = this.gapUnder(move.clientX, move.clientY);
      if (target == null || this.dragCut?.to === target) return;
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
        this.handlers.onCommand('move-cut', { from: drag.from, to: drag.to });
      } else if (moved) {
        this.syncCutMarks(); // dragged back where it started
      } else {
        // A plain click: add a split here, or remove the one already here.
        this.handlers.onCommand('toggle-cut', { afterPage });
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
        a.align, a.valign, a.marks, a.bgColor, a.border, a.rotate, a.opacity]),
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
      // The overlay is not part of the cached bitmap, so it has to be redrawn
      // here too — skipping it is why the inspection view came back empty after
      // the thumbnails had been seen once.
      this.drawOcrInspection(shell, page);
      await this.addThumbTextLayer(page, shell);
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
      if (shell.isConnected) {
        shell.replaceChildren(cloneCanvas(canvas));
        this.drawOcrInspection(shell, page);
        await this.addThumbTextLayer(page, shell);
      }
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      shell.replaceChildren(h('div.pcard__error', 'Preview failed'));
      console.error('thumbnail failed', err);
    }
  }
}

/** Adds the selectable-text overlay to one thumbnail. */
PageGrid.prototype.addThumbTextLayer = async function addThumbTextLayer(page, shell) {
  const source = this.ws.source(page);
  const hasOcr = Boolean(page.ocr?.words?.length);
  // A rasterised page holds no text objects, but recognised text still belongs
  // in the layer — otherwise OCR results would only exist in the saved file.
  const hasPdfText = source?.kind === 'pdf' && !page.rasterId;
  if (!hasPdfText && !hasOcr) return;

  const { viewport } = await viewportFor(this.ws, page, 1);
  const mapper = makeMapper(viewport, page);
  if (!shell.isConnected) return;

  const layer = h('div.textlayer');
  layer.style.setProperty('--scale-factor', '1');
  layer.style.width = `${mapper.displayWidth}px`;
  layer.style.height = `${mapper.displayHeight}px`;

  if (hasPdfText) {
    const pdfPage = await source.doc.getPage(page.srcIndex + 1);
    const textViewport = pdfPage.getViewport({ scale: 1, rotation: totalQuarter(page) });
    await new TextLayer({
      textContentSource: pdfPage.streamTextContent(),
      container: layer,
      viewport: textViewport,
    }).render();
  }
  if (hasOcr) appendOcrText(layer, page, mapper.displayWidth, mapper.displayHeight);
  // What a drag across the page picks up follows the order these are in, and a
  // PDF stores its words in the order they were drawn rather than read.
  sortIntoReadingOrder(layer);
  if (!shell.isConnected) return;

  Object.assign(shell.dataset, {
    winW: String(mapper.outWidth),
    winX: String(mapper.window.x),
    winY: String(mapper.window.y),
  });
  shell.appendChild(layer);
  this.fitTextLayer(shell, shell.getBoundingClientRect().width);
};

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
