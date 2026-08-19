/**
 * Browser test suite.
 *
 * Run the dev server, open http://localhost:5175/tests/ and the results appear
 * on the page. These are round-trip tests on purpose: almost every subtle bug in
 * a PDF editor is a coordinate bug, and the only way to catch those is to write
 * a file, read it back, and compare it against the preview the user was shown.
 */
import { Workspace, normalizeQuarter } from '../app/core/workspace.js';
import { TOOLS } from '../app/tools/index.js';
import { buildPdf, needsRaster } from '../app/core/export.js';
import { renderPageCanvas } from '../app/core/render.js';
import { makeAnnot, applyMark } from '../app/core/annots.js';
import { wrapText } from '../app/core/fonts.js';
import { pageSize } from '../app/core/workspace.js';
import { extractRows, toCsv } from '../app/core/text.js';
import { parseRange, formatRange } from '../app/util/ranges.js';
import { primeFontMetrics } from '../app/core/fonts.js';
import { PageGrid } from '../app/ui/pagegrid.js';
import { PageViewer } from '../app/ui/pageviewer.js';
import { analysePage } from '../app/core/coverage.js';
import { ocrAvailable, ocrPage } from '../app/core/ocr.js';
import { ocrLines } from '../app/ui/ocrlayer.js';
import { readableRuns, coloursOf } from '../app/core/retype.js';
import {
  targetOf, nameFromUrl, supported, turnOn, turnOff, reconcile, diagnose, looksLikePdf, workspaceFor,
} from '../app/core/intercept.js';
import { PDFDocument, StandardFonts } from '../vendor/pdf-lib.esm.js';
import * as pdfjsLib from '../vendor/pdf.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------ helpers

async function loadWorkspace(names) {
  const ws = new Workspace();
  const files = [];
  for (const name of names) {
    const blob = await fetch(`../test-files/${name}`).then((r) => r.blob());
    files.push(new File([blob], name, { type: 'application/pdf' }));
  }
  const results = await ws.addFiles(files);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`could not load: ${failed.map((f) => f.error).join(', ')}`);
  return ws;
}

/** Renders an exported PDF's page so it can be compared with the preview. */
async function renderBytes(bytes, index = 0, { password } = {}) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), password }).promise;
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 'print' intent avoids pdf.js's requestAnimationFrame loop, which never
  // advances in a background tab.
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  const meta = { canvas, rotate: page.rotate, numPages: doc.numPages, view: page.view };
  await doc.destroy();
  return meta;
}

/** Centre of mass of pixels matching a predicate, as a fraction of the canvas. */
function centroid(canvas, match) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!match(data[i], data[i + 1], data[i + 2])) continue;
    const p = i / 4;
    sx += p % canvas.width;
    sy += Math.floor(p / canvas.width);
    n++;
  }
  return n ? { x: sx / n / canvas.width, y: sy / n / canvas.height, count: n } : null;
}

const isYellow = (r, g, b) => r > 200 && g > 185 && b < 130;
const isRed = (r, g, b) => r > 140 && g < 90 && b < 90;

function near(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected.toFixed(3)}, got ${actual.toFixed(3)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// -------------------------------------------------------------------- tests

test('page ranges parse the documented syntax', () => {
  assert(parseRange('1-10', 20).pages.length === 10, '1-10');
  assert(parseRange('1,4,10', 20).pages.join() === '1,4,10', '1,4,10');
  assert(parseRange('1', 20).pages.join() === '1', 'single');
  assert(parseRange('all', 5).pages.join() === '1,2,3,4,5', 'all');
  assert(parseRange('odd', 6).pages.join() === '1,3,5', 'odd');
  assert(parseRange('3-1', 6).pages.join() === '1,2,3', 'reversed range');
  assert(parseRange('99', 6).error, 'out of range must fail');
  assert(parseRange('banana', 6).error, 'nonsense must fail');
  assert(formatRange([1, 2, 3, 7, 9, 10]) === '1-3, 7, 9-10', 'formatRange');
});

test('imported page geometry matches the source', async () => {
  const ws = await loadWorkspace(['mixed-pages.pdf']);
  const expected = [
    [595.28, 841.89, 0], [841.89, 595.28, 0], [595.28, 841.89, 90],
    [595.28, 841.89, 270], [420, 595, 180],
  ];
  ws.pages.forEach((page, i) => {
    near(page.base.w, expected[i][0], 0.5, `page ${i + 1} width`);
    near(page.base.h, expected[i][1], 0.5, `page ${i + 1} height`);
    assert(page.base.rotate === expected[i][2], `page ${i + 1} rotation`);
  });
});

test('export preserves size and rotation for every quarter turn', async () => {
  const ws = await loadWorkspace(['mixed-pages.pdf']);
  for (const [i, page] of ws.pages.entries()) {
    const bytes = await buildPdf(ws, [page], {});
    const out = await renderBytes(bytes);
    const expected = pageSize(page);
    near(out.canvas.width, expected.w, 1.5, `page ${i + 1} exported width`);
    near(out.canvas.height, expected.h, 1.5, `page ${i + 1} exported height`);
    assert(out.rotate === expected.quarter, `page ${i + 1} rotate: ${out.rotate} vs ${expected.quarter}`);
  }
});

test('annotations land in the same spot in the export as in the preview', async () => {
  const ws = await loadWorkspace(['mixed-pages.pdf']);
  for (const [i, page] of ws.pages.entries()) {
    page.annots = [makeAnnot({
      text: 'ANCHOR', x: 0.10, y: 0.10, w: 0.30, h: 0.10,
      size: 20, color: '#cc0000', bgColor: '#ffee00',
    })];

    const preview = (await renderPageCanvas(ws, page, { scale: 1 })).canvas;
    const out = await renderBytes(await buildPdf(ws, [page], {}));

    for (const [label, match] of [['box', isYellow], ['text', isRed]]) {
      const a = centroid(preview, match);
      const b = centroid(out.canvas, match);
      assert(a, `page ${i + 1}: no ${label} in preview`);
      assert(b, `page ${i + 1}: no ${label} in export`);
      near(b.x, a.x, 0.02, `page ${i + 1} ${label} x`);
      near(b.y, a.y, 0.02, `page ${i + 1} ${label} y`);
      // A badly rotated box also gets clipped, which shows up as lost pixels.
      const ratio = b.count / a.count;
      assert(ratio > 0.75 && ratio < 1.35, `page ${i + 1} ${label} area off by ${ratio.toFixed(2)}×`);
    }
    page.annots = [];
  }
});

test('rotating a page by a quarter turn rotates the export too', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const page = ws.pages[0];
  page.rotate = 90;
  const out = await renderBytes(await buildPdf(ws, [page], {}));
  assert(out.rotate === 90, `expected /Rotate 90, got ${out.rotate}`);
  near(out.canvas.width, 841.89, 1.5, 'rotated width');
  page.rotate = 0;
});

test('cropping shrinks the exported page and keeps it vector', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const page = ws.pages[0];
  page.crop = { left: 0.25, top: 0.1, right: 0.75, bottom: 0.6 };

  const out = await renderBytes(await buildPdf(ws, [page], {}));
  near(out.canvas.width, 595.28 * 0.5, 2, 'cropped width');
  near(out.canvas.height, 841.89 * 0.5, 2, 'cropped height');

  const preview = (await renderPageCanvas(ws, page, { scale: 1 })).canvas;
  near(out.canvas.width / out.canvas.height, preview.width / preview.height, 0.02, 'crop aspect');
  page.crop = null;
});

