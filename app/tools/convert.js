/** Convert (CSV / PNG / JPG) and URL → PDF. */
import { h } from '../util/dom.js';
import { section, field, hint, primary, buttonRow, select, radioCards, checkbox, textInput, slider } from '../ui/controls.js';
import { renderPageCanvas } from '../core/render.js';
import { extractRows, toCsv } from '../core/text.js';
import { saveFile, saveMany } from '../core/download.js';
import { baseName, formatBytes } from '../util/format.js';
import { progressToast, toast } from '../ui/toast.js';
import { pageScope } from './organize.js';
import { IN_EXTENSION } from '../core/paths.js';

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

// ------------------------------------------------------------- url to pdf

const urlToPdf = {
  id: 'url',
  label: 'URL → PDF',
  group: 'Convert',
  mode: 'grid',
  icon: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  blurb: 'Save any web page as a PDF, using Chrome’s own print engine.',
  panel(ctx) {
    const url = textInput({ placeholder: 'https://example.com/article' });
    const paper = select({
      value: 'a4',
      options: [
        { value: 'a4', label: 'A4' },
        { value: 'letter', label: 'Letter' },
        { value: 'a3', label: 'A3' },
      ],
    });
    const landscape = checkbox({ label: 'Landscape' });
    const background = checkbox({ label: 'Include background colours and images', checked: true });
    const margin = select({
      value: '0.4',
      options: [
        { value: '0', label: 'No margin' },
        { value: '0.4', label: 'Normal margin' },
        { value: '0.8', label: 'Wide margin' },
      ],
    });
    const openAfter = checkbox({ label: 'Add to the workspace instead of downloading', checked: true });

    const PAPER = {
      a4: [8.27, 11.69],
      letter: [8.5, 11],
      a3: [11.69, 16.54],
    };

    const run = async () => {
      const target = url.value.trim();
      if (!target) return toast('Enter a URL first', { tone: 'error' });

      let parsed;
      try {
        parsed = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
      } catch {
        return toast('That does not look like a URL', { tone: 'error' });
      }

      if (!IN_EXTENSION) {
        return toast('URL → PDF needs the installed extension — Chrome’s print engine is not reachable from a plain page.', { tone: 'error', timeout: 9000 });
      }

      // The debugger permission is only requested when the feature is used.
      const granted = await chrome.permissions.request({
        permissions: ['debugger'],
        origins: [`${parsed.origin}/*`],
      }).catch(() => false);
      if (!granted) return toast('Permission denied — cannot capture the page', { tone: 'error' });

      const [width, height] = PAPER[paper.value];
      const progress = progressToast(`Loading ${parsed.hostname}…`);
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'url-to-pdf',
          url: parsed.href,
          options: {
            paperWidth: width,
            paperHeight: height,
            landscape: landscape.checked,
            printBackground: background.checked,
            margin: Number(margin.value),
          },
        });
        if (!response?.ok) throw new Error(response?.error ?? 'Capture failed');

        const bytes = base64ToBytes(response.base64);
        const name = `${parsed.hostname}${parsed.pathname.replace(/\/+$/, '').replace(/\//g, '-')}.pdf`;
        if (openAfter.checked) {
          await ctx.ws.addBytes(bytes, name);
          progress.done(`Added ${name}`);
        } else {
          await saveFile(bytes, name);
          progress.done(`Saved ${name}`);
        }
      } catch (err) {
        console.error(err);
        progress.fail(`Could not capture the page: ${err.message}`);
      }
    };

    return h('div',
      section('Address', field(null, url), hint('Pages behind a login are captured as Chrome sees them in a fresh tab, so private pages may render logged out.')),
      section('Paper', field('Size', paper), landscape, field('Margins', margin), background),
      section(null, buttonRow(primary('Capture page', { onclick: run })), openAfter),
    );
  },
};

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default [convert, urlToPdf];
