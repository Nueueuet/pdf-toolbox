/**
 * Counting placeholders in a text box: {n}, {a}, {A}, {i}, {I}.
 *
 * A text box copied across a document is nearly always the same words on every
 * page except for one thing that has to move on — a page number, an exhibit
 * letter, an invoice line. Writing that by hand is the sort of job people give
 * up on halfway through a long document, so the box carries a mark for it and
 * each copy gets the next value.
 *
 * The five kinds are the ones anyone actually numbers things with. Anything else
 * inside braces is left exactly as typed: a document that happens to contain
 * {something} should come out with {something} still in it.
 */

/** The mark, what it counts in, and how a value is written. */
const KINDS = {
  n: { label: 'Numbers — 1, 2, 3', format: (value) => String(value) },
  a: { label: 'Letters — a, b, c', format: (value) => toLetters(value).toLowerCase() },
  A: { label: 'Letters — A, B, C', format: (value) => toLetters(value) },
  i: { label: 'Roman — i, ii, iii', format: (value) => toRoman(value).toLowerCase() },
  I: { label: 'Roman — I, II, III', format: (value) => toRoman(value) },
};

export const COUNTER_KINDS = Object.entries(KINDS).map(([key, { label }]) => ({ key, label }));

/** `{n}` and `{n+2}`: the mark, optionally with how far along to start. */
const MARK = /\{([naAiI])(?:\+(\d+))?\}/g;

export function hasCounter(text) {
  MARK.lastIndex = 0;
  return MARK.test(String(text ?? ''));
}

/** Which of the five a pattern is counting in, or null if it counts in none. */
export function markKind(text) {
  MARK.lastIndex = 0;
  return MARK.exec(String(text ?? ''))?.[1] ?? null;
}

/**
 * Switches a pattern from counting one way to counting another.
 *
 * Numbers and letters are the same job written differently, so choosing between
 * them is a choice, not a rewrite: the pattern keeps its words and its starting
 * offset, and only the mark inside the braces changes. A pattern with no mark at
 * all gains one at the end, which is where a name that has run out of room for
 * one wants it.
 */
export function setMarkKind(text, kind) {
  const source = String(text ?? '');
  if (!KINDS[kind]) return source;
  if (!hasCounter(source)) return `${source.trimEnd()} {${kind}}`.trim();
  MARK.lastIndex = 0;
  return source.replace(MARK, (whole, was, offset) => `{${kind}${offset ? `+${offset}` : ''}}`);
}

/**
 * Fills the marks in for the `index`-th copy.
 *
 * @param {string} text the text as typed, marks and all
 * @param {number} index 0 for the first copy, 1 for the next, and so on
 * @param {{start?: number|string, step?: number}} opts where counting begins
 */
export function fillCounter(text, index, { start = 1, step = 1 } = {}) {
  const from = typeof start === 'string' ? fromLetters(start) : Number(start) || 1;
  return String(text ?? '').replace(MARK, (whole, kind, offset) => {
    const value = from + (index * step) + (offset ? Number(offset) : 0);
    // Nothing sensible to write below the first: leave the run alone rather
    // than inventing a zeroth letter or a roman numeral for nought.
    if (value < 1 && kind !== 'n') return whole;
    return KINDS[kind].format(value);
  });
}

/** 1 -> A, 26 -> Z, 27 -> AA, the way spreadsheet columns are named. */
function toLetters(value) {
  let n = Math.max(1, Math.floor(value));
  let out = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The inverse, so a start can be given as "c" rather than as 3. */
export function fromLetters(text) {
  const clean = String(text ?? '').trim();
  if (/^\d+$/.test(clean)) return Number(clean);
  if (!/^[a-z]+$/i.test(clean)) return 1;
  let value = 0;
  for (const char of clean.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value;
}

const ROMAN = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function toRoman(value) {
  let n = Math.max(1, Math.floor(value));
  let out = '';
  for (const [amount, numeral] of ROMAN) {
    while (n >= amount) {
      out += numeral;
      n -= amount;
    }
  }
  return out;
}
