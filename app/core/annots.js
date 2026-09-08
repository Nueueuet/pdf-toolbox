/**
 * Annotations: the text boxes produced by Write, Stamps and Watermark, and the
 * strokes produced by the pen.
 *
 * Layout is computed once, in display points relative to the visible page
 * window, and then consumed by both the canvas preview and the pdf-lib
 * exporter. Keeping a single layout pass is what makes the preview trustworthy.
 */
import { wrapText, widthOf, lineHeightOf, cssFamilyFor, sanitize } from './fonts.js';
import { fillDateWithMarks } from './counter.js';
import { uid } from '../util/format.js';

export const DEFAULT_ANNOT = {
  role: 'text',
  x: 0.1,
  y: 0.1,
  w: 0.4,
  h: 0.12,
  text: 'Text',
  family: 'Helvetica',
  size: 14,
  bold: false,
  italic: false,
  color: '#111827',
  align: 'left',
  valign: 'top',
  lineSpacing: 1.25,
  padding: 4,
  /**
   * Highlighted character ranges: [{ start, end, color }], half-open, indexing
   * into `text`. A range rather than a flag on the whole box, because
   * highlighting means "these words", the way it does in a word processor.
   */
  marks: [],
  bgColor: null,
  border: null,
  opacity: 1,
  rotate: 0,
};

/**
 * A stroke of the pen, as one annotation.
 *
 * One stroke each rather than one drawing per page: a stroke is what was made
 * in a single movement, so it is also what a person means by "that one" — the
 * thing to undo, or to rub out. Points are fractions of the page, like
 * everything else here, so a signature stays where it was put at any zoom and
 * on any screen.
 *
 * @param {{x: number, y: number}[]} points
 * @param {{color?: string, width?: number, opacity?: number}} [style] width in
 *   points, as a pen's nib is quoted
 */
export function makeInk(points, style = {}) {
  const clean = simplifyStroke(points);
  return makeAnnot({
    role: 'ink',
    points: clean,
    color: style.color ?? '#111827',
    width: style.width ?? 2,
    opacity: style.opacity ?? 1,
    ...inkBounds(clean),
  });
}

/** The smallest box the stroke fits in, so it can be handled like any other. */
export function inkBounds(points) {
  if (!points?.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Drops the points that say nothing.
 *
 * A pointer reports a position every few milliseconds, which for a slow, careful
 * signature is hundreds of points within a millimetre of each other. Each one
 * becomes a line in the saved file, so a page of handwriting would carry tens of
 * thousands of them for a picture indistinguishable from a tenth as many. Kept
 * are the points that move the pen at least a fifth of a millimetre, and always
 * the last one, which is where the pen was lifted.
 */
export function simplifyStroke(points, least = 0.0005) {
  const kept = [];
  for (const point of points ?? []) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= least) kept.push({ x: point.x, y: point.y });
  }
  // The last point is where the pen was lifted, which is part of the shape —
  // unless it is already the last one kept, as it is for a single tap.
  const final = points?.[points.length - 1];
  const last = kept[kept.length - 1];
  if (final && (!last || last.x !== final.x || last.y !== final.y)) kept.push({ x: final.x, y: final.y });
  return kept;
}

