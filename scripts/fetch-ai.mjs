/**
 * Optional step: vendors TensorFlow.js and the ESRGAN-slim super-resolution
 * models so the Upscale tool's AI mode works offline.
 *
 * Kept separate from `npm run vendor` because it adds a few megabytes that most
 * users of a PDF editor will never need — the fast re-render mode covers text
 * and vector documents, which is the majority case.
 *
 *   node scripts/fetch-ai.mjs
 */
import { mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aiDir = path.join(root, 'vendor', 'ai');
const tmpDir = path.join(root, '.ai-tmp');

/** Scales the Upscale tool offers. The model files are ~900 KB each. */
const SCALES = [2, 3, 4];

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

await rm(tmpDir, { recursive: true, force: true });
await mkdir(aiDir, { recursive: true });

console.log('vendoring the AI upscaler (this pulls a few MB)');

const tfjs = await download('@tensorflow/tfjs');
await cp(path.join(tfjs.dir, 'dist', 'tf.min.js'), path.join(aiDir, 'tf.min.js'));
console.log(`  ok  @tensorflow/tfjs@${tfjs.version}`);

const esrgan = await download('@upscalerjs/esrgan-slim');
const models = {};
for (const scale of SCALES) {
  const from = path.join(esrgan.dir, 'models', `x${scale}`);
  const to = path.join(aiDir, 'models', `x${scale}`);
  await cp(from, to, { recursive: true });
  // Sanity check: the loader we use depends on this being a layers model with
  // an unnormalised 0-255 input range.
  const manifest = JSON.parse(await readFile(path.join(to, 'model.json'), 'utf8'));
  if (manifest.format !== 'layers-model') {
    throw new Error(`x${scale}: expected a layers model, got ${manifest.format}`);
  }
  models[scale] = { path: `vendor/ai/models/x${scale}/model.json`, patch: scale === 3 ? 129 : 128 };
}
console.log(`  ok  @upscalerjs/esrgan-slim@${esrgan.version} (x${SCALES.join(', x')})`);

// Deliberately not called manifest.json: the Chrome Web Store scans the whole
// package for that filename and rejects an upload that contains more than one,
// reading a nested config file as a second extension manifest.
await writeFile(path.join(aiDir, 'models.json'), `${JSON.stringify({
  tfjs: 'vendor/ai/tf.min.js',
  tfjsVersion: tfjs.version,
  modelName: 'ESRGAN-slim (RDN)',
  modelVersion: esrgan.version,
  // The RDN variant takes and returns plain 0-255 values, so no scaling.
  inputRange: [0, 255],
  outputRange: [0, 255],
  models,
}, null, 2)}\n`);

await rm(tmpDir, { recursive: true, force: true });
console.log('  ok  vendor/ai/models.json — reload the extension to enable AI upscaling');
