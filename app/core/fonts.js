/**
 * Text metrics and line breaking.
 *
 * Both the on-screen preview and the exported PDF go through this module, using
 * pdf-lib's own font metrics as the single source of truth. Measuring the
 * preview with the browser's `measureText` instead would drift from the export
 * and produce different line breaks — the classic "looked fine in the editor"
 * bug.
 */
import { PDFDocument, StandardFonts } from '../../vendor/pdf-lib.esm.js';

export const FONT_FAMILIES = [
  { id: 'Helvetica', label: 'Helvetica', css: 'Helvetica, Arial, "Helvetica Neue", sans-serif' },
  { id: 'Times', label: 'Times', css: '"Times New Roman", Times, serif' },
  { id: 'Courier', label: 'Courier', css: '"Courier New", Courier, monospace' },
];

const STANDARD = {
  Helvetica: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  Times: {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  Courier: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
};

export function standardFontFor(family, bold, italic) {
  const set = STANDARD[family] ?? STANDARD.Helvetica;
  if (bold && italic) return set.boldItalic;
  if (bold) return set.bold;
  if (italic) return set.italic;
  return set.regular;
}

export function cssFamilyFor(family) {
  return (FONT_FAMILIES.find((f) => f.id === family) ?? FONT_FAMILIES[0]).css;
}

/** A throwaway document whose only job is to give us embedded fonts to measure with. */
let measurePromise = null;
const measureCache = new Map();

async function measuringFonts() {
  if (!measurePromise) {
    measurePromise = (async () => {
      const doc = await PDFDocument.create();
      const fonts = new Map();
      for (const family of Object.keys(STANDARD)) {
        for (const variant of ['regular', 'bold', 'italic', 'boldItalic']) {
          fonts.set(`${family}:${variant}`, await doc.embedFont(STANDARD[family][variant]));
        }
      }
      return fonts;
    })();
  }
  return measurePromise;
}

/** Must be awaited once before any synchronous `widthOf` call. */
export async function primeFontMetrics() {
  const fonts = await measuringFonts();
  measureCache.clear();
  for (const [key, font] of fonts) measureCache.set(key, font);
  return true;
}

function variantKey(bold, italic) {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

/** Width of `text` in points. Requires `primeFontMetrics()` to have resolved. */
export function widthOf(text, { family = 'Helvetica', bold = false, italic = false, size = 12 }) {
  const font = measureCache.get(`${family}:${variantKey(bold, italic)}`);
  if (!font) return text.length * size * 0.5; // pre-prime fallback
  // The standard fonts have no glyphs outside WinAnsi; strip them rather than throw.
  return font.widthOfTextAtSize(sanitize(text), size);
}

export function lineHeightOf({ size = 12, lineSpacing = 1.2 }) {
  return size * lineSpacing;
}

/**
 * Replaces characters the standard PDF fonts cannot encode. pdf-lib throws on
 * them, which would otherwise turn one stray emoji into a failed export.
 */
export function sanitize(text) {
  return String(text ?? '').replace(/[^\x00-\xFF]/g, (ch) => {
    const fallback = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' }[ch];
    return fallback ?? '?';
  });
}

/**
 * Greedy word wrap into `maxWidth` points, honouring explicit newlines.
 *
 * Each line carries its character offsets into the original string. Highlights
 * are stored as character ranges, so without offsets there is no way to work out
 * which part of which line a highlight covers.
 *
 * @returns {{text: string, start: number, end: number}[]}
 */
export function wrapText(text, style, maxWidth) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const limit = Math.max(1, maxWidth);
  const lines = [];
  let paragraphStart = 0;

  for (const paragraph of source.split('\n')) {
    const paragraphEnd = paragraphStart + paragraph.length;

    if (paragraph === '') {
      lines.push({ text: '', start: paragraphStart, end: paragraphStart });
      paragraphStart = paragraphEnd + 1;
      continue;
    }

    let lineStart = paragraphStart;
    let lastBreak = -1; // index of the most recent space we could break at
    let i = paragraphStart;

    while (i < paragraphEnd) {
      const next = i + 1;
      if (widthOf(source.slice(lineStart, next), style) > limit && next > lineStart + 1) {
        // Break at the last space if there was one, otherwise mid-word.
        const breakAt = lastBreak > lineStart ? lastBreak : i;
        lines.push({ text: source.slice(lineStart, breakAt), start: lineStart, end: breakAt });
        let resume = breakAt;
        while (resume < paragraphEnd && /\s/.test(source[resume])) resume++;
        lineStart = resume;
        lastBreak = -1;
        i = Math.max(resume, breakAt);
        continue;
      }
      if (/\s/.test(source[i])) lastBreak = i;
      i = next;
    }
    lines.push({ text: source.slice(lineStart, paragraphEnd), start: lineStart, end: paragraphEnd });

    paragraphStart = paragraphEnd + 1;
  }

  return lines;
}
