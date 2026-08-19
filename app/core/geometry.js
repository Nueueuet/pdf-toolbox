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
