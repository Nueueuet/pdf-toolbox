/** Convert: pages out as CSV, PNG or JPG. */
import { h } from '../util/dom.js';
import { section, field, hint, primary, buttonRow, select, radioCards, checkbox, textInput, slider } from '../ui/controls.js';
import { renderPageCanvas } from '../core/render.js';
import { extractRows, toCsv } from '../core/text.js';
import { saveFile, saveMany } from '../core/download.js';
import { baseName, formatBytes } from '../util/format.js';
import { progressToast, toast } from '../ui/toast.js';
import { pageScope } from './organize.js';
import { ocrLines } from '../ui/ocrlayer.js';

const convert = {
  id: 'convert',
  label: 'Convert',
  group: 'Convert',
  mode: 'grid',
  icon: 'M4 7h11 M11 3l4 4-4 4 M20 17H9 M13 21l-4-4 4-4',
  blurb: 'Turn the document into images or a spreadsheet.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const formats = radioCards({
      value: 'png',
      options: [
        { value: 'png', label: 'PNG', description: 'One lossless image per page. Keeps transparency.' },
        { value: 'jpg', label: 'JPG', description: 'One photo-style image per page. Much smaller.' },
        { value: 'csv', label: 'CSV', description: 'Extracts the text and lays it out as rows and columns.' },
      ],
    });

    const dpi = select({
      value: '150',
      options: [
        { value: '96', label: '96 dpi — screen' },
        { value: '150', label: '150 dpi — good' },
        { value: '300', label: '300 dpi — print' },
        { value: '600', label: '600 dpi — very large files' },
        // An A4 page at this comes out around 9900 by 14000 pixels, which is
        // past what some browsers will allocate a canvas for. Worth offering,
        // worth saying so.
        { value: '1200', label: '1200 dpi — huge; may fail on big pages' },
      ],
    });
    const quality = slider({ value: 85, min: 40, max: 100, step: 1, format: (v) => `${v}%` });
    const singleCsv = checkbox({ label: 'All pages in one CSV file', checked: true });
    const delimiter = select({
      value: ',',
      options: [
        { value: ',', label: 'Comma (,)' },
        { value: ';', label: 'Semicolon (;) — European Excel' },
        { value: '\t', label: 'Tab' },
      ],
    });

    const imageOptions = h('div', field('Resolution', dpi), field('JPG quality', quality));
    const csvOptions = h('div', field('Separator', delimiter), singleCsv,
      hint('PDF stores glyphs, not tables, so columns are recovered from the spacing. Check the result before relying on it. Scanned pages have no text to extract.'));

    const syncOptions = () => {
      const format = formats.value;
      imageOptions.style.display = format === 'csv' ? 'none' : '';
      csvOptions.style.display = format === 'csv' ? '' : 'none';
      quality.parentElement.style.display = format === 'jpg' ? '' : 'none';
    };
    formats.addEventListener('change', syncOptions);
    syncOptions();

    const run = async () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages matched', { tone: 'error' });

      const format = formats.value;
      const base = baseName(ctx.ws.name);
      const progress = progressToast('Converting…');

      try {
        if (format === 'csv') {
          const perPage = [];
          for (const [index, page] of pages.entries()) {
            progress.update(index / pages.length, `Page ${index + 1} of ${pages.length}`);
            perPage.push(await extractRows(ctx.ws, page));
          }

          const empty = perPage.every((rows) => rows.length === 0);
          if (empty) {
            progress.fail('No selectable text found — these pages are probably scans.');
            return;
          }

          if (singleCsv.checked) {
            const rows = [];
            perPage.forEach((pageRows, index) => {
              if (pages.length > 1) rows.push([`# page ${ctx.ws.indexOf(pages[index].id) + 1}`]);
              rows.push(...pageRows);
            });
            await saveFile(toCsv(rows, { delimiter: delimiter.value }), `${base}.csv`, { type: 'text/csv;charset=utf-8' });
            progress.done('Saved CSV');
          } else {
            const entries = perPage.map((rows, index) => ({
              name: `${base} page ${ctx.ws.indexOf(pages[index].id) + 1}.csv`,
              data: new Blob([toCsv(rows, { delimiter: delimiter.value })], { type: 'text/csv;charset=utf-8' }),
            }));
            const outcome = await saveMany(entries, { zipName: `${base} csv.zip` });
            progress.done(`Saved ${outcome.count} files${outcome.zipped ? ' as a zip' : ''}`);
          }
          return;
        }

        const mime = format === 'png' ? 'image/png' : 'image/jpeg';
        const scale = Number(dpi.value) / 72;
        const entries = [];
        let bytes = 0;
        for (const [index, page] of pages.entries()) {
          progress.update(index / pages.length, `Page ${index + 1} of ${pages.length}`);
          const { canvas } = await renderPageCanvas(ctx.ws, page, { scale });
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality.value / 100));
          bytes += blob.size;
          entries.push({ name: `${base} page ${ctx.ws.indexOf(page.id) + 1}.${format}`, data: blob, type: mime });
        }
        const outcome = await saveMany(entries, { zipName: `${base} ${format}.zip` });
        progress.done(`Saved ${outcome.count} images (${formatBytes(bytes)})${outcome.zipped ? ' as a zip' : ''}`);
      } catch (err) {
        console.error(err);
        progress.fail(`Conversion failed: ${err.message}`);
      }
    };

    return h('div',
      section('Pages', scope.el),
      section('Format', formats),
      section('Options', imageOptions, csvOptions),
      section(null, buttonRow(primary('Convert & save', { onclick: run }))),
    );
  },
};

