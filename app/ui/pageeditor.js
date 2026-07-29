/**
 * Single-page editor: the surface behind Write, Stamps, Watermark and Crop.
 *
 * The page itself is a canvas rendered *without* annotations; every annotation
 * is a DOM box on top. That makes dragging, resizing and typing feel native, and
 * keeps the canvas free to be the honest preview of what will be exported (the
 * grid thumbnails render the same page through the real pipeline).
 */
import { h, clear } from '../util/dom.js';
import { renderPageCanvas } from '../core/render.js';
import { cssFamilyFor } from '../core/fonts.js';
import { normalizeCrop } from '../core/geometry.js';
import { clamp } from '../util/format.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

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
    this.selectedId = null;
    this.scale = 1;
    this.renderToken = 0;

    this.stage = h('div.editor__stage');
    this.canvasHost = h('div.editor__canvas');
    this.overlay = h('div.editor__overlay');
    this.stage.append(this.canvasHost, this.overlay);
    this.viewport = h('div.editor__viewport', this.stage);
    clear(root).appendChild(this.viewport);

    this.overlay.addEventListener('pointerdown', (event) => {
      if (event.target === this.overlay) this.select(null);
    });
    this.onResize = () => this.fit();
    window.addEventListener('resize', this.onResize);
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
  }

  async open(page) {
    this.page = page;
    this.selectedId = null;
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

  selectedAnnot() {
    return this.annots.find((a) => a.id === this.selectedId) ?? null;
  }

  select(id) {
    this.selectedId = id;
    for (const el of this.overlay.querySelectorAll('.abox')) {
      el.classList.toggle('is-selected', el.dataset.id === id);
    }
    this.handlers.onSelectAnnot(this.selectedAnnot());
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

    this.pageWidth = mapper.displayWidth;
    this.pageHeight = mapper.displayHeight;
    canvas.className = 'editor__bitmap';
    clear(this.canvasHost).appendChild(canvas);

    this.fit();
    this.drawOverlay();
  }

  /** Sizes the stage so the page fits the available area. */
  fit() {
    if (!this.pageWidth) return;
    const box = this.viewport.getBoundingClientRect();
    const padding = 48;
    const scale = Math.min(
      (box.width - padding) / this.pageWidth,
      (box.height - padding) / this.pageHeight,
    );
    this.scale = Math.max(0.05, scale || 0.5);
    this.stage.style.width = `${this.pageWidth * this.scale}px`;
    this.stage.style.height = `${this.pageHeight * this.scale}px`;
  }

  // -------------------------------------------------------------- overlay

  drawOverlay() {
    clear(this.overlay);
    if (!this.page) return;

    if (this.mode === 'crop') {
      this.overlay.appendChild(this.cropUi());
      return;
    }
    for (const annot of this.annots) this.overlay.appendChild(this.annotBox(annot));
  }

  annotBox(annot) {
    const text = h('span.abox__text', { contenteditable: 'false', spellcheck: 'false' });
    text.textContent = annot.text;

    const box = h('div.abox', {
      dataset: { id: annot.id },
      class: annot.id === this.selectedId ? 'is-selected' : '',
    }, h('div.abox__inner', text), ...HANDLES.map((dir) => h('span.abox__handle', { dataset: { dir } })));

    this.styleBox(box, annot);

    box.addEventListener('pointerdown', (event) => this.onBoxPointerDown(event, annot, box, text));
    box.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.beginTextEdit(annot, box, text);
    });
    text.addEventListener('input', () => {
      annot.text = text.innerText.replace(/ /g, ' ');
      this.handlers.onChange({ structural: false });
    });
    text.addEventListener('blur', () => {
      text.contentEditable = 'false';
      box.classList.remove('is-editing');
      this.handlers.onChange();
    });

    return box;
  }

  styleBox(box, annot) {
    const s = this.scale;
    Object.assign(box.style, {
      left: `${annot.x * 100}%`,
      top: `${annot.y * 100}%`,
      width: `${annot.w * 100}%`,
      height: `${annot.h * 100}%`,
      transform: annot.rotate ? `rotate(${annot.rotate}deg)` : '',
      opacity: String(annot.opacity ?? 1),
      background: annot.bgColor ?? 'transparent',
      border: annot.border?.width > 0 ? `${Math.max(1, annot.border.width * s)}px solid ${annot.border.color}` : '',
      padding: `${(annot.padding ?? 0) * s}px`,
    });

    const inner = box.querySelector('.abox__inner');
    Object.assign(inner.style, {
      textAlign: annot.align,
      justifyContent: annot.valign === 'middle' ? 'center' : annot.valign === 'bottom' ? 'flex-end' : 'flex-start',
    });

    const text = box.querySelector('.abox__text');
    Object.assign(text.style, {
      fontFamily: cssFamilyFor(annot.family),
      fontSize: `${annot.size * s}px`,
      lineHeight: String(annot.lineSpacing ?? 1.25),
      color: annot.color,
      fontWeight: annot.bold ? '700' : '400',
      fontStyle: annot.italic ? 'italic' : 'normal',
      background: annot.highlight ?? 'transparent',
    });
  }

  /** Applies style changes from the tool panel without rebuilding the overlay. */
  syncAnnot(annot) {
    const box = this.overlay.querySelector(`.abox[data-id="${annot.id}"]`);
    if (!box) return this.drawOverlay();
    this.styleBox(box, annot);
    const text = box.querySelector('.abox__text');
    if (text.innerText !== annot.text && document.activeElement !== text) text.textContent = annot.text;
  }

  beginTextEdit(annot, box, text) {
    text.contentEditable = 'true';
    box.classList.add('is-editing');
    text.focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  onBoxPointerDown(event, annot, box, text) {
    if (box.classList.contains('is-editing')) return; // let the caret work
    event.stopPropagation();
    this.select(annot.id);

    const dir = event.target.dataset?.dir;
    const rect = this.stage.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const origin = { x: annot.x, y: annot.y, w: annot.w, h: annot.h };

    const onMove = (move) => {
      const dx = (move.clientX - start.x) / rect.width;
      const dy = (move.clientY - start.y) / rect.height;

      if (!dir) {
        annot.x = clamp(origin.x + dx, -0.5, 1.5);
        annot.y = clamp(origin.y + dy, -0.5, 1.5);
      } else {
        if (dir.includes('w')) {
          const right = origin.x + origin.w;
          annot.x = Math.min(origin.x + dx, right - 0.02);
          annot.w = right - annot.x;
        }
        if (dir.includes('e')) annot.w = Math.max(0.02, origin.w + dx);
        if (dir.includes('n')) {
          const bottom = origin.y + origin.h;
          annot.y = Math.min(origin.y + dy, bottom - 0.02);
          annot.h = bottom - annot.y;
        }
        if (dir.includes('s')) annot.h = Math.max(0.02, origin.h + dy);
      }
      this.styleBox(box, annot);
      this.handlers.onChange({ structural: false });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.handlers.onChange();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ----------------------------------------------------------------- crop

  cropUi() {
    const crop = this.page.crop ?? { left: 0.06, top: 0.06, right: 0.94, bottom: 0.94 };
    const rect = h('div.crop', ...HANDLES.map((dir) => h('span.crop__handle', { dataset: { dir } })));
    const shade = h('div.crop__shade');
    const apply = () => {
      Object.assign(rect.style, {
        left: `${crop.left * 100}%`,
        top: `${crop.top * 100}%`,
        width: `${(crop.right - crop.left) * 100}%`,
        height: `${(crop.bottom - crop.top) * 100}%`,
      });
      // Four-sided mask, drawn as one inset shadow region.
      shade.style.clipPath = `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
        ${crop.left * 100}% ${crop.top * 100}%,
        ${crop.left * 100}% ${crop.bottom * 100}%,
        ${crop.right * 100}% ${crop.bottom * 100}%,
        ${crop.right * 100}% ${crop.top * 100}%,
        ${crop.left * 100}% ${crop.top * 100}%)`;
    };
    apply();

    rect.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      const dir = event.target.dataset?.dir;
      const bounds = this.stage.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const origin = { ...crop };

      const onMove = (move) => {
        const dx = (move.clientX - start.x) / bounds.width;
        const dy = (move.clientY - start.y) / bounds.height;
        if (!dir) {
          const w = origin.right - origin.left;
          const hgt = origin.bottom - origin.top;
          crop.left = clamp(origin.left + dx, 0, 1 - w);
          crop.top = clamp(origin.top + dy, 0, 1 - hgt);
          crop.right = crop.left + w;
          crop.bottom = crop.top + hgt;
        } else {
          if (dir.includes('w')) crop.left = clamp(origin.left + dx, 0, origin.right - 0.02);
          if (dir.includes('e')) crop.right = clamp(origin.right + dx, origin.left + 0.02, 1);
          if (dir.includes('n')) crop.top = clamp(origin.top + dy, 0, origin.bottom - 0.02);
          if (dir.includes('s')) crop.bottom = clamp(origin.bottom + dy, origin.top + 0.02, 1);
        }
        apply();
        this.pendingCrop = { ...crop };
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.pendingCrop = { ...crop };
        this.handlers.onChange({ structural: false });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    this.pendingCrop = { ...crop };
    return h('div.crop__layer', shade, rect);
  }

  /** The crop rectangle currently drawn, normalized; null when it covers everything. */
  currentCrop() {
    return normalizeCrop(this.pendingCrop);
  }

  setCrop(crop) {
    this.pendingCrop = crop ? { ...crop } : null;
    this.drawOverlay();
  }
}
