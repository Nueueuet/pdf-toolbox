/**
 * Optional step: vendors the PaddleOCR stack so the OCR tool works offline.
 *
 * Kept separate from `npm run vendor` because it is by far the biggest thing in
 * the extension — roughly 30 MB of runtime and model weights — and most users of
 * a PDF editor never touch OCR.
 *
 * Three things make this fiddly, and all three are handled here:
 *   1. The packages import `onnxruntime-web` and `ppu-ocv/canvas-web` by bare
 *      specifier. There is no bundler in this project and MV3 forbids the inline
 *      <script type="importmap"> that would otherwise resolve them, so the
 *      specifiers are rewritten to relative paths on the way in.
 *   2. ONNX Runtime looks for its .wasm next to itself; the path is pinned at
 *      load time in app/core/ocr.js instead.
 *   3. The model weights are fetched now and read from disk at runtime, so the
 *      extension never contacts the network.
 *
 *   node scripts/fetch-ocr.mjs
 */
import { mkdir, rm, cp, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ocrDir = path.join(root, 'vendor', 'ocr');
const tmpDir = path.join(root, '.ocr-tmp');

/**
 * PP-OCRv6 tiny: the package's own default, and the right trade for WASM.
 * The larger presets are three to five times the size and correspondingly
 * slower to run without a GPU. Swap the paths here to change that.
 */
const MODEL_BASE = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
const DICT_BASE = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
const MODEL = {
  name: 'PP-OCRv6 tiny',
  detection: `${MODEL_BASE}/detection/ort/PP-OCRv6_tiny_det.ort`,
  recognition: `${MODEL_BASE}/recognition/ort/PP-OCRv6_tiny_rec.ort`,
  dictionary: `${DICT_BASE}/recognition/ppocrv6_tiny_dict.txt`,
};

/** Bare specifier -> path relative to the importing file, applied to every .js copied in. */
const REWRITES = [
  ['onnxruntime-web', '../ort/ort.wasm.mjs'],
  ['ppu-ocv/canvas-web', '../ocv/index.canvas-web.js'],
  ['ppu-ocv', '../ocv/index.web.js'],
  ['@techstark/opencv-js', '../opencv/opencv.js'],
];

async function download(name, version) {
  const meta = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`).then((r) => r.json());
  const resolved = version ?? meta['dist-tags'].latest;
  const url = meta.versions[resolved].dist.tarball;

  const workDir = path.join(tmpDir, name.replace(/[@/]/g, '_'));
  await mkdir(workDir, { recursive: true });
  const tgz = path.join(workDir, 'pkg.tgz');
  await writeFile(tgz, Buffer.from(await fetch(url).then((r) => r.arrayBuffer())));
  execFileSync('tar', ['-xzf', tgz, '-C', workDir]);
  return { dir: path.join(workDir, 'package'), version: resolved };
}

/** Copies a tree, rewriting bare imports in every JavaScript file on the way. */
async function copyRewritten(from, to, depth = 0) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    // Type definitions and CLI plumbing are dead weight in the extension.
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map') || entry.name === 'cli') continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);

    if (entry.isDirectory()) {
      await copyRewritten(source, target, depth + 1);
      continue;
    }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) {
      await cp(source, target);
      continue;
    }

    let code = await readFile(source, 'utf8');
    /*
     * The replacement targets are siblings of the package directory, so a file
     * at the package root already needs one `../`, and each level deeper needs
     * another. Getting this off by one leaves imports pointing inside the
     * package, where the module simply 404s.
     */
    const climb = '../'.repeat(depth + 1);
    for (const [specifier, replacement] of REWRITES) {
      const relative = climb + replacement.replace(/^\.\.\//, '');
      code = code.replaceAll(`"${specifier}"`, `"${relative}"`).replaceAll(`'${specifier}'`, `'${relative}'`);
    }
    await writeFile(target, code);
  }
}

async function fetchTo(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  return (await stat(target)).size;
}

async function sizeOf(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await sizeOf(full) : (await stat(full)).size;
  }
  return total;
}

await rm(tmpDir, { recursive: true, force: true });
await rm(ocrDir, { recursive: true, force: true });
await mkdir(ocrDir, { recursive: true });

console.log('vendoring the OCR engine (this pulls about 30 MB)');

// --- ONNX Runtime: the WASM-only build, which is a fifth of the full one ------
const ort = await download('onnxruntime-web');
await mkdir(path.join(ocrDir, 'ort'), { recursive: true });
for (const file of ['ort.wasm.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await cp(path.join(ort.dir, 'dist', file), path.join(ocrDir, 'ort', file));
}
console.log(`  ok  onnxruntime-web@${ort.version} (wasm build)`);

// --- OpenCV, used for the image preparation before detection -----------------
const opencv = await download('@techstark/opencv-js');
await mkdir(path.join(ocrDir, 'opencv'), { recursive: true });
for (const file of await readdir(path.join(opencv.dir, 'dist'))) {
  if (file.endsWith('.js') || file.endsWith('.wasm')) {
    await cp(path.join(opencv.dir, 'dist', file), path.join(ocrDir, 'opencv', file));
  }
}
console.log(`  ok  @techstark/opencv-js@${opencv.version}`);

const ocv = await download('ppu-ocv');
await copyRewritten(ocv.dir, path.join(ocrDir, 'ocv'));
console.log(`  ok  ppu-ocv@${ocv.version}`);

const paddle = await download('ppu-paddle-ocr');
await copyRewritten(paddle.dir, path.join(ocrDir, 'paddle'));
console.log(`  ok  ppu-paddle-ocr@${paddle.version}`);

// --- model weights -----------------------------------------------------------
await mkdir(path.join(ocrDir, 'models'), { recursive: true });
const det = await fetchTo(MODEL.detection, path.join(ocrDir, 'models', 'det.ort'));
const rec = await fetchTo(MODEL.recognition, path.join(ocrDir, 'models', 'rec.ort'));
const dict = await fetchTo(MODEL.dictionary, path.join(ocrDir, 'models', 'dict.txt'));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`  ok  ${MODEL.name} — detection ${mb(det)}, recognition ${mb(rec)}, dictionary ${mb(dict)}`);

await writeFile(path.join(ocrDir, 'models.json'), `${JSON.stringify({
  engine: 'ppu-paddle-ocr',
  engineVersion: paddle.version,
  runtime: 'onnxruntime-web',
  runtimeVersion: ort.version,
  model: MODEL.name,
  detection: 'vendor/ocr/models/det.ort',
  recognition: 'vendor/ocr/models/rec.ort',
  dictionary: 'vendor/ocr/models/dict.txt',
  wasmPath: 'vendor/ocr/ort/',
}, null, 2)}\n`);

await rm(tmpDir, { recursive: true, force: true });
console.log(`\n  total ${mb(await sizeOf(ocrDir))} in vendor/ocr — reload the extension to enable OCR`);
