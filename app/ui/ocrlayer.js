/**
 * Puts recognised words into the same transparent text layer that carries a
 * page's real text.
 *
 * Without this, OCR results exist only in the exported file: the workspace would
 * show a scan you cannot select a word from, having just told you it recognised
 * every word on it. Once the spans are here, selecting and copying work the same
 * for recognised text as for text the PDF always had.
 */

/**
 * @param {HTMLElement} container a `.textlayer` element, laid out in page points
 * @param {object} page
 * @param {number} displayWidth page width in points
 * @param {number} displayHeight page height in points
 */
export function appendOcrText(container, page, displayWidth, displayHeight) {
  const words = page.ocr?.words ?? [];
  if (words.length === 0) return 0;

  const placed = [];
  for (const word of words) {
    if (!word.text?.trim()) continue;

    const span = document.createElement('span');
    span.className = 'ocrword';
    span.textContent = word.text;
    span.style.left = `${word.x * displayWidth}px`;
    span.style.top = `${word.y * displayHeight}px`;
    // Font size follows the recognised box height, so a selection highlight
    // covers the ink rather than floating above or below it.
    span.style.fontSize = `${Math.max(1, word.h * displayHeight)}px`;
    container.appendChild(span);
    placed.push([span, word.w * displayWidth]);
  }

  /*
   * Widths are matched in a second pass, on purpose. Reading offsetWidth forces
   * layout, so measuring inside the loop would lay the page out once per word;
   * appending everything first costs one reflow for the lot.
   */
  for (const [span, want] of placed) {
    const natural = span.offsetWidth;
    if (natural > 0) span.style.transform = `scaleX(${want / natural})`;
  }

  return placed.length;
}

/** Recognised words as readable lines, for copying whole pages at once. */
export function ocrLines(page, tolerance = 0.012) {
  const words = [...(page.ocr?.words ?? [])].filter((w) => w.text?.trim());
  if (words.length === 0) return [];

  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const word of words) {
    const line = lines.find((l) => Math.abs(l.y - word.y) <= tolerance);
    if (line) line.words.push(word);
    else lines.push({ y: word.y, words: [word] });
  }
  return lines.map((line) => line.words.sort((a, b) => a.x - b.x).map((w) => w.text).join(' '));
}
