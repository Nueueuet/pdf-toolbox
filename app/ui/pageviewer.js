/**
 * Reading surface.
 *
 * Separate from the page editor on purpose. Editing wants one page pinned to the
 * window with handles and overlays on it; reading wants to move around freely,
 * zoom in on small print, and carry on scrolling into the next page. Trying to
 * be both at once is what makes most in-browser PDF viewers unpleasant.
 *
 * Panning is deliberately plain scrolling: once the page is bigger than the
 * window, the wheel, shift-wheel, a tilt wheel, the scrollbars and the keyboard
 * all work without a line of code. Only middle-drag has to be implemented, and
 * the one genuine decision — that at fit zoom the wheel turns the page instead
 * of doing nothing.
 */
import { h, clear, icon } from '../util/dom.js';
import { renderPageCanvas, viewportFor } from '../core/render.js';
import { makeMapper, totalQuarter } from '../core/geometry.js';
import { pageSize } from '../core/workspace.js';
import { cssFamilyFor } from '../core/fonts.js';
import { appendOcrText, sortIntoReadingOrder } from './ocrlayer.js';
import { AnnotationLayer } from './annotlayer.js';
import { TextLayer } from '../../vendor/pdf.mjs';

/**
 * Zoom steps the buttons and keyboard walk through.
 *
 * Half-steps as far as 400%, because the jump from 200 straight to 300 skips
 * the range where you are actually reading something closely; past that the
 * doubling is fine, since nobody adjusts 600% by fifty.
 */
const ZOOM_STEPS = [
  0.25, 0.375, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 6, 8,
];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Gap between pages in continuous layout, in CSS pixels. */
const PAGE_GAP = 18;

/** How far beyond the window a page is drawn, so scrolling meets a ready page. */
const PAINT_MARGIN = 400;

export class PageViewer {
  /**
   * @param {HTMLElement} root
   * @param {import('../core/workspace.js').Workspace} ws
   * @param {{onPageChange: (page) => void, onZoomChange: (zoom, fit) => void}} handlers
   */
  constructor(root, ws, handlers) {
    this.root = root;
    this.ws = ws;
    this.handlers = handlers;

    /**
     * single      one page at a time, stepped through with the arrows at the
     *             sides — the default, and how the page grid presents a document
     * continuous  pages stacked, scrolling runs straight across the join
     */
    this.layout = 'single';
    this.zoom = null; // null means "fit the window"
    this.currentPageId = null;
    this.renderToken = 0;
    this.frames = new Map(); // page id -> frame element
    this.layers = new Map(); // page id -> its editing layer
    this.editMode = 'select';

    this.scroller = h('div.viewer__scroll');
    this.pages = h('div.viewer__pages');
    this.scroller.appendChild(this.pages);

    // Turning the page from the sides of the view, where the pointer already is
    // while reading. Siblings of the scroller, not children, so they stay put
    // rather than scrolling away with the page.
    this.prevNav = this.navButton('prev', 'M15 18 9 12l6-6', -1);
    this.nextNav = this.navButton('next', 'M9 18l6-6-6-6', 1);
    clear(root).append(this.scroller, this.prevNav, this.nextNav);

    this.wireWheel();
    this.wireMiddleDrag();
    this.wireVisibility();
    this.wireScroll();

    this.onResize = () => this.relayout();
    window.addEventListener('resize', this.onResize);
  }

  navButton(side, path, delta) {
    return h(`button.editor__nav.editor__nav--${side}`, {
      type: 'button',
      title: side === 'prev' ? 'Previous page (left arrow)' : 'Next page (right arrow)',
      'aria-label': side === 'prev' ? 'Previous page' : 'Next page',
      onclick: () => this.step(delta),
    }, icon(path, { size: 22, stroke: 2 }));
  }

  /**
   * Hides the arrow that leads nowhere. In continuous layout they go entirely:
   * scrolling already carries you between pages there, so a page-turn button
   * would only be a second, worse way of doing the same thing.
   */
  syncNav() {
    const index = this.ws.indexOf(this.currentPageId);
    const paged = this.layout === 'single' && this.ws.pageCount > 1;
    this.prevNav.disabled = !paged || index <= 0;
    this.nextNav.disabled = !paged || index < 0 || index >= this.ws.pageCount - 1;
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
    this.visibility?.disconnect();
  }

  // ------------------------------------------------------------------ state

  setLayout(layout) {
    if (this.layout === layout) return;
    this.layout = layout;
    this.render();
  }

