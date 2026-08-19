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
 * Puts the layer's spans into reading order: down the page, then across.
 *
 * A selection is a range over the DOM, so what you get when you drag across a
 * page is decided by the order the spans are in — not by where they sit. A PDF
 * stores its text in whatever order it was drawn, which for anything laid out in
 * columns or boxes is often nowhere near the order it is read in: on a tax form
 * here, the second run on the page sits at the very bottom of it, and a heading
 * is stored after the line beneath it.
 *
 * Left alone, that means dragging from the top of the page catches everything
 * while starting a few lines down quietly skips whatever the file happened to
 * store earlier. Sorting the spans fixes the selection without moving anything:
 * every one of them is absolutely positioned, so the page looks identical.
 *
 * @param {HTMLElement} container a `.textlayer` element
 */
export function sortIntoReadingOrder(container) {
  const spans = [...container.children].filter((el) => el.tagName === 'SPAN' && !el.classList.contains('endOfContent'));
  if (spans.length < 2) return;

  /*
   * Measured rather than read off the style.
   *
   * pdf.js writes `top` and `left` as percentages of the layer, not pixels, so
   * parsing them gives numbers in a unit that has nothing to do with the
   * tolerance below: a "4" meant for points became four per cent of the page,
   * about three lines' worth, and whole paragraphs were treated as one line and
   * ordered left to right. Every read happens before any write here, so the
   * browser settles the layout once for all of them.
   */
  const origin = container.getBoundingClientRect();
  const measured = spans.map((el, index) => {
    const box = el.getBoundingClientRect();
    return { el, index, top: box.top - origin.top, left: box.left - origin.left };
  });

  // A line is not perfectly level — glyphs of different sizes sit on the same
  // baseline at slightly different tops — so anything within a fraction of the
  // page counts as the same line and is ordered across instead. Taken from the
  // page height so it holds at any zoom.
  const SAME_LINE = Math.max(2, origin.height * 0.006);
  measured.sort((a, b) => {
    if (Math.abs(a.top - b.top) > SAME_LINE) return a.top - b.top;
    if (a.left !== b.left) return a.left - b.left;
    return a.index - b.index;
  });

  /*
   * The line breaks are rebuilt rather than carried along.
   *
   * pdf.js marks the ends of lines with its own <br> elements, and those are
   * what put newlines into copied text. Moving the spans without them left every
   * break stranded at the top of the layer, so a page copied as one unbroken
   * paragraph. They are dropped and re-inserted wherever the sorted order steps
   * down to a new line.
   */
  for (const br of container.querySelectorAll('br')) br.remove();

  const tail = container.querySelector('.endOfContent');
  let previousTop = null;
  for (const { el, top } of measured) {
    if (previousTop !== null && top - previousTop > SAME_LINE) {
      container.appendChild(document.createElement('br'));
    }
    container.appendChild(el);
    previousTop = top;
  }
  // The marker pdf.js uses to extend a selection past the last span belongs at
  // the end, wherever it started.
  if (tail) container.appendChild(tail);
}

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
