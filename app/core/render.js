/**
 * Rasterises a workspace page to a canvas.
 *
 * Used for three quite different jobs, all of which must agree pixel for pixel:
 * the thumbnail grid, the tool previews, and the raster export path.
 */
import { makeMapper, totalQuarter } from './geometry.js';
import { pageSize } from './workspace.js';
import { drawAnnotOnCanvas } from './annots.js';

/** pdf.js viewport for a page at its total rotation. */
export async function viewportFor(ws, page, scale = 1) {
  const source = ws.source(page);
  if (source?.kind === 'pdf') {
    const pdfPage = await source.doc.getPage(page.srcIndex + 1);
    return { viewport: pdfPage.getViewport({ scale, rotation: totalQuarter(page) }), pdfPage };
  }
  // Images and pure rasters never need user-space mapping, so a stand-in with
  // the right dimensions is enough.
  const q = totalQuarter(page);
  const swap = q % 180 === 90;
  const w = (swap ? page.base.h : page.base.w) * scale;
  const h = (swap ? page.base.w : page.base.h) * scale;
  return { viewport: { width: w, height: h, scale, convertToPdfPoint: (x, y) => [x / scale, (h - y) / scale] }, pdfPage: null };
}

/**
 * How finely one part of a page can usefully be drawn, in pixels per point.
 *
 * A page drawn from the file has no limit worth naming: it is instructions, and
 * they can be followed at any size. A page that *is* a picture — a scan, an
 * upscaled page, an imported image — has exactly as much detail as the picture
 * has, and asking for more spends time to produce a blur with more pixels in it.
 *
 * @returns {number} Infinity for a page drawn from the file
 */
export function detailCeiling(ws, page) {
  const raster = ws.raster(page.rasterId);
  if (raster) return rasterCeiling(raster.width, raster.height, page);

  const source = ws.source(page);
  if (source?.kind === 'image') return rasterCeiling(source.bitmap.width, source.bitmap.height, page);
  return Infinity;
}

function rasterCeiling(width, height, page) {
  const { w, h } = pageSize(page);
  // Turned a quarter, the picture's width answers for the page's height.
  const swap = totalQuarter(page) % 180 === 90;
  const across = (swap ? height : width) / Math.max(1, w);
  const down = (swap ? width : height) / Math.max(1, h);
  return Math.max(0.05, Math.min(across, down));
}

/**
 * Draws one part of a page, at whatever size is asked for.
 *
 * For a sheet far larger than the screen this is the only way to read it: the
 * whole page cannot be drawn finely enough to zoom into — an A0 plan at four
 * times its own size is 171 megapixels, which no browser will allocate — so past
 * a point the page is drawn once for the whole and then, for the part being
 * looked at, again at the size it is actually being shown.
 *
 * Every kind of page can be drawn this way, which takes some care:
 *
 *   - A mirrored page is made by mirroring the finished picture, so the piece
 *     to fetch is the mirror image of the piece being asked for, and the piece
 *     is mirrored in turn once it is drawn.
 *   - A page that is a picture is cut out of that picture rather than drawn
 *     again; `detailCeiling` says how fine it is worth asking for.
 *   - A replaced background is worked out from each pixel on its own, so doing
 *     it to a piece gives what doing it to the page and cutting would have.
 *
 * @param {Workspace} ws
 * @param {object} page
 * @param {{x: number, y: number, w: number, h: number}} region in display
 *   points, in the page as it is shown
 * @param {{scale?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{canvas: HTMLCanvasElement}|null>}
 */
