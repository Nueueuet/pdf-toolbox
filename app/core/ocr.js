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
    friendly = 'OCR could not start because the browser blocked the engine. It runs in a '
      + 'sandboxed page for exactly this reason, so the likely cause is an extension that '
      + 'has not been reloaded since the sandbox was added: reload it from chrome://extensions '
      + '(or brave://extensions) and open the workspace again.';
  } else if (/sandbox did not start/i.test(message)) {
    friendly = 'The OCR sandbox never started. If the extension was updated in place, reload it '
      + 'from chrome://extensions so the new sandbox page is registered.';
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

/**
 * Conversation with the sandboxed page that actually runs the engine.
 *
 * The engine cannot live in this page: OpenCV's build evaluates strings as
 * JavaScript, and Manifest V3 forbids that on an extension page outright — no
 * manifest setting can permit it. A sandboxed page gets a looser policy in
 * exchange for having no access to chrome.* or to the extension's origin, which
 * costs nothing here, since all the engine needs is pixels in and words out.
 */
class SandboxLink {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.progress = null;

    this.frame = document.createElement('iframe');
    this.frame.src = assetUrl('sandbox/ocr-sandbox.html');
    this.frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';

    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The OCR sandbox did not start')), 20000);
      this.onMessage = (event) => {
        if (event.source !== this.frame.contentWindow) return;
        const message = event.data ?? {};
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (message.type === 'progress') {
          this.progress?.(message.fraction, message.label);
          return;
        }
        if (message.type === 'result') {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          message.ok ? entry.resolve(message.result) : entry.reject(new Error(message.error));
        }
      };
      window.addEventListener('message', this.onMessage);
      document.body.appendChild(this.frame);
    });
  }

  send(type, payload, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.frame.contentWindow.postMessage({ id, type, payload }, '*', transfer);
    });
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    this.frame.remove();
  }
}

/**
 * Starts the engine in its sandbox. Everything it needs comes from the
 * extension's own files; nothing is fetched from the network.
 */
export async function loadEngine(onProgress) {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const manifest = await loadManifest();
    if (!manifest) throw new Error(OCR_NOT_INSTALLED);

    onProgress?.(0.02, 'Starting sandbox');
    const link = new SandboxLink();
    link.progress = (fraction, label) => onProgress?.(0.1 + fraction * 0.8, label);
    await link.ready;

    // Fetched here and handed over: a sandboxed page has an opaque origin and
    // cannot reliably request the extension's own files.
    const grab = (relative) => fetch(assetUrl(relative)).then((r) => r.arrayBuffer());
    const [detection, recognition, dictionary] = await Promise.all([
      grab(manifest.detection),
      grab(manifest.recognition),
      grab(manifest.dictionary),
    ]);

    await link.send('init', {
      detection,
      recognition,
      dictionary,
      wasmPath: assetUrl(manifest.wasmPath),
    }, [detection, recognition, dictionary]);

    onProgress?.(1, 'Ready');
    return { link, manifest };
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
  const { link } = await loadEngine();
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  // Transferred rather than copied: a full page is tens of megabytes of pixels,
  // and every region would otherwise be duplicated on the way across.
  const pixels = image.data.buffer;
  return link.send('recognize', { width: canvas.width, height: canvas.height, pixels }, [pixels]);
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
    const { link } = await enginePromise;
    link.destroy();
  } catch {}
  enginePromise = null;
}
