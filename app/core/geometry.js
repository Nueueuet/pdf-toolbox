/**
 * Coordinate plumbing shared by the renderer and the exporter.
 *
 * Three coordinate spaces are in play and mixing them up is the single easiest
 * way to produce a PDF that looks right on screen and wrong in a viewer:
 *
 *   display space  canvas pixels, origin top-left, y grows downwards. Already
 *                  rotated, i.e. it is what the user actually sees.
 *   fraction space display space divided by its own width/height, so 0..1. All
 *                  annotations and crop rectangles are stored like this, which
 *                  makes them resolution independent.
 *   user space     PDF points, origin bottom-left, y grows upwards, *unrotated*.
 *                  This is the space pdf-lib draws in.
 *
 * pdf.js viewports already know how to get from display to user space, so we
 * lean on `convertToPdfPoint` rather than re-deriving the rotation matrices.
 */
import { normalizeQuarter } from './workspace.js';

/** Total clockwise quarter-turn a page is displayed at. */
export function totalQuarter(page) {
  return normalizeQuarter(page.base.rotate + page.rotate);
}

/**
 * Builds the mapper for one page.
 *
 * @param {object} viewport a pdf.js viewport at scale 1 and the page's total rotation
 * @param {object} page
 */
export function makeMapper(viewport, page) {
  const dw = viewport.width;
  const dh = viewport.height;
  const crop = page.crop;

  // The visible window in display space, in points.
  const win = crop
    ? { x: crop.left * dw, y: crop.top * dh, w: (crop.right - crop.left) * dw, h: (crop.bottom - crop.top) * dh }
    : { x: 0, y: 0, w: dw, h: dh };

  const toUser = (dx, dy) => {
    const [x, y] = viewport.convertToPdfPoint(dx, dy);
    return { x, y };
  };

  return {
    displayWidth: dw,
    displayHeight: dh,
    /** Size of the exported page, i.e. the crop window. */
    outWidth: win.w,
    outHeight: win.h,
    window: win,

    /** fraction (of the *visible window*) -> PDF user space */
    fractionToUser(fx, fy) {
      return toUser(win.x + fx * win.w, win.y + fy * win.h);
    },

    /** fraction of the full page -> PDF user space */
    pageFractionToUser(fx, fy) {
      return toUser(fx * dw, fy * dh);
    },

    /**
     * CropBox in user space. Computed from the two opposite corners of the
     * window so it stays correct for every rotation.
     */
    cropBoxUser() {
      const a = toUser(win.x, win.y);
      const b = toUser(win.x + win.w, win.y + win.h);
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
      };
    },

    /**
     * Rotation to hand pdf-lib so drawn content reads upright on screen.
     *
     * Derivation, because the sign is easy to get backwards: display space has
     * y pointing down, user space has it pointing up, so a display direction
     * (a, b) becomes (a, −b) in user space and is then turned by the page's own
     * /Rotate. A line running right across the screen therefore points at angle
     * +q in user space — not −q. Both signs agree at 0° and 180°, which is why
     * getting this wrong only shows up on quarter-turned pages.
     */
    drawRotation: totalQuarter(page),
  };
}

/**
 * Length of one point of display space measured along the user-space axes.
 * Used to convert font sizes and stroke widths, which are direction independent.
 */
export function unitScale(viewport) {
  // viewports produced by getViewport({scale: 1}) are always 1:1 in magnitude.
  return 1 / (viewport.scale || 1);
}

/**
 * The rectangle one run of a page's text occupies, in display-space fractions.
 *
 * A run is measured along its own two directions, not along the page's. `width`
 * is how far it advances in the direction it is written, which for most text is
 * straight across the page and for some text is not: a watermark set at 45
 * degrees, or a label printed up the left margin of a form. Adding that advance
 * to x regardless draws the box along the bottom of the page instead of along
 * the words — a diagonal watermark comes out as a bar wider than the page
 * itself, and a column of upright labels as a stripe down the edge.
 *
 * Shared by everything that has to know where the existing words are, because
 * two copies of this sum drifted apart once already: the inspection overlay was
 * put right while the text picker went on drawing bars off the side of the page.
 *
 * @param {object} item one item from pdf.js getTextContent
 * @param {object} viewport a pdf.js viewport at scale 1
 * @param {{displayWidth: number, displayHeight: number}} mapper
 */
