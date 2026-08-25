/**
 * Printing what is in the workspace, edits and all.
 *
 * The browser's own Ctrl+P prints the page it is on, which here is the
 * application: three columns of tool rail, thumbnails and panel. What anyone
 * pressing it wants is the document — so the document is what is built, handed
 * to the browser as a PDF, and printed.
 */
import { h } from '../util/dom.js';
import { section, hint, primary, buttonRow, checkbox } from '../ui/controls.js';
import { buildPdf } from '../core/export.js';
import { pageScope } from './organize.js';
import { progressToast, toast } from '../ui/toast.js';

/**
 * Hands a built PDF to the browser's print dialog.
 *
 * Through a frame the page cannot see: a PDF put in an <iframe> is opened by the
 * browser's own PDF viewer, and asking that frame to print gives the ordinary
 * print dialog with a proper preview of the document — page sizes, margins and
 * all — rather than a screenshot of the workspace.
 *
 * The frame is kept until the dialog is done with it. Removing it straight away
 * takes the document out from under the dialog, which then has nothing to print.
 *
 * @param {Uint8Array} bytes the document to print
 * @param {(frame: HTMLIFrameElement) => void} [send] how the frame is printed,
 *   so a test can watch without a dialog opening
 */
export function printBytes(bytes, send = (frame) => frame.contentWindow.print()) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = h('iframe.printframe', { src: url, 'aria-hidden': 'true' });

  return new Promise((resolve, reject) => {
    frame.addEventListener('load', () => {
      try {
        send(frame);
        resolve(frame);
      } catch (err) {
        reject(err);
      }
    });
    frame.addEventListener('error', () => reject(new Error('the document could not be opened for printing')));
    document.body.appendChild(frame);

    // Long enough for any dialog to have been answered, and harmless if it has
    // not: the dialog holds its own copy of what it is printing.
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 120_000);
  });
}

const print = {
  id: 'print',
  label: 'Print',
  group: 'Read',
  mode: 'any',
  icon: 'M6 9V3h12v6 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v7H6z',
  blurb: 'Print the document as it stands, with every edit on it.',
  panel(ctx) {
    const scope = pageScope(ctx, { label: 'Pages' });
    const withAnnots = checkbox({ label: 'Include text boxes, stamps and watermarks', checked: true });

    const run = async () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages to print', { tone: 'error' });

      const progress = progressToast('Preparing to print…');
      try {
        const bytes = await buildPdf(ctx.ws, pages, {
          ...ctx.app.exportOptions(),
          includeAnnots: withAnnots.checked,
        });
        await printBytes(bytes);
        progress.done(`Sent ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} to the printer`);
      } catch (err) {
        console.error(err);
        progress.fail(`Printing failed: ${err.message}`);
      }
    };

    // Reached from Ctrl+P as well, which goes straight to the dialog.
    ctx.app.printNow = run;
    ctx.onClose(() => { ctx.app.printNow = null; });

    return h('div',
      section('What to print', scope.el, withAnnots),
      section(null,
        buttonRow(primary('Print', { onclick: run })),
        hint('Ctrl+P prints the whole document without coming here first. What is printed is the document, not the window — the edits on the pages are on the print.'),
      ),
    );
  },
};

export default [print];