test('cropping a rotated page crops the region the user sees', async () => {
  const ws = await loadWorkspace(['mixed-pages.pdf']);
  const page = ws.pages[2]; // /Rotate 90
  page.crop = { left: 0, top: 0, right: 0.5, bottom: 1 };
  const preview = (await renderPageCanvas(ws, page, { scale: 1 })).canvas;
  const out = await renderBytes(await buildPdf(ws, [page], {}));
  near(out.canvas.width / out.canvas.height, preview.width / preview.height, 0.03, 'rotated crop aspect');
  page.crop = null;
});

test('splitting produces the right page counts', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const ranges = [[1, 2], [3, 3], [4, 5]];
  for (const [from, to] of ranges) {
    const bytes = await buildPdf(ws, ws.pages.slice(from - 1, to), {});
    const out = await renderBytes(bytes);
    assert(out.numPages === to - from + 1, `part ${from}-${to} had ${out.numPages} pages`);
  }
});

test('merging keeps every page and the chosen order', async () => {
  const ws = await loadWorkspace(['invoice.pdf', 'appendix.pdf']);
  assert(ws.pageCount === 4, `expected 4 pages, got ${ws.pageCount}`);
  ws.moveTo([ws.pages[3].id], 1);
  assert(ws.indexOf(ws.pages[0].id) === 0, 'moveTo did not reorder');
  const out = await renderBytes(await buildPdf(ws, ws.pages, {}));
  assert(out.numPages === 4, `merged file had ${out.numPages} pages`);
});

test('cut points describe the parts they will produce', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  ws.setCuts([2, 4]);
  assert(JSON.stringify(ws.splitRanges()) === JSON.stringify([[1, 2], [3, 4], [5, 5]]),
    `ranges wrong: ${JSON.stringify(ws.splitRanges())}`);

  ws.moveCut(2, 3);
  assert(ws.cutList().join() === '3,4', `move wrong: ${ws.cutList()}`);

  ws.toggleCut(3);
  assert(ws.cutList().join() === '4', `toggle off wrong: ${ws.cutList()}`);

  // A cut after the last page would produce an empty part, so it is ignored.
  ws.setCuts([1, 5, 99]);
  assert(ws.cutList().join() === '1', `out-of-range cuts kept: ${ws.cutList()}`);
});

test('clicking and dragging the split marks in the grid', async () => {
  // This one drives the real DOM. The first version of the split marks looked
  // correct and was still broken: preventDefault on pointerdown, needed to stop
  // the page card being dragged, also suppresses the click event, so clicking
  // the scissors did nothing. Only a gesture-level test catches that.
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'grid'; // the real class, so the real layout rules apply
  // Invisible but still hit-testable: gapUnder uses elementFromPoint, and
  // pointer-events:none here would quietly route the test down a fallback path.
  host.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:640px;overflow:hidden;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const grid = new PageGrid(host, ws, {
    onOpenPage: () => {},
    onCommand: (name, payload) => {
      if (name === 'toggle-cut') ws.toggleCut(payload.afterPage);
      if (name === 'move-cut') ws.moveCut(payload.from, payload.to);
    },
  });
  grid.setZoom(0.3);
  grid.render();

  const slot = (n) => host.querySelector(`.cutmark[data-after="${n}"]`);
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const gesture = (el, from, to) => {
    const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: from.x, clientY: from.y }));
    if (to) window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: to.x, clientY: to.y }));
    const end = to ?? from;
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: end.x, clientY: end.y }));
  };

  try {
    assert(host.querySelectorAll('.cutmark').length === ws.pageCount - 1,
      'there should be one slot in every gap');

    gesture(slot(2), centre(slot(2)));
    assert(ws.cutList().join() === '2', `click on an empty gap did not add a cut: ${ws.cutList()}`);
    assert(slot(2).classList.contains('is-active'), 'the new cut is not drawn as active');

    gesture(slot(2), centre(slot(2)));
    assert(ws.cutList().length === 0, `click on the scissors did not remove the cut: ${ws.cutList()}`);

    ws.setCuts([1, 3]);
    gesture(slot(1), centre(slot(1)), centre(slot(4)));
    assert(ws.cutList().join() === '3,4', `drag moved the cut wrongly: ${ws.cutList()}`);

    // A couple of pixels of tremor must still read as a click, not a drag.
    ws.setCuts([2]);
    const spot = centre(slot(2));
    gesture(slot(2), spot, { x: spot.x + 2, y: spot.y + 1 });
    assert(ws.cutList().length === 0, `a shaky click was treated as a drag: ${ws.cutList()}`);

    // Reaching for a gap must never select or move the page underneath.
    assert(ws.selection.size === 0, 'clicking a gap selected a page');
  } finally {
    host.remove();
  }
});

test('copy-text mode trades dragging for selecting', async () => {
  // Chrome switches text selection off inside a draggable element, so these two
  // cannot both be live. The mode has to actually flip `draggable` — and it has
  // to flip it on cards rendered *after* the mode was entered, which is the case
  // that quietly broke when the attribute was set as the string "false".
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'grid';
  host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px;overflow:hidden;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const grid = new PageGrid(host, ws, { onOpenPage: () => {}, onCommand: () => {} });
  grid.setZoom(0.3);

  try {
    grid.setTextMode(false);
    grid.render();
    const draggable = () => [...host.querySelectorAll('.pcard')].filter((c) => c.draggable).length;
    const total = () => host.querySelectorAll('.pcard').length;
    assert(total() > 0, 'no cards rendered');
    assert(draggable() === total(), 'pages should be draggable by default');

    // Entering the mode, then re-rendering, as switching tools does.
    grid.setTextMode(true);
    grid.render();
    assert(host.classList.contains('is-textmode'), 'the grid is not marked as text mode');
    assert(draggable() === 0, `${draggable()} cards are still draggable in text mode`);

    grid.setTextMode(false);
    grid.render();
    assert(draggable() === total(), 'dragging did not come back');
    assert(!host.classList.contains('is-textmode'), 'text mode was not cleared');
  } finally {
    host.remove();
  }
});

test('reordering a file moves all of its pages as a block', async () => {
  const ws = await loadWorkspace(['invoice.pdf', 'appendix.pdf']);
  const groups = ws.fileGroups();
  assert(groups.length === 2, `expected 2 files, got ${groups.length}`);
  assert(groups[0].pages.length === 2 && groups[1].pages.length === 2, 'wrong page counts');

  ws.moveFile(groups[1].srcId, groups[0].srcId, false);
  const names = ws.pages.map((p) => ws.source(p).name);
  assert(names.join() === 'appendix.pdf,appendix.pdf,invoice.pdf,invoice.pdf',
    `page order after move: ${names.join()}`);

  // Interleave the files, then move again: the block must still gather cleanly.
  ws.moveTo([ws.pages[3].id], 1);
  const beforeCount = ws.pageCount;
  ws.moveFile(ws.fileGroups()[1].srcId, ws.fileGroups()[0].srcId, true);
  assert(ws.pageCount === beforeCount, 'moving a file lost pages');
  const grouped = ws.fileGroups();
  assert(grouped.length === 2 && grouped.every((g) => g.pages.length === 2),
    'file grouping broke after an interleaved move');
});