/**
 * Selecting text on the pages is its own mode for the same reason splitting is:
 * it changes what a drag on a page means. Chrome switches selection off inside
 * a draggable element, so reordering and selecting cannot both be live, and a
 * mode makes which one is active something the user chose rather than guessed.
 */
const copyText = {
  id: 'copytext',
  label: 'Copy text',
  group: 'Convert',
  mode: 'grid',
  icon: 'M9 3h9a2 2 0 0 1 2 2v9 M5 7h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z',
  blurb: 'Select text straight off the pages and copy it. Dragging pages to reorder is paused while this is open.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const status = h('p.hint');

    const copyAll = async () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages matched', { tone: 'error' });

      const progress = progressToast('Reading text…');
      try {
        const chunks = [];
        for (const [index, page] of pages.entries()) {
          progress.update(index / pages.length, `Page ${index + 1} of ${pages.length}`);
          const rows = await extractRows(ctx.ws, page);
          // Recognised words count as text too, or copying a scan that OCR has
          // just read would come back empty.
          const lines = [...rows.map((cells) => cells.join(' ')), ...ocrLines(page)];
          if (lines.length === 0) continue;
          if (pages.length > 1) chunks.push(`--- page ${ctx.ws.indexOf(page.id) + 1} ---`);
          chunks.push(lines.join('\n'));
        }

        if (chunks.length === 0) {
          progress.fail('No text found. If these are scans, run OCR first.');
          return;
        }

        const text = chunks.join('\n\n');
        await navigator.clipboard.writeText(text);
        progress.done(`Copied ${text.length.toLocaleString()} characters`);
      } catch (err) {
        console.error(err);
        progress.fail(`Could not copy: ${err.message}`);
      }
    };

    status.textContent = 'Drag across the pages to select text, then copy it as usual. '
      + 'Page reordering is paused until you leave this tool.';

    return h('div',
      section(null, status),
      section('Copy everything', scope.el,
        buttonRow(primary('Copy text to clipboard', { onclick: copyAll })),
        hint('Scanned pages hold no text, so nothing can be copied from them — there is no OCR here.'),
      ),
    );
  },
};

export default [convert, copyText];
