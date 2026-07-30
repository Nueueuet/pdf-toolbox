/** Merge, Split, Remove, Rotate and Crop — everything that rearranges pages. */
import { h, clear } from '../util/dom.js';
import {
  section, field, hint, button, primary, buttonRow, rangeField, numberInput,
  slider, checkbox, select,
} from '../ui/controls.js';
import { parseRange, formatRange } from '../util/ranges.js';
import { buildPdf } from '../core/export.js';
import { saveMany } from '../core/download.js';
import { renderPageCanvas } from '../core/render.js';
import { normalizeQuarter } from '../core/workspace.js';
import { normalizeCrop } from '../core/geometry.js';
import { baseName } from '../util/format.js';
import { progressToast, toast } from '../ui/toast.js';

/**
 * Shared "which pages?" control. Defaults to the current selection so the
 * grid and the panel never disagree about what is about to be edited.
 */
function pageScope(ctx, { label = 'Pages' } = {}) {
  /*
   * Looking at a single page makes that page the obvious default — but only the
   * default. The field still takes `all` or any range, so a tool opened from the
   * single-page view can still act on the whole document.
   */
  const current = ctx.app.mode === 'page' ? ctx.currentPage() : null;
  const initial = ctx.ws.selection.size
    ? formatRange([...ctx.ws.selection].map((id) => ctx.ws.indexOf(id) + 1))
    : current
      ? String(ctx.ws.indexOf(current.id) + 1)
      : 'all';
  const control = rangeField({ value: initial });

  const resolve = () => {
    const { pages, error } = parseRange(control.value, ctx.ws.pageCount);
    control.setError(error);
    return error ? null : ctx.ws.pagesByNumbers(pages);
  };
  control.addEventListener('input', resolve);

  // Keep in step when the user changes the selection in the grid.
  const off = ctx.ws.on('selection', () => {
    if (ctx.ws.selection.size === 0) return;
    control.value = formatRange([...ctx.ws.selection].map((id) => ctx.ws.indexOf(id) + 1));
    control.setError(null);
  });
  ctx.onClose(off);

  return {
    el: field(label, control, 'Type “all” for the whole document, or a range: 1-10 · 1,4,10 · odd · last'),
    resolve,
  };
}

// ------------------------------------------------------------------- merge

const merge = {
  id: 'merge',
  label: 'Merge',
  group: 'Organise',
  mode: 'grid',
  icon: 'M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M3 16v3a2 2 0 0 0 2 2h3 M21 16v3a2 2 0 0 1-2 2h-3 M12 8v8 M8 12h8',
  blurb: 'Combine files into one PDF. Drag pages to reorder, or right-click a page to type an exact position.',
  panel(ctx) {
    const list = h('div.filelist');

    const renderList = () => {
      clear(list);
      const counts = new Map();
      for (const page of ctx.ws.pages) counts.set(page.srcId, (counts.get(page.srcId) ?? 0) + 1);

      if (counts.size === 0) {
        list.appendChild(hint('No files yet.'));
        return;
      }
      for (const [srcId, count] of counts) {
        const source = ctx.ws.sources.get(srcId);
        list.appendChild(h('div.filerow',
          h('span.filerow__name', { title: source?.name }, source?.name ?? 'Unknown'),
          h('span.filerow__meta', `${count} ${count === 1 ? 'page' : 'pages'}`),
          h('button.linkbtn', {
            type: 'button',
            onclick: () => ctx.commit(`Remove ${source?.name ?? 'file'}`, () => {
              const removed = ctx.ws.pages.filter((p) => p.srcId === srcId);
              ctx.ws.removed.push(...removed);
              ctx.ws.pages = ctx.ws.pages.filter((p) => p.srcId !== srcId);
            }),
          }, 'Remove'),
        ));
      }
    };
    renderList();
    ctx.onClose(ctx.ws.on('pages', renderList));

    return h('div',
      section('Files', list,
        buttonRow(
          primary('Add files', { onclick: () => ctx.app.pickFiles() }),
          button('Add blank page', { onclick: () => ctx.app.addBlankPage() }),
        ),
      ),
      section('Order',
        hint('Drag any page in the grid to move it. Right-click → “Move to position…” to type a page number instead. Select several pages first to move them as a block.'),
      ),
      section('Output',
        buttonRow(primary('Merge & save', { onclick: () => ctx.app.exportCurrent() })),
      ),
    );
  },
};

// ------------------------------------------------------------------- split

