/**
 * Application shell: owns the workspace, decides whether the centre shows the
 * page grid or the single-page editor, and hands every tool the same context.
 */
import { $, h, clear } from './util/dom.js';
import { Workspace, normalizeQuarter } from './core/workspace.js';
import { PageGrid } from './ui/pagegrid.js';
import { PageEditor } from './ui/pageeditor.js';
import { TOOLS, GROUPS } from './tools/index.js';
import { buildPdf } from './core/export.js';
import { saveFile } from './core/download.js';
import { primeFontMetrics } from './core/fonts.js';
import { passwordPrompt, modal } from './ui/modal.js';
import { toast, progressToast } from './ui/toast.js';
import { baseName, formatBytes } from './util/format.js';
import { IN_EXTENSION } from './core/paths.js';
import { makeAnnot } from './core/annots.js';
import { PDFDocument } from '../vendor/pdf-lib.esm.js';

class App {
  constructor() {
    this.ws = new Workspace();
    this.activeToolId = null;
    this.currentPageId = null;
    this.surface = 'grid';
    this.panelCleanups = [];
    this.annotListeners = [];

    this.el = {
      landing: $('#landing'),
      surface: $('#surface'),
      grid: $('#pageGrid'),
      editor: $('#editor'),
      editorbar: $('#editorbar'),
      editorLabel: $('#editorLabel'),
      wsbar: $('#wsbar'),
      rail: $('#rail'),
      panel: $('#panel'),
      panelTitle: $('#panelTitle'),
      panelBlurb: $('#panelBlurb'),
      panelBody: $('#panelBody'),
      docBar: $('#docBar'),
      docTitle: $('#docTitle'),
      docMeta: $('#docMeta'),
      topActions: $('#topActions'),
      picker: $('#filePicker'),
      dropveil: $('#dropveil'),
      selectionStatus: $('#selectionStatus'),
      zoomValue: $('#zoomValue'),
      undo: $('#undoBtn'),
      redo: $('#redoBtn'),
    };

    this.grid = new PageGrid(this.el.grid, this.ws, {
      onOpenPage: (page) => this.openPage(page),
      onCommand: (name, payload) => this.handleGridCommand(name, payload),
    });
    this.editor = new PageEditor(this.el.editor, this.ws, {
      onChange: (opts) => this.onEditorChange(opts),
      onSelectAnnot: (annot) => {
        for (const listener of this.annotListeners) listener(annot);
      },
      onDeleteAnnot: (annot) => this.deleteAnnot(annot),
      onStepPage: (delta) => this.stepPage(delta),
      // One undo step per editing session, not one per keystroke.
      onCommitText: (annot, after) => {
        this.ws.commit('Edit text', () => {
          annot.text = after.text;
          annot.marks = after.marks;
        });
      },
    });

    this.buildRail();
    this.wireChrome();
    this.wireDropTarget();
    this.wireKeys();

    this.guardAgainstReload();
    this.ws.on('pages', () => this.onPagesChanged());
    // Recognition changes only the badges and the overlay, so it repaints the
    // grid without going through the full page-change path.
    this.ws.on('ocr', () => {
      // Recognised words join the page's selectable text, so both surfaces have
      // to rebuild — otherwise OCR finishes and the page still cannot be
      // selected from until something else happens to redraw it.
      if (this.mode === 'grid') this.grid.render();
      else this.editor.refresh();
    });
    this.ws.on('history', () => this.syncHistoryButtons());
    this.ws.on('selection', () => this.syncSelectionStatus());

    this.grid.setZoom(0.3);
    primeFontMetrics().catch((err) => console.error('font metrics failed', err));

    // Dev-server only. `scripts/screenshots.mjs` uses this to capture the real
    // UI with real documents in it, rather than shipping a mocked-up picture to
    // the store. Guarded so it can never run in the packaged extension, where
    // there are no sample files to load anyway.
    if (!IN_EXTENSION && location.search.includes('demo=')) {
      this.runDemo().catch((err) => console.error('demo setup failed', err));
    }
  }