  /** @param {number|null} zoom null fits the window */
  setZoom(zoom) {
    const centre = this.centreFraction();
    this.zoom = zoom === null ? null : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.relayout();
    // Zooming keeps whatever was in the middle in the middle. Without this the
    // view would snap back to a corner every time the margins change size.
    this.restoreCentre(centre);
    this.handlers.onZoomChange?.(this.effectiveZoom(), this.zoom === null);
  }

  /** Where the middle of the window sits within the page area, as 0..1. */
  centreFraction() {
    const s = this.scroller;
    const { top, left, right, bottom } = this.padding();
    const width = s.scrollWidth - left - right;
    const height = s.scrollHeight - top - bottom;
    return {
      x: width > 0 ? (s.scrollLeft + s.clientWidth / 2 - left) / width : 0.5,
      y: height > 0 ? (s.scrollTop + s.clientHeight / 2 - top) / height : 0.5,
    };
  }

  restoreCentre({ x, y }) {
    const s = this.scroller;
    const { top, left, right, bottom } = this.padding();
    s.scrollLeft = left + x * (s.scrollWidth - left - right) - s.clientWidth / 2;
    s.scrollTop = top + y * (s.scrollHeight - top - bottom) - s.clientHeight / 2;
  }

  /** The empty room around the pages, as set by applyPanRoom. */
  padding() {
    const style = getComputedStyle(this.pages);
    return {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
  }

  zoomBy(direction) {
    const current = this.effectiveZoom();
    const stops = this.zoomStops();
    const steps = direction > 0
      ? stops.filter((z) => z > current + 0.001)
      : stops.filter((z) => z < current - 0.001).reverse();
    this.setZoom(steps.length ? steps[0] : current);
  }

  /**
   * The round steps, plus the two sizes at which the page exactly fills the
   * window — once across and once down.
   *
   * Those two are worth stopping at because they are the sizes anyone actually
   * wants: the whole width in view, or the whole page. They are also the ones
   * nobody could dial in by hand, being a different awkward number for every
   * document and every window — 223% on one, 91% on the next.
   */
  zoomStops() {
    const fit = this.fitScales();
    const stops = [...ZOOM_STEPS];
    for (const value of [fit.width, fit.height]) {
      if (value >= MIN_ZOOM && value <= MAX_ZOOM
        && !stops.some((z) => Math.abs(z - value) < 0.005)) {
        stops.push(value);
      }
    }
    return stops.sort((a, b) => a - b);
  }

  /** Scales at which the page fills the window across, and down. */
  fitScales() {
    const page = this.currentPage() ?? this.ws.pages[0];
    if (!page) return { width: 1, height: 1 };
    const { w, h: ph } = pageSize(page);
    // clientWidth, not the outer box: the gutter kept for the scrollbar is not
    // room the page can use, and on a very wide sheet that difference is what
    // stops "fit" from actually fitting.
    const padding = 48;
    return {
      width: (this.scroller.clientWidth - padding) / w || 1,
      height: (this.scroller.clientHeight - padding) / ph || 1,
    };
  }

  /** The scale actually in use, resolving "fit" against the current window. */
  effectiveZoom() {
    if (this.zoom !== null) return this.zoom;
    return this.fitScale();
  }

  /** Scale at which the current page fits entirely inside the window. */
  fitScale() {
    const { width, height } = this.fitScales();
    return Math.max(MIN_ZOOM, Math.min(width, height) || 1);
  }

  currentPage() {
    return this.ws.pageById(this.currentPageId) ?? this.ws.pages[0] ?? null;
  }

  // ----------------------------------------------------------------- render

  async open(page) {
    this.currentPageId = page?.id ?? this.ws.pages[0]?.id ?? null;
    await this.render();
  }

  /** Points at the live page object after undo replaced the old one. */
  /**
   * Points at the current object for a page and redraws, without moving.
   *
   * The view is anchored on the page being worked on: where its top sat in the
   * window before is where it sits afterwards. Cropping is what this is for —
   * the page genuinely becomes smaller, and without an anchor the whole document
   * jumps to the top and appears to have zoomed out, when all that was asked for
   * was to trim one page.
   */
  async rebind(page) {
    if (!page) return;
    this.currentPageId = page.id;

    const asked = this.pendingAnchor?.pageId === page.id ? this.pendingAnchor.top : null;
    this.pendingAnchor = null;

    const anchor = this.frames.get(page.id);
    const offset = asked ?? (anchor
      ? anchor.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top
      : null);

    // Told not to scroll to the page on its way through: render() otherwise puts
    // it at the top of the window first, and anchoring on top of that is one
    // movement correcting another rather than simply not moving.
    await this.render({ keepScroll: offset !== null });

    const settled = this.frames.get(page.id);
    if (offset === null || !settled) return;
    const now = settled.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += now - offset;
    // Sideways it is centred, which for a page that just changed width is the
    // only place that reads as "the same page, trimmed".
    this.scroller.scrollLeft = (this.scroller.scrollWidth - this.scroller.clientWidth) / 2;

    /*
     * A last check that the page is still somewhere you can see it.
     *
     * Holding a page where it was assumes it stayed roughly the size it was. A
     * crop down to one corner does not: keeping its top where it sat left the
     * whole of what remained above the window, so the document read as having
     * scrolled itself down past the page just worked on.
     */
    const box = settled.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    if (box.bottom < view.top + 24 || box.top > view.bottom - 24) this.scrollToPage(page.id, 'auto');
  }

  /**
   * Holds the crop rectangle still while the crop is applied.
   *
   * What is left of the page afterwards is exactly what the rectangle covers,
   * so the rectangle's own place in the window is where the trimmed page
   * belongs — anywhere else and the crop appears to jump the moment it lands.
   */
  anchorOnCrop() {
    const box = this.layer?.cropBox();
    if (!box) return;
    this.pendingAnchor = {
      pageId: this.currentPageId,
      top: box.top - this.scroller.getBoundingClientRect().top,
    };
  }

  async render({ keepScroll = false } = {}) {
    const token = ++this.renderToken;
    clear(this.pages);
    this.frames.clear();
    this.layers.clear();
    if (this.ws.pageCount === 0) return;

    this.root.dataset.layout = this.layout;
    const list = this.layout === 'single'
      ? [this.currentPage()].filter(Boolean)
      : this.ws.pages;

    for (const page of list) {
      const frame = this.frame(page);
      this.frames.set(page.id, frame);
      this.pages.appendChild(frame);
      this.visibility.observe(frame);
    }

    this.relayout();
    this.applyEditMode();
    for (const [id, frame] of this.frames) this.drawInspection(frame, this.ws.pageById(id));
    this.syncNav();
    if (this.layout === 'continuous' && !keepScroll) this.scrollToPage(this.currentPageId, 'auto');
    if (token === this.renderToken) this.handlers.onZoomChange?.(this.effectiveZoom(), this.zoom === null);
  }

  frame(page) {
    const { w, h: ph } = pageSize(page);
    /*
     * Every page carries its own editing layer, so a text box is edited on the
     * page it belongs to rather than on whichever page a separate editor decided
     * to show. The layer is laid out in page points and scaled with the rest, so
     * a box stays where it was put at any zoom.
     */
    const overlay = h('div.editor__overlay.viewer__overlay');
    const frame = h('div.viewer__page', { dataset: { id: page.id, w: String(w), h: String(ph) } },
      h('div.viewer__canvas'),
      h('div.textlayer'),
      // Above the page and below the annotations: it is a check on what OCR
      // read, so it has to be visible over the ink it claims to describe.
      h('div.inspectlayer'),
      overlay,
      h('span.viewer__number', String(this.ws.indexOf(page.id) + 1)),
    );

    const layer = new AnnotationLayer({
      el: overlay,
      handlers: this.handlers,
      pageBox: () => {
        const box = frame.getBoundingClientRect();
        return { width: box.width, height: box.height };
      },
    });
    layer.setPage(page);
    this.layers.set(page.id, layer);

    // The overlay lets clicks through so the text underneath stays selectable,
    // so "click the page to deselect" has to be caught on the frame instead.
    frame.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.abox') || event.target.closest('.crop')) return;
      this.setCurrentPage(page.id);
      layer.select(null);
    });