test('highlights cover only the marked characters', async () => {
  const ws = await loadWorkspace(['invoice.pdf']);
  const page = ws.pages[0];

  // "Reviewed" highlighted, the rest not.
  page.annots = [makeAnnot({
    text: 'Reviewed and approved today',
    x: 0.1, y: 0.1, w: 0.7, h: 0.1, size: 20,
    color: '#111111',
    marks: [{ start: 0, end: 8, color: '#ffee00' }],
  })];

  const preview = (await renderPageCanvas(ws, page, { scale: 1 })).canvas;
  const out = await renderBytes(await buildPdf(ws, [page], {}));

  for (const [label, canvas] of [['preview', preview], ['export', out.canvas]]) {
    const yellow = centroid(canvas, isYellow);
    assert(yellow, `${label}: no highlight drawn`);
    // Marking 8 of 27 characters must not paint the whole line: the strip has to
    // sit in the left third of the box, which starts at x = 0.1.
    assert(yellow.x < 0.32, `${label}: highlight extends past the marked text (centre ${yellow.x.toFixed(3)})`);
  }

  // Same range, split across two lines by a narrow box, still only that range.
  page.annots[0].w = 0.22;
  page.annots[0].marks = [{ start: 9, end: 21, color: '#ffee00' }];
  const narrow = (await renderPageCanvas(ws, page, { scale: 1 })).canvas;
  const marked = centroid(narrow, isYellow);
  assert(marked, 'no highlight after wrapping');
  const all = centroid(narrow, (r, g, b) => !(r > 240 && g > 240 && b > 240));
  assert(marked.count < all.count, 'the highlight covers everything, not just the marked words');

  page.annots = [];
});

test('applying and clearing a highlight range', async () => {
  const text = 'one two three';
  let marks = applyMark([], 4, 7, '#ffee00', text);
  assert(marks.length === 1 && marks[0].start === 4 && marks[0].end === 7, `apply: ${JSON.stringify(marks)}`);

  // Overlapping a second colour splits the first rather than stacking.
  marks = applyMark(marks, 6, 9, '#88ccff', text);
  assert(marks.length === 2, `overlap: ${JSON.stringify(marks)}`);
  assert(marks[0].end === 6 && marks[1].start === 6, `overlap boundaries: ${JSON.stringify(marks)}`);

  // Clearing punches a hole in the middle of a range.
  marks = applyMark([{ start: 0, end: 13, color: '#ffee00' }], 4, 7, null, text);
  assert(marks.length === 2, `clear: ${JSON.stringify(marks)}`);
  assert(marks[0].end === 4 && marks[1].start === 7, `clear boundaries: ${JSON.stringify(marks)}`);

  // Touching ranges of one colour merge instead of piling up.
  marks = applyMark([{ start: 0, end: 4, color: '#ffee00' }], 4, 8, '#ffee00', text);
  assert(marks.length === 1 && marks[0].end === 8, `merge: ${JSON.stringify(marks)}`);
});

test('wrapped lines report the character offsets highlights need', () => {
  const style = { family: 'Helvetica', bold: false, italic: false, size: 12 };
  const text = 'alpha beta gamma delta';
  const lines = wrapText(text, style, 60);
  assert(lines.length > 1, 'the text should have wrapped');
  for (const line of lines) {
    assert(text.slice(line.start, line.end) === line.text,
      `offsets do not match the text: ${JSON.stringify(line)}`);
  }
  // Explicit newlines keep their own offsets too.
  const multi = wrapText('a\nb', style, 500);
  assert(multi.length === 2 && multi[0].text === 'a' && multi[1].text === 'b', JSON.stringify(multi));
  assert(multi[1].start === 2, `offset after a newline: ${JSON.stringify(multi)}`);
});

test('page text can be selected and copied', async () => {
  // The page is drawn to a canvas, which has no text in it at all. Selecting
  // words only works because a transparent text layer is laid over the bitmap,
  // so this checks the words are really there and really selectable.
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;opacity:0;z-index:9999';
  document.body.appendChild(host);
  const editor = new PageViewer(host, ws, { onChange: () => {}, onSelectAnnot: () => {} });

  try {
    await editor.open(ws.pages[0]);
    // The text layer is built after the bitmap, so give it a moment to land.
    for (let i = 0; i < 40 && host.querySelectorAll('.textlayer span').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const spans = host.querySelectorAll('.textlayer span');
    assert(spans.length > 0, 'no selectable text was laid over the page');

    const words = [...spans].map((s) => s.textContent).join(' ');
    assert(words.includes('Quarterly report'), `the heading is missing: ${words.slice(0, 120)}`);
    assert(words.includes('Region'), 'the table headings are missing');

    // What the browser would actually put on the clipboard.
    const range = document.createRange();
    range.setStart(spans[0], 0);
    range.setEnd(spans[Math.min(2, spans.length - 1)], spans[Math.min(2, spans.length - 1)].childNodes.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = selection.toString();
    selection.removeAllRanges();
    assert(copied.includes('Quarterly report'), `selection produced nothing useful: "${copied}"`);

    // The glyphs must stay invisible — the canvas underneath is what is seen.
    assert(getComputedStyle(spans[0]).color === 'rgba(0, 0, 0, 0)',
      'the text layer is painting over the page');
  } finally {
    editor.destroy();
    host.remove();
  }
});

test('a text box moves from its edge, but takes a caret in the middle', async () => {
  const ws = await loadWorkspace(['invoice.pdf']);
  const page = ws.pages[0];
  page.annots = [makeAnnot({ text: 'Hello there', x: 0.2, y: 0.2, w: 0.5, h: 0.2 })];

  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;opacity:0;z-index:9999';
  document.body.appendChild(host);
  const editor = new PageViewer(host, ws, { onChange: () => {}, onSelectAnnot: () => {} });

  const press = (el, at, move) => {
    const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: at.x, clientY: at.y }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: at.x + move.dx, clientY: at.y + move.dy }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: at.x + move.dx, clientY: at.y + move.dy }));
  };

  try {
    await editor.open(page);
    const box = host.querySelector('.abox');
    assert(box, 'no text box was rendered');
    assert(box.querySelector('.abox__text').isContentEditable, 'the text is not editable');

    const rect = box.getBoundingClientRect();
    const startX = page.annots[0].x;

    // Dragging from the middle must leave the box alone — that gesture belongs
    // to the text, for placing a caret or selecting words.
    press(box, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { dx: 40, dy: 30 });
    assert(page.annots[0].x === startX, 'a press in the middle moved the box');

    // Dragging from the border must move it.
    press(box, { x: rect.left + 3, y: rect.top + rect.height / 2 }, { dx: 40, dy: 30 });
    assert(page.annots[0].x !== startX, 'a press on the edge did not move the box');
  } finally {
    editor.destroy();
    host.remove();
    page.annots = [];
  }
});

test('a tilted watermark lands where the preview puts it', async () => {
  const ws = await loadWorkspace(['mixed-pages.pdf']);
  // The annotation's own tilt and the page rotation have opposite signs, so a
  // tilted mark on a quarter-turned page is the case that catches sign errors.
  for (const index of [0, 2]) {
    const page = ws.pages[index];
    page.annots = [makeAnnot({
      role: 'watermark', text: 'DRAFT', x: 0.15, y: 0.3, w: 0.7, h: 0.2,
      size: 48, rotate: -45, align: 'center', valign: 'middle',
      color: '#cc0000', bgColor: '#ffee00', padding: 0,
    })];
    const preview = (await renderPageCanvas(ws, page, { scale: 1 })).canvas;
    const out = await renderBytes(await buildPdf(ws, [page], {}));
    const a = centroid(preview, isRed);
    const b = centroid(out.canvas, isRed);
    assert(a && b, `page ${index + 1}: watermark text missing`);
    near(b.x, a.x, 0.03, `page ${index + 1} watermark x`);
    near(b.y, a.y, 0.03, `page ${index + 1} watermark y`);
    page.annots = [];
  }
});

