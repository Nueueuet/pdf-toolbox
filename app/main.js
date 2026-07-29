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
import { passwordPrompt } from './ui/modal.js';
import { toast, progressToast } from './ui/toast.js';
import { baseName, formatBytes } from './util/format.js';
import { PDFDocument } from '../vendor/pdf-lib.esm.js';

class App {
  constructor() {
    this.ws = new Workspace();
    this.activeToolId = null;
    this.currentPageId = null;
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
    });

    this.buildRail();
    this.wireChrome();
    this.wireDropTarget();
    this.wireKeys();

    this.ws.on('pages', () => this.onPagesChanged());
    this.ws.on('history', () => this.syncHistoryButtons());
    this.ws.on('selection', () => this.syncSelectionStatus());

    this.grid.setZoom(0.3);
    primeFontMetrics().catch((err) => console.error('font metrics failed', err));
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

      if (meta && event.key.toLowerCase() === 'z') {
        if (typing) return;
        event.preventDefault();
        event.shiftKey ? this.ws.redo() : this.ws.undo();
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
      if (event.key === 'Delete' && !typing && this.ws.selection.size) {
        event.preventDefault();
        this.removePages(this.ws.targetPages());
        return;
      }
      if (event.key === 'Escape' && !typing && this.mode === 'page') {
        this.showGrid();
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

  get mode() {
    const tool = TOOLS.find((t) => t.id === this.activeToolId);
    return tool?.mode === 'page' && this.currentPageId ? 'page' : 'grid';
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
    if (this.mode === 'page') this.editor.refresh();
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

    // The surface is switched before the panel is built so that a panel can read
    // the editor's state (selected annotation, crop rectangle) as it renders.
    if (tool.mode === 'page') {
      this.currentPageId = (page ?? this.currentPage())?.id ?? null;
      this.showEditor(tool.editorMode ?? 'select');
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
    this.el.grid.hidden = false;
    this.el.editor.hidden = true;
    this.el.wsbar.hidden = false;
    this.el.editorbar.hidden = true;
    this.grid.render();
  }

  showEditor(editorMode) {
    this.el.grid.hidden = true;
    this.el.editor.hidden = false;
    this.el.wsbar.hidden = true;
    this.el.editorbar.hidden = false;

    const page = this.currentPage();
    if (!page) return;
    this.editor.setMode(editorMode);
    this.editor.open(page);
    this.el.editorLabel.textContent = `Page ${this.ws.indexOf(page.id) + 1} of ${this.ws.pageCount}`;
  }

  /** Called when a page is opened from the grid. */
  openPage(page) {
    if (!page) return;
    const tool = TOOLS.find((t) => t.id === this.activeToolId);
    // An organise tool has no per-page controls, so opening a page from the grid
    // switches to Write rather than leaving a panel that cannot act on it.
    if (tool?.mode !== 'page') {
      this.selectTool('write', page);
      return;
    }
    this.currentPageId = page.id;
    this.showEditor(tool.editorMode ?? 'select');
  }

  stepPage(delta) {
    const index = this.ws.indexOf(this.currentPageId);
    const next = this.ws.pages[index + delta];
    if (next) this.openPage(next);
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
      default:
        console.warn('unknown grid command', name);
    }
  }

  removePages(pages) {
    if (pages.length === 0) return;
    if (pages.length >= this.ws.pageCount) {
      toast('At least one page has to stay', { tone: 'error' });
      return;
    }
    this.ws.commit(`Remove ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, () => {
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
    return { rasterDpi: 150, rasterMime: 'image/jpeg', jpegQuality: 0.82 };
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
