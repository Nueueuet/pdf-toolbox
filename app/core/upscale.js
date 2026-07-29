/**
 * Page upscaling.
 *
 * Two very different jobs hide behind one word:
 *   - A page made of text and vector art has no "lost detail" to recover; it
 *     just needs to be *redrawn* at a higher resolution. That is exact, instant,
 *     and what most PDFs want.
 *   - A page that is a scan or a photo has no vector data left, so the only way
 *     to add detail is to hallucinate it with a super-resolution model.
 *
 * The AI half is optional: the model files are large, so they are vendored by a
 * separate `npm run vendor:ai` step and everything degrades gracefully without
 * them.
 */
import { assetUrl } from './paths.js';

export const AI_MODEL_NOTE =
  'The AI model is not installed. Run “npm run vendor:ai” in the extension folder and reload to enable it.';

let manifestPromise = null;
let tfPromise = null;
const modelCache = new Map(); // scale -> loaded tf.LayersModel

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(assetUrl('vendor/ai/manifest.json'))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return manifestPromise;
}

/** Cheap probe so the UI can disable the option without downloading anything. */
export async function aiAvailable() {
  return Boolean(await loadManifest());
}

/** Scale factors the vendored models actually provide. */
export async function aiScales() {
  const manifest = await loadManifest();
  return manifest ? Object.keys(manifest.models).map(Number).sort((a, b) => a - b) : [];
}

async function loadTf(manifest) {
  if (!tfPromise) {
    // TensorFlow.js ships as a classic script that installs a global. Loading it
    // from the extension's own origin keeps it inside the MV3 script-src policy.
    tfPromise = new Promise((resolve, reject) => {
      if (globalThis.tf) return resolve(globalThis.tf);
      const script = document.createElement('script');
      script.src = assetUrl(manifest.tfjs);
      script.onload = () => resolve(globalThis.tf);
      script.onerror = () => reject(new Error('Could not load TensorFlow.js'));
      document.head.appendChild(script);
    }).then(async (tf) => {
      await tf.ready();
      return tf;
    });
  }
  return tfPromise;
}

async function loadAi(factor, onProgress) {
  const manifest = await loadManifest();
  if (!manifest) throw new Error(AI_MODEL_NOTE);

  const entry = manifest.models[factor];
  if (!entry) {
    throw new Error(`No AI model vendored for ${factor}× (have ${Object.keys(manifest.models).join('×, ')}×)`);
  }

  onProgress?.(0.05);
  const tf = await loadTf(manifest);
  onProgress?.(0.2);

  if (!modelCache.has(factor)) {
    // ESRGAN-slim is a Keras layers model, not a graph model.
    modelCache.set(factor, await tf.loadLayersModel(assetUrl(entry.path)));
  }
  onProgress?.(0.45);

  return {
    tf,
    model: modelCache.get(factor),
    scale: factor,
    patch: entry.patch ?? 128,
    // The RDN variant consumes and produces plain 0-255 values.
    inputMax: manifest.inputRange?.[1] ?? 255,
    outputMax: manifest.outputRange?.[1] ?? 255,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{mode: 'render'|'ai', factor: number, sharpen?: boolean, onProgress?: (f: number) => void}} opts
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function upscaleCanvas(canvas, { mode = 'render', factor = 2, sharpen = true, onProgress } = {}) {
  let result = canvas;

  if (mode === 'ai') {
    result = await aiUpscale(canvas, factor, onProgress);
  } else {
    result = resample(canvas, canvas.width * factor, canvas.height * factor);
    onProgress?.(0.8);
  }

  if (sharpen) result = unsharpMask(result, mode === 'ai' ? 0.35 : 0.6);
  onProgress?.(1);
  return result;
}

/** High-quality browser resampling. */
function resample(source, width, height) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(width));
  out.height = Math.max(1, Math.round(height));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/** Overlap between tiles, in source pixels, hidden when stitching. */
const TILE_PADDING = 8;

async function aiUpscale(canvas, factor, onProgress) {
  const { tf, model, scale, patch, outputMax } = await loadAi(factor, onProgress);

  // A whole page as one tensor blows past WebGL texture limits, so the image is
  // processed in overlapping tiles. The overlap is discarded on stitching, which
  // keeps the seams out of the result.
  const out = document.createElement('canvas');
  out.width = canvas.width * scale;
  out.height = canvas.height * scale;
  const outCtx = out.getContext('2d');

  const cols = Math.ceil(canvas.width / patch);
  const rows = Math.ceil(canvas.height / patch);
  const total = cols * rows;
  let done = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = Math.max(0, col * patch - TILE_PADDING);
      const sy = Math.max(0, row * patch - TILE_PADDING);
      const sw = Math.min(canvas.width - sx, patch + TILE_PADDING * 2);
      const sh = Math.min(canvas.height - sy, patch + TILE_PADDING * 2);
      if (sw <= 0 || sh <= 0) continue;

      const tile = document.createElement('canvas');
      tile.width = sw;
      tile.height = sh;
      tile.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

      const predicted = tf.tidy(() => {
        // ESRGAN-slim's RDN variant takes raw 0-255 values, so no normalising.
        const input = tf.browser.fromPixels(tile).toFloat().expandDims(0);
        const prediction = model.predict(input);
        return prediction.squeeze().clipByValue(0, outputMax).div(outputMax);
      });

      const tileOut = document.createElement('canvas');
      tileOut.width = predicted.shape[1];
      tileOut.height = predicted.shape[0];
      await tf.browser.toPixels(predicted, tileOut);
      predicted.dispose();

      // Trim the padding back off before stitching.
      const trimX = (col * patch - sx) * scale;
      const trimY = (row * patch - sy) * scale;
      const drawW = Math.min(patch, canvas.width - col * patch) * scale;
      const drawH = Math.min(patch, canvas.height - row * patch) * scale;
      outCtx.drawImage(
        tileOut,
        trimX, trimY, drawW, drawH,
        col * patch * scale, row * patch * scale, drawW, drawH,
      );

      done++;
      onProgress?.(0.45 + (done / total) * 0.5);
      // Yield so a long page does not lock the tab up entirely.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return out;
}

/**
 * Unsharp mask. Upscaling always softens edges a little; this puts the bite back
 * without the halos a plain sharpen kernel produces.
 */
export function unsharpMask(canvas, amount = 0.5) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const image = ctx.getImageData(0, 0, width, height);
  const src = image.data;
  const out = new Uint8ClampedArray(src);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const centre = src[i + c];
        const blur = (
          src[i - width * 4 + c] + src[i + width * 4 + c] +
          src[i - 4 + c] + src[i + 4 + c] +
          centre * 4
        ) / 8;
        out[i + c] = centre + (centre - blur) * amount * 2;
      }
    }
  }

  ctx.putImageData(new ImageData(out, width, height), 0, 0);
  return canvas;
}