  /** Loads sample documents and puts the app into a given state, for screenshots. */
  async runDemo() {
    const params = new URLSearchParams(location.search);

    /*
     * A headless `--screenshot` fires on the window load event, and load waits
     * for subresources. Adding an image the dev server answers slowly therefore
     * holds the shot back until the documents are actually on screen. Timer- and
     * virtual-clock-based waits do not work here: the capture fast-forwards
     * timers, and parsing PDFs is CPU work in a worker that it races straight
     * past, producing a screenshot of a half-loaded page.
     */
    const hold = new Image();
    hold.src = '/__wait?ms=9000';
    hold.style.display = 'none';
    document.head.appendChild(hold);

    const names = (params.get('files') ?? 'report.pdf,invoice.pdf,appendix.pdf').split(',');

    const files = [];
    for (const name of names) {
      const response = await fetch(`../test-files/${name.trim()}`);
      if (!response.ok) continue;
      files.push(new File([await response.blob()], name.trim(), { type: 'application/pdf' }));
    }
    if (files.length === 0) throw new Error('no sample files found — run "npm run test-files"');
    await this.importFiles(files);

    if (params.get('zoom')) this.setZoom(Number(params.get('zoom')));
    if (params.get('cuts')) this.ws.setCuts(params.get('cuts').split(',').map(Number));

    this.selectTool(params.get('demo') || 'merge');

    if (params.get('annot')) {
      const page = this.currentPage();
      page.annots.push(makeAnnot({
        text: 'Reviewed and approved\n14 March',
        x: 0.09, y: 0.1, w: 0.46, h: 0.13, size: 17,
        color: '#0a6fc2', bgColor: '#eaf4fd',
        border: { color: '#0d8bf2', width: 1 },
      }));
      await this.editor.refresh();
      this.editor.select(page.annots[page.annots.length - 1].id);
    }

    document.documentElement.dataset.demoReady = 'true';
  }

  // ------------------------------------------------------------------ chrome

