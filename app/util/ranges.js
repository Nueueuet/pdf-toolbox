/**
 * Page-range parsing for the "which pages?" input that most tools share.
 * Accepts the syntax the spec asked for: `1-10`, `1,4,10`, `1`, and mixtures
 * like `1-3, 7, 9-12`. Also understands `all`, `odd`, `even`, `last`, and open
 * ranges (`5-`, `-4`).
 */

/**
 * @param {string} input
 * @param {number} pageCount
 * @returns {{ pages: number[], error: string|null }} `pages` is 1-based, sorted, de-duplicated.
 */
export function parseRange(input, pageCount) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text || text === 'all' || text === '*') {
    return { pages: countUp(pageCount), error: null };
  }

  const picked = new Set();
  for (const rawPart of text.split(/[,;]/)) {
    const part = rawPart.trim();
    if (!part) continue;

    if (part === 'odd') {
      for (let i = 1; i <= pageCount; i += 2) picked.add(i);
      continue;
    }
    if (part === 'even') {
      for (let i = 2; i <= pageCount; i += 2) picked.add(i);
      continue;
    }
    if (part === 'last') {
      if (pageCount) picked.add(pageCount);
      continue;
    }

    const match = part.match(/^(\d*)\s*(?:-|–|to|\.\.)\s*(\d*)$/);
    if (match) {
      const from = match[1] ? Number(match[1]) : 1;
      const to = match[2] ? Number(match[2]) : pageCount;
      if (!Number.isFinite(from) || !Number.isFinite(to)) return fail(part);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      if (lo < 1 || hi > pageCount) return outOfRange(part, pageCount);
      for (let i = lo; i <= hi; i++) picked.add(i);
      continue;
    }

    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > pageCount) return outOfRange(part, pageCount);
      picked.add(n);
      continue;
    }

    return fail(part);
  }

  if (picked.size === 0) return { pages: [], error: 'No pages selected' };
  return { pages: [...picked].sort((a, b) => a - b), error: null };
}

/** Renders a page list back into compact range syntax, e.g. [1,2,3,7] -> "1-3, 7". */
export function formatRange(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) {
      start = prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(', ');
}

function countUp(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function fail(part) {
  return { pages: [], error: `Could not read "${part}" — try 1-10, or 1,4,10` };
}

function outOfRange(part, pageCount) {
  return { pages: [], error: `"${part}" is outside 1-${pageCount}` };
}
