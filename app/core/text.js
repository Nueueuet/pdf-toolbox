/**
 * Text extraction, used by the CSV converter.
 *
 * PDF has no notion of a table — only glyphs at coordinates. So rows are
 * recovered by clustering text runs that share a baseline, and cells by looking
 * for horizontal gaps wider than ordinary word spacing. It is a heuristic, and
 * it is honest about that in the UI.
 */

/**
 * @returns {Promise<string[][]>} rows of cells, in reading order
 */
export async function extractRows(ws, page, { columnGap = 1.8 } = {}) {
  const source = ws.source(page);
  if (source?.kind !== 'pdf') return [];

  const pdfPage = await source.doc.getPage(page.srcIndex + 1);
  const content = await pdfPage.getTextContent();

  const items = content.items
    .filter((item) => item.str && item.str.trim() !== '')
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: Math.abs(item.transform[3]) || item.height || 10,
    }));

  if (items.length === 0) return [];

  const medianHeight = median(items.map((i) => i.height)) || 10;
  const rowTolerance = medianHeight * 0.6;

  // Cluster by baseline. PDF y grows upwards, so sort descending for reading order.
  const rows = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    // The first run seen on a line anchors it; averaging the baseline instead
    // lets a row drift far enough to swallow the next one.
    const row = rows.find((r) => Math.abs(r.y - item.y) <= rowTolerance);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }

  const spaceWidth = medianHeight * 0.32;
  return rows.map((row) => {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let current = null;
    for (const item of sorted) {
      if (current && item.x - (current.x + current.width) <= spaceWidth * columnGap) {
        const needsSpace = item.x - (current.x + current.width) > spaceWidth * 0.4;
        current.text += (needsSpace ? ' ' : '') + item.text;
        current.width = item.x + item.width - current.x;
      } else {
        if (current) cells.push(current);
        current = { ...item };
      }
    }
    if (current) cells.push(current);
    return cells.map((cell) => cell.text.replace(/\s+/g, ' ').trim());
  }).filter((cells) => cells.some((cell) => cell !== ''));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** RFC 4180 quoting, with a BOM so Excel opens UTF-8 correctly. */
export function toCsv(rows, { delimiter = ',', bom = true } = {}) {
  const escape = (cell) => {
    const text = String(cell ?? '');
    return /["\n\r]|^\s|\s$/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  const body = rows.map((row) => row.map(escape).join(delimiter)).join('\r\n');
  return (bom ? '﻿' : '') + body;
}

/** Plain reading-order text, used by the "plain text" CSV fallback. */
export async function extractText(ws, page) {
  const rows = await extractRows(ws, page);
  return rows.map((cells) => cells.join(' ')).join('\n');
}