test('lower compression levels always produce smaller files', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const at = (dpi, quality) => buildPdf(ws, ws.pages, {
    forceRaster: true, rasterDpi: dpi, rasterMime: 'image/jpeg', jpegQuality: quality,
  });
  const light = await at(200, 0.88);
  const balanced = await at(150, 0.76);
  const maximum = await at(72, 0.45);
  assert(balanced.length < light.length, `balanced ${balanced.length} >= light ${light.length}`);
  assert(maximum.length < balanced.length, `maximum ${maximum.length} >= balanced ${balanced.length}`);

  // Worth stating outright: rasterising a small vector PDF makes it *bigger*.
  // The Compress panel therefore estimates real sizes and warns when that happens
  // rather than promising a saving it cannot deliver.
  const plain = await buildPdf(ws, ws.pages, {});
  assert(plain.length > 0, 'plain save produced nothing');
});

test('text extraction finds the table and CSV quotes it correctly', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const rows = await extractRows(ws, ws.pages[0]);
  const header = rows.find((r) => r[0] === 'Region');
  assert(header, 'header row not found');
  assert(header.length === 4, `header had ${header.length} columns: ${JSON.stringify(header)}`);
  const north = rows.find((r) => r[0] === 'North' && r[1] === 'Q1');
  assert(north && north[2] === '128400', `data row wrong: ${JSON.stringify(north)}`);
  const csv = toCsv([['a,b', 'c"d']], {});
  assert(csv.includes('"a,b"') && csv.includes('"c""d"'), `csv quoting wrong: ${csv}`);
});

test('a password-protected export really needs the password', async () => {
  const ws = await loadWorkspace(['invoice.pdf']);
  const bytes = await buildPdf(ws, ws.pages, { password: { user: 'hunter2', owner: 'hunter2' } });

  let refused = false;
  try {
    await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    refused = err?.name === 'PasswordException';
  }
  assert(refused, 'the encrypted file opened without a password');

  const out = await renderBytes(bytes, 0, { password: 'hunter2' });
  assert(out.numPages === 2, 'could not open with the right password');
});

test('background replacement recolours the page', async () => {
  const ws = await loadWorkspace(['invoice.pdf']);
  const page = ws.pages[0];
  page.bg = { mode: 'color', color: '#2244ff', threshold: 0.85 };
  const { canvas } = await renderPageCanvas(ws, page, { scale: 0.5 });
  const blue = centroid(canvas, (r, g, b) => b > 180 && r < 120);
  assert(blue && blue.count > canvas.width * canvas.height * 0.5, 'background was not replaced');
  page.bg = null;
});

// ------------------------------------------------------------------------ OCR

/** Rasterises a page so it becomes a picture of text, with no text objects left. */
async function makeScan(ws, page) {
  const bytes = await buildPdf(ws, [page], { forceRaster: true, rasterDpi: 150 });
  await ws.addBytes(bytes, 'scan.pdf');
  return ws.pages[ws.pageCount - 1];
}

test('a page that already has text is left alone', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const analysis = await analysePage(ws, ws.pages[0]);
  assert(analysis.verdict === 'text', `expected "text", got "${analysis.verdict}"`);
  assert(analysis.textBoxes.length > 10, `only ${analysis.textBoxes.length} text runs found`);
  assert(analysis.regions.length === 0,
    `${analysis.regions.length} regions offered for OCR on a page that is already text`);
});

test('a scanned page is recognised as needing OCR', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const scan = await makeScan(ws, ws.pages[0]);
  const analysis = await analysePage(ws, scan);
  assert(analysis.verdict === 'none', `expected "none", got "${analysis.verdict}"`);
  assert(analysis.textBoxes.length === 0, 'a rasterised page should carry no text');
  assert(analysis.regions.length > 0, 'nothing was offered for OCR');
});

test('a running header is not mistaken for a speck', async () => {
  /*
   * Regions were kept or dropped on area alone, and a short header does not have
   * any. "Chapter 3" at the top of a scan is about a tenth of the page wide and
   * an eightieth tall — a thousandth of the page, four times under the threshold
   * — so every header went unrecognised while the body text below it came out
   * perfectly.
   */
  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 1754;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#111';
  c.font = '22px Arial';
  c.fillText('Chapter 3', 110, 90);
  c.font = '20px Arial';
  for (let i = 0; i < 20; i++) {
    c.fillText('Lorem ipsum dolor sit amet, consectetur adipiscing elit.', 110, 300 + i * 40);
  }
  // The things the threshold is there to reject, so this cannot be passed by
  // simply keeping everything.
  c.fillRect(600, 1700, 4, 4);
  c.fillRect(650, 1712, 3, 3);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawImage(await doc.embedPng(await blob.arrayBuffer()), { x: 0, y: 0, width: 595.28, height: 841.89 });

  const ws = new Workspace();
  await ws.addBytes(await doc.save(), 'scan.pdf');
  const analysis = await analysePage(ws, ws.pages[0]);

  const header = analysis.regions.find((r) => r.y < 0.12);
  assert(header, `nothing was offered for OCR at the top of the page; regions: ${
    analysis.regions.map((r) => `${r.y.toFixed(2)}±${(r.w * r.h).toFixed(4)}`).join(', ')}`);
  assert(header.w * header.h < 0.004,
    'the test header is large enough to pass on area alone, so it proves nothing');

  const specks = analysis.regions.filter((r) => r.y > 0.9);
  assert(specks.length === 0, `${specks.length} speck(s) at the foot of the page were offered for OCR`);
});

test('a half-scanned page is only recognised where it helps', async () => {
  // The case that separates a useful OCR tool from a wasteful one: real text at
  // the top, a picture of text at the bottom. Recognising the whole page would
  // spend the time twice and stack a worse copy under the good text.
  const ws = new Workspace();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('This heading is real selectable text', { x: 56, y: 780, size: 18, font });

  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 46px Arial';
  ctx.fillText('Scanned addendum 2026', 40, 90);
  ctx.font = '38px Arial';
  ctx.fillText('Reference SCAN-88231', 40, 180);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const image = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
  page.drawImage(image, { x: 56, y: 300, width: 483, height: 193 });

  await ws.addFiles([new File([await doc.save()], 'mixed.pdf', { type: 'application/pdf' })]);
  const mixed = ws.pages[0];

  const analysis = await analysePage(ws, mixed);
  assert(analysis.verdict === 'partial', `expected "partial", got "${analysis.verdict}"`);
  assert(analysis.textBoxes.length > 0, 'the real text was not seen');
  assert(analysis.regions.length > 0, 'the scanned block was not offered for OCR');

  // Every region has to sit below the heading — none of them over the real text.
  const heading = analysis.textBoxes[0];
  for (const region of analysis.regions) {
    assert(region.y > heading.y + heading.h,
      `a region overlaps the existing text (region y ${region.y.toFixed(2)}, text ends ${(heading.y + heading.h).toFixed(2)})`);
  }
});