const split = {
  id: 'split',
  label: 'Split',
  group: 'Organise',
  mode: 'grid',
  icon: 'M8 3v6a2 2 0 0 1-2 2H3 M16 3v6a2 2 0 0 0 2 2h3 M8 21v-6a2 2 0 0 0-2-2H3 M16 21v-6a2 2 0 0 1 2-2h3 M12 2v20',
  blurb: 'Cut the document into several files. Add as many cut points as you like — they are all applied at once.',
  panel(ctx) {
    const cutsInput = rangeField({ value: '' });
    const cutsField = field('Cut after page', cutsInput, 'One or more page numbers. “3, 7” makes three files.');
    const preview = h('div.partlist');
    const everyN = numberInput({ value: 1, min: 1, max: 999 });
    const zipToggle = checkbox({ label: 'Bundle the parts into a .zip', checked: true });

    // The cuts live on the workspace so the grid can draw them and the user can
    // drag them there. This field is a second view onto the same state, so it
    // has to push changes out and pull them back in.
    let syncing = false;

    const pushToWorkspace = () => {
      const { pages, error } = cutsInput.value.trim()
        ? parseRange(cutsInput.value, Math.max(1, ctx.ws.pageCount - 1))
        : { pages: [], error: null };
      cutsInput.setError(error);
      if (error) return;
      syncing = true;
      ctx.ws.setCuts(pages);
      syncing = false;
      renderPreview();
    };

    const pullFromWorkspace = () => {
      if (syncing) return;
      cutsInput.value = formatRange(ctx.ws.cutList());
      cutsInput.setError(null);
      renderPreview();
    };

    const renderPreview = () => {
      clear(preview);
      const ranges = ctx.ws.splitRanges();
      if (ranges.length < 2) {
        preview.appendChild(hint('Add at least one cut point to split the document.'));
        return;
      }
      const base = baseName(ctx.ws.name);
      ranges.forEach(([from, to], index) => {
        preview.appendChild(h('div.partrow',
          h('span.partrow__name', `${base} cut ${index + 1}.pdf`),
          h('span.partrow__meta', from === to ? `page ${from}` : `pages ${from}–${to}`),
        ));
      });
    };

    cutsInput.addEventListener('input', pushToWorkspace);
    ctx.onClose(ctx.ws.on('cuts', pullFromWorkspace));
    ctx.onClose(ctx.ws.on('pages', pullFromWorkspace));
    pullFromWorkspace();

    const applyEveryN = () => {
      const n = Math.max(1, everyN.valueAsNumber || 1);
      const cuts = [];
      for (let i = n; i < ctx.ws.pageCount; i += n) cuts.push(i);
      ctx.ws.setCuts(cuts);
    };

    const run = async () => {
      const ranges = ctx.ws.splitRanges();
      if (ranges.length < 2) {
        return toast('Add at least one cut point first', { tone: 'error' });
      }
      const result = { ranges };

      const base = baseName(ctx.ws.name);
      const progress = progressToast('Splitting…');
      try {
        const entries = [];
        for (const [index, [from, to]] of result.ranges.entries()) {
          progress.update(index / result.ranges.length, `Part ${index + 1} of ${result.ranges.length}`);
          const pages = ctx.ws.pages.slice(from - 1, to);
          const bytes = await buildPdf(ctx.ws, pages, ctx.app.exportOptions());
          entries.push({ name: `${base} cut ${index + 1}.pdf`, data: bytes });
        }
        const outcome = await saveMany(entries, {
          zipName: `${base} split.zip`,
          zipThreshold: zipToggle.checked ? 2 : Infinity,
        });
        progress.done(`Saved ${outcome.count} files${outcome.zipped ? ' as a zip' : ''}`);
      } catch (err) {
        console.error(err);
        progress.fail(`Split failed: ${err.message}`);
      }
    };

    return h('div',
      section('Cut points',
        cutsField,
        h('div.inline',
          hint('Or cut every'), everyN, hint('pages'),
          button('Apply', { onclick: applyEveryN }),
        ),
        buttonRow(button('Clear all cuts', { onclick: () => ctx.ws.setCuts([]) })),
        hint('Click between two pages to cut there. Click the scissors again to remove that cut, or drag them to another gap to move it. While this tool is open, every possible cut position is marked.'),
      ),
      section('Result', preview, zipToggle),
      section(null, buttonRow(primary('Split & save', { onclick: run }))),
    );
  },
};

