/**
 * The editing layer: text boxes and the crop rectangle, drawn over a page.
 *
 * Deliberately knows nothing about how the page beneath it got there. It is
 * handed an element to fill and two questions it may ask — how big the page is
 * at the moment, and where on screen it sits — which is all the editing gestures
 * need. That is what lets the same layer sit on the single-page editor and on a
 * page in the viewer, rather than editing being a place you have to go to.
 *
 * Everything inside is positioned in percentages of the whole page, so the layer
 * is correct at any scale without being told about zoom at all.
 */
import { h, icon } from '../util/dom.js';
import { cssFamilyFor } from '../core/fonts.js';
import { normalizeMarks } from '../core/annots.js';
import { normalizeCrop } from '../core/geometry.js';
import { clamp } from '../util/format.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export class AnnotationLayer {
  /**
   * @param {object} options
   * @param {HTMLElement} options.el element to draw into; the layer fills it
   * @param {{
   *   onChange: (opts?: {structural?: boolean}) => void,
   *   onSelectAnnot?: (annot: object|null) => void,
   *   onDeleteAnnot?: (annot: object) => void,
   *   onCommitText?: (annot: object, after: object) => void,
   * }} options.handlers
   * @param {() => {width: number, height: number}} options.pageBox the page's
   *   size on screen, used to turn a drag in pixels into a fraction of the page
   */
  constructor({ el, handlers, pageBox }) {
    this.el = el;
    this.handlers = handlers;
    this.pageBox = pageBox;
    this.page = null;
    this.mode = 'select';
    this.selectedId = null;
    this.pendingCrop = null;
  }

  get annots() {
    return this.page?.annots ?? [];
  }

  setPage(page) {
    if (this.page?.id !== page?.id) this.selectedId = null;
    this.page = page;
  }

  setMode(mode) {
    this.mode = mode;
    this.draw();
  }

  selectedAnnot() {
    return this.annots.find((a) => a.id === this.selectedId) ?? null;
  }

  select(id) {
    this.selectedId = id;
    for (const box of this.el.querySelectorAll('.abox')) {
      box.classList.toggle('is-selected', box.dataset.id === id);
    }
    this.handlers.onSelectAnnot?.(this.selectedAnnot());
  }

  draw() {
    this.el.replaceChildren();
    if (!this.page) return;

    if (this.mode === 'crop') {
      this.el.appendChild(this.cropUi());
      return;
    }
    for (const annot of this.annots) this.el.appendChild(this.annotBox(annot));
  }

  // ------------------------------------------------------------- text boxes

  annotBox(annot) {
    // Always editable: clicking into the middle of a box should put a caret
    // there, the way it does in any word processor. Moving the box happens from
    // its edge instead — see onBoxPointerDown.
    const text = h('span.abox__text', { contenteditable: 'true', spellcheck: 'false' });
    renderMarkedText(text, annot);

    /*
     * Deleting happens on pointerdown, not on click.
     *
     * Pressing the button blurs the text first, which commits the edit, which
     * redraws the overlay — so by the time a click would fire, this button no
     * longer exists and nothing happens. Acting on the press avoids that race
     * entirely. The click handler stays for keyboard use, where there is no
     * pointerdown at all.
     */
    let deleted = false;
    const doDelete = (event) => {
      event.stopPropagation();
      if (deleted) return;
      deleted = true;
      this.handlers.onDeleteAnnot?.(annot);
    };

    const remove = h('button.abox__delete', {
      type: 'button',
      title: 'Delete this text box',
      'aria-label': 'Delete this text box',
      onpointerdown: doDelete,
      onclick: doDelete,
    }, icon([
      'M3 6h18',
      'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
      'M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    ], { size: 13, stroke: 1.9 }));

    const box = h('div.abox', {
      dataset: { id: annot.id },
      class: annot.id === this.selectedId ? 'is-selected' : '',
    }, h('div.abox__inner', text), remove, ...HANDLES.map((dir) => h('span.abox__handle', { dataset: { dir } })));

    this.styleBox(box, annot);

    box.addEventListener('pointerdown', (event) => this.onBoxPointerDown(event, annot, box));
    box.addEventListener('pointermove', (event) => box.classList.toggle('is-edge', isNearEdge(event, box)));
    box.addEventListener('pointerleave', () => box.classList.remove('is-edge'));

    // Typing is not committed keystroke by keystroke — that would bury every
    // other action under hundreds of undo steps. The state at focus is kept so
    // that one edit session becomes one entry when the caret leaves.
    let editedFrom = null;

    text.addEventListener('focus', () => {
      editedFrom = { text: annot.text, marks: annot.marks.map((m) => ({ ...m })) };
    });

    text.addEventListener('input', () => {
      const read = readMarkedText(text);
      annot.text = read.text;
      annot.marks = read.marks;
      this.handlers.onChange({ structural: false });
    });

    text.addEventListener('blur', () => {
      const before = editedFrom;
      editedFrom = null;
      if (!before || before.text === annot.text) {
        this.handlers.onChange();
        return;
      }
      // Rewind, then commit forward, so the history entry has a proper "before".
      const after = { text: annot.text, marks: annot.marks };
      annot.text = before.text;
      annot.marks = before.marks;
      this.handlers.onCommitText?.(annot, after);
    });

    return box;
  }

  /**
   * Puts the caret in a box's text.
   * @param {object} annot
   * @param {{at?: 'end'|'all'}} opts
   */
  focusText(annot, { at = 'end' } = {}) {
    const text = this.textOf(annot.id);
    if (!text) return;

    this.select(annot.id);
    text.focus({ preventScroll: true });
    const length = readMarkedText(text).text.length;
    restoreSelection(text, at === 'all' ? { start: 0, end: length } : { start: length, end: length });
  }

  textOf(id) {
    return this.el.querySelector(`.abox[data-id="${id}"] .abox__text`) ?? null;
  }

  /** True when the caret is inside this layer's text. */
  isEditingText() {
    const active = document.activeElement;
    return Boolean(active?.classList?.contains('abox__text') && this.el.contains(active));
  }

  /** Character range currently selected inside the focused text box, if any. */
  selectionRange() {
    const text = this.textOf(this.selectedId);
    return text ? selectionOffsets(text) : null;
  }

  /** Redraws a box's text after its highlights changed from the panel. */
  refreshText(annot) {
    const text = this.textOf(annot.id);
    if (!text) return;
    const selection = selectionOffsets(text);
    renderMarkedText(text, annot);
    if (selection) restoreSelection(text, selection);
  }

  styleBox(box, annot) {
    // Sizes are in page points, not screen pixels: the whole layer is scaled by
    // a CSS transform, so multiplying here as well would scale everything twice.
    Object.assign(box.style, {
      left: `${annot.x * 100}%`,
      top: `${annot.y * 100}%`,
      width: `${annot.w * 100}%`,
      height: `${annot.h * 100}%`,
      transform: annot.rotate ? `rotate(${annot.rotate}deg)` : '',
      opacity: String(annot.opacity ?? 1),
      background: annot.bgColor ?? 'transparent',
      border: annot.border?.width > 0 ? `${annot.border.width}px solid ${annot.border.color}` : '',
      padding: `${annot.padding ?? 0}px`,
    });

    const inner = box.querySelector('.abox__inner');
    Object.assign(inner.style, {
      textAlign: annot.align,
      justifyContent: annot.valign === 'middle' ? 'center' : annot.valign === 'bottom' ? 'flex-end' : 'flex-start',
    });

    const text = box.querySelector('.abox__text');
    Object.assign(text.style, {
      fontFamily: cssFamilyFor(annot.family),
      fontSize: `${annot.size}px`,
      lineHeight: String(annot.lineSpacing ?? 1.25),
      color: annot.color,
      fontWeight: annot.bold ? '700' : '400',
      fontStyle: annot.italic ? 'italic' : 'normal',
    });
  }

  /** Applies style changes from the tool panel without rebuilding the overlay. */
  syncAnnot(annot) {
    const box = this.el.querySelector(`.abox[data-id="${annot.id}"]`);
    if (!box) return this.draw();
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
    if (!dir && !isNearEdge(event, box)) {
      // Landing on a glyph lets the browser put the caret exactly there. Landing
      // on the empty part of the box would otherwise do nothing at all, so the
      // caret goes after the last character and typing can simply continue.
      if (!event.target.closest('.abox__text')) {
        event.preventDefault();
        this.focusText(annot, { at: 'end' });
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    // Grabbing the edge means "I am handling the box, not its text". Dropping
    // focus makes that unambiguous, and is what lets Delete remove the box.
    box.querySelector('.abox__text')?.blur();

    // Positions are fractions of the whole page, so the drag is measured against
    // the page, not against the (possibly cropped) part on show.
    const rect = this.pageBox();
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

  // ------------------------------------------------------------------ crop

  cropUi() {
    const crop = this.pendingCrop ?? this.page.crop ?? { left: 0.06, top: 0.06, right: 0.94, bottom: 0.94 };
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
      const bounds = this.pageBox();
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
    this.draw();
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
