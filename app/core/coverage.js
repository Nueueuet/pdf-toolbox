/**
 * Works out which parts of a page already carry selectable text, and which parts
 * are only a picture of text.
 *
 * This is what keeps OCR from being either useless or wasteful. A born-digital
 * PDF needs none of it. A scan needs all of it. The awkward and common case is
 * the mixture — a typed letter with a scanned signature block, or a report whose
 * charts are images — where recognising the whole page would spend minutes
 * re-deriving text that is already there, and would then stack a second, worse
 * copy of it underneath the first.
 *
 * The method: mark where the existing text sits, mark where there is ink, and
 * whatever ink is left over is what OCR should look at.
 */
import { viewportFor } from './render.js';
import { makeMapper, runBox } from './geometry.js';
import { renderPageCanvas } from './render.js';

/** Pixel size of one grid cell when hunting for leftover ink, at ANALYSIS_DPI. */
const CELL = 8;
const ANALYSIS_DPI = 100;
/** A cell counts as inked once this share of it is darker than the paper. */
const INK_SHARE = 0.06;
/** Existing text boxes are grown by this fraction before masking, for descenders and antialiasing. */
const TEXT_PADDING = 0.35;
/** Regions smaller than this share of the page are noise — page numbers, rules, specks. */
const MIN_REGION_AREA = 0.004;
/**
 * ...except a strip this wide and this tall, which is a line of writing however
 * little of the page it covers.
 *
 * Area alone threw away running headers. "Chapter 3" at the top of a scan is
 * about a tenth of the width and a eightieth of the height — a thousandth of the
 * page, four times under the threshold — so every header on every page went
 * unrecognised while the body text beneath was picked up perfectly. Judging the
 * two dimensions separately keeps the specks and the rules out without taking
 * short lines of text with them.
 */
const MIN_TEXT_WIDTH = 0.05;
const MIN_TEXT_HEIGHT = 0.008;

function looksLikeWriting(region) {
  if (region.w * region.h >= MIN_REGION_AREA) return true;
  /*
   * A short line of writing is wider than it is tall — that is what makes it a
   * line. Without the shape test this exemption also let through the narrow
   * upright slivers along the edge of a scan, which are the shadow of the paper
   * rather than anything to read.
   */
  if (region.w <= region.h) return false;
  return region.w >= MIN_TEXT_WIDTH && region.h >= MIN_TEXT_HEIGHT;
}

/**
 * @returns {Promise<{
 *   verdict: 'text'|'partial'|'none'|'empty',
 *   textBoxes: {x: number, y: number, w: number, h: number}[],
 *   regions: {x: number, y: number, w: number, h: number}[],
 *   textCoverage: number
 * }>} all rectangles as fractions of the full display page
 */
export async function analysePage(ws, page) {
  const source = ws.source(page);
  const textBoxes = source?.kind === 'pdf' && !page.rasterId
    ? await existingTextBoxes(ws, page)
    : [];

  const { canvas } = await renderPageCanvas(ws, page, { scale: ANALYSIS_DPI / 72, withAnnots: false });
  const grid = inkGrid(canvas);
  if (grid.inked === 0) {
    return { verdict: 'empty', textBoxes, regions: [], textCoverage: 1 };
  }

  const covered = maskCells(grid, textBoxes);
  const textCoverage = covered / grid.inked;

  // Ink still standing after the existing text is masked out is what OCR is for.
  const regions = mergeRegions(grid).filter(looksLikeWriting);

  let verdict;
  if (regions.length === 0) verdict = 'text';
  else if (textBoxes.length === 0) verdict = 'none';
  else verdict = 'partial';

  return { verdict, textBoxes, regions, textCoverage };
}

/** Bounding boxes of the page's existing text runs, as page fractions. */
export async function existingTextBoxes(ws, page) {
  const source = ws.source(page);
  const pdfPage = await source.doc.getPage(page.srcIndex + 1);
  const { viewport } = await viewportFor(ws, page, 1);
  const mapper = makeMapper(viewport, page);
  const content = await pdfPage.getTextContent();

  const boxes = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    /*
     * Where one of these boxes lands decides two things: what the inspection
     * overlay draws, and which ink the recogniser is told already has text over
     * it. A box drawn along the wrong axis therefore both marks the page in the
     * wrong place and declares a band of it as already read, so whatever sits
     * under that band is skipped.
     */
    const { x, y, w, h, angle, turned } = runBox(item, viewport, mapper);
    // The upright box masks; the turned one is what gets drawn.
    boxes.push({ x, y, w, h, angle, turned });
  }
  return boxes;
}

