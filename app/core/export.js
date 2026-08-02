/**
 * Turns workspace pages back into a PDF file.
 *
 * Two paths per page:
 *   vector  the page is copied from its source, keeping text selectable and the
 *           file small. Rotation, cropping and annotations are applied on top.
 *   raster  the page is re-rendered to a bitmap. Needed whenever an edit cannot
 *           be expressed in the original page objects — free-angle rotation,
 *           background replacement, compression, upscaling, images.
 */
import { PDFDocument, StandardFonts, PDFName, degrees, rgb } from '../../vendor/pdf-lib.esm.js';
import { makeMapper, totalQuarter } from './geometry.js';
import { renderPageCanvas, viewportFor } from './render.js';
import { layoutAnnot, anchorOf } from './annots.js';
import { standardFontFor, primeFontMetrics, sanitize } from './fonts.js';
import { hexToUnit } from '../util/format.js';

/** A page can only stay vector if every edit on it is expressible in PDF objects. */
export function needsRaster(ws, page, opts) {
  if (opts?.forceRaster) return true;
  if (page.rasterId) return true;
  if (page.bg && page.bg.mode !== 'none') return true;
  if ((page.angle ?? 0) % 360 !== 0) return true;
  return ws.source(page)?.kind !== 'pdf';
}

/**
 * @param {Workspace} ws
 * @param {object[]} pages pages to write, in order
 * @param {object} opts
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf(ws, pages, opts = {}) {
  const {
    rasterDpi = 150,
    rasterMime = 'image/jpeg',
    jpegQuality = 0.82,
    password = null,
    onProgress = null,
    title = null,
    includeOcr = true,
  } = opts;

  await primeFontMetrics();

  const out = await PDFDocument.create();
  const sourceDocs = new Map();
  const fontCache = new Map();

  const embedFont = async (family, bold, italic) => {
    const key = `${family}:${bold}:${italic}`;
    if (!fontCache.has(key)) fontCache.set(key, await out.embedFont(standardFontFor(family, bold, italic)));
    return fontCache.get(key);
  };

  const loadSourceDoc = async (source) => {
    if (!sourceDocs.has(source.id)) {
      sourceDocs.set(
        source.id,
        await PDFDocument.load(source.bytes, {
          ignoreEncryption: true,
          password: source.password ?? undefined,
        }),
      );
    }
    return sourceDocs.get(source.id);
  };

  for (const [index, page] of pages.entries()) {
    onProgress?.(index / pages.length, `Page ${index + 1} of ${pages.length}`);

    if (needsRaster(ws, page, opts)) {
      await addRasterPage(out, ws, page, { rasterDpi, rasterMime, jpegQuality });
      continue;
    }

    const source = ws.source(page);
    const srcDoc = await loadSourceDoc(source);
    const [copied] = await out.copyPages(srcDoc, [page.srcIndex]);
    out.addPage(copied);

    const q = totalQuarter(page);
    copied.setRotation(degrees(q));

    // Watermarks added as PDF annotations by other tools live here, which is why
    // "strip embedded" can reach them at all.
    if (page.meta?.stripAnnots) copied.node.delete(PDFName.of('Annots'));

    const { viewport } = await viewportFor(ws, page, 1);
    const mapper = makeMapper(viewport, page);

    if (page.crop) {
      const box = mapper.cropBoxUser();
      copied.setCropBox(box.x, box.y, box.width, box.height);
      copied.setMediaBox(box.x, box.y, box.width, box.height);
    }

    if (includeOcr && page.ocr?.words?.length) {
      await drawOcrLayer(copied, page.ocr.words, mapper, await embedFont('Helvetica', false, false));
    }

    for (const annot of page.annots) {
      await drawAnnotOnPage(copied, annot, mapper, embedFont);
    }
  }

  onProgress?.(0.95, 'Writing file');

  if (title) out.setTitle(title);
  out.setProducer('PDF Toolbox');
  out.setModificationDate(new Date());

  if (password) applyEncryption(out, password);

  const bytes = await out.save({ useObjectStreams: true });
  onProgress?.(1, 'Done');
  return bytes;
}

/**
 * Writes recognised words onto the page at zero opacity.
 *
 * This is what makes a scan searchable: the page still shows its original
 * picture, but a viewer finds real text at the same coordinates, so it can be
 * selected, copied and searched — in this app and in any other PDF reader, long
 * after the file has been saved.
 *
 * Each word is scaled so its glyphs span the box recognition reported, which
 * keeps selection rectangles lined up with the ink underneath.
 */
async function drawOcrLayer(pdfPage, words, mapper, font) {
  const rotate = degrees(mapper.drawRotation);

  for (const word of words) {
    const text = sanitize(word.text);
    if (!text.trim()) continue;

    // Height first: the box is the glyph height, and font size is close enough
    // to that for selection to feel right.
    const boxHeight = word.h * mapper.displayHeight;
    const boxWidth = word.w * mapper.displayWidth;
    const size = Math.max(1, boxHeight * 0.82);

    // Then squeeze horizontally so the run ends where the ink ends.
    const natural = font.widthOfTextAtSize(text, size);
    const scale = natural > 0 ? Math.min(4, Math.max(0.2, boxWidth / natural)) : 1;

    // Baseline sits a little above the bottom of the box.
    const at = mapper.pageFractionToUser(word.x, word.y + word.h - boxHeight * 0.2 / mapper.displayHeight);

    pdfPage.drawText(text, {
      x: at.x,
      y: at.y,
      size: size * scale,
      font,
      rotate,
      // Invisible, but present: extraction and selection both still find it.
      opacity: 0,
    });
  }
}

