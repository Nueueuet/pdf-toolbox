/**
 * OCR: makes the text in scanned pages selectable.
 *
 * Its own tool rather than a checkbox somewhere, because it is the one operation
 * that takes minutes rather than moments, needs watching, and changes what the
 * grid is showing while it runs.
 */
import { h, clear } from '../util/dom.js';
import { section, field, hint, button, primary, buttonRow, checkbox } from '../ui/controls.js';
import { ocrAvailable, ocrInfo, loadEngine, ocrPage, wasmAllowed, OCR_NOT_INSTALLED } from '../core/ocr.js';
import { analysePage } from '../core/coverage.js';
import { pageScope } from './organize.js';
import { toast } from '../ui/toast.js';

/** Where a page stands, for the grid badges and the summary. */
export function ocrStatusOf(page) {
  if (page.ocr?.words?.length) return 'done';
  if (page.ocr?.skipped || page.meta?.ocrScan === 'text' || page.meta?.ocrScan === 'empty') return 'not-needed';
  if (page.meta?.ocrScan) return 'pending';
  return 'unknown';
}

export const OCR_STATUS_LABEL = {
  done: 'Text recognised',
  'not-needed': 'Already selectable text',
  pending: 'No selectable text yet',
  unknown: 'Not checked yet',
};