// ------------------------------------------------------------------ remove

const remove = {
  id: 'remove',
  label: 'Remove',
  group: 'Organise',
  mode: 'grid',
  icon: 'M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6',
  blurb: 'Take pages out of the document. Removed pages are kept here so you can put them back.',
  panel(ctx) {
    const scope = pageScope(ctx, { label: 'Pages to remove' });
    const bin = h('div.bin');

    /**
     * Mirrors whichever view the workspace is showing: removing a file in the
     * Files view should give back a file, not a heap of loose pages.
     */
    const renderBin = () => {
      clear(bin);
      if (ctx.ws.removed.length === 0) {
        bin.appendChild(hint('Nothing removed yet.'));
        return;
      }

      const byFile = ctx.grid.view === 'files';
      const groups = byFile ? groupRemovedByFile(ctx.ws) : ctx.ws.removed.map((page) => ({
        key: page.id,
        pages: [page],
        title: ctx.ws.source(page)?.name ?? 'page',
        subtitle: `was page ${(page.meta.removedFrom ?? 0) + 1}`,
      }));

      const noun = byFile
        ? `${groups.length} ${groups.length === 1 ? 'file' : 'files'}`
        : `${ctx.ws.removed.length} ${ctx.ws.removed.length === 1 ? 'page' : 'pages'}`;

      bin.appendChild(h('div.bin__head',
        h('span', `${noun} removed`),
        h('button.linkbtn', { type: 'button', onclick: restoreAll }, 'Restore all'),
        h('button.linkbtn.is-danger', {
          type: 'button',
          onclick: () => ctx.commit('Empty removed pages', () => { ctx.ws.removed = []; }),
        }, 'Discard'),
      ));

      for (const group of groups) {
        const thumb = h('div.bin__thumb');
        bin.appendChild(h('div.bin__row', thumb,
          h('div.bin__meta',
            h('span.bin__name', group.title),
            h('span.bin__sub', group.subtitle),
          ),
          h('button.linkbtn', { type: 'button', onclick: () => restoreMany(group.pages) }, 'Put back'),
        ));

        renderPageCanvas(ctx.ws, group.pages[0], { scale: 0.16 })
          .then(({ canvas }) => { if (thumb.isConnected) thumb.replaceChildren(canvas); })
          .catch(() => {});
      }
    };

    const restoreMany = (pages) => ctx.commit(
      pages.length === 1 ? 'Restore page' : `Restore ${pages.length} pages`,
      () => {
        const ids = new Set(pages.map((p) => p.id));
        ctx.ws.removed = ctx.ws.removed.filter((p) => !ids.has(p.id));
        // Reinstated in their original order, so each index still means
        // something by the time the next page is put back.
        const ordered = [...pages].sort((a, b) => (a.meta.removedFrom ?? 0) - (b.meta.removedFrom ?? 0));
        for (const page of ordered) {
          const at = Math.min(page.meta.removedFrom ?? ctx.ws.pages.length, ctx.ws.pages.length);
          ctx.ws.pages.splice(at, 0, page);
        }
      },
    );

    const restoreAll = () => ctx.commit('Restore all pages', () => {
      // Reinstate in original order so indices stay meaningful as we go.
      const back = [...ctx.ws.removed].sort((a, b) => (a.meta.removedFrom ?? 0) - (b.meta.removedFrom ?? 0));
      ctx.ws.removed = [];
      for (const page of back) {
        const at = Math.min(page.meta.removedFrom ?? ctx.ws.pages.length, ctx.ws.pages.length);
        ctx.ws.pages.splice(at, 0, page);
      }
    });

    renderBin();
    ctx.onClose(ctx.ws.on('pages', renderBin));
    ctx.onClose(ctx.ws.on('view', renderBin));

    const run = () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages matched', { tone: 'error' });
      if (pages.length === ctx.ws.pageCount) return toast('That would remove every page', { tone: 'error' });
      ctx.app.removePages(pages);
    };

    return h('div',
      section('Remove', scope.el, buttonRow(primary('Remove pages', { onclick: run }))),
      section('Removed pages', bin),
    );
  },
};

// ------------------------------------------------------------------ rotate

