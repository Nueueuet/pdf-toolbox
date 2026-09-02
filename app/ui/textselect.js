/**
 * Selecting text on a page, including the parts of a page that are not text.
 *
 * A PDF's words are a scattering of absolutely positioned pieces, and most of a
 * page is the space between them: margins, column gutters, the inside of a
 * table, the gap after a short line. Pressing there gives the browser no word to
 * anchor to, so it anchors in the layer itself — at a position *between* two of
 * its children — and drags the selection through the pieces in the order the
 * file happens to store them. On a form laid out in columns, a drag across two
 * lines came back with half the page, jumbled.
 *
 * So a press that lands on nothing is answered here instead: the nearest word is
 * found, then the nearest gap between two of its letters, and the selection is
 * made and extended by hand from there. A press that lands on a word is left to
 * the browser, which does that part exactly right — including double-click to
 * take a word and triple-click to take a line.
 *
 * The stylesheet does its half by making the layer itself unselectable while
 * leaving its words selectable, so there is no longer anything in the gaps for a
 * stray press to catch hold of.
 */

/** How much more a line above or below counts than a column to the side. */
const LINE_WEIGHT = 4;

/**
 * True for a run written at an angle — a watermark, a label up a margin.
 *
 * Such a run is skipped when looking for the word nearest a press, because the
 * rectangle it reports is not the shape it occupies. "unverbindlicher
 * Einzelblattausdruck" set corner to corner across a form reports a box 516 by
 * 516 on a page 595 wide: nearest to every point on the page, and the answer to
 * every press in every margin. The browser knows better — it hit-tests the
 * turned shape itself — so a press that really is on the watermark still lands
 * there and is handled the ordinary way.
 */
function isTurned(span) {
  const angle = /rotate\((-?[\d.]+)deg\)/.exec(span.style.transform ?? '');
  return Boolean(angle) && Math.abs(Number(angle[1])) > 1;
}

/**
 * The word nearest a point.
 *
 * @param {HTMLElement} layer a `.textlayer`
 * @returns {HTMLElement|null}
 */
function nearestWord(layer, x, y) {
  let best = null;
  for (const span of layer.children) {
    if (span.tagName !== 'SPAN' || span.classList.contains('endOfContent')) continue;
    if (!span.firstChild || span.firstChild.nodeType !== Node.TEXT_NODE) continue;
    if (isTurned(span)) continue;
    const box = span.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;

    const dx = x < box.left ? box.left - x : Math.max(0, x - box.right);
    const dy = y < box.top ? box.top - y : Math.max(0, y - box.bottom);
    /*
     * Pressing in the gutter between two columns, the word meant is the one on
     * the same line as the pointer — not the nearer one a line above.
     */
    const distance = dy * LINE_WEIGHT + dx;
    if (!best || distance < best.distance) best = { span, distance };
  }
  return best?.span ?? null;
}

/**
 * Where in a word a caret belongs for a given x.
 *
 * Measured letter by letter rather than asked of the browser: asked, it answers
 * for the point given, and the point given is in the empty space this is here to
 * get out of — it comes back with a position between two children of the layer,
 * which is the very thing that makes a selection run away.
 *
 * @returns {{node: Text, offset: number}}
 */
function offsetInWord(span, x) {
  const node = span.firstChild;
  const text = node.nodeValue ?? '';
  const range = document.createRange();
  let best = { offset: 0, distance: Infinity };

  for (let offset = 0; offset <= text.length; offset++) {
    range.setStart(node, offset);
    range.setEnd(node, offset);
    const rect = range.getBoundingClientRect();
    // A collapsed range at the very end of a text node can report nothing; the
    // end of the word is then as good a place as the measurement would give.
    const at = rect.width === 0 && rect.height === 0 && offset > 0
      ? span.getBoundingClientRect().right
      : rect.left;
    const distance = Math.abs(at - x);
    if (distance < best.distance) best = { offset, distance };
  }
  return { node, offset: best.offset };
}

/**
 * A text position for a point, whether or not the point is over a word.
 *
 * @param {HTMLElement} layer
 * @returns {{node: Text, offset: number}|null}
 */
export function textPositionAt(layer, x, y) {
  const span = nearestWord(layer, x, y);
  if (!span) return null;
  return offsetInWord(span, x);
}

/**
 * Makes dragging across a page select the words dragged across.
 *
 * @param {HTMLElement} root the element the pages live in
 * @returns {() => void} stops listening
 */
export function wireTextSelection(root) {
  let dragging = null;

  const layerAt = (x, y) => {
    const under = document.elementFromPoint(x, y);
    return under?.closest?.('.textlayer') ?? null;
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const layer = event.target.closest?.('.textlayer');
    if (!layer) return;

    layer.classList.add('is-selecting');
    // On a word, the browser's own handling is better than anything here.
    if (event.target !== layer) return;

    const from = textPositionAt(layer, event.clientX, event.clientY);
    if (!from) return;

    // Stops the browser putting its own anchor between two children of the
    // layer, which is where a run-away selection comes from.
    event.preventDefault();
    window.getSelection().setBaseAndExtent(from.node, from.offset, from.node, from.offset);
    dragging = { layer, from };
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    // Dragging off the page keeps the last page dragged on, so the selection
    // grows to the edge rather than stopping dead at it.
    const layer = layerAt(event.clientX, event.clientY) ?? dragging.layer;
    const to = textPositionAt(layer, event.clientX, event.clientY);
    if (!to) return;
    event.preventDefault();
    const { from } = dragging;
    window.getSelection().setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  };

  const onPointerUp = () => {
    dragging = null;
    for (const layer of root.querySelectorAll('.textlayer.is-selecting')) {
      layer.classList.remove('is-selecting');
    }
  };

  root.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  return () => {
    root.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
  };
}