export async function renderPageRegion(ws, page, region, { scale = 1, signal } = {}) {
  const { viewport, pdfPage } = await viewportFor(ws, page, 1);
  const mapper = makeMapper(viewport, page);
  const winW = mapper.outWidth;
  const winH = mapper.outHeight;

  // The piece as the page is written, which is the mirror of the piece as it is
  // shown whenever the page is being shown mirrored.
  const want = {
    x: page.flipX ? winW - (region.x + region.w) : region.x,
    y: page.flipY ? winH - (region.y + region.h) : region.y,
    w: region.w,
    h: region.h,
  };

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.w * scale));
  canvas.height = Math.max(1, Math.round(region.h * scale));
  const ctx = canvas.getContext('2d');

  const paper = page.bg?.mode === 'transparent' ? null : page.bg?.color ?? '#ffffff';
  if (paper) {
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const raster = ws.raster(page.rasterId);
  if (raster) {
    const bitmap = await bitmapFrom(raster);
    const sx = bitmap.width / winW;
    const sy = bitmap.height / winH;
    ctx.drawImage(
      bitmap,
      want.x * sx, want.y * sy, want.w * sx, want.h * sy,
      0, 0, canvas.width, canvas.height,
    );
  } else {
    const source = ws.source(page);
    if (source?.kind === 'image') {
      drawRotatedBitmap(ctx, source.bitmap, page, mapper, scale, want);
    } else if (pdfPage) {
      /*
       * The whole page is laid out as usual and then shifted so that the wanted
       * corner lands at the origin. pdf.js still works through the entire
       * drawing — measured, a corner of a plan costs exactly what the whole
       * sheet costs — but only what falls inside the canvas is kept, and that is
       * the part that can then be made as fine as the screen deserves.
       */
      const shown = pdfPage.getViewport({ scale, rotation: totalQuarter(page) });
      const window = mapper.window;
      const task = pdfPage.render({
        canvasContext: ctx,
        viewport: shown,
        intent: 'print',
        transform: [1, 0, 0, 1, -(window.x + want.x) * scale, -(window.y + want.y) * scale],
      });
      signal?.addEventListener('abort', () => task.cancel(), { once: true });
      await task.promise;
    } else {
      return null;
    }
  }

  if (page.bg && page.bg.mode !== 'none') applyBackground(ctx, canvas, page.bg);
  if (page.flipX || page.flipY) flipCanvas(ctx, canvas, page);
  return { canvas };
}

/**
 * @param {Workspace} ws
 * @param {object} page
 * @param {{scale?: number, withAnnots?: boolean, signal?: AbortSignal}} opts
 * @returns {Promise<{canvas: HTMLCanvasElement, winW: number, winH: number}>}
 */
export async function renderPageCanvas(ws, page, { scale = 1, withAnnots = true, signal, intent = 'print' } = {}) {
  const { viewport, pdfPage } = await viewportFor(ws, page, 1);
  const mapper = makeMapper(viewport, page);
  const winW = mapper.outWidth;
  const winH = mapper.outHeight;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(winW * scale));
  canvas.height = Math.max(1, Math.round(winH * scale));
  const ctx = canvas.getContext('2d');

  // Paper is white; PDF pages themselves are transparent.
  const paper = page.bg?.mode === 'transparent' ? null : page.bg?.color ?? '#ffffff';
  if (paper) {
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const raster = ws.raster(page.rasterId);
  if (raster) {
    const bitmap = await bitmapFrom(raster);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } else {
    const source = ws.source(page);
    if (source?.kind === 'image') {
      drawRotatedBitmap(ctx, source.bitmap, page, mapper, scale);
    } else if (pdfPage) {
      await renderPdfPage(ctx, pdfPage, page, mapper, scale, signal, intent);
    }
  }

  if (page.bg && page.bg.mode !== 'none') applyBackground(ctx, canvas, page.bg);

  // Mirroring happens to the finished page rather than to each way of drawing
  // one, so a scan, an image and a PDF page all flip identically — and it lands
  // after cropping, which is what makes it mirror the page you can see.
  if (page.flipX || page.flipY) flipCanvas(ctx, canvas, page);

  if (withAnnots && page.annots.length) {
    // Annotations are stored relative to the *full* page so that changing the
    // crop never drags them around; shift into the crop window to draw them.
    ctx.save();
    ctx.translate(-mapper.window.x * scale, -mapper.window.y * scale);
    for (const annot of page.annots) {
      drawAnnotOnCanvas(ctx, annot, mapper.displayWidth, mapper.displayHeight, scale);
    }
    ctx.restore();
  }

  return { canvas, winW, winH, mapper };
}

/**
 * `intent` defaults to 'print' throughout the app on purpose. pdf.js drives its
 * 'display' render loop with requestAnimationFrame, which stops firing the
 * moment the tab goes to the background — so a user who switches tabs mid-export
 * comes back to a job frozen at 40%. The 'print' loop has no such dependency.
 */