test('recognised text survives being saved, and the page still looks identical', async () => {
  if (!(await ocrAvailable())) {
    // The engine is an optional 32 MB download; without it there is nothing to
    // assert, and failing here would only be noise.
    return;
  }
  const ws = await loadWorkspace(['report.pdf']);
  const scan = await makeScan(ws, ws.pages[0]);

  const result = await ocrPage(ws, scan, {});
  assert(!result.skipped, 'the scan was skipped');
  assert(result.words.length > 0, 'nothing was recognised');
  scan.ocr = { words: result.words, regions: result.regions, verdict: result.verdict };

  const withOcr = await buildPdf(ws, [scan], { includeOcr: true });
  const without = await buildPdf(ws, [scan], { includeOcr: false });

  const textOf = async (bytes) => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const text = content.items.map((i) => i.str).join(' ');
    await doc.destroy();
    return text;
  };

  const text = await textOf(withOcr);
  assert(text.includes('Quarterly report'), `the heading is not extractable: "${text.slice(0, 80)}"`);
  assert((await textOf(without)).length === 0, 'text was written even with the layer switched off');

  // The whole point: identical to look at, different to select from.
  const shot = async (bytes) => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 0.4 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    await doc.destroy();
    return data;
  };
  const a = await shot(withOcr);
  const b = await shot(without);
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
  assert(diff === 0, `the invisible layer changed the page's appearance (total difference ${diff})`);
});

