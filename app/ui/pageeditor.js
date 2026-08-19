/**
 * Single-page editor: the surface behind Write, Stamps, Watermark and Crop.
 *
 * The page itself is a canvas rendered *without* annotations; every annotation
 * is a DOM box on top. That makes dragging, resizing and typing feel native, and
 * keeps the canvas free to be the honest preview of what will be exported (the
 * grid thumbnails render the same page through the real pipeline).
 */
import { h, clear, icon } from '../util/dom.js';

import { renderPageCanvas } from '../core/render.js';
import { totalQuarter } from '../core/geometry.js';
import { appendOcrText } from './ocrlayer.js';
import { AnnotationLayer } from './annotlayer.js';
import { TextLayer } from '../../vendor/pdf.mjs';

export class PageEditor {
  /**
   * @param {HTMLElement} root
   * @param {import('../core/workspace.js').Workspace} ws
   * @param {{onChange: (opts?: {structural?: boolean}) => void, onSelectAnnot: (annot|null) => void}} handlers
   */
  constructor(root, ws, handlers) {
    this.root = root;
    this.ws = ws;
    this.handlers = handlers;
    this.page = null;
    this.mode = 'select';
    this.scale = 1;
    this.renderToken = 0;

    this.stage = h('div.editor__stage');
    this.canvasHost = h('div.editor__canvas');
    // Transparent, selectable copies of the page's words, sitting between the
    // bitmap and the annotations — the same trick Chrome's own PDF viewer uses.
    this.textHost = h('div.textlayer');
    // Sits above the page and below the annotations: it is a check on the OCR
    // result, so it has to be visible over the ink it claims to describe.
    this.inspectHost = h('div.inspectlayer');
    this.overlay = h('div.editor__overlay');
    /*
     * The editing itself lives in a layer that knows nothing about this class —
     * only how big the page is on screen. That is what lets the same editing sit
     * on a page in the viewer, so a tool is something you use where you are
     * rather than somewhere you have to go.
     */
    this.layer = new AnnotationLayer({
      el: this.overlay,
      handlers,
      pageBox: () => ({ width: this.pageWidth * this.scale, height: this.pageHeight * this.scale }),
    });
    this.stage.append(this.canvasHost, this.textHost, this.inspectHost, this.overlay);
    // Paging arrows at the edges of the view, where the mouse already is when
    // you are reading a page — the pair in the toolbar is a long way from there.
    this.prevNav = this.navButton('prev', 'M15 18 9 12l6-6', -1);
    this.nextNav = this.navButton('next', 'M9 18l6-6-6-6', 1);

    /*
     * The arrows are siblings of the viewport, not children of it. Inside a
     * scrollable box, `top: 50%` measures against the scrollable content rather
     * than the part you can see, so on a tall page they would sit off-screen.
     */
    this.viewport = h('div.editor__viewport', this.stage);
    clear(root).append(this.viewport, this.prevNav, this.nextNav);

    // The overlay lets clicks through so text underneath stays selectable, so
    // "click the page to deselect" has to be caught on the stage instead.
    this.stage.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.abox')) this.select(null);
    });
    this.onResize = () => this.fit();
    window.addEventListener('resize', this.onResize);
  }

  /**
   * The chevron is drawn, not typed. A text glyph like › is centred by its line
   * box rather than by its own shape, so it sits visibly off-centre — and by a
   * different amount depending on the font the machine happens to use.
   */
  navButton(side, path, delta) {
    return h(`button.editor__nav.editor__nav--${side}`, {
      type: 'button',
      title: side === 'prev' ? 'Previous page (left arrow)' : 'Next page (right arrow)',
      'aria-label': side === 'prev' ? 'Previous page' : 'Next page',
      onclick: () => this.handlers.onStepPage?.(delta),
    }, icon(path, { size: 22, stroke: 2 }));
  }

  /** Greys out the arrow that would run off the end of the document. */
  syncNav() {
    const index = this.page ? this.ws.indexOf(this.page.id) : -1;
    const single = this.ws.pageCount <= 1;
    this.prevNav.disabled = single || index <= 0;
    this.nextNav.disabled = single || index < 0 || index >= this.ws.pageCount - 1;
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
  }

  async open(page) {
    this.page = page;
    this.layer.setPage(page);
    await this.refresh();
  }

  /**
   * Points the editor at the current object for the page it is showing.
   *
   * Undo and redo restore *clones*, so the object the editor was holding stops
   * being the one in the document. Without re-binding, everything after an undo
   * would be edited into a copy nobody looks at.
   */
  async rebind(page) {
    if (!page) return;
    this.page = page;
    this.layer.setPage(page);
    await this.refresh();
  }

  setMode(mode) {
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.drawOverlay();
  }

  get annots() {
    return this.page?.annots ?? [];
  }

  /** Re-renders the page bitmap; call after edits that change the page itself. */
  async refresh() {
    if (!this.page) return;
    const token = ++this.renderToken;

    // Crop is ignored while cropping so the whole page stays adjustable.
    const pageForRender = this.mode === 'crop' ? { ...this.page, crop: null, annots: [] } : { ...this.page, annots: [] };

    const { canvas, mapper } = await renderPageCanvas(this.ws, pageForRender, {
      scale: 1.6 * (window.devicePixelRatio || 1),
      withAnnots: false,
    });
    if (token !== this.renderToken) return;

    // Two sizes matter, and conflating them is what made cropped pages look
    // stretched: the stage shows the *visible window*, while annotations and the
    // text layer are laid out against the *whole page* and shifted into place.
    this.viewWidth = mapper.outWidth;
    this.viewHeight = mapper.outHeight;
    this.pageWidth = mapper.displayWidth;
    this.pageHeight = mapper.displayHeight;
    this.window = mapper.window;
    canvas.className = 'editor__bitmap';
    clear(this.canvasHost).appendChild(canvas);

    this.fit();
    this.syncNav();
    this.drawOverlay();
    this.drawInspection();
    this.buildTextLayer(pageForRender, token).catch((err) => console.error('text layer failed', err));
  }

  /** Colours what OCR added against what the PDF already carried. */
  setInspect(on) {
    this.inspect = Boolean(on);
    this.drawInspection();
  }

  drawInspection() {
    clear(this.inspectHost);
    if (!this.inspect || !this.page) return;

    const groups = [
      ['existing', this.page.meta?.ocrTextBoxesList ?? []],
      ['ocr', (this.page.ocr?.words ?? []).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, text: w.text }))],
    ];

    for (const [kind, boxes] of groups) {
      for (const box of boxes) {
        this.inspectHost.appendChild(h(`div.inspectbox.inspectbox--${kind}`, {
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
   * Lays the page's text over the bitmap so it can be selected and copied.
   *
   * Only source PDFs have text to offer: a page that has been rasterised by
   * compression or upscaling is a picture, and a scan never had any.
   */
  async buildTextLayer(page, token) {
    clear(this.textHost);
    const source = this.ws.source(page);
    const hasOcr = Boolean(page.ocr?.words?.length);
    // A rasterised page has no text objects left, but it may well have
    // recognised text — so the layer is still worth building.
    const hasPdfText = source?.kind === 'pdf' && !page.rasterId;
    if (!hasPdfText && !hasOcr) return;

    // Built at scale 1 and then scaled with a CSS transform, so resizing the
    // window is a transform change rather than a full re-layout of every word.
    this.textHost.style.setProperty('--scale-factor', '1');
    this.textHost.style.width = `${this.pageWidth}px`;
    this.textHost.style.height = `${this.pageHeight}px`;

    if (hasPdfText) {
      const pdfPage = await source.doc.getPage(page.srcIndex + 1);
      if (token !== this.renderToken) return;
      const viewport = pdfPage.getViewport({ scale: 1, rotation: totalQuarter(page) });
      await new TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: this.textHost,
        viewport,
      }).render();
      if (token !== this.renderToken) {
        clear(this.textHost);
        return;
      }
    }

    if (hasOcr) appendOcrText(this.textHost, page, this.pageWidth, this.pageHeight);
    this.placeLayers();
  }

  /** Sizes the stage so the visible part of the page fits the available area. */
  fit() {
    if (!this.viewWidth) return;

    /*
     * Measured against the viewport's content box, so the CSS padding is the
     * only place the margin around the page is decided — including the wider
     * left and right margins that keep the paging arrows off the page. Repeating
     * that number here as well is how they ended up overlapping.
     */
    const style = getComputedStyle(this.viewport);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const scale = Math.min(
      (this.viewport.clientWidth - padX) / this.viewWidth,
      (this.viewport.clientHeight - padY) / this.viewHeight,
    );
    this.scale = Math.max(0.05, scale || 0.5);
    this.stage.style.width = `${this.viewWidth * this.scale}px`;
    this.stage.style.height = `${this.viewHeight * this.scale}px`;
    this.placeLayers();
  }

  /**
   * Text and annotations both live in full-page coordinates, so each layer is
   * the size of the whole page and slid so the crop window lines up with the
   * bitmap underneath.
   */
  placeLayers() {
    const s = this.scale;
    const win = this.window ?? { x: 0, y: 0 };
    const transform = `translate(${-win.x * s}px, ${-win.y * s}px) scale(${s})`;
    for (const layer of [this.textHost, this.inspectHost, this.overlay]) {
      layer.style.width = `${this.pageWidth}px`;
      layer.style.height = `${this.pageHeight}px`;
      layer.style.transform = transform;
    }
    // Handles and the delete button are chrome, not content: they would shrink
    // with the page otherwise and become unclickable at low zoom.
    this.overlay.style.setProperty('--inv-scale', String(1 / s));
  }

  // -------------------------------------------------------------- overlay

  // ------------------------------------------------- the editing layer

  /*
   * Text boxes and the crop rectangle live in AnnotationLayer, which knows only
   * how big the page is and where it sits. Everything below hands its own
   * questions on to that layer, so this class is left doing what is genuinely
   * its own: drawing the page, and the paging around it.
   */

  drawOverlay() {
    this.layer.setPage(this.page);
    this.layer.setMode(this.mode);
  }

  selectedAnnot() { return this.layer.selectedAnnot(); }
  select(id) { this.layer.select(id); }
  focusText(annot, opts) { this.layer.focusText(annot, opts); }
  isEditingText() { return this.layer.isEditingText(); }
  selectionRange() { return this.layer.selectionRange(); }
  refreshText(annot) { this.layer.refreshText(annot); }
  syncAnnot(annot) { this.layer.syncAnnot(annot); }
  currentCrop() { return this.layer.currentCrop(); }
  setCrop(crop) { this.layer.setCrop(crop); }

  get selectedId() { return this.layer.selectedId; }
}

