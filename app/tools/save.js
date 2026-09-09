/**
 * Saving the document: what it is called, and which of it to keep.
 *
 * The button in the title bar asks the same two questions in a dialog, which is
 * right for "save this, now". This is for the other way round — deciding what
 * the file is called and which pages go into it while still looking at them, and
 * seeing the answer sitting there rather than having to open a box to find out.
 */
import { h } from '../util/dom.js';
import { section, field, hint, primary, buttonRow, textInput, checkbox } from '../ui/controls.js';
import { buildPdf } from '../core/export.js';
import { saveFile } from '../core/download.js';
import { baseName, formatBytes } from '../util/format.js';
import { withExtension, pageScope } from './organize.js';
import { progressToast, toast } from '../ui/toast.js';

const save = {
  id: 'save',
  label: 'Save',
  group: 'Read',
  mode: 'any',
  icon: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8',
  blurb: 'Name the file and choose what goes into it.',
  panel(ctx) {
    const name = textInput({
      value: baseName(ctx.ws.name),
      placeholder: 'document',
      // Only the caption follows a rename — redrawing the document for it made
      // the pages flicker under every keystroke.
      oninput: (value) => ctx.app.renameDocument(value),
    });
    // The title bar and the merge panel edit the same name, so it is followed
    // back — unless the caret is in this box, which would fight the typing.
    const followName = () => {
      if (document.activeElement !== name) name.value = baseName(ctx.ws.name);
    };
    ctx.onClose(ctx.ws.on('name', followName));
    ctx.onClose(ctx.ws.on('pages', followName));

    const scope = pageScope(ctx, { label: 'Pages to save' });
    const withAnnots = checkbox({ label: 'Include text boxes, stamps and watermarks', checked: true });

    const run = async () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages to save', { tone: 'error' });

      const filename = `${name.value.trim() || 'document'}.pdf`;
      const progress = progressToast('Building PDF…');
      try {
        const bytes = await buildPdf(ctx.ws, pages, {
          ...ctx.app.exportOptions(),
          includeAnnots: withAnnots.checked,
          title: ctx.ws.name,
          onProgress: (fraction, message) => progress.update(fraction, message),
        });
        await saveFile(bytes, filename);
        const part = pages.length === ctx.ws.pageCount ? '' : `${pages.length} of ${ctx.ws.pageCount} pages `;
        progress.done(`Saved ${part}— ${formatBytes(bytes.length)}`);
      } catch (err) {
        console.error(err);
        progress.fail(`Saving failed: ${err.message}`);
      }
    };

    return h('div',
      section('File name', withExtension(field(null, name), name)),
      section('What to save', scope.el, withAnnots),
      section(null,
        buttonRow(primary('Save PDF', { onclick: run })),
        hint('Ctrl+S saves the whole document without coming here first.'),
      ),
    );
  },
};

export default [save];