test('recognised text can be selected in the app, not only in the saved file', async () => {
  if (!(await ocrAvailable())) return;

  const ws = await loadWorkspace(['report.pdf']);
  const scan = await makeScan(ws, ws.pages[0]);
  const result = await ocrPage(ws, scan, {});
  assert(result.words.length > 0, 'nothing was recognised');
  scan.ocr = { words: result.words, regions: result.regions, verdict: result.verdict };

  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;opacity:0;z-index:9999';
  document.body.appendChild(host);
  const editor = new PageViewer(host, ws, { onChange: () => {}, onSelectAnnot: () => {} });

  try {
    await editor.open(scan);
    for (let i = 0; i < 50 && host.querySelectorAll('.textlayer .ocrword').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const spans = host.querySelectorAll('.textlayer .ocrword');
    assert(spans.length > 0, 'recognised words never reached the text layer');

    // Invisible, but selectable — the page underneath is what should be seen.
    assert(getComputedStyle(spans[0]).color === 'rgba(0, 0, 0, 0)', 'the words are painted over the page');

    const range = document.createRange();
    range.selectNodeContents(spans[0]);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = selection.toString();
    selection.removeAllRanges();
    assert(copied.trim().length > 0, 'selecting a recognised word produced nothing');

    // And each word has to sit on the page rather than beside it.
    const stage = host.querySelector('.viewer__page').getBoundingClientRect();
    const box = spans[0].getBoundingClientRect();
    assert(box.left >= stage.left - 2 && box.right <= stage.right + 2,
      'a recognised word is positioned outside the page');

    assert(ocrLines(scan).length > 0, 'ocrLines produced nothing to copy');
  } finally {
    editor.destroy();
    host.remove();
  }
});

// ------------------------------------------------------------------- viewer

test('the viewer zooms, pans, and turns the page when there is nothing to pan', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  let currentPage = null;
  const viewer = new PageViewer(host, ws, { onPageChange: (p) => { currentPage = p; } });

  try {
    await viewer.open(ws.pages[0]);
    const scroller = host.querySelector('.viewer__scroll');

    // Fit: the whole sheet is visible, so there is nothing to scroll.
    viewer.setZoom(null);
    assert(!viewer.canScroll(), 'the page should fit entirely at fit zoom');

    // Zoomed in: now it is bigger than the window, and panning is just scrolling.
    viewer.setZoom(3);
    assert(viewer.canScroll(), 'a page at 300% should be scrollable');
    scroller.scrollTop = 50;
    scroller.scrollLeft = 40;
    assert(scroller.scrollTop > 0 && scroller.scrollLeft > 0, 'the page did not pan');

    // The wheel gesture that would otherwise do nothing turns the page instead.
    viewer.setZoom(null);
    const before = viewer.currentPageId;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert(viewer.currentPageId !== before, 'the wheel did not turn the page at fit zoom');
    assert(currentPage, 'the page change was not reported');

    // Zoomed in, the same gesture has to scroll rather than skip a page.
    viewer.setZoom(3);
    const held = viewer.currentPageId;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(viewer.currentPageId === held, 'the wheel skipped a page while there was still page to scroll');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('the paging arrows appear only where they lead somewhere', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  const prev = () => host.querySelector('.editor__nav--prev');
  const next = () => host.querySelector('.editor__nav--next');

  try {
    await viewer.open(ws.pages[0]);
    assert(prev() && next(), 'the viewer has no paging arrows');
    assert(prev().disabled, 'the back arrow should be gone on the first page');
    assert(!next().disabled, 'the forward arrow should be available on the first page');

    next().click();
    assert(ws.indexOf(viewer.currentPageId) === 1, 'the arrow did not turn the page');
    assert(!prev().disabled, 'the back arrow should appear once past the first page');

    while (ws.indexOf(viewer.currentPageId) < ws.pageCount - 1) next().click();
    assert(next().disabled, 'the forward arrow should be gone on the last page');

    // Scrolling already crosses pages in continuous layout, so a page-turn
    // button there would be a second, worse way of doing the same thing.
    viewer.setLayout('continuous');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert(prev().disabled && next().disabled, 'the arrows should go in continuous layout');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('continuous layout stacks every page', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  try {
    await viewer.open(ws.pages[0]);
    assert(host.querySelectorAll('.viewer__page').length === 1, 'single layout should show one page');

    viewer.setLayout('continuous');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const frames = [...host.querySelectorAll('.viewer__page')];
    assert(frames.length === ws.pageCount, `expected ${ws.pageCount} pages, got ${frames.length}`);
    // Stacked, so scrolling runs from one page into the next.
    assert(frames[1].offsetTop > frames[0].offsetTop, 'pages are not stacked vertically');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('a long document only draws the pages in view', async () => {
  /*
   * The point of this one is what does *not* happen. A 148-page document has to
   * open at the speed of its first page: every frame exists so that scrolling
   * has somewhere to go, but only what is near the window is rasterised.
   *
   * What made opening one slow was different again — sizing a frame and then
   * asking where it landed, once per page, made the browser settle the layout
   * 148 times over — and this test does not catch that. A timing assertion is a
   * coin toss on someone else's machine, so the comment in relayout() carries
   * that story instead.
   */
  const ws = await loadWorkspace(['long.pdf']);
  assert(ws.pageCount === 148, `expected 148 pages, got ${ws.pageCount}`);

  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  try {
    viewer.setLayout('continuous');
    await viewer.open(ws.pages[0]);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const frames = host.querySelectorAll('.viewer__page');
    assert(frames.length === 148, `expected a frame per page, got ${frames.length}`);

    // A 600px window fits about one page, plus the margin drawn ahead of it.
    const drawn = host.querySelectorAll('.viewer__canvas canvas').length;
    assert(drawn > 0, 'nothing was drawn at all');
    assert(drawn <= 8, `${drawn} of 148 pages were rasterised; only the ones in view should be`);

    // And the frames still stack in order, at the sizes the pages ask for.
    const first = frames[0].getBoundingClientRect();
    const second = frames[1].getBoundingClientRect();
    assert(second.top > first.top, 'the pages are not stacked');
    assert(Math.round(first.height) > 0, 'the frames have no height');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('zoom stops where the page fills the window, and steps by fifty to 400%', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  try {
    await viewer.open(ws.pages[0]);
    const stops = viewer.zoomStops();
    const fit = viewer.fitScales();

    // The two sizes nobody could dial in by hand: a different awkward number for
    // every page and every window, and the only two worth landing on exactly.
    for (const [name, value] of [['width', fit.width], ['height', fit.height]]) {
      assert(stops.some((z) => Math.abs(z - value) < 0.005),
        `the size that fills the window ${name}wise (${(value * 100).toFixed(1)}%) is not a stop`);
    }

    // Half-steps through the range where a document is actually being read.
    for (const step of [2, 2.5, 3, 3.5, 4]) {
      assert(stops.some((z) => Math.abs(z - step) < 0.001), `${step * 100}% is missing`);
    }

    // Walking up must never skip one of them.
    viewer.setZoom(2);
    viewer.zoomBy(1);
    assert(Math.abs(viewer.zoom - 2.5) < 0.001,
      `above 200% it went to ${(viewer.zoom * 100).toFixed(0)}%, not 250%`);
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('left and right move across the page, then on to the next one', async () => {
  /*
   * Zoomed in, "right" means the part of the sheet just out of view, not the
   * next sheet. Turning the page there also reset the scroll, so the document
   * appeared to lurch away diagonally. Only at the edge, with nothing further to
   * see, does sideways mean the next page.
   */
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  try {
    await viewer.open(ws.pages[0]);
    viewer.setZoom(3);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const room = viewer.scroller.scrollWidth - viewer.scroller.clientWidth;
    assert(room > 10, 'the test needs a page wider than its window');

    // Away from the edge: it travels along the page and stays on it.
    viewer.scroller.scrollLeft = Math.round(room / 2);
    const page = viewer.currentPageId;
    const from = viewer.scroller.scrollLeft;
    viewer.handleKey({ key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(viewer.scroller.scrollLeft > from, 'the right arrow did not move along the page');
    assert(viewer.currentPageId === page, 'the right arrow turned the page with room still to spare');

    // At the right-hand edge, there is nothing left to see: on to the next page.
    viewer.scroller.scrollLeft = room;
    viewer.handleKey({ key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert(viewer.currentPageId !== page, 'at the edge the right arrow did not turn the page');

    // Up and down stay with the page they are on.
    const now = viewer.currentPageId;
    const top = viewer.scroller.scrollTop;
    viewer.handleKey({ key: 'ArrowDown' });
    assert(viewer.currentPageId === now, 'the down arrow turned the page');
    assert(viewer.scroller.scrollTop > top, 'the down arrow did not scroll');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('a text box is drawn once, not painted into the page as well', async () => {
  /*
   * Every annotation is a live box in the editing layer over the page. Painting
   * them into the bitmap underneath as well put a second, frozen copy of each on
   * screen: moving the real one left the painted one sitting where it had been,
   * so one text box looked like two, only one of which answered to the pointer.
   */
  const ws = await loadWorkspace(['invoice.pdf']);
  const page = ws.pages[0];

  const fingerprint = async (opts) => {
    const { canvas } = await renderPageCanvas(ws, page, { scale: 0.4, ...opts });
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 40) sum += data[i];
    return sum;
  };

  const bare = await fingerprint({ withAnnots: false });
  page.annots.push(makeAnnot({ text: 'On the page', x: 0.2, y: 0.5, w: 0.5, h: 0.12, bgColor: '#ff0000' }));

  assert(await fingerprint({ withAnnots: false }) === bare,
    'the page the viewer draws changed when a text box was added — it is being painted in twice');
  assert(await fingerprint({ withAnnots: true }) !== bare,
    'the thumbnail path stopped drawing annotations, and the grid has no layer to show them instead');
});

test('a wide sheet can be panned past all four of its edges', async () => {
  const ws = await loadWorkspace(['blueprint.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  try {
    await viewer.open(ws.pages[0]);
    const scroller = host.querySelector('.viewer__scroll');
    const frame = host.querySelector('.viewer__page');

    // Nothing to pan while it all fits, so no empty room is invented either.
    viewer.setZoom(null);
    assert(!viewer.canScroll(), 'the whole sheet should fit at fit zoom');
    assert(scroller.scrollWidth <= scroller.clientWidth + 2, 'fit zoom should not need sideways scrolling');

    viewer.setZoom(1);
    const quarterX = scroller.clientWidth * 0.25;
    const quarterY = scroller.clientHeight * 0.25;
    const gap = (edge) => {
      const f = frame.getBoundingClientRect();
      const v = scroller.getBoundingClientRect();
      return { left: f.left - v.left, right: v.right - f.right, top: f.top - v.top, bottom: v.bottom - f.bottom };
    };
    // A quarter of the window on every side, so a detail in any corner of a
    // wide drawing can be dragged into the middle to be looked at.
    scroller.scrollLeft = 0;
    scroller.scrollTop = 0;
    const start = gap();
    assert(start.left >= quarterX - 1, `only ${Math.round(start.left)}px of room past the left edge`);
    assert(start.top >= quarterY - 1, `only ${Math.round(start.top)}px of room past the top edge`);

    scroller.scrollLeft = scroller.scrollWidth;
    scroller.scrollTop = scroller.scrollHeight;
    const end = gap();
    assert(end.right >= quarterX - 1, `only ${Math.round(end.right)}px of room past the right edge`);
    assert(end.bottom >= quarterY - 1, `only ${Math.round(end.bottom)}px of room past the bottom edge`);
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('the viewer can be sent straight to a page by number', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  let reported = null;
  const viewer = new PageViewer(host, ws, { onPageChange: (p) => { reported = p; } });
  try {
    await viewer.open(ws.pages[0]);
    const target = ws.pages[3];

    assert(viewer.goTo(target.id), 'the jump was refused');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(viewer.currentPageId === target.id, 'the viewer did not land on the chosen page');
    assert(reported?.id === target.id, 'the page change was not reported');

    // In a stack the jump scrolls to the page instead of rebuilding it, so the
    // pages already drawn stay drawn.
    viewer.setLayout('continuous');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = [...host.querySelectorAll('.viewer__page')].map((f) => f.dataset.id).join();
    viewer.goTo(ws.pages[1].id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = [...host.querySelectorAll('.viewer__page')].map((f) => f.dataset.id).join();
    assert(before === after, 'jumping in continuous layout threw the drawn pages away');
    assert(viewer.currentPageId === ws.pages[1].id, 'the viewer lost track of the page it jumped to');

    assert(!viewer.goTo('no-such-page'), 'a page that does not exist should not be jumped to');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('a handed-over PDF address survives its own query string', async () => {
  // The reason this is not read with URLSearchParams: everything after `open=`
  // is the original address, and a PDF address carrying its own parameters would
  // be cut at the first `&` by anything that treats it as one field among many.
  const cases = [
    ['?open=https://example.com/a.pdf', 'https://example.com/a.pdf'],
    ['?open=https://example.com/a.pdf?token=abc&page=2', 'https://example.com/a.pdf?token=abc&page=2'],
    ['?open=https://example.com/one%20two.pdf', 'https://example.com/one%20two.pdf'],
    ['?open=file:///C:/reports/q1.pdf', 'file:///C:/reports/q1.pdf'],
  ];
  for (const [search, expected] of cases) {
    const got = targetOf(search);
    assert(got === expected, `from "${search}" expected "${expected}", got "${got}"`);
  }

  assert(targetOf('') === null, 'an empty query should hand over nothing');
  assert(targetOf('?demo=merge') === null, 'an unrelated query should hand over nothing');
});

test('a fetched document is named after the address it came from', async () => {
  const cases = [
    ['https://example.com/annual-report.pdf', 'annual-report.pdf'],
    ['https://example.com/annual-report.pdf?token=abc', 'annual-report.pdf'],
    ['https://example.com/files/Q1%20results.pdf', 'Q1 results.pdf'],
    // Served as a PDF from an address that does not say so — still gets a name
    // that says what it is, because that name ends up on the saved file.
    ['https://example.com/download/8821', '8821.pdf'],
    ['https://example.com/', 'document.pdf'],
    ['not a url at all', 'document.pdf'],
  ];
  for (const [url, expected] of cases) {
    const got = nameFromUrl(url);
    assert(got === expected, `from "${url}" expected "${expected}", got "${got}"`);
  }
});

test('rotating a page turns it in the viewer, without leaving it', async () => {
  // Rotate is one of the tools that acts wherever you are. If it ever went back
  // to being grid-only, opening it while reading would throw you out of the
  // document — so the declaration is worth pinning down alongside the behaviour.
  const rotate = TOOLS.find((tool) => tool.id === 'rotate');
  assert(rotate, 'there is no rotate tool');
  assert(rotate.mode === 'any',
    `rotate declares mode "${rotate.mode}"; anything but "any" leaves the viewer`);

  const ws = await loadWorkspace(['mixed-pages.pdf']);
  const landscape = ws.pages[1];
  const before = pageSize(landscape);
  assert(before.w > before.h, 'expected page 2 of the sample to be landscape');

  const host = document.createElement('div');
  host.className = 'viewer';
  host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;z-index:9999';
  document.body.appendChild(host);

  const viewer = new PageViewer(host, ws, {});
  try {
    await viewer.open(landscape);
    const frame = () => host.querySelector(`.viewer__page[data-id="${landscape.id}"]`);
    assert(Number(frame().dataset.w) > Number(frame().dataset.h), 'the viewer did not start landscape');

    landscape.rotate = normalizeQuarter(landscape.rotate + 90);
    await viewer.rebind(landscape);

    const after = pageSize(landscape);
    assert(after.w === before.h && after.h === before.w, 'the quarter turn did not swap the sides');
    assert(Number(frame().dataset.w) < Number(frame().dataset.h),
      'the viewer still shows the page in its old shape');
  } finally {
    viewer.destroy();
    host.remove();
  }
});

test('mirroring a page really reverses it, and survives being saved', async () => {
  const ws = await loadWorkspace(['mixed-pages.pdf']);
  const page = ws.pages[0];

  const pixels = async () => {
    const { canvas } = await renderPageCanvas(ws, page, { scale: 0.5 });
    const ctx = canvas.getContext('2d');
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height), w: canvas.width, h: canvas.height };
  };

  const plain = await pixels();
  page.flipX = true;
  const flipped = await pixels();

  assert(flipped.w === plain.w && flipped.h === plain.h, 'mirroring changed the page size');

  /*
   * Every pixel has to be its opposite number across the page. Sampling rather
   * than comparing all of them: a handful of rows through the middle is enough
   * to tell a mirrored page from an unchanged one, and cheap.
   */
  const at = (img, x, y) => {
    const i = (y * img.w + x) * 4;
    return [img.data.data[i], img.data.data[i + 1], img.data.data[i + 2]].join(',');
  };
  let compared = 0;
  for (let y = 4; y < plain.h; y += Math.floor(plain.h / 12)) {
    for (let x = 0; x < plain.w; x += Math.floor(plain.w / 12)) {
      assert(at(plain, x, y) === at(flipped, plain.w - 1 - x, y),
        `pixel ${x},${y} is not the mirror of ${plain.w - 1 - x},${y}`);
      compared++;
    }
  }
  assert(compared > 50, `only ${compared} pixels were compared`);

  // And the saved file has to show it too, which means it may not stay vector.
  assert(needsRaster(ws, page, {}), 'a mirrored page was left as vector, which cannot show a reflection');
  const bytes = await buildPdf(ws, [page], {});
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  assert(doc.numPages === 1, 'the mirrored page did not survive saving');
});

test('taking over the page’s own text puts a box in its place', async () => {
  const ws = await loadWorkspace(['report.pdf']);
  const page = ws.pages[0];

  const runs = await readableRuns(ws, page);
  assert(runs.length > 10, `only ${runs.length} runs of text were found`);

  const heading = runs.find((r) => r.text.includes('Quarterly'));
  assert(heading, 'the heading was not among the runs');
  // The size has to be the one the page uses, or the replacement will not sit
  // on the same line as what is around it.
  assert(Math.abs(heading.size - 22) < 0.5, `the heading reads as ${heading.size}pt, not 22`);
  assert(heading.y < 0.2 && heading.x > 0.02, `the heading is placed at ${heading.x}, ${heading.y}`);

  const { ink, paper } = await coloursOf(ws, page, heading);
  // Sampled from beside the words, not through them: from inside, the average
  // is white blurred with the letters, and lays a grey rectangle on white paper.
  assert(paper === '#ffffff', `the paper under the heading came out as ${paper}`);
  assert(ink !== paper && ink < '#888888', `the ink came out as ${ink}`);

  page.annots.push(makeAnnot({
    text: 'Annual report — page 1',
    x: heading.x, y: heading.y, w: heading.w, h: heading.h,
    size: heading.size, family: heading.family, color: ink, bgColor: paper,
  }));

  const bytes = await buildPdf(ws, [page], {});
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  assert(text.includes('Annual report'), 'the new wording is not in the saved file');
  assert(text.includes('Region'), 'the rest of the page did not survive');

  /*
   * And the part worth being straight about: the old words are still in there,
   * behind the cover. Anyone reaching for this to hide something would be
   * mistaken, so the tool says so and this holds the claim to being true.
   */
  assert(text.includes('Quarterly report'),
    'the original text is gone — then the warning about it being merely covered is now wrong');
});

test('saving a range of pages keeps their text selectable', async () => {
  // The point of the feature: the same choice a print dialog offers, but what
  // comes out is the document, not a picture of it.
  const ws = await loadWorkspace(['report.pdf']);
  const { pages } = parseRange('2-4', ws.pageCount);
  const chosen = ws.pagesByNumbers(pages);
  assert(chosen.length === 3, `expected 3 pages, got ${chosen.length}`);

  const bytes = await buildPdf(ws, chosen, {});
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  assert(doc.numPages === 3, `saved ${doc.numPages} pages instead of 3`);

  // Page 1 of the saved file has to be page 2 of the original, with its text.
  const text = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    text.push(content.items.map((item) => item.str).join(' '));
  }
  assert(text[0].includes('page 2'), `first saved page reads "${text[0].slice(0, 60)}"`);
  assert(text[2].includes('page 4'), `last saved page reads "${text[2].slice(0, 60)}"`);
  for (const [i, page] of text.entries()) {
    assert(page.trim().length > 20, `saved page ${i + 1} carries no selectable text`);
  }
});

test('local files are asked for, and refusing them keeps the rest', async () => {
  /*
   * The switch on the browser's extensions page does not grant file access, it
   * only makes it grantable. Without asking as well the extension holds none,
   * and then nothing can touch a local PDF however that switch is set — which is
   * why local files never worked on any machine.
   */
  const make = ({ fileSwitch, allowFile }) => {
    const asked = [];
    const store = new Map();
    let held = [];
    return {
      asked,
      held: () => held,
      chrome: {
        runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}`, getManifest: () => ({ version: 'test' }) },
        storage: {
          local: {
            get: async (key) => ({ [key]: store.get(key) }),
            set: async (patch) => { for (const [k, v] of Object.entries(patch)) store.set(k, v); },
          },
        },
        permissions: {
          contains: async ({ origins }) => origins.every((o) => held.includes(o)),
          request: async ({ origins }) => {
            asked.push(origins.join(' '));
            if (!allowFile && origins.some((o) => o.startsWith('file://'))) return false;
            held = [...new Set([...held, ...origins])];
            return true;
          },
          remove: async () => { held = []; return true; },
          getAll: async () => ({ origins: held }),
        },
        declarativeNetRequest: {
          updateDynamicRules: async () => {},
          getDynamicRules: async () => [],
        },
        extension: { isAllowedFileSchemeAccess: async () => fileSwitch },
      },
    };
  };

  const real = globalThis.chrome;
  try {
    // Switch off: never asked for, so the web half is not put at risk.
    let env = make({ fileSwitch: false, allowFile: false });
    globalThis.chrome = env.chrome;
    await turnOn();
    assert(!env.asked.some((a) => a.includes('file://')),
      'file access was asked for although the browser switch is off');
    assert(env.held().includes('https://*/*'), 'the web access was not obtained');

    // Switch on and allowed: asked for together, and held.
    env = make({ fileSwitch: true, allowFile: true });
    globalThis.chrome = env.chrome;
    await turnOn();
    assert(env.asked[0].includes('file:///*'), 'file access was not asked for');
    assert(env.held().includes('file:///*'), 'file access was not obtained');
    assert((await diagnose()).fileOriginGranted, 'the diagnostic does not report the file grant');

    // Switch on but turned down: the web half still has to survive it.
    env = make({ fileSwitch: true, allowFile: false });
    globalThis.chrome = env.chrome;
    const result = await turnOn();
    assert(result.ok, 'refusing local files took the whole feature down with it');
    assert(env.held().includes('https://*/*'), 'the web access was lost with the file refusal');
    assert(env.asked.length === 2, `expected a second ask without file access, got ${env.asked.length}`);
  } finally {
    globalThis.chrome = real;
  }
});

test('the setting is already on before the permission is granted', async () => {
  /*
   * Granting fires permissions.onAdded, and the background worker answers it by
   * reconciling the rule against this stored setting — on its own schedule, in a
   * worker that may have to start up first. Whatever order those land in, the
   * setting has to read "on" by the time the grant happens, or a reconcile that
   * arrives late tears down the rule that was just installed.
   *
   * Asserting the order directly rather than trying to stage the race: the race
   * is by nature timing-dependent, and a test that only sometimes reproduces it
   * is worth less than one that pins the invariant which prevents it.
   */
  const store = new Map();
  const events = [];
  let settingAtGrant = 'never asked';
  let granted = false;
  let rules = [];

  const chromeStub = {
    runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}` },
    storage: {
      local: {
        get: async (key) => ({ [key]: store.get(key) }),
        set: async (patch) => { for (const [k, v] of Object.entries(patch)) store.set(k, v); },
      },
    },
    permissions: {
      contains: async () => granted,
      request: async () => {
        // What a reconcile triggered by this grant would see.
        settingAtGrant = store.get('pdf-toolbox:intercept-pdfs');
        granted = true;
        events.push('reconcile');
        await reconcile();
        return true;
      },
      remove: async () => { granted = false; return true; },
      getAll: async () => ({ permissions: [], origins: granted ? ['http://*/*', 'https://*/*'] : [] }),
    },
    declarativeNetRequest: {
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        rules = rules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      },
      getDynamicRules: async () => rules,
    },
    extension: { isAllowedFileSchemeAccess: async () => false },
  };

  const real = globalThis.chrome;
  globalThis.chrome = chromeStub;
  try {
    const result = await turnOn();
    assert(result.ok, `turning it on failed: ${result.reason ?? ''} ${result.error ?? ''}`);
    assert(events.includes('reconcile'), 'the test did not actually exercise the reconcile');
    assert(settingAtGrant === true,
      `the setting read "${settingAtGrant}" when the permission was granted; a reconcile `
      + 'arriving at that moment would have removed the rule');

    const state = await diagnose();
    assert(state.ruleInstalled, 'no rule was installed');

    // And the redirect has to point at something the manifest makes reachable.
    const [rule] = await chromeStub.declarativeNetRequest.getDynamicRules();
    assert(rule.action.redirect.regexSubstitution.includes('app/index.html'),
      'the rule does not redirect to the workspace');
    assert(/\\0$/.test(rule.action.redirect.regexSubstitution),
      'the original address is not carried through to the workspace');

    // The fallback has to land on the same address the rule builds, and that
    // address has to be readable back out at the far end.
    const url = 'https://example.com/a.pdf?token=abc&page=2';
    const handover = workspaceFor(url);
    assert(handover === rule.action.redirect.regexSubstitution.replace('\\0', url),
      `the fallback sends documents somewhere else: ${handover}`);
    assert(targetOf(handover.slice(handover.indexOf('?'))) === url,
      'the address does not survive the fallback hand-over');

    /*
     * The rule and the tab-watching fallback have to agree about what a PDF
     * address is. They are two separate expressions of the same judgement, and a
     * document caught by one but not the other would behave differently
     * depending on which mechanism happened to fire.
     */
    const pattern = new RegExp(rule.condition.regexFilter, 'i');
    const cases = [
      ['https://example.com/report.pdf', true],
      ['http://example.com/a/b/report.PDF', true],
      ['https://example.com/report.pdf?token=abc', true],
      ['file:///C:/reports/q1.pdf', true],
      ['https://example.com/report.pdfx', false],
      ['https://example.com/download/8821', false],
      ['chrome-extension://abc/app/index.html?open=https://x/y.pdf', false],
    ];
    for (const [url, want] of cases) {
      assert(looksLikePdf(url) === want, `looksLikePdf("${url}") should be ${want}`);
      assert(pattern.test(url) === want, `the rule pattern disagrees about "${url}"`);
    }

    // Switching off has to take the rule with it, not just the setting.
    await turnOff();
    assert((await diagnose()).ruleInstalled === false, 'the rule outlived being switched off');
  } finally {
    globalThis.chrome = real;
  }
});

test('intercepting stays switched off outside the extension', async () => {
  // The whole feature hinges on it being inert until asked for. On a plain page
  // there is no chrome.* to ask, and it has to say so rather than throw.
  assert(supported() === false, 'interception should report itself unavailable off-extension');
});

// --------------------------------------------------------------------- runner

export async function run(onResult) {
  await primeFontMetrics();
  const results = [];
  for (const { name, fn } of tests) {
    const started = performance.now();
    try {
      await fn();
      const result = { name, ok: true, ms: Math.round(performance.now() - started) };
      results.push(result);
      onResult?.(result);
    } catch (err) {
      const result = { name, ok: false, error: String(err?.message ?? err), ms: Math.round(performance.now() - started) };
      results.push(result);
      onResult?.(result);
    }
  }
  return results;
}