const ocr = {
  id: 'ocr',
  label: 'OCR',
  group: 'Convert',
  mode: 'grid',
  icon: 'M7 3H5a2 2 0 0 0-2 2v2 M17 3h2a2 2 0 0 1 2 2v2 M7 21H5a2 2 0 0 1-2-2v-2 M17 21h2a2 2 0 0 0 2-2v-2 M7 8h10 M7 12h7 M7 16h4',
  blurb: 'Recognise the text in scanned pages so it can be selected and copied — in the saved file too.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const summary = h('div.ocrsummary');
    const status = h('p.hint');
    const progressWrap = h('div.ocrprogress', { hidden: true },
      h('span.progress', h('i.progress__bar')),
      h('span.ocrprogress__label'),
    );

    const includeInExport = checkbox({
      label: 'Include recognised text when saving',
      checked: ctx.app.includeOcr !== false,
      onchange: (on) => { ctx.app.includeOcr = on; },
    });
    const inspect = checkbox({
      label: 'Show what OCR added',
      checked: ctx.app.grid.ocrInspect === true,
      onchange: (on) => ctx.app.grid.setOcrInspect(on),
    });

    const startBtn = primary('Recognise text', { onclick: () => run() });
    const cancelBtn = button('Cancel', { tone: 'danger', onclick: () => abort?.abort() });
    cancelBtn.hidden = true;

    let abort = null;
    let installed = false;

    // ---------------------------------------------------------------- summary

    const renderSummary = () => {
      const counts = { done: 0, 'not-needed': 0, pending: 0, unknown: 0 };
      for (const page of ctx.ws.pages) counts[ocrStatusOf(page)]++;

      clear(summary);
      for (const key of ['done', 'pending', 'not-needed', 'unknown']) {
        if (counts[key] === 0) continue;
        summary.appendChild(h('div.ocrsummary__row',
          h(`span.ocrdot.ocrdot--${key}`),
          h('span.ocrsummary__count', String(counts[key])),
          h('span.ocrsummary__label', OCR_STATUS_LABEL[key]),
        ));
      }
      if (summary.childElementCount === 0) summary.appendChild(hint('No pages loaded.'));
    };

    renderSummary();
    ctx.onClose(ctx.ws.on('pages', renderSummary));
    ctx.onClose(ctx.ws.on('ocr', renderSummary));

    // ------------------------------------------------------------ availability

    (async () => {
      installed = await ocrAvailable();
      startBtn.disabled = !installed;
      if (!installed) {
        status.textContent = OCR_NOT_INSTALLED;
        return;
      }

      // Checked up front rather than three minutes into a job: OCR needs to
      // compile WebAssembly, and if the browser will not allow that here, the
      // failure is worth reporting before anyone waits on it.
      const wasm = wasmAllowed();
      if (!wasm.ok) {
        startBtn.disabled = true;
        installed = false;
        status.textContent = 'This browser is refusing to compile WebAssembly on this page, '
          + 'so OCR cannot run. The extension needs "wasm-unsafe-eval" in its content security '
          + `policy, and to be reloaded after that changed. Reported: ${wasm.error}`;
        status.classList.add('hint--warn');
        return;
      }

      const info = await ocrInfo();
      status.textContent = `Engine: ${info.model}, running locally. Nothing is uploaded.`;
      // Work out what each page needs, quietly, so the grid can colour itself in.
      ctx.app.scanPagesForOcr();
    })();

    // ---------------------------------------------------------------- running

    const setRunning = (on) => {
      startBtn.hidden = on;
      cancelBtn.hidden = !on;
      progressWrap.hidden = !on;
    };

    const setProgress = (fraction, label) => {
      progressWrap.querySelector('.progress__bar').style.width = `${Math.round(fraction * 100)}%`;
      progressWrap.querySelector('.ocrprogress__label').textContent = label;
    };

    const run = async (only) => {
      if (!installed) return toast(OCR_NOT_INSTALLED, { tone: 'error', timeout: 9000 });

      const pages = only ? [only] : scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages matched', { tone: 'error' });

      abort = new AbortController();
      setRunning(true);
      setProgress(0, 'Starting the engine…');

      let done = 0;
      let recognised = 0;
      let skipped = 0;
      try {
        await loadEngine((f, label) => setProgress(f * 0.1, label));

        for (const page of pages) {
          if (abort.signal.aborted) break;
          const number = ctx.ws.indexOf(page.id) + 1;
          setProgress(0.1 + (done / pages.length) * 0.9, `Page ${number} of ${ctx.ws.pageCount}`);

          const result = await ocrPage(ctx.ws, page, {
            signal: abort.signal,
            onProgress: (f) => setProgress(0.1 + ((done + f) / pages.length) * 0.9, `Page ${number}`),
          });

          // Written straight onto the page, not through commit: cancelling must
          // keep what is already finished, and undoing an hour of recognition
          // one page at a time helps nobody.
          page.meta.ocrScan = result.verdict;
          page.ocr = result.skipped
            ? { skipped: true, reason: result.reason, verdict: result.verdict, words: [] }
            : { words: result.words, regions: result.regions, verdict: result.verdict, at: Date.now() };

          if (result.skipped) skipped++;
          else recognised++;
          done++;
          ctx.ws.emit('ocr');
        }

        const cancelled = abort.signal.aborted;
        setRunning(false);
        toast(
          cancelled
            ? `Cancelled — ${done} of ${pages.length} pages kept`
            : `Recognised ${recognised} ${recognised === 1 ? 'page' : 'pages'}${skipped ? `, ${skipped} needed nothing` : ''}`,
          { tone: cancelled ? 'info' : 'success' },
        );
      } catch (err) {
        setRunning(false);
        if (err?.name === 'AbortError') {
          toast(`Cancelled — ${done} of ${pages.length} pages kept`, { tone: 'info' });
        } else {
          console.error(err);
          toast(`OCR failed: ${err.message}`, { tone: 'error', timeout: 9000 });
        }
      } finally {
        abort = null;
        ctx.ws.emit('ocr');
      }
    };

    // The grid's per-page button comes back through here.
    ctx.app.runOcrForPage = (page) => run(page);
    ctx.onClose(() => { ctx.app.runOcrForPage = null; });
    ctx.onClose(() => abort?.abort());

    const clearAll = () => {
      const pages = scope.resolve();
      if (!pages) return;
      for (const page of pages) {
        delete page.ocr;
        delete page.meta.ocrScan;
      }
      ctx.ws.emit('ocr');
      toast('Recognised text discarded', { tone: 'info' });
    };

    return h('div',
      section('Pages', summary),
      section('Recognise', scope.el,
        hint('Click the OCR badge on a page in the grid to do just that one.'),
        buttonRow(startBtn, cancelBtn),
        progressWrap,
        status,
      ),
      section('Result', includeInExport, inspect,
        hint('The page itself is never altered. The recognised words go into the saved PDF as an invisible layer, so it looks identical but the text can be selected and searched.'),
        buttonRow(button('Discard recognised text', { onclick: clearAll })),
      ),
    );
  },
};

/**
 * Works out what every page needs, without recognising anything.
 *
 * Cheap enough to run over the whole document when the tool opens, which is what
 * lets the grid say "this one is already text" before anyone waits on OCR.
 */
export async function scanPages(ws, pages, onEach) {
  for (const page of pages) {
    if (page.meta?.ocrScan || page.ocr) continue;
    try {
      const analysis = await analysePage(ws, page);
      page.meta.ocrScan = analysis.verdict;
      // Kept for the inspection overlay, which draws the text the PDF already
      // had beside the text recognition added.
      page.meta.ocrTextBoxesList = analysis.textBoxes;
      onEach?.(page);
    } catch (err) {
      console.error('page analysis failed', err);
    }
  }
}

export default [ocr];
