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
import { normalizeMarks } from '../core/annots.js';
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
    // Always editable: clicking into the middle of a box should put a caret
    // there, the way it does in any word processor. Moving the box happens from
    // its edge instead — see onBoxPointerDown.
    const text = h('span.abox__text', { contenteditable: 'true', spellcheck: 'false' });
    renderMarkedText(text, annot);

    const box = h('div.abox', {
      dataset: { id: annot.id },
      class: annot.id === this.selectedId ? 'is-selected' : '',
    }, h('div.abox__inner', text), ...HANDLES.map((dir) => h('span.abox__handle', { dataset: { dir } })));

    this.styleBox(box, annot);

    box.addEventListener('pointerdown', (event) => this.onBoxPointerDown(event, annot, box));
    box.addEventListener('pointermove', (event) => this.updateEdgeCursor(event, box));
    box.addEventListener('pointerleave', () => box.classList.remove('is-edge'));
    text.addEventListener('input', () => {
      const read = readMarkedText(text);
      annot.text = read.text;
      annot.marks = read.marks;
      this.handlers.onChange({ structural: false });
    });
    text.addEventListener('blur', () => this.handlers.onChange());
    // Typing inside a box must not reach the workspace shortcuts.
    text.addEventListener('keydown', (event) => event.stopPropagation());

    return box;
  }

  /** Character range currently selected inside the focused text box, if any. */
  selectionRange() {
    const box = this.overlay.querySelector(`.abox[data-id="${this.selectedId}"]`);
    const text = box?.querySelector('.abox__text');
    return text ? selectionOffsets(text) : null;
  }

  /** Redraws a box's text after its highlights changed from the panel. */
  refreshText(annot) {
    const box = this.overlay.querySelector(`.abox[data-id="${annot.id}"]`);
    const text = box?.querySelector('.abox__text');
    if (!text) return;
    const selection = selectionOffsets(text);
    renderMarkedText(text, annot);
    if (selection) restoreSelection(text, selection);
  }

  /** Shows the move cursor only in the grab band around the border. */
  updateEdgeCursor(event, box) {
    box.classList.toggle('is-edge', isNearEdge(event, box));
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
    });
    // Highlights are per-character-range now, carried by spans inside the text.
  }

  /** Applies style changes from the tool panel without rebuilding the overlay. */
  syncAnnot(annot) {
    const box = this.overlay.querySelector(`.abox[data-id="${annot.id}"]`);
    if (!box) return this.drawOverlay();
    this.styleBox(box, annot);
    const text = box.querySelector('.abox__text');
    // Never rewrite the text while the caret is in it — that would collapse the
    // selection mid-edit.
    if (document.activeElement !== text) renderMarkedText(text, annot);
  }

  onBoxPointerDown(event, annot, box) {
    this.select(annot.id);

    const dir = event.target.dataset?.dir;
    // The middle of a box belongs to the text: a press there places the caret or
    // starts a selection. Only the band around the border, and the handles, move
    // or resize the box.
    if (!dir && !isNearEdge(event, box)) return;

    event.preventDefault();
    event.stopPropagation();

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

// --------------------------------------------------------- marked-up text

/** Width of the band around a box's border that grabs it instead of the text. */
const EDGE_BAND = 9;

function isNearEdge(event, box) {
  const rect = box.getBoundingClientRect();
  // On a small box the band would swallow the whole thing, so it never takes
  // more than a third of either side.
  const bandX = Math.min(EDGE_BAND, rect.width / 3);
  const bandY = Math.min(EDGE_BAND, rect.height / 3);
  return event.clientX - rect.left < bandX
    || rect.right - event.clientX < bandX
    || event.clientY - rect.top < bandY
    || rect.bottom - event.clientY < bandY;
}

/**
 * Splits the text at every highlight boundary. Each piece is uniform, so it can
 * be one text node or one span.
 */
function segmentsOf(text, marks) {
  const bounds = new Set([0, text.length]);
  for (const mark of marks ?? []) {
    bounds.add(mark.start);
    bounds.add(mark.end);
  }
  const ordered = [...bounds].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const start = ordered[i];
    const end = ordered[i + 1];
    if (end <= start) continue;
    const mark = (marks ?? []).find((m) => m.start <= start && m.end >= end);
    segments.push({ text: text.slice(start, end), color: mark?.color ?? null });
  }
  return segments;
}

/** Paints `annot.text` into a contenteditable element, highlights and all. */
export function renderMarkedText(el, annot) {
  const text = String(annot.text ?? '');
  el.replaceChildren(...segmentsOf(text, annot.marks).map((segment) => {
    if (!segment.color) return document.createTextNode(segment.text);
    const span = document.createElement('span');
    span.dataset.hl = segment.color;
    span.style.background = segment.color;
    span.textContent = segment.text;
    return span;
  }));
  if (el.childNodes.length === 0) el.appendChild(document.createTextNode(''));
}

/**
 * Reads text and highlight ranges back out after the user has typed. The browser
 * is free to reshape contenteditable's DOM however it likes, so the ranges are
 * recovered from the surviving spans rather than tracked as edits happen.
 */
export function readMarkedText(root) {
  let text = '';
  const marks = [];

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const color = child.parentElement?.dataset?.hl || null;
        const start = text.length;
        text += child.nodeValue;
        if (color) marks.push({ start, end: text.length, color });
      } else if (child.nodeName === 'BR') {
        text += '\n';
      } else {
        // contenteditable wraps new paragraphs in divs; each starts a new line.
        const block = /^(DIV|P)$/.test(child.nodeName);
        if (block && text !== '' && !text.endsWith('\n')) text += '\n';
        walk(child);
      }
    }
  };
  walk(root);

  return { text, marks: normalizeMarks(marks, text) };
}

/** Character offset of a DOM position, counting the same way readMarkedText does. */
function offsetOf(root, node, offset) {
  let count = 0;
  let done = false;

  const walk = (current) => {
    if (done) return;
    if (current.nodeType === Node.TEXT_NODE) {
      if (current === node) {
        count += offset;
        done = true;
      } else {
        count += current.nodeValue.length;
      }
      return;
    }
    if (current.nodeName === 'BR') {
      count += 1;
      return;
    }
    for (let i = 0; i < current.childNodes.length; i++) {
      if (current === node && i === offset) {
        done = true;
        return;
      }
      walk(current.childNodes[i]);
      if (done) return;
    }
    if (current === node) done = true;
  };

  walk(root);
  return count;
}

/** The selection inside `root` as character offsets, or null if there is none. */
export function selectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const a = offsetOf(root, range.startContainer, range.startOffset);
  const b = offsetOf(root, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Puts the caret back after the text was re-rendered from scratch. */
function restoreSelection(root, { start, end }) {
  const locate = (target) => {
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const node = stack.shift();
      if (node.nodeType === Node.TEXT_NODE) {
        if (seen + node.nodeValue.length >= target) return { node, offset: target - seen };
        seen += node.nodeValue.length;
      } else {
        stack.unshift(...node.childNodes);
      }
    }
    return null;
  };

  const from = locate(start);
  const to = locate(end);
  if (!from || !to) return;

  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
