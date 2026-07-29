/**
 * Rasterises a workspace page to a canvas.
 *
 * Used for three quite different jobs, all of which must agree pixel for pixel:
 * the thumbnail grid, the tool previews, and the raster export path.
 */
import { makeMapper, totalQuarter } from './geometry.js';
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

function drawRotatedBitmap(ctx, bitmap, page, mapper, scale) {
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
  ctx.drawImage(
    full,
    w.x * sx, w.y * sy, w.w * sx, w.h * sy,
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