async function addRasterPage(out, ws, page, { rasterDpi, rasterMime, jpegQuality }) {
  const scale = rasterDpi / 72;
  const { canvas, winW, winH } = await renderPageCanvas(ws, page, { scale });

  // JPEG cannot carry transparency, so a transparent background forces PNG.
  const mime = page.bg?.mode === 'transparent' ? 'image/png' : rasterMime;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, jpegQuality));
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const image = mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const pdfPage = out.addPage([winW, winH]);
  pdfPage.drawImage(image, { x: 0, y: 0, width: winW, height: winH });
}

async function drawAnnotOnPage(pdfPage, annot, mapper, embedFont) {
  // Layout happens in full-page display space — see the note in render.js.
  const layout = layoutAnnot(annot, mapper.displayWidth, mapper.displayHeight);
  const font = await embedFont(annot.family, annot.bold, annot.italic);
  const opacity = annot.opacity ?? 1;

  // Page rotation contributes +q, the annotation's own tilt −θ: a clockwise tilt
  // on screen is anticlockwise in user space. See makeMapper for the derivation.
  const drawRotate = mapper.drawRotation - layout.rotate;

  const toUser = (dx, dy) => {
    const p = anchorOf(layout, dx, dy);
    return mapper.pageFractionToUser(p.x / mapper.displayWidth, p.y / mapper.displayHeight);
  };

  if (annot.bgColor || annot.border?.width > 0) {
    const { dx, dy, w, h } = layout.boxRel;
    const rect = {
      ...rotatedRect(toUser, dx, dy, w, h, drawRotate),
      rotate: degrees(drawRotate),
      opacity,
      borderOpacity: opacity,
    };
    if (annot.bgColor) rect.color = toRgb(annot.bgColor);
    if (annot.border?.width > 0) {
      rect.borderColor = toRgb(annot.border.color);
      rect.borderWidth = annot.border.width;
    }
    if (!annot.bgColor) rect.opacity = 0;
    pdfPage.drawRectangle(rect);
  }

  for (const line of layout.lines) {
    if (!line.text) continue;

    for (const strip of line.highlights) {
      pdfPage.drawRectangle({
        ...rotatedRect(toUser, strip.dx, strip.dy, strip.w, strip.h, drawRotate),
        color: toRgb(strip.color),
        rotate: degrees(drawRotate),
        opacity,
      });
    }

    const at = toUser(line.dx, line.dy);
    pdfPage.drawText(line.text, {
      x: at.x,
      y: at.y,
      size: annot.size,
      font,
      color: toRgb(annot.color),
      rotate: degrees(drawRotate),
      opacity,
    });
  }
}

/**
 * pdf-lib anchors a rotated rectangle at (x, y) and grows it along the rotated
 * axes, so the anchor has to be whichever display corner ends up lowest in that
 * rotated frame — which differs per quarter turn. Picking one corner by hand
 * silently misplaces boxes on /Rotate 90 and 270 pages, so derive it instead:
 * map all four corners, project them onto the rotated axes, and take the minima.
 *
 * @param {(dx: number, dy: number) => {x: number, y: number}} toUser
 */
function rotatedRect(toUser, dx, dy, w, h, angleDeg) {
  const corners = [
    toUser(dx, dy),
    toUser(dx + w, dy),
    toUser(dx + w, dy + h),
    toUser(dx, dy + h),
  ];
  const rad = (angleDeg * Math.PI) / 180;
  const axis = { x: Math.cos(rad), y: Math.sin(rad) };
  const perp = { x: -Math.sin(rad), y: Math.cos(rad) };

  const along = corners.map((p) => p.x * axis.x + p.y * axis.y);
  const across = corners.map((p) => p.x * perp.x + p.y * perp.y);
  const minAlong = Math.min(...along);
  const minAcross = Math.min(...across);

  // The corner that is minimal on both axes is the rectangle's origin.
  const originIndex = corners.findIndex(
    (_, i) => Math.abs(along[i] - minAlong) < 1e-6 && Math.abs(across[i] - minAcross) < 1e-6,
  );
  const origin = corners[originIndex === -1 ? 0 : originIndex];

  return {
    x: origin.x,
    y: origin.y,
    width: Math.max(...along) - minAlong,
    height: Math.max(...across) - minAcross,
  };
}

function toRgb(hex) {
  const { r, g, b } = hexToUnit(hex);
  return rgb(r, g, b);
}

/**
 * @cantoo/pdf-lib adds encryption on top of upstream pdf-lib. Guarded because a
 * plain pdf-lib build would silently produce an unprotected file otherwise.
 */
export function applyEncryption(doc, password) {
  if (typeof doc.encrypt !== 'function') {
    throw new Error('This build of pdf-lib cannot encrypt. Re-run `npm run vendor`.');
  }
  doc.encrypt({
    userPassword: password.user || undefined,
    ownerPassword: password.owner || password.user || undefined,
    permissions: password.permissions ?? {},
  });
}

export { StandardFonts };
