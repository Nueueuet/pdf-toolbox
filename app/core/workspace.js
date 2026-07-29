/**
 * The single document model every tool reads and writes.
 *
 * Design notes
 * ------------
 * - A *source* is an imported file (PDF or image). Sources are immutable and
 *   append-only, which is what lets undo be cheap: history snapshots only the
 *   page list, never the file bytes.
 * - A *page* is a lightweight reference into a source plus the edits stacked on
 *   top of it (rotation, crop, annotations, an optional raster override). Merge,
 *   split, remove and reorder are all just operations on this array — which is
 *   why they compose instead of each needing their own pipeline.
 * - Rasters (from compress/upscale/background) live in a side store keyed by id
 *   so that history snapshots stay small.
 */
import { openDocument, isPasswordError } from './pdfjs.js';
import { uid, baseName } from '../util/format.js';

export class Workspace extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, Source>} */
    this.sources = new Map();
    /** @type {Page[]} */
    this.pages = [];
    /** @type {Page[]} pages removed by the Remove tool, recoverable */
    this.removed = [];
    /** @type {Set<string>} ids of selected pages */
    this.selection = new Set();
    /** @type {Map<string, RasterEntry>} */
    this.rasters = new Map();
    this.name = 'document';

    this.history = [];
    this.future = [];
    this.busy = null;
  }

  // ---------------------------------------------------------------- importing

  /**
   * Imports PDFs and images. Returns per-file results so the caller can report
   * partial failures (a locked or corrupt file must not abort the whole batch).
   *
   * @param {File[]|FileList} files
   * @param {(file: File) => Promise<string|null>} askPassword
   */
  async addFiles(files, askPassword = async () => null) {
    const results = [];
    const before = this.pages.length;

    for (const file of [...files]) {
      try {
        if (/^image\//.test(file.type)) {
          results.push(await this.#addImage(file));
        } else {
          results.push(await this.#addPdf(file, askPassword));
        }
      } catch (err) {
        results.push({ file: file.name, ok: false, error: String(err?.message ?? err) });
      }
    }

    if (this.pages.length !== before) {
      if (this.pages.length && (this.name === 'document' || !this.name)) {
        const first = this.sources.get(this.pages[0].srcId);
        this.name = baseName(first?.name);
      }
      this.#snapshotBaseline();
      this.emit('pages');
    }
    return results;
  }

  async #addPdf(file, askPassword) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    let doc;
    let password;
    try {
      // pdf.js detaches the buffer it receives, so it always gets a copy.
      doc = await openDocument(bytes.slice(), {});
    } catch (err) {
      if (!isPasswordError(err)) throw err;
      password = await askPassword(file);
      if (password == null) return { file: file.name, ok: false, error: 'Skipped — needs a password' };
      doc = await openDocument(bytes.slice(), { password });
    }

    const source = {
      id: uid('src'),
      kind: 'pdf',
      name: file.name,
      size: file.size,
      bytes,
      password: password ?? null,
      doc,
      pageCount: doc.numPages,
    };
    this.sources.set(source.id, source);

    for (let i = 0; i < doc.numPages; i++) {
      const pdfPage = await doc.getPage(i + 1);
      const [x0, y0, x1, y1] = pdfPage.view;
      this.pages.push(makePage(source.id, i, {
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
        rotate: normalizeQuarter(pdfPage.rotate),
      }));
    }

    return { file: file.name, ok: true, pages: doc.numPages, encrypted: Boolean(password) };
  }

  async #addImage(file) {
    const bitmap = await createImageBitmap(file);
    const source = {
      id: uid('src'),
      kind: 'image',
      name: file.name,
      size: file.size,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      bitmap,
      pageCount: 1,
    };
    this.sources.set(source.id, source);
    // Images become a page at their natural pixel size mapped 1px -> 1pt.
    this.pages.push(makePage(source.id, 0, { w: bitmap.width, h: bitmap.height, rotate: 0 }));
    return { file: file.name, ok: true, pages: 1 };
  }

  /** Imports raw PDF bytes we produced ourselves (URL -> PDF, unlock, ...). */
  async addBytes(bytes, name) {
    const file = new File([bytes], name, { type: 'application/pdf' });
    return this.addFiles([file]);
  }

  // ------------------------------------------------------------------ history

  #cloneState() {
    return {
      pages: this.pages.map(clonePage),
      removed: this.removed.map(clonePage),
      name: this.name,
    };
  }

  #applyState(state) {
    this.pages = state.pages.map(clonePage);
    this.removed = state.removed.map(clonePage);
    this.name = state.name;
    // Selection may reference pages that no longer exist.
    const live = new Set(this.pages.map((p) => p.id));
    for (const id of [...this.selection]) if (!live.has(id)) this.selection.delete(id);
  }

  /** Records the current state so it is reachable by undo, without an entry of its own. */
  #snapshotBaseline() {
    if (this.history.length === 0) this.history.push({ label: 'Import', state: this.#cloneState() });
  }

  /**
   * Runs a mutation as one undoable step.
   * @param {string} label shown in the undo tooltip
   * @param {() => void|Promise<void>} mutate
   */
  async commit(label, mutate) {
    const before = this.#cloneState();
    await mutate();
    this.history.push({ label, state: before });
    if (this.history.length > 60) this.history.shift();
    this.future.length = 0;
    this.emit('pages');
    this.emit('history');
  }

  get canUndo() {
    return this.history.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return;
    this.future.push({ label: entry.label, state: this.#cloneState() });
    this.#applyState(entry.state);
    this.emit('pages');
    this.emit('history');
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return;
    this.history.push({ label: entry.label, state: this.#cloneState() });
    this.#applyState(entry.state);
    this.emit('pages');
    this.emit('history');
  }

  // -------------------------------------------------------------- page access

  get pageCount() {
    return this.pages.length;
  }

  pageById(id) {
    return this.pages.find((p) => p.id === id) ?? null;
  }

  indexOf(id) {
    return this.pages.findIndex((p) => p.id === id);
  }

  source(page) {
    return this.sources.get(page.srcId) ?? null;
  }

  /** Pages the tools should act on: the selection if there is one, else everything. */
  targetPages() {
    if (this.selection.size === 0) return [...this.pages];
    return this.pages.filter((p) => this.selection.has(p.id));
  }

  /** Resolves 1-based page numbers to page objects, skipping out-of-range values. */
  pagesByNumbers(numbers) {
    return numbers.map((n) => this.pages[n - 1]).filter(Boolean);
  }

  // ----------------------------------------------------------------- ordering

  /** Moves `ids` so the first of them lands at 1-based position `target`. */
  moveTo(ids, target) {
    const set = new Set(ids);
    const moving = this.pages.filter((p) => set.has(p.id));
    if (moving.length === 0) return;
    const rest = this.pages.filter((p) => !set.has(p.id));
    const index = Math.max(0, Math.min(rest.length, target - 1));
    this.pages = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  }

  /** Drag-and-drop reorder: drop `ids` before the page currently at `beforeId`. */
  moveBefore(ids, beforeId) {
    const set = new Set(ids);
    const moving = this.pages.filter((p) => set.has(p.id));
    if (moving.length === 0) return;
    const rest = this.pages.filter((p) => !set.has(p.id));
    const index = beforeId == null ? rest.length : Math.max(0, rest.findIndex((p) => p.id === beforeId));
    const at = beforeId == null || index < 0 ? rest.length : index;
    this.pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  }

  // ------------------------------------------------------------------ rasters

  putRaster(entry) {
    const id = uid('ras');
    this.rasters.set(id, entry);
    return id;
  }

  raster(id) {
    return id ? this.rasters.get(id) ?? null : null;
  }

  releaseRaster(id) {
    const entry = this.rasters.get(id);
    if (entry?.url) URL.revokeObjectURL(entry.url);
    this.rasters.delete(id);
  }

  // ------------------------------------------------------------------- events

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  reset() {
    for (const id of [...this.rasters.keys()]) this.releaseRaster(id);
    for (const source of this.sources.values()) source.doc?.destroy?.();
    this.sources.clear();
    this.pages = [];
    this.removed = [];
    this.selection.clear();
    this.history = [];
    this.future = [];
    this.name = 'document';
    this.emit('pages');
    this.emit('history');
  }
}

// ---------------------------------------------------------------------- pages

export function makePage(srcId, srcIndex, base) {
  return {
    id: uid('pg'),
    srcId,
    srcIndex,
    base, // { w, h, rotate } — the untouched source geometry, in points
    rotate: 0, // extra quarter turns applied on top of base.rotate
    angle: 0, // extra free rotation in degrees; forces the embed-and-draw path
    crop: null, // { left, bottom, right, top } as fractions of the base box
    annots: [], // text boxes, stamps and watermarks, see annots.js
    bg: null, // { mode: 'color'|'remove', color }
    rasterId: null, // when set, the page is exported from this bitmap instead
    meta: {}, // free-form per-tool bookkeeping (e.g. compression level used)
  };
}

function clonePage(page) {
  return {
    ...page,
    base: { ...page.base },
    crop: page.crop ? { ...page.crop } : null,
    bg: page.bg ? { ...page.bg } : null,
    annots: page.annots.map((a) => ({ ...a })),
    meta: { ...page.meta },
  };
}

export function normalizeQuarter(deg) {
  return ((Math.round((deg ?? 0) / 90) * 90) % 360 + 360) % 360;
}

/** Effective on-screen size of a page in points, after rotation and cropping. */
export function pageSize(page) {
  const crop = page.crop;
  let w = page.base.w * (crop ? crop.right - crop.left : 1);
  let h = page.base.h * (crop ? crop.top - crop.bottom : 1);
  const quarter = normalizeQuarter(page.base.rotate + page.rotate);
  if (quarter % 180 === 90) [w, h] = [h, w];
  return { w, h, quarter };
}

/**
 * @typedef {object} Source
 * @property {string} id
 * @property {'pdf'|'image'} kind
 * @property {string} name
 * @property {number} size
 * @property {Uint8Array} bytes pristine bytes, safe to hand to pdf-lib
 * @property {import('../../vendor/pdf.mjs').PDFDocumentProxy} [doc]
 *
 * @typedef {object} RasterEntry
 * @property {string} url object URL of the rendered bitmap
 * @property {Blob} blob
 * @property {number} width
 * @property {number} height
 * @property {'image/png'|'image/jpeg'} mime
 */