async function renderPdfPage(ctx, pdfPage, page, mapper, scale, signal, intent) {
  const viewport = pdfPage.getViewport({ scale, rotation: totalQuarter(page) });
  const hasCrop = Boolean(page.crop);

  // Without a crop we can render straight into the destination canvas.
  const target = hasCrop ? document.createElement('canvas') : ctx.canvas;
  let targetCtx = ctx;
  if (hasCrop) {
    target.width = Math.max(1, Math.round(viewport.width));
    target.height = Math.max(1, Math.round(viewport.height));
    targetCtx = target.getContext('2d');
    targetCtx.fillStyle = '#ffffff';
    targetCtx.fillRect(0, 0, target.width, target.height);
  }

  const task = pdfPage.render({ canvasContext: targetCtx, viewport, intent });
  signal?.addEventListener('abort', () => task.cancel(), { once: true });
  await task.promise;

  if (hasCrop) {
    const w = mapper.window;
    ctx.drawImage(
      target,
      w.x * scale, w.y * scale, w.w * scale, w.h * scale,
      0, 0, ctx.canvas.width, ctx.canvas.height,
    );
  }
}

/**
 * Mirrors what has been drawn so far, in place.
 *
 * Through a copy rather than by drawing the canvas onto itself: a canvas used as
 * its own source while a transform is active gives an undefined result in some
 * browsers, and a torn image in others.
 */
function flipCanvas(ctx, canvas, page) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d').drawImage(canvas, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(page.flipX ? canvas.width : 0, page.flipY ? canvas.height : 0);
  ctx.scale(page.flipX ? -1 : 1, page.flipY ? -1 : 1);
  ctx.drawImage(copy, 0, 0);
  ctx.restore();
}

/**
 * @param {{x: number, y: number, w: number, h: number}} [region] part of the
 *   visible page to draw, in display points; the whole of it by default
 */
function drawRotatedBitmap(ctx, bitmap, page, mapper, scale, region) {
  const q = totalQuarter(page);
  const full = document.createElement('canvas');
  const swap = q % 180 === 90;
  full.width = swap ? bitmap.height : bitmap.width;
  full.height = swap ? bitmap.width : bitmap.height;
  const fctx = full.getContext('2d');
  fctx.translate(full.width / 2, full.height / 2);
  fctx.rotate((q * Math.PI) / 180);
  fctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

  const w = mapper.window;
  const sx = full.width / mapper.displayWidth;
  const sy = full.height / mapper.displayHeight;
  const part = region
    ? { x: w.x + region.x, y: w.y + region.y, w: region.w, h: region.h }
    : { x: w.x, y: w.y, w: w.w, h: w.h };
  ctx.drawImage(
    full,
    part.x * sx, part.y * sy, part.w * sx, part.h * sy,
    0, 0, ctx.canvas.width, ctx.canvas.height,
  );
}

/**
 * Background replacement / removal.
 *
 * `threshold` decides what counts as background: anything brighter is treated as
 * paper. That handles the common case of a scan whose "white" is really a dingy
 * grey, and at threshold 1 it only touches genuinely untouched pixels.
 */
export function applyBackground(ctx, canvas, bg) {
  if (bg.mode === 'none') return;
  const threshold = (bg.threshold ?? 0.85) * 255;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;

  const target = bg.mode === 'transparent' ? null : hexToBytes(bg.color ?? '#ffffff');

  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const isPaper = data[i + 3] === 0 || luminance >= threshold;
    if (!isPaper) continue;
    if (target) {
      data[i] = target[0];
      data[i + 1] = target[1];
      data[i + 2] = target[2];
      data[i + 3] = 255;
    } else {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function hexToBytes(hex) {
  const clean = String(hex).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const bitmapCache = new WeakMap();

async function bitmapFrom(raster) {
  if (bitmapCache.has(raster)) return bitmapCache.get(raster);
  const bitmap = await createImageBitmap(raster.blob);
  bitmapCache.set(raster, bitmap);
  return bitmap;
}

/** Convenience wrapper used by the exporters. */
export async function renderPageBlob(ws, page, { dpi = 150, mime = 'image/png', quality = 0.85 } = {}) {
  const scale = dpi / 72;
  const { canvas } = await renderPageCanvas(ws, page, { scale });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  return { blob, width: canvas.width, height: canvas.height };
}
