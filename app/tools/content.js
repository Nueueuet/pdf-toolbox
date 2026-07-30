/** Write, Stamps, Watermark and Background — everything that puts marks on a page. */
import { h, clear } from '../util/dom.js';
import {
  section, field, hint, button, primary, buttonRow, select, numberInput,
  colorInput, optionalColor, checkbox, textArea, textInput, slider, radioCards,
} from '../ui/controls.js';
import { FONT_FAMILIES } from '../core/fonts.js';
import { makeAnnot, applyMark } from '../core/annots.js';
import { parseRange } from '../util/ranges.js';
import { pageScope } from './organize.js';
import { toast } from '../ui/toast.js';
import { confirmDialog, modal } from '../ui/modal.js';
import * as storage from '../core/storage.js';

const ALIGNMENTS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

/**
 * The property sheet shared by Write and Stamps. Edits the annotation in place
 * and reports back so the editor overlay and the thumbnail can follow along.
 */
function textProperties(ctx, { onEdit }) {
  const host = h('div.props');
  let current = null;

  const update = (patch) => {
    if (!current) return;
    Object.assign(current, patch);
    onEdit(current);
  };

  const family = select({ options: FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label })), onchange: (v) => update({ family: v }) });
  const size = numberInput({ value: 14, min: 4, max: 300, step: 1, oninput: (v) => update({ size: Math.max(4, v) }) });
  const color = colorInput({ value: '#111827', onchange: (v) => update({ color: v }) });
  const bold = checkbox({ label: 'Bold', onchange: (v) => update({ bold: v }) });
  const italic = checkbox({ label: 'Italic', onchange: (v) => update({ italic: v }) });
  const align = select({ options: ALIGNMENTS, onchange: (v) => update({ align: v }) });
  const valign = select({
    options: [{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }],
    onchange: (v) => update({ valign: v }),
  });
  /**
   * Highlighting works on the selected characters, like a word processor —
   * not on the whole box. With nothing selected there is nothing to mark, so
   * the buttons say so rather than silently colouring everything.
   */
  const highlightColor = colorInput({ value: '#fde047' });
  const highlightNote = h('span.field__help');

  const applyHighlight = (color) => {
    if (!current) return;
    const range = ctx.editor.selectionRange();
    if (!range || range.end <= range.start) {
      highlightNote.textContent = 'Select some text in the box first.';
      return;
    }
    highlightNote.textContent = '';
    current.marks = applyMark(current.marks, range.start, range.end, color, current.text);
    ctx.editor.refreshText(current);
    onEdit(current);
  };

  const highlight = h('div.inline',
    highlightColor,
    button('Highlight', { onclick: () => applyHighlight(highlightColor.value) }),
    button('Clear', { onclick: () => applyHighlight(null) }),
  );
  const bgColor = optionalColor({ value: null, fallback: '#ffffff', onchange: (v) => update({ bgColor: v }) });
  const borderColor = optionalColor({ value: null, fallback: '#111827', onchange: (v) => update({ border: v ? { color: v, width: borderWidth.valueAsNumber || 1 } : null }) });
  const borderWidth = numberInput({ value: 1, min: 0.25, max: 12, step: 0.25, oninput: (v) => { if (current?.border) update({ border: { ...current.border, width: v } }); } });
  const opacity = slider({ value: 100, min: 10, max: 100, step: 1, format: (v) => `${v}%`, oninput: (v) => update({ opacity: v / 100 }) });
  const rotation = numberInput({ value: 0, min: -180, max: 180, step: 1, oninput: (v) => update({ rotate: v }) });
  const text = textArea({ rows: 3, placeholder: 'Type here…', oninput: (v) => update({ text: v }) });

  const body = h('div',
    field('Text', text),
    h('div.grid2', field('Font', family), field('Size', size)),
    h('div.grid2', field('Colour', color), field('Opacity', opacity)),
    h('div.inline', bold, italic),
    h('div.grid2', field('Align', align), field('Vertical', valign)),
    field('Highlight', highlight, 'Select text in the box, then apply'),
    highlightNote,
    field('Box fill', bgColor, 'Colour behind the whole box'),
    h('div.grid2', field('Border', borderColor), field('Border width', borderWidth)),
    field('Rotation', rotation, 'Degrees'),
  );
  const empty = hint('Select a text box on the page, or add one.');
  host.append(empty, body);
  body.style.display = 'none';

  return {
    el: host,
    /** @param {object|null} annot */
    bind(annot) {
      current = annot;
      body.style.display = annot ? '' : 'none';
      empty.style.display = annot ? 'none' : '';
      if (!annot) return;
      text.value = annot.text;
      family.value = annot.family;
      size.value = String(annot.size);
      color.value = annot.color;
      bold.checked = annot.bold;
      italic.checked = annot.italic;
      align.value = annot.align;
      valign.value = annot.valign;
      highlightNote.textContent = '';
      bgColor.value = annot.bgColor;
      borderColor.value = annot.border?.color ?? null;
      borderWidth.value = String(annot.border?.width ?? 1);
      rotation.value = String(annot.rotate ?? 0);
    },
    get current() {
      return current;
    },
  };
}