export function runBox(item, viewport, mapper) {
  const [a, b, c, d, e, f] = item.transform;
  // The size the glyphs stand at, whichever way up they are.
  const size = Math.hypot(c, d) || item.height || 10;
  const along = Math.hypot(a, b) || size;
  // Unit vectors: along the writing, and up the glyphs.
  const ux = a / along;
  const uy = b / along;
  const vx = c / size;
  const vy = d / size;
  const width = item.width || (item.str?.length ?? 1) * size * 0.5;

  // The run sits on its baseline, so the box starts a little below it and
  // reaches the ascender height above.
  const dropX = e - vx * size * 0.25;
  const dropY = f - vy * size * 0.25;
  const tall = size * 1.25;
  const corners = [
    [dropX, dropY],
    [dropX + ux * width, dropY + uy * width],
    [dropX + vx * tall, dropY + vy * tall],
    [dropX + ux * width + vx * tall, dropY + uy * width + vy * tall],
  ].map(([px, py]) => viewport.convertToViewportPoint(px, py));

  const xs = corners.map(([px]) => px);
  const ys = corners.map(([, py]) => py);
  const left = Math.min(...xs);
  const top = Math.min(...ys);

  /*
   * Two rectangles come out of this, and they are different things.
   *
   * The upright one is the smallest box the run fits inside, which is what
   * masking and hit-testing need. For a watermark set across the page that box
   * is enormous — most of the sheet — and drawn on screen it says nothing about
   * where the words are. So the run's own rectangle is given too: the same
   * shape, turned the way the writing is, to be drawn about its top-left corner.
   * For ordinary upright text the two are identical and the angle is zero.
   */
  const [startX, startY] = corners[0];
  const [endX, endY] = corners[1];
  const [aboveX, aboveY] = corners[2];
  const angle = (Math.atan2(endY - startY, endX - startX) * 180) / Math.PI;
  const runLength = Math.hypot(endX - startX, endY - startY);
  const runHeight = Math.hypot(aboveX - startX, aboveY - startY);

  return {
    x: left / mapper.displayWidth,
    y: top / mapper.displayHeight,
    w: (Math.max(...xs) - left) / mapper.displayWidth,
    h: (Math.max(...ys) - top) / mapper.displayHeight,
    size,
    angle,
    // Lengths divided by the page so they travel as fractions like everything
    // else; whoever draws them multiplies by the page's own size again, which
    // makes them true lengths rather than a width read off the wrong side.
    turned: {
      x: aboveX / mapper.displayWidth,
      y: aboveY / mapper.displayHeight,
      w: runLength / mapper.displayWidth,
      h: runHeight / mapper.displayHeight,
    },
  };
}

/**
 * A crop drawn on a page that is already cropped.
 *
 * The rectangle is drawn on what the page shows, and what a page shows is
 * already its crop window, so a second crop is measured inside the first rather
 * than against the whole sheet. Without this, trimming a little more off a page
 * that had been trimmed once would jump to some quite different part of it.
 */
export function composeCrop(existing, rect) {
  if (!rect) return existing ?? null;
  if (!existing) return { ...rect };
  const w = existing.right - existing.left;
  const h = existing.bottom - existing.top;
  return {
    left: existing.left + rect.left * w,
    right: existing.left + rect.right * w,
    top: existing.top + rect.top * h,
    bottom: existing.top + rect.bottom * h,
  };
}

/** Clamps a crop rectangle to the page and keeps a minimum size. */
export function normalizeCrop(crop) {
  if (!crop) return null;
  const left = Math.min(Math.max(crop.left, 0), 0.98);
  const top = Math.min(Math.max(crop.top, 0), 0.98);
  const right = Math.max(Math.min(crop.right, 1), left + 0.02);
  const bottom = Math.max(Math.min(crop.bottom, 1), top + 0.02);
  const isFull = left === 0 && top === 0 && right === 1 && bottom === 1;
  return isFull ? null : { left, top, right, bottom };
}
