/**
 * Turning a piece of a PDF's own text into something editable.
 *
 * What this cannot do, and why: the words in a PDF are drawn with a font
 * embedded in the file, almost always as a *subset* containing only the glyphs
 * that page happened to use. Typing a letter the original never contained has
 * nothing to draw it with, and pdf.js hands back its own identifier for the font
 * ("g_d0_f1") rather than something that could be embedded again. Editing a
 * paragraph in place would also mean re-flowing everything after it, which a PDF
 * has no notion of — it stores glyphs at coordinates, not sentences.
 *
 * What it does instead: reads a run of text, covers it with the colour of the
 * paper around it, and puts an ordinary editable box in exactly its place at the
 * same size, colour and alignment. Carrying on typing then works, and the result
 * is honest — the shapes of the letters are the closest standard font, not the
 * original, and the tool says so rather than pretending otherwise.
 */
import { viewportFor } from './render.js';
import { makeMapper, runBox } from './geometry.js';
import { renderPageCanvas } from './render.js';

/** The three standard families a PDF font can be matched to. */
function familyFor(style) {
  const name = `${style?.fontFamily ?? ''}`.toLowerCase();
  if (name.includes('mono') || name.includes('courier')) return 'Courier';
  if (name.includes('serif') && !name.includes('sans')) return 'Times';
  return 'Helvetica';
}

/**
 * Every run of text on a page, with where it sits and what it looks like.
 *
 * @returns {Promise<{
 *   text: string, x: number, y: number, w: number, h: number,
 *   size: number, family: string, bold: boolean, italic: boolean,
 * }[]>} boxes as fractions of the full display page
 */
export async function readableRuns(ws, page) {
  const source = ws.source(page);
  if (source?.kind !== 'pdf' || page.rasterId) return [];

  const pdfPage = await source.doc.getPage(page.srcIndex + 1);
  const { viewport } = await viewportFor(ws, page, 1);
  const mapper = makeMapper(viewport, page);
  const content = await pdfPage.getTextContent();

  const runs = [];
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const style = content.styles?.[item.fontName];
    // Measured the same way the inspection overlay measures, so a watermark set
    // at an angle offers a box over the words rather than a bar across the page.
    const { x, y, w, h, size, angle, turned } = runBox(item, viewport, mapper);

    const name = `${style?.fontFamily ?? ''}`.toLowerCase();
    runs.push({
      text: item.str,
      x,
      y,
      w,
      h,
      // The upright box is where a replacement text box would go; the turned one
      // is how the run is offered on screen.
      angle,
      turned,
      size,
      family: familyFor(style),
      bold: name.includes('bold'),
      italic: name.includes('italic') || name.includes('oblique'),
    });
  }
  return runs;
}

/**
 * The colour of the ink in a box, and of the paper around it.
 *
 * Sampled from the page as drawn rather than read from the file: the fill colour
 * of a glyph lives in the content stream, and following it there would mean
 * interpreting the whole stream. The darkest pixel inside the box is the ink,
 * and the commonest just outside it is the paper — which is what has to be
 * painted over the original for it to disappear.
 */
export async function coloursOf(ws, page, run) {
  const { canvas } = await renderPageCanvas(ws, page, { scale: 1.5, withAnnots: false });
  const ctx = canvas.getContext('2d');
  const px = (fx, fy) => ({
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(fx * canvas.width))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.round(fy * canvas.height))),
  });

  const a = px(run.x, run.y);
  const b = px(run.x + run.w, run.y + run.h);
  const w = Math.max(1, b.x - a.x);
  const h = Math.max(1, b.y - a.y);

  // Darkest pixel inside the run: the ink it is printed in.
  const inside = ctx.getImageData(a.x, a.y, w, h).data;
  let ink = [0, 0, 0];
  let darkest = Infinity;
  for (let i = 0; i < inside.length; i += 4) {
    const luminance = 0.2126 * inside[i] + 0.7152 * inside[i + 1] + 0.0722 * inside[i + 2];
    if (luminance < darkest) {
      darkest = luminance;
      ink = [inside[i], inside[i + 1], inside[i + 2]];
    }
  }

  /*
   * The paper is sampled from a band just above and below the run, never from
   * inside it.
   *
   * Taken from within the box, the commonest colour is white blurred with the
   * edges of the letters — on a white page it came out at #f8f8f8, which lays a
   * visibly grey rectangle over the paper it is meant to disappear into.
   */
  const band = Math.max(2, Math.round(h * 0.4));
  const strips = [
    { y: Math.max(0, a.y - band), height: Math.min(band, a.y) },
    { y: Math.min(canvas.height - 1, b.y + 1), height: Math.min(band, canvas.height - b.y - 1) },
  ];

  const tally = new Map();
  for (const strip of strips) {
    if (strip.height < 1) continue;
    const data = ctx.getImageData(a.x, strip.y, w, strip.height).data;
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }

  let paper = [255, 255, 255];
  let most = 0;
  for (const [key, count] of tally) {
    if (count <= most) continue;
    most = count;
    // The key holds the top five bits; the low three are put back as ones so a
    // near-white sample lands on white rather than a shade below it.
    paper = key.split(',').map((n) => (Number(n) << 3) | 0b111);
  }

  return { ink: hex(ink), paper: hex(paper) };
}

function hex([r, g, b]) {
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
}