// ------------------------------------------------------------------- write

const write = {
  id: 'write',
  label: 'Write',
  group: 'Content',
  mode: 'page',
  editorMode: 'select',
  icon: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  blurb: 'Add text boxes. Drag to move, pull the handles to resize, double-click to type.',
  panel(ctx) {
    const props = textProperties(ctx, {
      onEdit: (annot) => {
        ctx.editor.syncAnnot(annot);
        ctx.touch();
      },
    });

    ctx.onSelectAnnot((annot) => props.bind(annot));
    props.bind(ctx.editor.selectedAnnot());

    const add = () => {
      const page = ctx.currentPage();
      if (!page) return toast('Open a page first', { tone: 'error' });
      const annot = makeAnnot({ text: 'New text', x: 0.12, y: 0.12, w: 0.45, h: 0.1 });
      ctx.commit('Add text', () => page.annots.push(annot));
      ctx.editor.drawOverlay();
      ctx.editor.select(annot.id);
    };

    const duplicateToPages = async () => {
      const annot = props.current;
      const page = ctx.currentPage();
      if (!annot || !page) return toast('Select a text box first', { tone: 'error' });

      const value = await modal({
        title: 'Copy text box to pages',
        width: 400,
        render: (close) => {
          const input = textInput({ value: 'all', placeholder: 'all, or 1-10, or 1,4,10' });
          return h('form', {
            onsubmit: (event) => {
              event.preventDefault();
              close(input.value);
            },
          },
            field('Pages', input, 'The box is copied — later edits stay independent.'),
            h('div.modal__actions',
              h('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
              h('button.btn.btn--primary', { type: 'submit' }, 'Copy'),
            ),
          );
        },
      });
      if (value == null) return;

      const { pages, error } = parseRange(value, ctx.ws.pageCount);
      if (error) return toast(error, { tone: 'error' });
      const targets = ctx.ws.pagesByNumbers(pages).filter((p) => p.id !== page.id);
      if (targets.length === 0) return toast('No other pages matched', { tone: 'error' });

      ctx.commit('Copy text box', () => {
        for (const target of targets) target.annots.push(makeAnnot({ ...annot }));
      });
      toast(`Copied to ${targets.length} pages`, { tone: 'success' });
    };

    const remove = () => {
      const annot = props.current;
      if (!annot) return toast('Select a text box first', { tone: 'error' });
      ctx.app.deleteAnnot(annot);
    };

    const saveAsStamp = async () => {
      const annot = props.current;
      if (!annot) return toast('Select a text box first', { tone: 'error' });
      await saveStamp(annot);
      toast('Saved as a stamp', { tone: 'success' });
    };

    return h('div',
      section(null, buttonRow(primary('Add text box', { onclick: add }))),
      section('Properties', props.el),
      section(null, buttonRow(
        button('Copy to pages…', { onclick: duplicateToPages }),
        button('Save as stamp', { onclick: saveAsStamp }),
        button('Delete', { tone: 'danger', onclick: remove }),
      )),
    );
  },
};

// ------------------------------------------------------------------ stamps

async function loadStamps() {
  return storage.get('stamps', []);
}

async function saveStamp(annot, name) {
  const stamps = await loadStamps();
  const label = name ?? (annot.text.split('\n')[0].slice(0, 40) || 'Stamp');
  // The stamp keeps the styling and the *current* text. Editing an inserted
  // stamp on a page never writes back here — that only happens on an explicit
  // re-save, which is what the spec asked for.
  const { id, ...style } = annot;
  stamps.push({ id: `st_${Date.now().toString(36)}`, name: label, annot: style });
  await storage.set('stamps', stamps);
  return stamps;
}

const stamps = {
  id: 'stamps',
  label: 'Stamps',
  group: 'Content',
  mode: 'page',
  editorMode: 'select',
  icon: 'M5 21h14 M7 18v-3a3 3 0 0 1 1.6-2.7L10 11.6V8a2 2 0 1 1 4 0v3.6l1.4.7A3 3 0 0 1 17 15v3Z',
  blurb: 'Reusable text blocks. Insert one and it behaves like any other text box — edits stay on the page unless you save it again.',
  panel(ctx) {
    const list = h('div.stamplist');
    const props = textProperties(ctx, {
      onEdit: (annot) => {
        ctx.editor.syncAnnot(annot);
        ctx.touch();
      },
    });
    ctx.onSelectAnnot((annot) => props.bind(annot));
    props.bind(ctx.editor.selectedAnnot());

    const render = async () => {
      const saved = await loadStamps();
      clear(list);
      if (saved.length === 0) {
        list.appendChild(hint('No stamps yet. Style a text box in Write, then “Save as stamp”.'));
        return;
      }
      for (const stamp of saved) {
        list.appendChild(h('div.stamprow',
          h('button.stamprow__insert', { type: 'button', onclick: () => insert(stamp) },
            h('span.stamprow__name', stamp.name),
            h('span.stamprow__preview', {
              style: {
                fontFamily: stamp.annot.family,
                color: stamp.annot.color,
                background: stamp.annot.bgColor ?? 'transparent',
                border: stamp.annot.border ? `1px solid ${stamp.annot.border.color}` : '',
              },
            }, stamp.annot.text.split('\n')[0].slice(0, 28)),
          ),
          h('button.linkbtn', { type: 'button', onclick: () => rename(stamp) }, 'Rename'),
          h('button.linkbtn.is-danger', { type: 'button', onclick: () => drop(stamp) }, 'Delete'),
        ));
      }
    };

    const insert = (stamp) => {
      const page = ctx.currentPage();
      if (!page) return toast('Open a page first', { tone: 'error' });
      const annot = makeAnnot({ ...stamp.annot, role: 'stamp', stampId: stamp.id });
      ctx.commit(`Insert ${stamp.name}`, () => page.annots.push(annot));
      ctx.editor.drawOverlay();
      ctx.editor.select(annot.id);
    };

    const rename = async (stamp) => {
      const name = await modal({
        title: 'Rename stamp',
        width: 360,
        render: (close) => {
          const input = textInput({ value: stamp.name });
          return h('form', {
            onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); },
          }, field('Name', input), h('div.modal__actions',
            h('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
            h('button.btn.btn--primary', { type: 'submit' }, 'Save'),
          ));
        },
      });
      if (!name) return;
      const saved = await loadStamps();
      const match = saved.find((s) => s.id === stamp.id);
      if (match) match.name = name;
      await storage.set('stamps', saved);
      render();
    };

    const drop = async (stamp) => {
      const ok = await confirmDialog({
        title: 'Delete stamp',
        message: `Remove “${stamp.name}” from your saved stamps? Copies already placed on pages stay where they are.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return;
      await storage.set('stamps', (await loadStamps()).filter((s) => s.id !== stamp.id));
      render();
    };

    /** Takes the placed copy off the page; the saved stamp itself is untouched. */
    const removeFromPage = () => {
      const annot = props.current;
      if (!annot) return toast('Select a stamp on the page first', { tone: 'error' });
      ctx.app.deleteAnnot(annot);
    };

    const saveCurrent = async () => {
      const annot = props.current;
      if (!annot) return toast('Select a text box on the page first', { tone: 'error' });
      await saveStamp(annot);
      render();
      toast('Stamp saved', { tone: 'success' });
    };

    const updateStamp = async () => {
      const annot = props.current;
      if (!annot?.stampId) return toast('Select a text box that came from a stamp', { tone: 'error' });
      const saved = await loadStamps();
      const match = saved.find((s) => s.id === annot.stampId);
      if (!match) return toast('That stamp no longer exists', { tone: 'error' });
      const { id, stampId, ...style } = annot;
      match.annot = style;
      await storage.set('stamps', saved);
      render();
      toast(`Updated “${match.name}”`, { tone: 'success' });
    };

    render();

    return h('div',
      section('Your stamps', list),
      section('Selected box', props.el),
      section(null, buttonRow(
        primary('Save selection as new stamp', { onclick: saveCurrent }),
        button('Update its stamp', { onclick: updateStamp, title: 'Write the current styling back to the stamp it came from' }),
        button('Delete from page', { tone: 'danger', onclick: removeFromPage }),
      )),
    );
  },
};

// --------------------------------------------------------------- watermark

const watermark = {
  id: 'watermark',
  label: 'Watermark',
  group: 'Content',
  mode: 'grid',
  icon: 'M12 3s6 6 6 10a6 6 0 0 1-12 0c0-4 6-10 6-10Z',
  blurb: 'Stamp text across pages, or strip watermarks that are already there.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const text = textInput({ value: 'CONFIDENTIAL' });
    const family = select({ options: FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label })) });
    const size = numberInput({ value: 60, min: 8, max: 400 });
    const color = colorInput({ value: '#9ca3af' });
    const opacity = slider({ value: 30, min: 5, max: 100, format: (v) => `${v}%` });
    const angle = slider({ value: -45, min: -90, max: 90, format: (v) => `${v}°` });
    const layout = select({
      value: 'center',
      options: [
        { value: 'center', label: 'Once, across the middle' },
        { value: 'tile', label: 'Tiled over the whole page' },
        { value: 'footer', label: 'Along the bottom' },
      ],
    });

    const add = () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (!text.value.trim()) return toast('Enter some watermark text', { tone: 'error' });

      const style = {
        role: 'watermark',
        text: text.value,
        family: family.value,
        size: size.valueAsNumber || 60,
        color: color.value,
        opacity: opacity.value / 100,
        rotate: angle.value,
        align: 'center',
        valign: 'middle',
        padding: 0,
      };

      ctx.commit(`Watermark ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, () => {
        for (const page of pages) {
          for (const spot of placements(layout.value)) {
            page.annots.push(makeAnnot({ ...style, ...spot }));
          }
        }
      });
      toast('Watermark added', { tone: 'success' });
    };

    const removeOurs = () => {
      const pages = scope.resolve();
      if (!pages) return;
      let count = 0;
      ctx.commit('Remove watermarks', () => {
        for (const page of pages) {
          const before = page.annots.length;
          page.annots = page.annots.filter((a) => a.role !== 'watermark');
          count += before - page.annots.length;
        }
      });
      toast(count ? `Removed ${count} watermarks` : 'No watermarks added by this app on those pages', { tone: count ? 'success' : 'info' });
    };

    const stripSource = async () => {
      const pages = scope.resolve();
      if (!pages) return;
      const ok = await confirmDialog({
        title: 'Strip embedded annotations',
        message: 'Many tools add their watermark as a PDF annotation. This removes every annotation on the selected pages — including links, comments and form fields. Watermarks painted directly into the page content cannot be removed this way; use Background or Compress to redraw those pages instead.',
        confirmLabel: 'Strip annotations',
        tone: 'danger',
      });
      if (!ok) return;
      ctx.commit('Strip annotations', () => {
        for (const page of pages) page.meta.stripAnnots = true;
      });
      toast(`Annotations will be dropped from ${pages.length} pages on export`, { tone: 'success' });
    };

    return h('div',
      section('Pages', scope.el),
      section('Watermark',
        field('Text', text),
        h('div.grid2', field('Font', family), field('Size', size)),
        h('div.grid2', field('Colour', color), field('Opacity', opacity)),
        h('div.grid2', field('Angle', angle), field('Layout', layout)),
        buttonRow(primary('Add watermark', { onclick: add })),
      ),
      section('Remove',
        buttonRow(
          button('Remove mine', { onclick: removeOurs, title: 'Removes watermarks added in this workspace' }),
          button('Strip embedded…', { onclick: stripSource }),
        ),
        hint('Watermarks baked into the page graphics cannot be lifted out cleanly — nothing can do that reliably.'),
      ),
    );
  },
};

/** Box positions for the three watermark layouts, in page fractions. */
function placements(layout) {
  if (layout === 'footer') return [{ x: 0.1, y: 0.88, w: 0.8, h: 0.08, rotate: 0 }];
  if (layout === 'tile') {
    const spots = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        spots.push({ x: 0.03 + col * 0.5, y: 0.05 + row * 0.32, w: 0.44, h: 0.24 });
      }
    }
    return spots;
  }
  return [{ x: 0.05, y: 0.35, w: 0.9, h: 0.3 }];
}

