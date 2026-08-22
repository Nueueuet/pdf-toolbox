/**
 * Application shell: owns the workspace, decides whether the centre shows the
 * page grid or the viewer, and hands every tool the same context.
 */
import { $, h, clear } from './util/dom.js';
import { Workspace, normalizeQuarter } from './core/workspace.js';
import { PageGrid } from './ui/pagegrid.js';
import { TOOLS, GROUPS, DEFAULT_TOOL } from './tools/index.js';
import { PageViewer } from './ui/pageviewer.js';
import { loadViewerSettings, saveViewerSettings, DEFAULT_LAYOUT } from './tools/viewer.js';
import { buildPdf } from './core/export.js';
import { saveFile } from './core/download.js';
import { primeFontMetrics } from './core/fonts.js';
import { passwordPrompt, modal, confirmDialog } from './ui/modal.js';
import { settingsDialog } from './ui/settings.js';
import { targetOf, nameFromUrl, turnOff } from './core/intercept.js';
import { toast, progressToast } from './ui/toast.js';
import { baseName, formatBytes } from './util/format.js';
import { parseRange, formatRange } from './util/ranges.js';
import { rangeField } from './ui/controls.js';
import * as storage from './core/storage.js';

/** Where the shell remembers how it was left. */
const SHELL_KEY = 'shell';
/** How wide the options panel was dragged to. */
const PANEL_KEY = 'panel-width';
import { IN_EXTENSION } from './core/paths.js';
import { makeAnnot } from './core/annots.js';
import { PDFDocument } from '../vendor/pdf-lib.esm.js';

class App {
  constructor() {
    this.ws = new Workspace();
    this.activeToolId = null;
    this.currentPageId = null;
    this.surface = 'grid';
    this.compact = false;
    this.panelCleanups = [];
    this.annotListeners = [];

    this.el = {
      landing: $('#landing'),
      surface: $('#surface'),
      grid: $('#pageGrid'),
      viewer: $('#viewer'),
      viewerbar: $('#viewerbar'),
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
    this.viewer = new PageViewer($('#viewer'), this.ws, {
      onPageChange: (page) => {
        this.currentPageId = page?.id ?? this.currentPageId;
        this.syncViewerLabel();
      },
      onZoomChange: (zoom, isFit) => {
        $('#viewerZoom').textContent = `${Math.round(zoom * 100)}%`;
        this.onViewerZoom?.(zoom, isFit);
      },
      // Editing happens on the pages the viewer shows, so these come here.
      onChange: (opts) => this.onEditorChange(opts),
      onSelectAnnot: (annot) => {
        for (const listener of this.annotListeners) listener(annot);
      },
      onDeleteAnnot: (annot) => this.deleteAnnot(annot),
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
      else this.viewer.rebind(this.currentPage());
    });
    this.ws.on('history', () => this.syncHistoryButtons());
    this.ws.on('selection', () => this.syncSelectionStatus());

    this.grid.setZoom(0.3);
    // Run once for the empty document, so the shell starts in the same state the
    // rest of the app maintains rather than in whatever the HTML happened to say.
    this.onPagesChanged();
    primeFontMetrics().catch((err) => console.error('font metrics failed', err));

    // Until the saved choice has been read, show the default rather than
    // whatever the viewer class happens to start in — otherwise the first render
    // is in an arrangement nobody asked for, and is thrown away a moment later.
    this.viewer.layout = DEFAULT_LAYOUT;

    storage.get(SHELL_KEY, {}).then((shell) => {
      if (shell?.compact) this.setCompact(true, { remember: false });
    });
    storage.get(PANEL_KEY, null).then((width) => {
      if (typeof width === 'number') this.setPanelWidth?.(width, { remember: false });
    });

    // A reading layout is a habit, not a per-document choice, so it is restored
    // before the first document is even open.
    loadViewerSettings().then((settings) => {
      this.viewer.layout = settings.layout;
      this.viewer.zoom = settings.zoom;
      if (this.mode === 'viewer') this.viewer.render();
      // The panel was built from the default while this was still being read, so
      // it would otherwise sit there showing an arrangement the viewer is not in.
      if (this.activeToolId === 'viewer') this.selectTool('viewer');
    });

    // Dev-server only. `scripts/screenshots.mjs` uses this to capture the real
    // UI with real documents in it, rather than shipping a mocked-up picture to
    // the store. Guarded so it can never run in the packaged extension, where
    // there are no sample files to load anyway.
    if (!IN_EXTENSION && location.search.includes('demo=')) {
      this.runDemo().catch((err) => console.error('demo setup failed', err));
    }

    // Arrived here because a PDF was handed over to us.
    const handed = targetOf();
    if (handed) this.openHandover(handed);
  }

  /**
   * Fetches a PDF the browser was about to open and puts it in the workspace.
   *
   * The address is left in the tab's own bar untouched — going back has to lead
   * to where the reader came from, not to an empty workspace.
   */
  async openHandover(url) {
    const name = nameFromUrl(url);
    this.showOpening(name);
    try {
      /*
       * The download was very likely started by handover.js before any of this
       * was even evaluated, in which case this picks up a request already well
       * on its way. Falling back to starting it here keeps the app working on
       * its own — the tests and the dev server both come in this way.
       *
       * Credentials are included either way, so a PDF behind a login arrives
       * rather than turning into a page of HTML saying "please sign in".
       */
      const early = window.__pdfToolboxHandover;
      const response = early?.url === url
        ? await early.response
        : await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);

      const blob = await response.blob();
      await this.importFiles([new File([blob], name, { type: 'application/pdf' })]);
    } catch (err) {
      console.error('could not open the handed-over document', err);
      toast(`Could not fetch that PDF: ${err.message}`, { tone: 'error', timeout: 8000 });
      // Better a viewer that works than one that insists.
      this.offerBrowserViewer(url);
    } finally {
      this.showOpening(null);
    }
  }