/** A stroke as an SVG path, in whatever space its points are given in. */
export function inkPathData(points, scaleX = 1, scaleY = 1) {
  if (!points?.length) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * scaleX).toFixed(2)} ${(p.y * scaleY).toFixed(2)}`)
    .join(' ');
}

export function makeAnnot(overrides = {}) {
  const annot = { ...DEFAULT_ANNOT, id: uid('an'), ...overrides };
  annot.marks = normalizeMarks(annot.marks, annot.text);
  // Older annotations (and stamps saved before ranges existed) carried a single
  // `highlight` colour for the whole box; keep them rendering as they did.
  if (annot.highlight && annot.marks.length === 0 && annot.text) {
    annot.marks = [{ start: 0, end: annot.text.length, color: annot.highlight }];
  }
  delete annot.highlight;
  return annot;
}

/** Sorts, clamps and merges touching ranges of the same colour. */
export function normalizeMarks(marks, text) {
  const length = String(text ?? '').length;
  const clean = (marks ?? [])
    .map((m) => ({
      start: Math.max(0, Math.min(length, m.start | 0)),
      end: Math.max(0, Math.min(length, m.end | 0)),
      color: m.color,
    }))
    .filter((m) => m.end > m.start && m.color)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const mark of clean) {
    const previous = merged[merged.length - 1];
    if (previous && previous.color === mark.color && mark.start <= previous.end) {
      previous.end = Math.max(previous.end, mark.end);
    } else {
      merged.push({ ...mark });
    }
  }
  return merged;
}

/** Applies `color` to [start, end), splitting any ranges it overlaps. */
export function applyMark(marks, start, end, color, text) {
  if (end <= start) return normalizeMarks(marks, text);
  const kept = [];
  for (const mark of marks ?? []) {
    if (mark.end <= start || mark.start >= end) {
      kept.push(mark);
      continue;
    }
    // Trim the parts of the old range that fall outside the new one.
    if (mark.start < start) kept.push({ ...mark, end: start });
    if (mark.end > end) kept.push({ ...mark, start: end });
  }
  if (color) kept.push({ start, end, color });
  return normalizeMarks(kept, text);
}

/** Shifts ranges so they still cover the same words after an edit. */
export function shiftMarks(marks, at, removed, inserted, text) {
  const delta = inserted - removed;
  const moved = (marks ?? []).map((mark) => {
    const start = mark.start >= at + removed ? mark.start + delta : mark.start > at ? at : mark.start;
    const end = mark.end >= at + removed ? mark.end + delta : mark.end > at ? at + inserted : mark.end;
    return { ...mark, start, end };
  });
  return normalizeMarks(moved, text);
}

/** Approximate ascent as a fraction of font size; good enough for box placement. */
const ASCENT = 0.75;

/**
 * @param {object} annot
 * @param {number} winW visible page width in points
 * @param {number} winH visible page height in points
 */
export function layoutAnnot(annot, winW, winH) {
  /*
   * `<date>` is written out here, at the last moment before anything is drawn.
   *
   * The box keeps the mark — that is what makes it a date that stays today, on
   * the page as in a stamp — and everything that shows the box, on screen and in
   * the saved file alike, goes through this one function. So this is where the
   * mark becomes a date, and there is no way to draw one without the other.
   */
  const shown = fillDateWithMarks(annot.text, annot.marks);
  annot = { ...annot, text: shown.text, marks: shown.marks };

  const box = {
    x: annot.x * winW,
    y: annot.y * winH,
    w: Math.max(annot.w * winW, 1),
    h: Math.max(annot.h * winH, 1),
  };
  const style = { family: annot.family, bold: annot.bold, italic: annot.italic, size: annot.size };
  const pad = annot.padding ?? 0;
  const inner = Math.max(4, box.w - pad * 2);

  const texts = wrapText(annot.text, style, inner);
  const lineHeight = lineHeightOf(annot);
  const blockHeight = texts.length * lineHeight;

  let firstTop = box.y + pad;
  if (annot.valign === 'middle') firstTop = box.y + (box.h - blockHeight) / 2;
  else if (annot.valign === 'bottom') firstTop = box.y + box.h - pad - blockHeight;

  // Everything is expressed relative to a pivot so rotation is a single
  // transform rather than per-line trigonometry scattered across call sites.
  const rotated = (annot.rotate ?? 0) !== 0;
  const pivot = rotated
    ? { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    : { x: 0, y: 0 };

  const source = String(annot.text ?? '').replace(/\r\n/g, '\n');
  const marks = normalizeMarks(annot.marks, source);

  const lines = texts.map((line, i) => {
    const clean = sanitize(line.text);
    const width = widthOf(clean, style);
    let x = box.x + pad;
    if (annot.align === 'center') x = box.x + (box.w - width) / 2;
    else if (annot.align === 'right') x = box.x + box.w - pad - width;
    const baseline = firstTop + i * lineHeight + annot.size * ASCENT;
    const top = baseline - annot.size * ASCENT;

    // Only the marked characters get a highlight, so each range is clipped to
    // this line and measured from the line's own start.
    const highlights = [];
    for (const mark of marks) {
      const from = Math.max(mark.start, line.start);
      const to = Math.min(mark.end, line.end);
      if (to <= from) continue;
      const before = widthOf(sanitize(source.slice(line.start, from)), style);
      const span = widthOf(sanitize(source.slice(from, to)), style);
      if (span <= 0) continue;
      highlights.push({
        dx: x + before - pivot.x,
        dy: top - pivot.y,
        w: span,
        h: lineHeight,
        color: mark.color,
      });
    }

    return {
      text: clean,
      width,
      start: line.start,
      end: line.end,
      // offsets from the pivot, still unrotated
      dx: x - pivot.x,
      dy: baseline - pivot.y,
      highlights,
    };
  });

  return {
    box,
    pivot,
    rotate: annot.rotate ?? 0,
    lines,
    lineHeight,
    blockHeight,
    /** Corners of the box relative to the pivot, for drawing fill and border. */
    boxRel: { dx: box.x - pivot.x, dy: box.y - pivot.y, w: box.w, h: box.h },
  };
}

/**
 * Applies the layout rotation to an offset. Display space has y pointing down,
 * so a positive angle turns clockwise, matching what the user sees.
 */
export function rotateOffset(dx, dy, degrees) {
  if (!degrees) return { dx, dy };
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { dx: dx * cos - dy * sin, dy: dx * sin + dy * cos };
}

/** Absolute display-space point for an offset that belongs to `layout`. */
export function anchorOf(layout, dx, dy) {
  const r = rotateOffset(dx, dy, layout.rotate);
  return { x: layout.pivot.x + r.dx, y: layout.pivot.y + r.dy };
}

// ------------------------------------------------------------- canvas preview

/**
 * Draws one annotation onto a canvas whose pixel size is `scale` times the
 * visible page window.
 */
export function drawAnnotOnCanvas(ctx, annot, winW, winH, scale) {
  if (annot.role === 'ink') {
    drawInkOnCanvas(ctx, annot, winW, winH, scale);
    return;
  }
  const layout = layoutAnnot(annot, winW, winH);
  const rad = (layout.rotate * Math.PI) / 180;

  ctx.save();
  ctx.globalAlpha = annot.opacity ?? 1;
  ctx.translate(layout.pivot.x * scale, layout.pivot.y * scale);
  ctx.rotate(rad);
  ctx.scale(scale, scale);

  const { dx, dy, w, h } = layout.boxRel;
  if (annot.bgColor) {
    ctx.fillStyle = annot.bgColor;
    ctx.fillRect(dx, dy, w, h);
  }
  if (annot.border?.width > 0) {
    ctx.strokeStyle = annot.border.color;
    ctx.lineWidth = annot.border.width;
    ctx.strokeRect(dx + annot.border.width / 2, dy + annot.border.width / 2, w - annot.border.width, h - annot.border.width);
  }

  ctx.font = `${annot.italic ? 'italic ' : ''}${annot.bold ? 'bold ' : ''}${annot.size}px ${cssFamilyFor(annot.family)}`;
  ctx.textBaseline = 'alphabetic';

  for (const line of layout.lines) {
    for (const strip of line.highlights) {
      ctx.fillStyle = strip.color;
      ctx.fillRect(strip.dx, strip.dy, strip.w, strip.h);
    }
    ctx.fillStyle = annot.color;
    ctx.fillText(line.text, line.dx, line.dy);
  }

  ctx.restore();
}

/** A pen stroke, drawn the way it is drawn everywhere else: round and joined. */
function drawInkOnCanvas(ctx, annot, winW, winH, scale) {
  const points = annot.points ?? [];
  if (points.length === 0) return;

  ctx.save();
  ctx.globalAlpha = annot.opacity ?? 1;
  ctx.scale(scale, scale);
  ctx.strokeStyle = annot.color;
  ctx.lineWidth = annot.width ?? 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (const [i, point] of points.entries()) {
    const x = point.x * winW;
    const y = point.y * winH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  // A single tap is a dot, which a stroke of no length does not draw.
  if (points.length === 1) ctx.lineTo(points[0].x * winW + 0.01, points[0].y * winH);
  ctx.stroke();
  ctx.restore();
}