  buildRail() {
    const rail = clear(this.el.rail);
    for (const group of GROUPS) {
      rail.appendChild(h('h3.rail__group', group));
      for (const tool of TOOLS.filter((t) => t.group === group)) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.7');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', tool.icon);
        svg.appendChild(path);

        rail.appendChild(h('button.rail__item', {
          type: 'button',
          dataset: { tool: tool.id },
          title: tool.blurb,
          onclick: () => this.selectTool(tool.id),
        }, svg, h('span', tool.label)));
      }
    }
  }

  wireChrome() {
    $('#pickBtn').addEventListener('click', () => this.pickFiles());
    $('#addFilesBtn').addEventListener('click', () => this.pickFiles());
    $('#exportBtn').addEventListener('click', () => this.exportCurrent());
    this.el.undo.addEventListener('click', () => this.ws.undo());
    this.el.redo.addEventListener('click', () => this.ws.redo());

    this.el.picker.addEventListener('change', async () => {
      const files = [...this.el.picker.files];
      this.el.picker.value = '';
      if (files.length) await this.importFiles(files);
    });

    $('#zoomIn').addEventListener('click', () => this.setZoom(this.grid.zoom + 0.08));
    $('#zoomOut').addEventListener('click', () => this.setZoom(this.grid.zoom - 0.08));
    $('#selectAllBtn').addEventListener('click', () => this.grid.selectAll());
    $('#clearSelBtn').addEventListener('click', () => this.grid.clearSelection());

    for (const btn of document.querySelectorAll('#viewToggle .segmented__btn')) {
      btn.addEventListener('click', () => {
        for (const other of document.querySelectorAll('#viewToggle .segmented__btn')) {
          other.classList.toggle('is-active', other === btn);
        }
        this.grid.setView(btn.dataset.view);
      });
    }

    $('#backToGrid').addEventListener('click', () => this.showGrid());
    $('#prevPage').addEventListener('click', () => this.stepPage(-1));
    $('#nextPage').addEventListener('click', () => this.stepPage(1));

    this.el.docTitle.addEventListener('change', () => {
      this.ws.name = this.el.docTitle.value.trim() || 'document';
    });
  }

  /**
   * The workspace lives entirely in memory — nothing is written to disk until
   * the user saves — so a reload or a closed tab throws the work away. Browsers
   * only allow a generic confirmation here; the wording is theirs, not ours.
   */
  guardAgainstReload() {
    window.addEventListener('beforeunload', (event) => {
      if (this.ws.pageCount === 0) return;
      event.preventDefault();
      // Older browsers need returnValue set; the string itself is ignored.
      event.returnValue = 'Your open document has not been saved.';
    });
  }

  wireDropTarget() {
    let depth = 0;
    const show = (on) => this.el.dropveil.classList.toggle('is-in', on);

    window.addEventListener('dragenter', (event) => {
      if (![...event.dataTransfer.types].includes('Files')) return;
      depth++;
      show(true);
    });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) show(false);
    });
    window.addEventListener('drop', async (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      depth = 0;
      show(false);
      await this.importFiles([...event.dataTransfer.files]);
    });
  }

  wireKeys() {
    window.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable;
      const meta = event.ctrlKey || event.metaKey;

      // While the caret is in a text box, undo belongs to the text: the browser
      // reverses the typing and our input handler picks the change up.
      if (meta && !typing && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        const redo = event.key.toLowerCase() === 'y' || event.shiftKey;
        redo ? this.ws.redo() : this.ws.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'a' && !typing) {
        event.preventDefault();
        this.grid.selectAll();
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.exportCurrent();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
        // In the page editor these keys remove the selected box — but only when
        // it was picked up by its edge. With the caret in the text they belong
        // to the text, and `typing` has already sent us home.
        const annot = this.mode === 'page' && !this.editor.isEditingText()
          ? this.editor.selectedAnnot()
          : null;
        if (annot) {
          event.preventDefault();
          this.deleteAnnot(annot);
          return;
        }
        if (event.key === 'Delete' && this.ws.selection.size) {
          event.preventDefault();
          this.removePages(this.ws.targetPages());
          return;
        }
      }
      if (event.key === 'Escape' && !typing && this.mode === 'page') {
        this.showGrid();
        return;
      }

      // Paging through a document with the arrow keys, as long as the caret is
      // not in a text box, where they belong to the text.
      if (this.mode === 'page' && !typing && !meta) {
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault();
          this.stepPage(-1);
        } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault();
          this.stepPage(1);
        }
      }
    });
  }

  // ----------------------------------------------------------------- import

  pickFiles() {
    this.el.picker.click();
  }

  async importFiles(files) {
    const progress = progressToast(`Reading ${files.length} ${files.length === 1 ? 'file' : 'files'}…`);
    try {
      const results = await this.ws.addFiles(files, async (file) => passwordPrompt({
        title: 'This file is protected',
        message: `“${file.name}” needs a password before it can be opened.`,
      }));

      const failed = results.filter((r) => !r.ok);
      const added = results.filter((r) => r.ok).reduce((sum, r) => sum + (r.pages ?? 0), 0);
      progress.done(added ? `Added ${added} ${added === 1 ? 'page' : 'pages'}` : null, 'success');
      for (const failure of failed) {
        toast(`${failure.file}: ${failure.error}`, { tone: 'error', timeout: 8000 });
      }
    } catch (err) {
      console.error(err);
      progress.fail(`Could not read the files: ${err.message}`);
    }
  }

  async addBlankPage() {
    // A blank page needs a real source, so make a one-page PDF on the fly.
    const doc = await PDFDocument.create();
    const reference = this.ws.pages[this.ws.pages.length - 1];
    doc.addPage(reference ? [reference.base.w, reference.base.h] : [595.28, 841.89]);
    const bytes = await doc.save();
    await this.ws.addBytes(bytes, 'blank page.pdf');
  }

  // ------------------------------------------------------------------ state

  /**
   * Which surface is actually on screen. Tracked rather than derived from the
   * active tool, because a tool declared `mode: 'any'` works on either and must
   * not change what is being shown.
   */
  get mode() {
    return this.surface === 'page' && this.currentPageId ? 'page' : 'grid';
  }

  currentPage() {
    return this.ws.pageById(this.currentPageId) ?? this.ws.pages[0] ?? null;
  }

  onPagesChanged() {
    const hasPages = this.ws.pageCount > 0;
    this.el.landing.hidden = hasPages;
    this.el.surface.hidden = !hasPages;
    this.el.rail.hidden = !hasPages;
    this.el.panel.hidden = !hasPages || !this.activeToolId;
    this.el.docBar.hidden = !hasPages;
    this.el.topActions.hidden = !hasPages;

    if (hasPages && !this.activeToolId) this.selectTool('merge');

    this.el.docTitle.value = this.ws.name;
    const sourceCount = new Set(this.ws.pages.map((p) => p.srcId)).size;
    this.el.docMeta.textContent = `${this.ws.pageCount} ${this.ws.pageCount === 1 ? 'page' : 'pages'} · ${sourceCount} ${sourceCount === 1 ? 'file' : 'files'}`;

    if (this.currentPageId && !this.ws.pageById(this.currentPageId)) {
      this.currentPageId = this.ws.pages[0]?.id ?? null;
    }

    this.grid.render();
    if (this.mode === 'page') this.editor.rebind(this.currentPage());
    this.syncSelectionStatus();
    this.syncHistoryButtons();
  }

  syncHistoryButtons() {
    this.el.undo.disabled = !this.ws.canUndo;
    this.el.redo.disabled = !this.ws.canRedo;
  }

  syncSelectionStatus() {
    const count = this.ws.selection.size;
    this.el.selectionStatus.textContent = count
      ? `${count} selected`
      : `${this.ws.pageCount} ${this.ws.pageCount === 1 ? 'page' : 'pages'}`;
  }

  setZoom(zoom) {
    this.grid.setZoom(zoom);
    this.el.zoomValue.textContent = `${Math.round(this.grid.zoom * 100)}%`;
  }

  // ------------------------------------------------------------------ tools

  /**
   * @param {string} id
   * @param {object} [page] page to open when the tool works on a single page
   */
  selectTool(id, page) {
    const tool = TOOLS.find((t) => t.id === id);
    if (!tool) return;

    for (const cleanup of this.panelCleanups) cleanup();
    this.panelCleanups = [];
    this.annotListeners = [];
    this.activeToolId = id;

    for (const item of this.el.rail.querySelectorAll('.rail__item')) {
      item.classList.toggle('is-active', item.dataset.tool === id);
    }

    this.el.panelTitle.textContent = tool.label;
    this.el.panelBlurb.textContent = tool.blurb;
    this.el.panel.hidden = this.ws.pageCount === 0;
    this.grid.setSplitHint(id === 'split');
    this.grid.setTextMode(id === 'copytext');
    this.grid.setOcrMode(id === 'ocr');

    // The surface is switched before the panel is built so that a panel can read
    // the editor's state (selected annotation, crop rectangle) as it renders.
    if (tool.mode === 'page') {
      this.currentPageId = (page ?? this.currentPage())?.id ?? null;
      this.showEditor(tool.editorMode ?? 'select');
    } else if (tool.mode === 'any' && this.mode === 'page') {
      // Works on either surface, so leave the one the user is looking at.
      this.editor.setMode('select');
    } else {
      this.showGrid();
    }

    clear(this.el.panelBody).appendChild(tool.panel(this.makeContext()));
  }

  makeContext() {
    return {
      ws: this.ws,
      app: this,
      editor: this.editor,
      grid: this.grid,
      currentPage: () => this.currentPage(),
      commit: (label, mutate) => this.ws.commit(label, mutate),
      touch: () => this.scheduleThumbRefresh(),
      onClose: (cleanup) => this.panelCleanups.push(cleanup),
      onSelectAnnot: (listener) => this.annotListeners.push(listener),
    };
  }

  /** Live edits repaint the editor immediately; the grid catches up when idle. */
  scheduleThumbRefresh() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      if (this.mode === 'grid') this.grid.render();
    }, 350);
  }

  /** Removes a text box or stamp from the page it sits on. */
  deleteAnnot(annot) {
    const page = this.currentPage();
    if (!page || !annot) return;
    this.ws.commit(annot.role === 'stamp' ? 'Delete stamp' : 'Delete text box', () => {
      page.annots = page.annots.filter((a) => a.id !== annot.id);
    });
    this.editor.drawOverlay();
    this.editor.select(null);
    toast('Deleted', {
      tone: 'info',
      action: { label: 'Undo', onClick: () => this.ws.undo() },
    });
  }

  onEditorChange(opts = {}) {
    if (opts.structural === false) return; // mid-drag, do not touch history
    this.scheduleThumbRefresh();
  }

  // ---------------------------------------------------------------- surfaces

  showGrid() {
    const tool = TOOLS.find((t) => t.id === this.activeToolId);
    // Leaving the editor means leaving the tool that needed it.
    if (tool?.mode === 'page') {
      this.selectTool('merge');
      return;
    }
    this.surface = 'grid';
    this.el.grid.hidden = false;
    this.el.editor.hidden = true;
    this.el.wsbar.hidden = false;
    this.el.editorbar.hidden = true;
    this.grid.render();
  }

  showEditor(editorMode) {
    this.surface = 'page';
    this.el.grid.hidden = true;
    this.el.editor.hidden = false;
    this.el.wsbar.hidden = true;
    this.el.editorbar.hidden = false;

    const page = this.currentPage();
    if (!page) return;
    this.editor.setMode(editorMode);
    this.editor.open(page);

    const index = this.ws.indexOf(page.id);
    this.el.editorLabel.textContent = `Page ${index + 1} of ${this.ws.pageCount}`;
    $('#prevPage').disabled = index <= 0;
    $('#nextPage').disabled = index >= this.ws.pageCount - 1;
  }

  /** Called when a page is opened from the grid, or stepped to with the arrows. */
  openPage(page) {
    if (!page) return;
    const tool = TOOLS.find((t) => t.id === this.activeToolId);

    /*
     * A tool that works on either surface stays put. Only a grid-only tool has
     * to hand over, because its panel cannot act on a single page — and it
     * hands over to Write. Getting this wrong meant paging through a document
     * with the arrows threw you out of OCR and into Write on the first press.
     */
    if (tool?.mode !== 'page' && tool?.mode !== 'any') {
      this.selectTool('write', page);
      return;
    }
    this.currentPageId = page.id;
    this.showEditor(tool.mode === 'page' ? (tool.editorMode ?? 'select') : 'select');
  }

  /** Moves to the next or previous page, staying in the current tool. */
  stepPage(delta) {
    const index = this.ws.indexOf(this.currentPageId);
    const next = this.ws.pages[index + delta];
    if (!next) return;
    this.openPage(next);
  }

  // --------------------------------------------------------------- commands

  handleGridCommand(name, payload) {
    switch (name) {
      case 'rotate':
        this.ws.commit('Rotate', () => {
          for (const page of payload.pages) page.rotate = normalizeQuarter(page.rotate + payload.delta);
        });
        break;
      case 'remove':
        this.removePages(payload.pages);
        break;
      case 'duplicate':
        this.ws.commit('Duplicate pages', () => {
          for (const page of payload.pages) {
            const index = this.ws.indexOf(page.id);
            const copy = { ...structuredClone({ ...page, id: undefined }), id: `pg_${Math.random().toString(36).slice(2, 10)}` };
            this.ws.pages.splice(index + 1, 0, copy);
          }
        });
        break;
      case 'move-to':
        this.ws.commit('Move pages', () => this.ws.moveTo(payload.ids, payload.target));
        break;
      case 'reorder': {
        const { ids, targetId, after } = payload;
        this.ws.commit('Reorder pages', () => {
          const rest = this.ws.pages.filter((p) => !ids.includes(p.id));
          const anchor = rest.findIndex((p) => p.id === targetId);
          const at = anchor < 0 ? rest.length : anchor + (after ? 1 : 0);
          const moving = this.ws.pages.filter((p) => ids.includes(p.id));
          this.ws.pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
        });
        break;
      }
      // Cuts are editing intent rather than document content, so they do not go
      // through commit — undoing a split is just clicking the mark again.
      case 'toggle-cut':
        this.ws.toggleCut(payload.afterPage);
        if (this.ws.cuts.size > 0 && this.activeToolId !== 'split') this.selectTool('split');
        break;
      case 'move-cut':
        this.ws.moveCut(payload.from, payload.to);
        break;
      case 'move-file':
        this.ws.commit('Reorder files', () => {
          this.ws.moveFile(payload.srcId, payload.targetSrcId, payload.after);
        });
        break;
      case 'add-files':
        this.pickFiles();
        break;
      case 'ocr-page':
        // The OCR tool owns the engine and the progress display, so the grid's
        // per-page button is routed back into it rather than duplicating both.
        if (this.runOcrForPage) this.runOcrForPage(payload.page);
        else this.selectTool('ocr');
        break;
      case 'remove-file': {
        const pages = this.ws.pages.filter((p) => p.srcId === payload.srcId);
        const name = this.ws.sources.get(payload.srcId)?.name ?? 'file';
        if (pages.length >= this.ws.pageCount) {
          toast('That is the only file left', { tone: 'error' });
          break;
        }
        this.removePages(pages, `Remove ${name}`);
        break;
      }
      default:
        console.warn('unknown grid command', name);
    }
  }

  removePages(pages, label) {
    if (pages.length === 0) return;
    if (pages.length >= this.ws.pageCount) {
      toast('At least one page has to stay', { tone: 'error' });
      return;
    }
    this.ws.commit(label ?? `Remove ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, () => {
      for (const page of pages) page.meta.removedFrom = this.ws.indexOf(page.id);
      const ids = new Set(pages.map((p) => p.id));
      this.ws.removed.push(...this.ws.pages.filter((p) => ids.has(p.id)));
      this.ws.pages = this.ws.pages.filter((p) => !ids.has(p.id));
      for (const id of ids) this.ws.selection.delete(id);
    });
    toast(`Removed ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, {
      tone: 'info',
      action: { label: 'Undo', onClick: () => this.ws.undo() },
    });
  }

  // ----------------------------------------------------------------- export

  exportOptions() {
    return {
      rasterDpi: 150,
      rasterMime: 'image/jpeg',
      jpegQuality: 0.82,
      // On by default: someone who ran OCR almost certainly wants the result in
      // the file they save.
      includeOcr: this.includeOcr !== false,
    };
  }

  /** The OCR inspection view, on whichever surface is showing. */
  setOcrInspect(on) {
    this.ocrInspect = Boolean(on);
    this.grid.setOcrInspect(this.ocrInspect);
    this.editor.setInspect(this.ocrInspect);
  }

  /**
   * Works out what each page needs, in the background, so the grid can show it
   * before anyone commits to a long recognition run.
   */
  async scanPagesForOcr() {
    if (this.ocrScanRunning) return;
    this.ocrScanRunning = true;
    try {
      const { scanPages } = await import('./tools/ocr.js');
      await scanPages(this.ws, [...this.ws.pages], () => this.ws.emit('ocr'));
    } catch (err) {
      console.error('ocr scan failed', err);
    } finally {
      this.ocrScanRunning = false;
    }
  }

  async exportCurrent() {
    if (this.ws.pageCount === 0) return;
    const progress = progressToast('Building PDF…');
    try {
      const bytes = await buildPdf(this.ws, this.ws.pages, {
        ...this.exportOptions(),
        title: this.ws.name,
        onProgress: (fraction, message) => progress.update(fraction, message),
      });
      await saveFile(bytes, `${baseName(this.ws.name)}.pdf`);
      progress.done(`Saved — ${formatBytes(bytes.length)}`);
    } catch (err) {
      console.error(err);
      progress.fail(`Export failed: ${err.message}`);
    }
  }
}

// Named `pdfToolbox`, not `app`: the shell element already has id="app", and
// that implicit global would shadow it depending on load order.
window.pdfToolbox = new App();
