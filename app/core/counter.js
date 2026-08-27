/**
 * Placeholders in a text box: the counting marks {n}, {a}, {A}, {i}, {I}, and
 * `<date>` for the day it goes on the page.
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

/** Today, written where `<date>` was typed. */
const DATE_MARK = /<date>/gi;

export function hasDate(text) {
  DATE_MARK.lastIndex = 0;
  return DATE_MARK.test(String(text ?? ''));
}

/**
 * Fills in `<date>` with the day the text is being put on the page.
 *
 * A stamp is the reason this exists: "Received <date>" saved once writes the
 * right day every time it is used, which a stamp with a date typed into it
 * stops doing the moment the day turns over. The stamp itself keeps the mark —
 * only the copy that lands on the page gets a date.
 *
 * Written the way this machine writes dates. A document stamped here is read
 * here, and 25.08.2026 or 8/25/2026 is whichever of those the reader expects.
 *
 * @param {string} text
 * @param {Date} [when] the day to write, for testing
 */
export function fillDate(text, when = new Date()) {
  return String(text ?? '').replace(DATE_MARK, () => writtenDate(when));
}

/**
 * Two digits for the day and the month: 25.08.2026 rather than 25.8.2026, which
 * is how a date on a document is written wherever dates are written.
 */
function writtenDate(when) {
  return when.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * The same, with the highlights kept over the words they were put on.
 *
 * A mark is a pair of character offsets, and writing out `<date>` makes the text
 * longer — six characters become ten. Left alone, every highlight after a date
 * would slide four characters to the left of the words it belongs to.
 *
 * @param {string} text as typed, marks and all
 * @param {{start: number, end: number, color: string}[]} marks
 * @param {Date} [when]
 */
export function fillDateWithMarks(text, marks, when = new Date()) {
  const source = String(text ?? '');
  if (!hasDate(source)) return { text: source, marks: marks ?? [] };

  const written = writtenDate(when);
  const grew = written.length - '<date>'.length;
  const at = [];
  DATE_MARK.lastIndex = 0;
  for (let found = DATE_MARK.exec(source); found; found = DATE_MARK.exec(source)) at.push(found.index);

  // A mark that starts after a date is pushed along by however much each date
  // before it grew.
  const moved = (offset) => offset + at.filter((index) => index < offset).length * grew;
  return {
    text: source.replace(DATE_MARK, () => written),
    marks: (marks ?? []).map((mark) => ({ ...mark, start: moved(mark.start), end: moved(mark.end) })),
  };
}

/**
 * Where an offset in the written-out text sits in the text as it was typed.
 *
 * Used to keep the caret still while a box swaps a date for the mark behind it:
 * click into the middle of "Received 27.08.2026" and the caret should stay in
 * the middle of "Received <date>", not jump to one end. An offset inside the
 * date itself comes back as the end of the mark, the mark being the smallest
 * thing that can be edited.
 *
 * @param {string} text as typed
 * @param {number} offset a position in the written-out text
 * @param {Date} [when]
 */
export function rawOffset(text, offset, when = new Date()) {
  const source = String(text ?? '');
  if (!hasDate(source)) return offset;

  const written = writtenDate(when);
  let raw = 0;
  let shown = 0;
  DATE_MARK.lastIndex = 0;
  for (let found = DATE_MARK.exec(source); found; found = DATE_MARK.exec(source)) {
    const plain = found.index - raw;
    if (shown + plain >= offset) return raw + (offset - shown);
    raw = found.index + found[0].length;
    shown += plain + written.length;
    if (shown >= offset) return raw;
  }
  return raw + (offset - shown);
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