const rotate = {
  id: 'rotate',
  label: 'Rotate',
  group: 'Organise',
  mode: 'grid',
  icon: 'M21 12a9 9 0 1 1-3-6.7 M21 3v6h-6',
  blurb: 'Turn pages a quarter at a time, or to any angle.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const angle = slider({ value: 0, min: -180, max: 180, step: 1, format: (v) => `${v}°` });
    const angleNote = hint('Free angles are rendered as an image, so text on those pages stops being selectable. Quarter turns keep it intact.');

    const quarter = (delta) => {
      const pages = scope.resolve();
      if (!pages) return;
      ctx.commit(`Rotate ${delta > 0 ? 'right' : 'left'}`, () => {
        for (const page of pages) page.rotate = normalizeQuarter(page.rotate + delta);
      });
    };

    const applyFree = () => {
      const pages = scope.resolve();
      if (!pages) return;
      const value = angle.value;
      ctx.commit('Set angle', () => {
        for (const page of pages) page.angle = value;
      });
    };

    return h('div',
      section('Pages', scope.el),
      section('Quarter turns',
        buttonRow(
          button('↺ 90° left', { onclick: () => quarter(-90) }),
          button('↻ 90° right', { onclick: () => quarter(90) }),
          button('180°', { onclick: () => quarter(180) }),
        ),
      ),
      section('Any angle',
        field('Angle', angle),
        buttonRow(
          primary('Apply angle', { onclick: applyFree }),
          button('Reset to 0°', {
            onclick: () => {
              const pages = scope.resolve();
              if (pages) ctx.commit('Reset angle', () => { for (const p of pages) p.angle = 0; });
            },
          }),
        ),
        angleNote,
      ),
    );
  },
};

// -------------------------------------------------------------------- crop

const crop = {
  id: 'crop',
  label: 'Crop',
  group: 'Organise',
  mode: 'page',
  editorMode: 'crop',
  icon: 'M6 2v14a2 2 0 0 0 2 2h14 M2 6h14a2 2 0 0 1 2 2v14',
  blurb: 'Drag the frame to choose the visible area, then apply it to this page or to a range.',
  panel(ctx) {
    const scopeSelect = select({
      value: 'this',
      options: [
        { value: 'this', label: 'Only this page' },
        { value: 'all', label: 'Every page' },
        { value: 'range', label: 'Specific pages…' },
      ],
    });
    const range = rangeField({ value: '1-1' });
    const rangeField_ = field('Pages', range, 'Examples: 1-10 · 1,4,10');
    rangeField_.style.display = 'none';
    scopeSelect.addEventListener('change', () => {
      rangeField_.style.display = scopeSelect.value === 'range' ? '' : 'none';
    });

    const targets = () => {
      const current = ctx.currentPage();
      if (scopeSelect.value === 'this') return current ? [current] : [];
      if (scopeSelect.value === 'all') return [...ctx.ws.pages];
      const { pages, error } = parseRange(range.value, ctx.ws.pageCount);
      range.setError(error);
      return error ? null : ctx.ws.pagesByNumbers(pages);
    };

    const apply = () => {
      const box = normalizeCrop(ctx.editor.currentCrop());
      const pages = targets();
      if (!pages) return;
      if (!box) return toast('The frame covers the whole page — nothing to crop', { tone: 'error' });
      ctx.commit('Crop', () => {
        for (const page of pages) page.crop = { ...box };
      });
      toast(`Cropped ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, { tone: 'success' });
    };

    const reset = () => {
      const pages = targets();
      if (!pages) return;
      ctx.commit('Reset crop', () => {
        for (const page of pages) page.crop = null;
      });
      ctx.editor.setCrop(null);
    };

    return h('div',
      section('Apply to', field(null, scopeSelect), rangeField_),
      section(null,
        buttonRow(primary('Apply crop', { onclick: apply }), button('Reset', { onclick: reset })),
        hint('Cropping keeps the text selectable — it changes the visible box rather than redrawing the page.'),
      ),
    );
  },
};

/** Removed pages bundled back into the files they came from. */
function groupRemovedByFile(ws) {
  const groups = new Map();
  for (const page of ws.removed) {
    if (!groups.has(page.srcId)) groups.set(page.srcId, []);
    groups.get(page.srcId).push(page);
  }
  return [...groups.entries()].map(([srcId, pages]) => {
    const source = ws.sources.get(srcId);
    const whole = source && pages.length === source.pageCount;
    return {
      key: srcId,
      pages,
      title: source?.name ?? 'file',
      subtitle: whole
        ? `whole file · ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`
        : `${pages.length} of ${source?.pageCount ?? '?'} pages`,
    };
  });
}

export default [merge, split, remove, rotate, crop];
export { pageScope };