// -------------------------------------------------------------- background

const background = {
  id: 'background',
  label: 'Background',
  group: 'Content',
  mode: 'grid',
  icon: 'M3 3h18v18H3z M3 15l5-5 4 4 3-3 6 6',
  blurb: 'Replace or clear the page background — useful for greying scans and dark-mode exports.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const modes = radioCards({
      value: 'color',
      options: [
        { value: 'color', label: 'Replace with a colour', description: 'Everything the app reads as background becomes this colour.' },
        { value: 'transparent', label: 'Remove it', description: 'Background becomes transparent. Great for PNG export; in a PDF it shows whatever is behind.' },
        { value: 'none', label: 'Leave it alone', description: 'Undoes a background change.' },
      ],
    });
    const color = colorInput({ value: '#ffffff' });
    const threshold = slider({
      value: 85, min: 40, max: 100, step: 1,
      format: (v) => (v >= 100 ? 'only pure white' : `${v}% brightness`),
    });

    const apply = () => {
      const pages = scope.resolve();
      if (!pages) return;
      const mode = modes.value;
      ctx.commit('Change background', () => {
        for (const page of pages) {
          page.bg = mode === 'none' ? null : { mode, color: color.value, threshold: threshold.value / 100 };
        }
      });
    };

    return h('div',
      section('Pages', scope.el),
      section('Background', modes, field('Colour', color),
        field('What counts as background', threshold, 'Lower this for scans whose “white” is really grey.')),
      section(null,
        buttonRow(primary('Apply', { onclick: apply })),
        hint('Changing the background redraws those pages as images, so their text stops being selectable.'),
      ),
    );
  },
};

export default [write, stamps, watermark, background];