/** Coarse map of where the page has ink, one flag per CELL x CELL block. */
function inkGrid(canvas) {
  const cols = Math.ceil(canvas.width / CELL);
  const rows = Math.ceil(canvas.height / CELL);
  const cells = new Uint8Array(cols * rows);
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;

  const counts = new Uint16Array(cols * rows);
  for (let y = 0; y < canvas.height; y++) {
    const row = Math.floor(y / CELL);
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      // Transparent counts as paper; the renderer fills white by default anyway.
      if (data[i + 3] < 24) continue;
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luminance < 190) counts[row * cols + Math.floor(x / CELL)]++;
    }
  }

  const threshold = CELL * CELL * INK_SHARE;
  let inked = 0;
  for (let i = 0; i < cells.length; i++) {
    if (counts[i] >= threshold) {
      cells[i] = 1;
      inked++;
    }
  }
  return { cells, cols, rows, inked, width: canvas.width, height: canvas.height };
}

/** Clears cells that the existing text already covers. Returns how many were cleared. */
function maskCells(grid, textBoxes) {
  let cleared = 0;
  for (const box of textBoxes) {
    const pad = box.h * TEXT_PADDING;
    const x0 = Math.floor(((box.x - pad * 0.2) * grid.width) / CELL);
    const x1 = Math.ceil(((box.x + box.w + pad * 0.2) * grid.width) / CELL);
    const y0 = Math.floor(((box.y - pad) * grid.height) / CELL);
    const y1 = Math.ceil(((box.y + box.h + pad) * grid.height) / CELL);

    for (let row = Math.max(0, y0); row < Math.min(grid.rows, y1); row++) {
      for (let col = Math.max(0, x0); col < Math.min(grid.cols, x1); col++) {
        const i = row * grid.cols + col;
        if (grid.cells[i]) {
          grid.cells[i] = 0;
          cleared++;
        }
      }
    }
  }
  return cleared;
}

/**
 * Groups the surviving cells into rectangles by flood fill, then pads each one
 * a little so recognition sees whole glyphs rather than clipped ones.
 */
function mergeRegions(grid) {
  const seen = new Uint8Array(grid.cells.length);
  const regions = [];

  for (let start = 0; start < grid.cells.length; start++) {
    if (!grid.cells[start] || seen[start]) continue;

    let minCol = grid.cols;
    let maxCol = 0;
    let minRow = grid.rows;
    let maxRow = 0;
    const stack = [start];
    seen[start] = 1;

    while (stack.length) {
      const index = stack.pop();
      const row = Math.floor(index / grid.cols);
      const col = index % grid.cols;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;

      // Eight-connected, and reaching two cells out, so a line of separate words
      // becomes one region instead of a dozen.
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) continue;
          const next = r * grid.cols + c;
          if (grid.cells[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }

    const pad = 1; // one cell of breathing room
    regions.push({
      x: Math.max(0, (minCol - pad) * CELL) / grid.width,
      y: Math.max(0, (minRow - pad) * CELL) / grid.height,
      w: Math.min(grid.width, (maxCol + 1 + pad) * CELL) / grid.width - Math.max(0, (minCol - pad) * CELL) / grid.width,
      h: Math.min(grid.height, (maxRow + 1 + pad) * CELL) / grid.height - Math.max(0, (minRow - pad) * CELL) / grid.height,
    });
  }

  return absorbOverlaps(regions);
}

/** Merges regions that overlap, so the same words are not recognised twice. */
function absorbOverlaps(regions) {
  const out = [];
  for (const region of regions.sort((a, b) => b.w * b.h - a.w * a.h)) {
    const host = out.find((other) => overlaps(other, region));
    if (host) {
      const x = Math.min(host.x, region.x);
      const y = Math.min(host.y, region.y);
      host.w = Math.max(host.x + host.w, region.x + region.w) - x;
      host.h = Math.max(host.y + host.h, region.y + region.h) - y;
      host.x = x;
      host.y = y;
    } else {
      out.push({ ...region });
    }
  }
  return out;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
