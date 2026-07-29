/**
 * Annotations: the text boxes produced by Write, Stamps and Watermark.
 *
 * Layout is computed once, in display points relative to the visible page
 * window, and then consumed by both the canvas preview and the pdf-lib
 * exporter. Keeping a single layout pass is what makes the preview trustworthy.
 */
import { wrapText, widthOf, lineHeightOf, cssFamilyFor, sanitize } from './fonts.js';
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
  highlight: null,
  bgColor: null,
  border: null,
  opacity: 1,
  rotate: 0,
};

export function makeAnnot(overrides = {}) {
  return { ...DEFAULT_ANNOT, id: uid('an'), ...overrides };
}

/** Approximate ascent as a fraction of font size; good enough for box placement. */
const ASCENT = 0.75;

/**
 * @param {object} annot
 * @param {number} winW visible page width in points
 * @param {number} winH visible page height in points
 */
export function layoutAnnot(annot, winW, winH) {
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

  const lines = texts.map((text, i) => {
    const clean = sanitize(text);
    const width = widthOf(clean, style);
    let x = box.x + pad;
    if (annot.align === 'center') x = box.x + (box.w - width) / 2;
    else if (annot.align === 'right') x = box.x + box.w - pad - width;
    const baseline = firstTop + i * lineHeight + annot.size * ASCENT;
    return {
      text: clean,
      width,
      // offsets from the pivot, still unrotated
      dx: x - pivot.x,
      dy: baseline - pivot.y,
      // the highlight strip sits behind the glyphs of this line only
      hl: { dx: x - pivot.x, dy: baseline - annot.size * ASCENT - pivot.y, w: width, h: lineHeight },
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
    if (annot.highlight && line.text) {
      ctx.fillStyle = annot.highlight;
      ctx.fillRect(line.hl.dx, line.hl.dy, line.hl.w, line.hl.h);
    }
    ctx.fillStyle = annot.color;
    ctx.fillText(line.text, line.dx, line.dy);
  }

  ctx.restore();
}
