/**
 * Text recognition, for pages whose "text" is only a picture of text.
 *
 * The result is not pasted onto the page. It is written into the exported PDF as
 * an invisible layer sitting exactly where the words are, which is how a
 * searchable PDF works: the page looks untouched, but the text can be selected
 * and copied — including after saving.
 *
 * The engine is optional (`npm run vendor:ocr`), because it is 32 MB of runtime
 * and model weights that most users of a PDF editor will never need.
 */
import { assetUrl } from './paths.js';

export const OCR_NOT_INSTALLED =
  'The OCR engine is not installed. Run “npm run vendor:ocr” in the extension folder and reload to enable it.';

let manifestPromise = null;
let enginePromise = null;

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(assetUrl('vendor/ocr/models.json'))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return manifestPromise;
}

/** Cheap probe so the tool can explain itself without downloading anything. */
export async function ocrAvailable() {
  return Boolean(await loadManifest());
}

/**
 * Asks the browser directly whether it will compile WebAssembly here.
 *
 * Worth testing rather than assuming: a content security policy problem shows up
 * deep inside the engine as an error about `wasm-eval`, minutes into a job, and
 * says nothing about which of the several possible causes applies. Eight bytes
 * is a complete, empty, valid module — enough to find out in a microsecond.
 */
export function wasmAllowed() {
  try {
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    return { ok: Boolean(new WebAssembly.Module(empty)), error: null };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export async function ocrInfo() {
  return loadManifest();
}

/**
 * Turns the engine's low-level failures into something a user can act on.
 *
 * The common one is a stale content security policy: Chrome reads the manifest
 * when the extension loads but the page's code when the tab opens, so updating
 * the files without reloading the extension leaves new code running under the
 * old policy — and WebAssembly is refused with a message that explains nothing
 * about what to do.
 */
function translateEngineError(err) {
  const message = String(err?.message ?? err);
  let friendly = null;

  if (/wasm-eval|unsafe-eval|Content Security Policy/i.test(message)) {
    friendly = 'OCR could not start: this page is not allowed to compile WebAssembly. '
      + 'The extension needs "wasm-unsafe-eval" in its content security policy, and to be '
      + 'reloaded from chrome://extensions after that changed.';
  } else if (/fetch|404|Failed to load/i.test(message) && /vendor\/ocr/i.test(message)) {
    friendly = OCR_NOT_INSTALLED;
  }
  if (!friendly) return err;

  // The original is kept, not replaced. Rewriting an error into friendlier words
  // and dropping what the browser actually said leaves nothing to debug with —
  // as this very message did.
  const translated = new Error(`${friendly}\n\nThe browser reported: ${message}`);
  translated.cause = err;
  return translated;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Brings up OpenCV, ONNX Runtime and the Paddle service. Everything is loaded
 * from the extension's own files; nothing is fetched from the network.
 */
export async function loadEngine(onProgress) {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const manifest = await loadManifest();
    if (!manifest) throw new Error(OCR_NOT_INSTALLED);

    onProgress?.(0.05, 'Loading image library');
    if (!globalThis.cv) await loadScript(assetUrl('vendor/ocr/opencv/opencv.js'));
    // OpenCV 5 hands back a promise for the module rather than the module.
    if (globalThis.cv && typeof globalThis.cv.then === 'function') {
      globalThis.cv = await globalThis.cv;
    }

    onProgress?.(0.2, 'Loading runtime');
    const ort = await import('../../vendor/ocr/ort/ort.wasm.mjs');
    ort.env.wasm.wasmPaths = assetUrl(manifest.wasmPath);
    /*
     * Extension pages cannot send the COOP/COEP headers that SharedArrayBuffer
     * needs, so threading is unavailable and asking for it just fails at load.
     */
    ort.env.wasm.numThreads = 1;

    onProgress?.(0.35, 'Loading model');
    const paddle = await import('../../vendor/ocr/paddle/web/index.js');
    const grab = (relative) => fetch(assetUrl(relative)).then((r) => r.arrayBuffer());
    const [detection, recognition, charactersDictionary] = await Promise.all([
      grab(manifest.detection),
      grab(manifest.recognition),
      grab(manifest.dictionary),
    ]);

    onProgress?.(0.75, 'Starting engine');
    const service = new paddle.PaddleOcrService({
      model: { detection, recognition, charactersDictionary },
    });
    await service.initialize();

    onProgress?.(1, 'Ready');
    return { service, manifest };
  })().catch((err) => {
    enginePromise = null; // let a later attempt try again
    throw translateEngineError(err);
  });

  return enginePromise;
}

/**
 * Runs recognition over one image.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<{text: string, box: {x: number, y: number, width: number, height: number}, confidence: number}[]>}
 *          boxes in the canvas's own pixel coordinates
 */
export async function recognizeCanvas(canvas) {
  const { service } = await loadEngine();
  const result = await service.recognize(canvas);
  const words = [];
  for (const line of result?.lines ?? []) {
    for (const item of line) {
      if (!item?.text?.trim() || !item.box) continue;
      words.push({ text: item.text, box: item.box, confidence: item.confidence ?? 0 });
    }
  }
  return words;
}

/**
 * Resolution the page is rendered at before recognition. High enough for small
 * print, low enough that a full page is not a 35 MB bitmap.
 */
export const OCR_DPI = 200;

/**
 * Recognises one page, but only the parts of it that are not already selectable
 * text.
 *
 * @param {Workspace} ws
 * @param {object} page
 * @param {{onProgress?: (f: number) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{skipped: boolean, reason?: string, verdict: string,
 *                    words: object[], regions: object[]}>}
 */
export async function ocrPage(ws, page, { onProgress, signal } = {}) {
  const { analysePage } = await import('./coverage.js');
  const { renderPageCanvas } = await import('./render.js');

  onProgress?.(0.05);
  const analysis = await analysePage(ws, page);
  throwIfAborted(signal);

  if (analysis.verdict === 'text') {
    return { skipped: true, reason: 'already-text', verdict: analysis.verdict, words: [], regions: [], analysis };
  }
  if (analysis.verdict === 'empty') {
    return { skipped: true, reason: 'blank', verdict: analysis.verdict, words: [], regions: [], analysis };
  }

  onProgress?.(0.15);
  const { canvas } = await renderPageCanvas(ws, page, { scale: OCR_DPI / 72, withAnnots: false });
  throwIfAborted(signal);

  const words = [];
  const regions = analysis.regions;
  for (const [index, region] of regions.entries()) {
    throwIfAborted(signal);

    const sx = Math.max(0, Math.floor(region.x * canvas.width));
    const sy = Math.max(0, Math.floor(region.y * canvas.height));
    const sw = Math.min(canvas.width - sx, Math.ceil(region.w * canvas.width));
    const sh = Math.min(canvas.height - sy, Math.ceil(region.h * canvas.height));
    if (sw < 8 || sh < 8) continue;

    const crop = document.createElement('canvas');
    crop.width = sw;
    crop.height = sh;
    const ctx = crop.getContext('2d');
    // White behind the crop: recognition expects paper, not transparency.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const found = await recognizeCanvas(crop);
    for (const item of found) {
      words.push({
        text: item.text,
        confidence: item.confidence,
        // Back from crop pixels to fractions of the whole page.
        x: (sx + item.box.x) / canvas.width,
        y: (sy + item.box.y) / canvas.height,
        w: item.box.width / canvas.width,
        h: item.box.height / canvas.height,
      });
    }
    onProgress?.(0.15 + ((index + 1) / regions.length) * 0.85);
  }

  return { skipped: false, verdict: analysis.verdict, words, regions, analysis };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

/** Frees the model sessions. The engine reloads on next use. */
export async function releaseEngine() {
  if (!enginePromise) return;
  try {
    const { service } = await enginePromise;
    await service.destroy();
  } catch {}
  enginePromise = null;
}
