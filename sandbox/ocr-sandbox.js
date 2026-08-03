/**
 * The OCR engine, running inside a sandboxed page.
 *
 * It talks to the workspace over postMessage and nothing else: pixels arrive,
 * recognised words go back. There is no access to chrome.* here, and none is
 * needed — which is exactly why this is a safe place to run a library that
 * evaluates strings as JavaScript.
 *
 * Model weights are handed in by the parent rather than fetched here. A
 * sandboxed page has an opaque origin, so its own requests back to the
 * extension are not reliably allowed; the parent already has the files and can
 * simply transfer them.
 */

let engine = null;

const post = (message, transfer) => parent.postMessage(message, '*', transfer);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

async function initEngine({ detection, recognition, dictionary, wasmPath }, onProgress) {
  if (engine) return engine;

  onProgress(0.1, 'Loading image library');
  if (!globalThis.cv) await loadScript('../vendor/ocr/opencv/opencv.js');
  // OpenCV 5 resolves to the module through a promise rather than being it.
  if (globalThis.cv && typeof globalThis.cv.then === 'function') {
    globalThis.cv = await globalThis.cv;
  }

  onProgress(0.35, 'Loading runtime');
  const ort = await import('../vendor/ocr/ort/ort.wasm.mjs');
  ort.env.wasm.wasmPaths = wasmPath;
  // No SharedArrayBuffer without cross-origin isolation, so no threads.
  ort.env.wasm.numThreads = 1;

  onProgress(0.6, 'Starting engine');
  const paddle = await import('../vendor/ocr/paddle/web/index.js');
  const service = new paddle.PaddleOcrService({
    model: { detection, recognition, charactersDictionary: dictionary },
  });
  await service.initialize();

  onProgress(1, 'Ready');
  engine = service;
  return engine;
}

/** Rebuilds the image the parent sent and hands it to the engine. */
async function recognize({ width, height, pixels }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);

  const result = await engine.recognize(canvas);
  const words = [];
  for (const line of result?.lines ?? []) {
    for (const item of line) {
      if (!item?.text?.trim() || !item.box) continue;
      words.push({ text: item.text, box: item.box, confidence: item.confidence ?? 0 });
    }
  }
  return words;
}

window.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (!id || !type) return;

  try {
    if (type === 'init') {
      await initEngine(payload, (fraction, label) => post({ type: 'progress', id, fraction, label }));
      post({ type: 'result', id, ok: true, result: true });
      return;
    }
    if (type === 'recognize') {
      const words = await recognize(payload);
      post({ type: 'result', id, ok: true, result: words });
      return;
    }
    post({ type: 'result', id, ok: false, error: `Unknown request "${type}"` });
  } catch (err) {
    post({ type: 'result', id, ok: false, error: String(err?.message ?? err) });
  }
});

// Tells the parent the page is listening; it waits for this before sending work.
post({ type: 'ready' });
