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
 * @returns {string[]} the laid-out lines
 */
export function wrapText(text, style, maxWidth) {
  const lines = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      const candidate = current + word;
      if (current !== '' && widthOf(candidate, style) > maxWidth) {
        lines.push(current.trimEnd());
        current = word.trimStart();
        // A single word longer than the box has to be broken mid-word.
        while (widthOf(current, style) > maxWidth && current.length > 1) {
          let cut = current.length - 1;
          while (cut > 1 && widthOf(current.slice(0, cut), style) > maxWidth) cut--;
          lines.push(current.slice(0, cut));
          current = current.slice(cut);
        }
      } else {
        current = candidate;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}