  /**
   * Dragging the edge of the options panel to widen it.
   *
   * There because a file name is only useful when all of it is on screen, and
   * the lists in there are full of them. Remembered with the rest of the shell:
   * how wide it should be is a property of the screen it is used on.
   */
  wirePanelResize() {
    const grip = $('#panelGrip');
    const MIN = 280;

    /*
     * Never more than a share of the window.
     *
     * A fixed ceiling is not enough on a small screen: dragged out to 700px
     * there, the bar above the document is left too narrow for the controls in
     * it, and the centred pair ends up under the ones beside it.
     */
    const maxWidth = () => Math.min(720, Math.round(window.innerWidth * 0.45));

    const setWidth = (px, { remember = true } = {}) => {
      const width = Math.round(Math.min(maxWidth(), Math.max(MIN, px)));
      document.documentElement.style.setProperty('--panel-w', `${width}px`);
      if (this.mode === 'viewer') this.viewer.relayout();
      if (remember) storage.set(PANEL_KEY, width);
      return width;
    };
    this.setPanelWidth = setWidth;

    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      $('#app').classList.add('is-resizing');
      const startX = event.clientX;
      const startWidth = this.el.panel.getBoundingClientRect().width;

      // Rightwards makes it narrower: the panel is on the right, so dragging its
      // edge that way takes room away from it.
      const onMove = (move) => setWidth(startWidth - (move.clientX - startX), { remember: false });
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        $('#app').classList.remove('is-resizing');
        setWidth(this.el.panel.getBoundingClientRect().width);
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });

    // Reachable without a pointer, for the same reason every other control is.
    grip.addEventListener('keydown', (event) => {
      const by = { ArrowLeft: 24, ArrowRight: -24 }[event.key];
      if (by === undefined) return;
      event.preventDefault();
      setWidth(this.el.panel.getBoundingClientRect().width + by);
    });
  }

  /**
   * Reading mode: the options panel away, the tool rail down to its symbols.
   *
   * A habit rather than a per-document choice, so it is remembered — like the
   * page layout, and for the same reason.
   */
  setCompact(on, { remember = true } = {}) {
    this.compact = Boolean(on);
    $('#app').classList.toggle('is-compact', this.compact);

    const button = $('#compactBtn');
    button.setAttribute('aria-pressed', String(this.compact));
    const label = this.compact ? 'Show the side panels' : 'Collapse the side panels';
    button.title = label;
    button.setAttribute('aria-label', label);

    // The workspace changed width, so anything sized against it has to be told.
    if (this.mode === 'viewer') this.viewer.relayout();
    if (remember) storage.set(SHELL_KEY, { compact: this.compact });
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      // Refused by the browser — nothing to recover from, but silence would
      // leave a button that visibly does nothing.
      toast(`Full screen was refused: ${err.message}`, { tone: 'error' });
    }
  }

  syncFullscreen() {
    const on = Boolean(document.fullscreenElement);
    const button = $('#fullscreenBtn');
    button.setAttribute('aria-pressed', String(on));
    const label = on ? 'Leave full screen' : 'Full screen';
    button.title = on ? `${label} (Escape)` : `${label} (F11)`;
    button.setAttribute('aria-label', label);
    /*
     * Set as attributes, not as the `hidden` property.
     *
     * These are SVG paths, and `hidden` is an HTMLElement property — assigning
     * it to an SVG element quietly creates an expando that reflects nowhere, so
     * the icon never changes. Only the attribute reaches the stylesheet.
     */
    for (const [path, show] of [['.js-enter', !on], ['.js-exit', on]]) {
      const el = button.querySelector(path);
      if (show) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    }
    if (this.mode === 'viewer') this.viewer.relayout();
  }

  /** The waiting room, so a hand-over is never a blank workspace. */
  showOpening(name) {
    $('#opening').hidden = !name;
    if (name) {
      $('#openingLabel').textContent = `Opening ${name}…`;
      // The empty-document screen would otherwise sit underneath, inviting a
      // file to be chosen while one is already on its way.
      this.el.landing.hidden = true;
      return;
    }
    // Back to whichever screen the workspace calls for — the document that
    // arrived, or, if it never did, the invitation to open one after all.
    this.onPagesChanged();
  }

  offerBrowserViewer(url) {
    modal({
      title: 'That PDF could not be fetched',
      width: 460,
      render: (close) => h('div',
        h('p.modal__text',
          'PDF Toolbox was given this document to open but could not download it. '
          + 'That usually means the site needs a sign-in the extension does not carry, '
          + 'or the file is a local one and file access is switched off.'),
        h('p.modal__text.modal__text--muted', url),
        h('div.modal__actions',
          h('button.btn', { type: 'button', onclick: () => close() }, 'Stay here'),
          h('button.btn.btn--primary', {
            type: 'button',
            // Reloading the address as it stands would only be redirected back
            // here, so the redirect has to go before the browser can have it.
            onclick: async () => {
              close();
              await turnOff();
              window.location.href = url;
            },
          }, 'Switch this off and open it'),
        ),
      ),
    });
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

    if (params.get('scan')) await this.demoScan(params.get('scan'));
    if (params.get('zoom')) this.setZoom(Number(params.get('zoom')));
    if (params.get('cuts')) this.ws.setCuts(params.get('cuts').split(',').map(Number));

    // Never inherit a remembered layout: a screenshot has to show the same thing
    // every time it is taken, not whatever was last used on this machine. Set
    // before the panel is built, so the panel agrees with the surface.
    if (params.get('layout')) this.viewer.setLayout(params.get('layout'));

    // Surface first, then the tool: a panel reads the surface it is built on, so
    // choosing the tool while the wrong one is showing bakes that into the shot.
    if (params.get('grid')) this.showGrid();
    this.selectTool(params.get('demo') || 'merge');
    if (params.get('nav')) document.body.classList.add('demo-nav');
    if (params.get('compact')) this.setCompact(true, { remember: false });
    if (params.get('page')) {
      const page = this.ws.pages[Number(params.get('page')) - 1];
      if (page) this.openPage(page);
    }

    if (params.get('annot')) {
      const page = this.currentPage();
      page.annots.push(makeAnnot({
        text: 'Reviewed and approved\n14 March',
        x: 0.09, y: 0.1, w: 0.46, h: 0.13, size: 17,
        color: '#0a6fc2', bgColor: '#eaf4fd',
        border: { color: '#0d8bf2', width: 1 },
      }));
      await this.viewer.rebind(page);
      this.viewer.select(page.annots[page.annots.length - 1].id);
    }

    document.documentElement.dataset.demoReady = 'true';
  }

  /**
   * Turns the named pages into scans — flattened to a bitmap, text and all — so
   * a screenshot of the OCR tool shows what it is actually for: a document that
   * is part real text and part picture of text.
   */
  async demoScan(range) {
    const targets = this.ws.pagesByNumbers(parseRange(range, this.ws.pageCount).pages);
    if (targets.length === 0) return;

    const before = this.ws.pageCount;
    await this.ws.addBytes(
      await buildPdf(this.ws, targets, { forceRaster: true, rasterDpi: 150 }),
      'scan.pdf',
    );
    const scans = this.ws.pages.slice(before);

    // Each scan takes the place of the page it was made from. They are all at
    // the end, so lifting one out never disturbs the positions still to come.
    targets.forEach((page, i) => {
      const at = this.ws.indexOf(page.id);
      this.ws.pages.splice(this.ws.indexOf(scans[i].id), 1);
      this.ws.pages.splice(at, 1, scans[i]);
    });
    this.ws.emit('pages');
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
          // Name first: collapsed to symbols, this tooltip is the only label.
          title: `${tool.label} — ${tool.blurb}`,
          onclick: () => this.selectTool(tool.id),
        }, svg, h('span', tool.label)));
      }
    }
  }

  wireChrome() {
    $('#pickBtn').addEventListener('click', () => this.pickFiles());
    $('#addFilesBtn').addEventListener('click', () => this.pickFiles());
    $('#clearAllBtn').addEventListener('click', () => this.startOver());
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

    $('#settingsBtn').addEventListener('click', () => settingsDialog());
    this.wirePanelResize();
    $('#compactBtn').addEventListener('click', () => this.setCompact(!this.compact));
    $('#fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
    // Leaving full screen by the Escape key or F11 has to move the button too.
    document.addEventListener('fullscreenchange', () => this.syncFullscreen());
    $('#viewerToGrid').addEventListener('click', () => this.showGrid());
    const pageInput = $('#viewerPageInput');
    pageInput.addEventListener('change', () => this.goToPage(pageInput.value));
    pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.goToPage(pageInput.value);
        pageInput.blur();
      } else if (event.key === 'Escape') {
        this.syncViewerLabel();
        pageInput.blur();
      }
    });
    $('#rotateLeft').addEventListener('click', () => this.turnCurrentPage(-90));
    $('#rotateRight').addEventListener('click', () => this.turnCurrentPage(90));
    $('#viewerZoomIn').addEventListener('click', () => this.viewer.zoomBy(1));
    $('#viewerZoomOut').addEventListener('click', () => this.viewer.zoomBy(-1));
    $('#viewerFit').addEventListener('click', () => {
      this.viewer.setZoom(null);
      this.persistViewerSettings();
    });

    this.el.docTitle.addEventListener('change', () => {
      this.ws.name = this.el.docTitle.value.trim() || 'document';
      this.onPagesChanged();
    });
  }

  /**
   * The workspace lives entirely in memory — nothing is written to disk until
   * the user saves — so a reload or a closed tab throws the work away. Browsers
   * only allow a generic confirmation here; the wording is theirs, not ours.
   */
  guardAgainstReload() {
    window.addEventListener('beforeunload', (event) => {
      if (this.ws.pageCount === 0 && this.ws.removed.length === 0) return;
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
        // On a page these keys remove the selected box — but only when it was
        // picked up by its edge. With the caret in the text they belong to the
        // text, and `typing` has already sent us home.
        const surface = this.surfaceEditor;
        const annot = this.onSinglePage && !surface.isEditingText()
          ? surface.selectedAnnot()
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
      if (event.key === 'Escape' && !typing && this.onSinglePage) {
        this.showGrid();
        return;
      }

      // The viewer has its own idea of what the keys mean, since most of them
      // are about moving around a page rather than between pages.
      if (this.mode === 'viewer' && !typing && !meta) {
        if (this.viewer.handleKey(event)) {
          event.preventDefault();
          this.syncViewerLabel();
          return;
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

  /**
   * Empties the workspace, as if the tab had just been opened.
   *
   * Unlike removing pages, this is not undoable — it clears the history along
   * with everything else — so it asks first. The wording mirrors the warning on
   * closing the tab, because it is the same loss.
   */
  async startOver() {
    if (this.ws.pageCount === 0 && this.ws.removed.length === 0) return;

    const ok = await confirmDialog({
      title: 'Start over?',
      message: 'Every page, every edit and the whole undo history will be discarded, '
        + 'and the workspace will be empty. Files you have already saved are not affected. '
        + 'This cannot be undone.',
      confirmLabel: 'Discard everything',
      tone: 'danger',
    });
    if (!ok) return;

    this.ws.reset();
    this.currentPageId = null;
    this.activeToolId = null;
    this.surface = 'grid';
    for (const cleanup of this.panelCleanups) cleanup();
    this.panelCleanups = [];
    this.annotListeners = [];
    clear(this.el.panelBody);
    for (const item of this.el.rail.querySelectorAll('.rail__item')) item.classList.remove('is-active');
    toast('Workspace cleared', { tone: 'info' });
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
    if (!this.currentPageId) return 'grid';
    if (this.surface === 'viewer') return 'viewer';
    return 'grid';
  }

  /** True while one page fills the workspace, whether for reading or editing. */
  get onSinglePage() {
    return this.mode === 'viewer';
  }

  /**
   * The surface a tool should be editing on: the one in front of the reader.
   *
   * There is only one now; the getter stays because every tool goes through it,
   * and a single name is easier to follow than the same check in ten places.
   */
  get surfaceEditor() {
    return this.viewer;
  }

  currentPage() {
    return this.ws.pageById(this.currentPageId) ?? this.ws.pages[0] ?? null;
  }

  onPagesChanged() {
    const hasPages = this.ws.pageCount > 0;
    /*
     * An empty document with something in the recoverable list is not really
     * empty: the panel has to stay reachable, or removing the last page would
     * put its only way back out of reach.
     */
    const hasWork = hasPages || this.ws.removed.length > 0;

    this.el.landing.hidden = hasPages;
    this.el.surface.hidden = !hasPages;
    this.el.docBar.hidden = !hasPages;
    this.el.topActions.hidden = !hasWork;

    /*
     * The empty state sits inside the app rather than replacing it. The rail
     * stays where it is, greyed out — it shows what the app is for, and keeps
     * the layout from jumping the moment a file arrives.
     */
    this.el.rail.hidden = false;
    this.el.rail.classList.toggle('is-idle', !hasWork);
    for (const item of this.el.rail.querySelectorAll('.rail__item')) {
      // With pages gone but a full recoverable list, Remove is the one tool
      // that still has something to do.
      item.disabled = hasPages ? false : !(hasWork && item.dataset.tool === 'remove');
    }
    this.el.panel.hidden = !hasWork || !this.activeToolId;

    if (hasPages && !this.activeToolId) this.selectTool(DEFAULT_TOOL);

    this.syncDocName();
    const sourceCount = new Set(this.ws.pages.map((p) => p.srcId)).size;
    this.el.docMeta.textContent = `${this.ws.pageCount} ${this.ws.pageCount === 1 ? 'page' : 'pages'} · ${sourceCount} ${sourceCount === 1 ? 'file' : 'files'}`;

    if (this.currentPageId && !this.ws.pageById(this.currentPageId)) {
      this.currentPageId = this.ws.pages[0]?.id ?? null;
    }

    this.grid.render();
    if (this.mode === 'viewer') {
      this.viewer.rebind(this.currentPage());
      this.syncViewerLabel();
    }
    this.syncSelectionStatus();
    this.syncHistoryButtons();
  }

  /**
   * The document's name wherever it is shown.
   *
   * Its own method because renaming is not an edit: a panel that changes the
   * name should not have to redraw every page and thumbnail to have the title
   * bar and the tab follow along.
   */
  syncDocName() {
    if (document.activeElement !== this.el.docTitle) this.el.docTitle.value = this.ws.name;
    // The tab is how you find this window again among twenty others, so it says
    // which document is in it rather than repeating the name of the app.
    document.title = this.ws.pageCount ? `${this.ws.name} — PDF Toolbox` : 'PDF Toolbox';
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
    this.viewer.setSplitHint(id === 'split');
    this.grid.setTextMode(id === 'copytext');
    this.grid.setOcrMode(id === 'ocr');

    /*
     * The surface is settled before the panel is built, so a panel can read the
     * state it is about to show — the selected box, the crop rectangle.
     *
     * A tool that works on a page does not send you anywhere any more: it uses
     * the page you are already looking at. Only a tool that genuinely needs the
     * whole document in front of it asks for the grid, and only when you are not
     * already on a page.
     */
    if (tool.mode === 'viewer') {
      const wanted = (page ?? this.currentPage())?.id ?? null;
      /*
       * Only actually go there if we are not there already.
       *
       * showViewer re-opens the document from scratch, which throws away the
       * scroll position and repaints every page. Doing that on every tool change
       * meant stepping from Write to Stamps jumped back to the top of the page
       * and flashed the whole thing white — for a change of panel, on a page
       * that was already in front of you.
       */
      const staying = this.mode === 'viewer' && (page == null || wanted === this.currentPageId);
      this.currentPageId = wanted;
      if (!staying) this.showViewer();
      this.viewer.setEditMode(tool.editorMode ?? 'select');
    } else if (tool.mode === 'any') {
      if (this.mode === 'viewer') this.viewer.setEditMode('select');
      else if (!this.onSinglePage) this.showGrid();
    } else {
      this.showGrid();
    }

    clear(this.el.panelBody).appendChild(tool.panel(this.makeContext()));
  }

  makeContext() {
    return {
      ws: this.ws,
      app: this,
      // Whichever surface is showing the page. Both answer the same calls, so a
      // tool panel edits where the reader is rather than sending them somewhere.
      editor: this.surfaceEditor,
      grid: this.grid,
      currentPage: () => this.currentPage(),
      commit: (label, mutate) => this.ws.commit(label, mutate),
      touch: () => this.scheduleThumbRefresh(),
      onClose: (cleanup) => this.panelCleanups.push(cleanup),
      onSelectAnnot: (listener) => this.annotListeners.push(listener),
    };
  }

  /** Live edits repaint the page immediately; the grid catches up when idle. */
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
    this.surfaceEditor.drawOverlay();
    this.surfaceEditor.select(null);
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
    // Leaving a single-page surface means leaving the tool that needed it.
    if (tool?.mode === 'viewer') {
      this.selectTool('merge');
      return;
    }
    this.surface = 'grid';
    this.el.grid.hidden = false;
    this.el.viewer.hidden = true;
    this.el.wsbar.hidden = false;
    this.el.viewerbar.hidden = true;
    this.grid.render();
  }

  showViewer() {
    this.surface = 'viewer';
    this.el.grid.hidden = true;
    this.el.viewer.hidden = false;
    this.el.wsbar.hidden = true;
    this.el.viewerbar.hidden = false;

    const page = this.currentPage();
    if (!page) return;
    this.viewer.open(page);
    this.syncViewerLabel();
  }

  syncViewerLabel() {
    const index = this.ws.indexOf(this.currentPageId);
    const input = $('#viewerPageInput');
    input.max = String(Math.max(1, this.ws.pageCount));
    // Left alone while it is being typed into, or the caret jumps mid-entry.
    if (document.activeElement !== input) input.value = index >= 0 ? String(index + 1) : '';
    $('#viewerPageTotal').textContent = `of ${this.ws.pageCount}`;
  }

  /**
   * Turns the page being read, from the bar above it.
   *
   * Only this page: the tool is where you go to turn a range of them, and a
   * button sitting beside the page number can only sensibly mean that page.
   */
  turnCurrentPage(delta) {
    const page = this.currentPage();
    if (!page) return;
    this.ws.commit(`Rotate ${delta > 0 ? 'right' : 'left'}`, () => {
      page.rotate = normalizeQuarter(page.rotate + delta);
    });
  }

  /** Jumps to a page number typed into the viewer's page field. */
  goToPage(raw) {
    const number = Number(raw);
    if (!Number.isFinite(number)) return this.syncViewerLabel();
    const page = this.ws.pages[Math.min(this.ws.pageCount, Math.max(1, Math.round(number))) - 1];
    if (!page) return this.syncViewerLabel();
    this.currentPageId = page.id;
    this.viewer.goTo(page.id);
    this.syncViewerLabel();
  }

  persistViewerSettings() {
    saveViewerSettings({ layout: this.viewer.layout, zoom: this.viewer.zoom });
  }

  /**
   * Called when a page is opened from the grid, or stepped to with the arrows.
   *
   * There is only one place a page can be opened now, so this no longer has to
   * work out which surface a tool wants. A grid-only tool still hands over,
   * because its panel has nothing to say about a single page.
   */
  openPage(page) {
    if (!page) return;
    const tool = TOOLS.find((t) => t.id === this.activeToolId);
    const staysOnThePage = tool?.mode === 'viewer' || tool?.mode === 'any';

    if (!staysOnThePage) {
      this.selectTool(DEFAULT_TOOL, page);
      return;
    }

    this.currentPageId = page.id;
    this.showViewer();
    this.viewer.open(page);
    this.syncViewerLabel();
  }

  /** Moves to the next or previous page, staying in the current tool. */
  stepPage(delta) {
    if (this.mode === 'viewer') {
      this.viewer.step(delta);
      return;
    }
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
    // Removing the last page is allowed: it goes to the recoverable list like
    // any other, and undo brings it straight back. Refusing was protecting
    // nothing.
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
    this.viewer.setInspect(this.ocrInspect);
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

  /**
   * Asks which pages to save, then saves them.
   *
   * The same choice a print dialog offers, except that what comes out is the
   * document itself rather than a picture of it: the pages keep their text,
   * their links and their vector art, exactly as saving everything does.
   */
  async exportCurrent() {
    if (this.ws.pageCount === 0) return;

    const choice = await this.askWhichPages();
    if (!choice) return;

    const progress = progressToast('Building PDF…');
    try {
      const bytes = await buildPdf(this.ws, choice.pages, {
        ...this.exportOptions(),
        title: this.ws.name,
        onProgress: (fraction, message) => progress.update(fraction, message),
      });
      await saveFile(bytes, choice.filename);
      progress.done(`Saved ${choice.pages.length === this.ws.pageCount
        ? ''
        : `${choice.pages.length} of ${this.ws.pageCount} pages `}— ${formatBytes(bytes.length)}`);
    } catch (err) {
      console.error(err);
      progress.fail(`Export failed: ${err.message}`);
    }
  }

  /** @returns {Promise<{pages: object[], filename: string}|null>} null if cancelled. */
  askWhichPages() {
    const total = this.ws.pageCount;
    // What is selected in the grid is almost always what someone means by "these
    // pages", so the field opens on it rather than making them type it again.
    const selected = [...this.ws.selection];
    const start = selected.length > 0 && selected.length < total
      ? formatRange(selected.map((id) => this.ws.indexOf(id) + 1))
      : 'all';

    return modal({
      title: 'Save PDF',
      width: 440,
      render: (close) => {
        const summary = h('p.modal__text.modal__text--muted');
        const control = rangeField({ value: start });

        const resolve = () => {
          const { pages, error } = parseRange(control.value, total);
          control.setError(error);
          if (error) {
            summary.textContent = '';
            return null;
          }
          summary.textContent = pages.length === total
            ? `The whole document — ${total} ${total === 1 ? 'page' : 'pages'}.`
            : `${pages.length} of ${total} pages: ${formatRange(pages)}.`;
          return this.ws.pagesByNumbers(pages);
        };

        const submit = () => {
          const pages = resolve();
          if (!pages || pages.length === 0) return;
          const name = baseName(this.ws.name);
          close({
            pages,
            filename: pages.length === total
              ? `${name}.pdf`
              : `${name} pages ${formatRange(pages.map((p) => this.ws.indexOf(p.id) + 1))}.pdf`,
          });
        };

        control.addEventListener('input', resolve);
        control.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') submit();
        });
        resolve();

        return h('div',
          h('label.field',
            h('span.field__label', 'Pages'),
            control,
            h('span.field__help', 'Type “all” for the whole document, or a range: 1-10 · 1,4,10 · odd · last'),
          ),
          summary,
          h('p.modal__text', 'Saved pages keep their text, so it can still be selected and searched — '
            + 'this is not a picture of the page.'),
          h('div.modal__actions',
            h('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
            h('button.btn.btn--primary', { type: 'button', onclick: submit }, 'Save'),
          ),
        );
      },
    });
  }
}

// Named `pdfToolbox`, not `app`: the shell element already has id="app", and
// that implicit global would shadow it depending on load order.
window.pdfToolbox = new App();