    return frame;
  }

  /** The editing layer for the page being worked on. */
  get layer() {
    return this.layers.get(this.currentPageId) ?? null;
  }

  /**
   * Which page the tools act on. In a stack this follows what you click, so
   * using a tool means using it where you are.
   */
  setCurrentPage(id) {
    if (id === this.currentPageId || !this.ws.pageById(id)) return;
    this.currentPageId = id;
    this.applyEditMode();
    this.syncNav();
    this.handlers.onPageChange?.(this.ws.pageById(id));
  }

  /**
   * @param {string} mode 'select' or 'crop'
   *
   * Cropping is about one page, so only the page being worked on gets the
   * rectangle; annotations belong to every page and are drawn on all of them.
   */
  setEditMode(mode) {
    this.editMode = mode;
    this.root.dataset.mode = mode;
    this.applyEditMode();
  }

  applyEditMode() {
    for (const [id, layer] of this.layers) {
      layer.setMode(this.editMode === 'crop' && id === this.currentPageId ? 'crop' : 'select');
    }
  }

  /**
   * Colours what OCR added against what the PDF already carried.
   *
   * On every page on show, not just one: in a continuous stack the whole point
   * is to run an eye down the document and see where the recognition reached.
   * This lived in the single-page editor and was lost when that went, leaving a
   * switch that quietly did nothing.
   */
  setInspect(on) {
    this.inspect = Boolean(on);
    this.root.classList.toggle('is-inspecting', this.inspect);
    for (const [id, frame] of this.frames) this.drawInspection(frame, this.ws.pageById(id));
  }

  drawInspection(frame, page) {
    const host = frame.querySelector('.inspectlayer');
    if (!host) return;
    clear(host);
    if (!this.inspect || !page) return;

    const groups = [
      ['existing', page.meta?.ocrTextBoxesList ?? []],
      ['ocr', (page.ocr?.words ?? []).map((word) => ({ x: word.x, y: word.y, w: word.w, h: word.h, text: word.text }))],
    ];

    for (const [kind, boxes] of groups) {
      for (const box of boxes) {
        // Nothing to draw a box around.
        if (box.w <= 0 || box.h <= 0) continue;
        host.appendChild(h(`div.inspectbox.inspectbox--${kind}`, {
          style: {
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.w * 100}%`,
            height: `${box.h * 100}%`,
          },
          title: box.text ? `Recognised: ${box.text}` : 'Text the PDF already had',
        }));
      }
    }
  }

  /**
   * Turns the pointer into the thing about to be placed.
   *
   * A stamp knows its own size, so the shape following the cursor is that size
   * on that page at that zoom — you can see whether it will fit before letting
   * go of it, rather than dropping it and dragging it about afterwards.
   *
   * @param {object} annot the annotation to place, used for its size and looks
   * @param {(page: object, at: {x: number, y: number}) => void} onPlace given
   *   the page landed on and the top-left corner as fractions of it
   */
  armPlacement(annot, onPlace) {
    this.disarmPlacement();
    this.root.classList.add('is-placing');

    const ghost = h('div.ghost', h('span.ghost__text', String(annot.text ?? '').split('\n')[0]));
    Object.assign(ghost.style, {
      width: `${annot.w * 100}%`,
      height: `${annot.h * 100}%`,
      background: annot.bgColor ?? 'transparent',
      color: annot.color,
      fontSize: `${annot.size}px`,
      fontFamily: cssFamilyFor(annot.family),
      border: annot.border?.width > 0 ? `${annot.border.width}px solid ${annot.border.color}` : '',
    });

    // Where the corner goes if the cursor is the middle of the stamp, which is
    // how it reads when it is stuck to the pointer.
    const corner = (event, frame) => {
      const box = frame.getBoundingClientRect();
      return {
        x: (event.clientX - box.left) / box.width - annot.w / 2,
        y: (event.clientY - box.top) / box.height - annot.h / 2,
      };
    };

    const onMove = (event) => {
      const frame = event.target.closest?.('.viewer__page');
      if (!frame) return ghost.remove();
      const overlay = frame.querySelector('.viewer__overlay');
      if (ghost.parentElement !== overlay) overlay.appendChild(ghost);
      const at = corner(event, frame);
      ghost.style.left = `${at.x * 100}%`;
      ghost.style.top = `${at.y * 100}%`;
    };

    const onClick = (event) => {
      const frame = event.target.closest?.('.viewer__page');
      if (!frame) return;
      const page = this.ws.pageById(frame.dataset.id);
      if (!page) return;
      event.preventDefault();
      event.stopPropagation();
      onPlace(page, corner(event, frame));
    };

    this.scroller.addEventListener('pointermove', onMove);
    this.scroller.addEventListener('pointerdown', onClick, { capture: true });
    this.placement = () => {
      ghost.remove();
      this.root.classList.remove('is-placing');
      this.scroller.removeEventListener('pointermove', onMove);
      this.scroller.removeEventListener('pointerdown', onClick, { capture: true });
    };
  }

  disarmPlacement() {
    this.placement?.();
    this.placement = null;
  }

  /**
   * Offers the page's own runs of text for the pointer to choose between.
   *
   * Drawn as outlines rather than left to the invisible text layer: the point of
   * this mode is seeing what a click would take, and a run of text is not
   * necessarily the line or the word the eye would group it into.
   *
   * @param {{x: number, y: number, w: number, h: number}[]} runs page fractions
   * @param {(run: object) => void} onPick
   */
  armPick(runs, onPick) {
    this.disarmPlacement();
    this.root.classList.add('is-picking');

    const frame = this.frames.get(this.currentPageId);
    const overlay = frame?.querySelector('.viewer__overlay');
    if (!overlay) return;

    const marks = runs.map((run) => {
      const mark = h('button.pickrun', { type: 'button', title: run.text.slice(0, 60) });
      Object.assign(mark.style, {
        left: `${run.x * 100}%`,
        top: `${run.y * 100}%`,
        width: `${run.w * 100}%`,
        height: `${run.h * 100}%`,
      });
      mark.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onPick(run);
      });
      overlay.appendChild(mark);
      return mark;
    });

    this.placement = () => {
      for (const mark of marks) mark.remove();
      this.root.classList.remove('is-picking');
    };
  }

  /*
   * The same calls the single-page editor answers, so a tool panel does not care
   * which surface it is driving. Each goes to the layer of the page being worked
   * on; annotations elsewhere in a stack look after themselves.
   */
  setMode(mode) { this.setEditMode(mode); }
  drawOverlay() { this.applyEditMode(); }
  selectedAnnot() { return this.layer?.selectedAnnot() ?? null; }
  select(id) { this.layer?.select(id); }
  focusText(annot, opts) { this.layer?.focusText(annot, opts); }
  isEditingText() { return [...this.layers.values()].some((l) => l.isEditingText()); }
  selectionRange() { return this.layer?.selectionRange() ?? null; }
  refreshText(annot) { this.layer?.refreshText(annot); }
  syncAnnot(annot) { this.layer?.syncAnnot(annot); }
  currentCrop() { return this.layer?.currentCrop() ?? null; }
  cropBox() { return this.layer?.cropBox() ?? null; }
  setCrop(crop) { this.layer?.setCrop(crop); }

  /**
   * Room to push the page past the edge of the window, so a detail sitting in a
   * corner can be brought to the middle to look at. A quarter of the window on
   * each side, and only on an axis that can actually be panned — adding it while
   * the whole sheet fits would invent scrollbars and rob the wheel of its
   * page-turning job.
   */
  applyPanRoom(contentWidth, contentHeight) {
    const view = { width: this.scroller.clientWidth, height: this.scroller.clientHeight };
    const base = 24;
    // A pixel of slack, so a page rounded to exactly the fitting size is not
    // mistaken for one that overflows.
    const fitsX = contentWidth <= view.width - base * 2 + 1;
    const fitsY = contentHeight <= view.height - base * 2 + 1;
    const padX = fitsX ? base : Math.round(view.width * 0.25);
    const padY = fitsY ? base : Math.round(view.height * 0.25);
    this.pages.style.padding = `${padY}px ${padX}px`;
  }

  /**
   * Applies the current scale to every frame, without re-rendering bitmaps.
   *
   * Deliberately in two passes. Sizing a frame and then asking where it landed
   * makes the browser settle the layout again before it can answer, and doing
   * that once per page turns a long document into hundreds of forced
   * recalculations — on a 148-page file it was the difference between the
   * document appearing and a visible wait. So every size is written first, and
   * only then is anything measured. Where each page sits is worked out from the
   * heights just set rather than asked of the DOM at all.
   */
  relayout() {
    const scale = this.effectiveZoom();
    this.pages.style.gap = `${PAGE_GAP}px`;
    let contentWidth = 0;
    let contentHeight = 0;
    const placed = [];

    for (const [id, frame] of this.frames) {
      const w = Number(frame.dataset.w);
      const ph = Number(frame.dataset.h);
      const pageWidth = Math.round(w * scale);
      const pageHeight = Math.round(ph * scale);
      frame.style.width = `${pageWidth}px`;
      frame.style.height = `${pageHeight}px`;
      contentWidth = Math.max(contentWidth, pageWidth);
      // The gap sits between pages, never after the last one.
      contentHeight += contentHeight ? pageHeight + PAGE_GAP : pageHeight;

      // Text, inspection and editing are all laid out in page points and scaled
      // as one, so a text box and the word under it never drift apart.
      for (const selector of ['.textlayer', '.inspectlayer', '.viewer__overlay']) {
        const el = frame.querySelector(selector);
        el.style.width = `${w}px`;
        el.style.height = `${ph}px`;
        el.style.transform = `scale(${scale})`;
      }

      // A page whose bitmap was drawn for a very different scale is redrawn, so
      // zooming in does not just enlarge a blurry picture.
      const drawn = Number(frame.dataset.drawnScale || 0);
      if (drawn && (scale / drawn > 1.5 || drawn / scale > 2.5)) frame.dataset.needsRedraw = '1';

      placed.push({ id, frame, height: pageHeight });
    }

    this.applyPanRoom(contentWidth, contentHeight);

    // The only measurements taken, and taken once.
    const top = this.padding().top;
    const from = this.scroller.scrollTop - PAINT_MARGIN;
    const to = this.scroller.scrollTop + this.scroller.clientHeight + PAINT_MARGIN;

    let y = top;
    for (const { id, frame, height } of placed) {
      if (y + height > from && y < to) this.paint(frame, id);
      y += height + PAGE_GAP;
    }
    this.root.classList.toggle('is-fit', !this.canScroll());
  }

  /** True when the content is larger than the window, i.e. panning does something. */
  canScroll() {
    return this.scroller.scrollHeight > this.scroller.clientHeight + 2
      || this.scroller.scrollWidth > this.scroller.clientWidth + 2;
  }

  isVisible(frame) {
    const box = frame.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    return box.bottom > view.top - PAINT_MARGIN && box.top < view.bottom + PAINT_MARGIN;
  }

  wireVisibility() {
    // Pages are drawn as they come into view, so a long document does not
    // rasterise itself in one go the moment it opens.
    this.visibility = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.dataset.id;
        this.paint(entry.target, id);
        if (this.layout === 'continuous') this.setCurrentFromScroll();
      }
    }, { root: this.scroller, rootMargin: `${PAINT_MARGIN}px 0px` });
  }

  async paint(frame, id) {
    // Asked for again mid-draw, it is drawn again afterwards rather than
    // dropped. Entering crop asks for a redraw of a page that is very often
    // still being drawn, and losing that request left the trimmed picture
    // stretched over the full-size frame.
    if (frame.dataset.painting === '1') {
      frame.dataset.needsRedraw = '1';
      return;
    }
    if (frame.dataset.drawnScale && frame.dataset.needsRedraw !== '1') return;

    const page = this.ws.pageById(id);
    if (!page) return;
    frame.dataset.painting = '1';
    delete frame.dataset.needsRedraw;

    const token = this.renderToken;
    try {
      const scale = this.effectiveZoom();
      const pixelScale = Math.min(4, scale * (window.devicePixelRatio || 1));
      /*
       * Without annotations: every one of them is a live box in the editing
       * layer above, and drawing them here as well put a second, frozen copy of
       * each on the page. Moving the real one then left the painted one behind
       * until the next repaint caught up — one text box, two apparent copies,
       * only one of which answered to the pointer.
       */
      const { canvas } = await renderPageCanvas(this.ws, page, {
        scale: pixelScale,
        withAnnots: false,
      });
      if (token !== this.renderToken || !frame.isConnected) return;

      canvas.className = 'viewer__bitmap';
      clear(frame.querySelector('.viewer__canvas')).appendChild(canvas);
      frame.dataset.drawnScale = String(scale);

      await this.buildTextLayer(frame, page, token);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error('viewer paint failed', err);
    } finally {
      delete frame.dataset.painting;
      if (frame.dataset.needsRedraw === '1' && frame.isConnected) this.paint(frame, id);
    }
  }

  /** Selectable text over the page — a viewer that cannot copy is half a viewer. */
  async buildTextLayer(frame, page, token) {
    const layer = frame.querySelector('.textlayer');
    clear(layer);

    const source = this.ws.source(page);
    const hasOcr = Boolean(page.ocr?.words?.length);
    const hasPdfText = source?.kind === 'pdf' && !page.rasterId;
    if (!hasPdfText && !hasOcr) return;

    const { viewport } = await viewportFor(this.ws, page, 1);
    const mapper = makeMapper(viewport, page);
    layer.style.setProperty('--scale-factor', '1');

    if (hasPdfText) {
      const pdfPage = await source.doc.getPage(page.srcIndex + 1);
      if (token !== this.renderToken) return;
      await new TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: layer,
        viewport: pdfPage.getViewport({ scale: 1, rotation: totalQuarter(page) }),
      }).render();
    }
    if (hasOcr) appendOcrText(layer, page, mapper.displayWidth, mapper.displayHeight);
    // Last, so recognised words take their place among the rest rather than
    // being tacked on after everything.
    sortIntoReadingOrder(layer);
  }

  // -------------------------------------------------------------- navigation

  /**
   * Puts a freshly turned-to page under the eye rather than in the empty room
   * around it: its own top or bottom edge, horizontally centred.
   */
  restAtEdge(edge) {
    const pad = this.padding();
    const padY = edge === 'top' ? pad.top : pad.bottom;
    this.scroller.scrollTop = edge === 'top'
      ? padY
      : this.scroller.scrollHeight - this.scroller.clientHeight - padY;
    this.scroller.scrollLeft = (this.scroller.scrollWidth - this.scroller.clientWidth) / 2;
  }

  /**
   * Jumps to a page by id. In a stack that means scrolling to it, keeping the
   * pages already drawn; one page at a time means swapping the page over.
   */
  goTo(id) {
    const page = this.ws.pageById(id);
    if (!page) return false;
    this.currentPageId = id;
    if (this.layout === 'continuous') {
      this.scrollToPage(id);
      this.syncNav();
    } else {
      this.render().then(() => this.restAtEdge('top'));
    }
    this.handlers.onPageChange?.(page);
    return true;
  }

  scrollToPage(id, behavior = 'smooth') {
    const frame = this.frames.get(id);
    if (frame) this.scroller.scrollTo({ top: frame.offsetTop - PAGE_GAP, behavior });
  }

  /**
   * Keeps the page number honest while scrolling through a stack. Watching for
   * pages coming into view is not enough on its own: once they are all drawn,
   * nothing fires again and the number would sit still while the pages move.
   */
  wireScroll() {
    let pending = false;
    this.scroller.addEventListener('scroll', () => {
      if (this.layout !== 'continuous' || pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        this.setCurrentFromScroll();
      }, 80);
    }, { passive: true });
  }

  /** Whichever page covers the middle of the window is the one being read. */
  setCurrentFromScroll() {
    const middle = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let best = null;
    for (const [id, frame] of this.frames) {
      if (frame.offsetTop <= middle && frame.offsetTop + frame.offsetHeight >= middle) best = id;
    }
    if (best && best !== this.currentPageId) {
      this.currentPageId = best;
      this.syncNav();
      this.handlers.onPageChange?.(this.ws.pageById(best));
    }
  }

  step(delta) {
    const index = this.ws.indexOf(this.currentPageId);
    const next = this.ws.pages[index + delta];
    if (!next) return false;

    this.currentPageId = next.id;
    if (this.layout === 'single') {
      // Sized only once the render has laid the new page out, so the resting
      // place is worked out after applyPanRoom has set the margins.
      this.render().then(() => this.restAtEdge(delta > 0 ? 'top' : 'bottom'));
    } else {
      this.scrollToPage(next.id);
    }
    this.syncNav();
    this.handlers.onPageChange?.(next);
    return true;
  }

  // ------------------------------------------------------------------ input

  wireWheel() {
    this.scroller.addEventListener('wheel', (event) => {
      // Ctrl or the pinch gesture zooms, as everywhere else.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        this.zoomBy(event.deltaY < 0 ? 1 : -1);
        return;
      }

      const canScrollSideways = this.scroller.scrollWidth > this.scroller.clientWidth + 2;

      // Shift turns a vertical wheel into a horizontal one. Browsers do this for
      // ordinary scrollers already, but not once the content fits vertically.
      if (event.shiftKey && event.deltaX === 0 && canScrollSideways) {
        event.preventDefault();
        this.scroller.scrollLeft += event.deltaY;
        return;
      }

      /*
       * A tilt wheel moves the page sideways, and only sideways — the same thing
       * Shift and the wheel do. It never turns the page: tilting is a way of
       * looking along a wide sheet, and having it jump to the next page at the
       * margin would take the document away mid-sentence.
       */
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        if (!canScrollSideways) return;
        event.preventDefault();
        this.scroller.scrollLeft += event.deltaX;
        return;
      }

      /*
       * The whole sheet is visible and there is nothing to scroll, so the wheel
       * would otherwise do nothing at all. Turning the page is what the gesture
       * means at that point.
       */
      if (this.layout === 'single' && !this.canScroll() && Math.abs(event.deltaY) > 0) {
        event.preventDefault();
        const now = performance.now();
        // Trackpads emit a stream of small deltas; one page per gesture.
        if (now - (this.lastPageTurn ?? 0) < 220) return;
        if (this.step(event.deltaY > 0 ? 1 : -1)) this.lastPageTurn = now;
        return;
      }

      // In single layout, scrolling past the end moves on to the next page.
      if (this.layout === 'single') {
        const atBottom = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 2;
        const atTop = this.scroller.scrollTop <= 2;
        const now = performance.now();
        if ((event.deltaY > 0 && atBottom) || (event.deltaY < 0 && atTop)) {
          if (now - (this.lastPageTurn ?? 0) < 320) return;
          if (this.step(event.deltaY > 0 ? 1 : -1)) {
            event.preventDefault();
            this.lastPageTurn = now;
          }
        }
      }
    }, { passive: false });
  }

  /** Middle button held down drags the page around, like a hand tool. */
  wireMiddleDrag() {
    this.scroller.addEventListener('pointerdown', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const fromLeft = this.scroller.scrollLeft;
      const fromTop = this.scroller.scrollTop;
      this.scroller.setPointerCapture(event.pointerId);
      this.root.classList.add('is-panning');

      const onMove = (move) => {
        this.scroller.scrollLeft = fromLeft - (move.clientX - startX);
        this.scroller.scrollTop = fromTop - (move.clientY - startY);
      };
      const onUp = () => {
        this.scroller.releasePointerCapture(event.pointerId);
        this.scroller.removeEventListener('pointermove', onMove);
        this.scroller.removeEventListener('pointerup', onUp);
        this.root.classList.remove('is-panning');
      };
      this.scroller.addEventListener('pointermove', onMove);
      this.scroller.addEventListener('pointerup', onUp);
    });

    // Middle click otherwise opens the browser's own auto-scroll.
    this.scroller.addEventListener('auxclick', (event) => {
      if (event.button === 1) event.preventDefault();
    });
  }

  /**
   * @returns {boolean} whether the key was used
   *
   * Left and right turn the page, up and down move within it. They used to
   * share the job — sideways turned the page only while the whole sheet was
   * visible, and scrolled it downwards otherwise — which meant that zooming in
   * silently changed what the arrow keys did.
   */
  handleKey(event) {
    const step = 120;
    switch (event.key) {
      /*
       * Sideways moves along the page while there is page to move along, and
       * turns to the next one only once there is not.
       *
       * Zoomed in, the obvious meaning of "right" is the part of the sheet just
       * out of view, not the next sheet — and turning the page there also reset
       * the scroll, which read as the document lurching diagonally away.
       */
      case 'ArrowRight': return this.scrollSideways(1, step);
      case 'ArrowLeft': return this.scrollSideways(-1, step);
      case 'PageDown': return this.pageDown(1);
      case 'PageUp': return this.pageDown(-1);
      case 'ArrowDown': this.scroller.scrollTop += step; return true;
      case 'ArrowUp': this.scroller.scrollTop -= step; return true;
      case 'Home': this.scroller.scrollTop = 0; return true;
      case 'End': this.scroller.scrollTop = this.scroller.scrollHeight; return true;
      case '+': case '=': this.zoomBy(1); return true;
      case '-': this.zoomBy(-1); return true;
      case '0': this.setZoom(null); return true;
      default: return false;
    }
  }

  /**
   * Moves across the page, and turns to the next one at its edge.
   *
   * @param {number} direction -1 for left, 1 for right
   * @param {number} step how far to move, in pixels
   */
  scrollSideways(direction, step) {
    const s = this.scroller;
    const room = s.scrollWidth - s.clientWidth;
    const atEdge = direction > 0 ? s.scrollLeft >= room - 2 : s.scrollLeft <= 2;

    if (room > 2 && !atEdge) {
      s.scrollLeft += direction * step;
      return true;
    }
    return this.layout === 'single' ? this.step(direction) : this.pageDown(direction);
  }

  /**
   * A windowful at a time, carrying on to the next page at the end of this one.
   * What Page Down means in every other reader.
   */
  pageDown(direction) {
    const s = this.scroller;
    const atEnd = direction > 0
      ? s.scrollTop + s.clientHeight >= s.scrollHeight - 2
      : s.scrollTop <= 2;
    if (atEnd) {
      if (this.layout !== 'single') return false;
      return this.step(direction);
    }
    s.scrollTop += direction * s.clientHeight * 0.9;
    return true;
  }
}
