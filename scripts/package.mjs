/**
 * Builds the ZIP that gets uploaded to the Chrome Web Store.
 *
 * The store wants the extension and nothing else, so development files (tests,
 * scripts, sample PDFs, the git directory) are left out. The vendored libraries
 * *are* included, because the extension cannot fetch them at runtime.
 *
 *   node scripts/package.mjs
 */
import { readFile, readdir, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = path.join(root, '.package-tmp');
const outDir = path.join(root, 'dist');

/** Everything the extension needs at runtime, and nothing more. */
const INCLUDE = ['manifest.json', 'app', 'background', 'icons', 'vendor', 'LICENSE', 'THIRD-PARTY.md', 'PRIVACY.md'];

/** Dropped even inside the included trees. */
const EXCLUDE = new Set(['.DS_Store', 'Thumbs.db']);

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

// The store rejects a package whose manifest points at files that are not in it,
// so fail loudly here rather than after an upload round-trip.
const problems = [];
for (const entry of INCLUDE) {
  try {
    await stat(path.join(root, entry));
  } catch {
    problems.push(`missing ${entry}${entry === 'vendor' ? ' — run "npm run vendor"' : ''}`);
  }
}
if (problems.length) {
  console.error('cannot package:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

async function copyInto(from, to) {
  const info = await stat(from);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from)) {
      if (EXCLUDE.has(entry)) continue;
      await copyInto(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
}

/**
 * Optionally mirrors the built extension to a folder outside the repo — a synced
 * drive, say, so other machines can load it unpacked without cloning anything.
 *
 * The destination is machine-specific, so it lives in a gitignored file rather
 * than in this script: put the absolute path in `mirror.local.txt`, or set
 * PDF_TOOLBOX_MIRROR. With neither, this step is skipped.
 */
async function mirror(fromDir, zipFile) {
  let target = process.env.PDF_TOOLBOX_MIRROR?.trim();
  if (!target) {
    try {
      target = (await readFile(path.join(root, 'mirror.local.txt'), 'utf8')).trim();
    } catch {
      return null;
    }
  }
  if (!target) return null;

  // Mirroring wipes the destination, so refuse anything that is not already an
  // empty folder or a previous copy of this extension. A mistyped path must not
  // be able to delete somebody's documents.
  let existing = [];
  try {
    existing = await readdir(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await mkdir(target, { recursive: true });
    } else {
      throw err;
    }
  }

  if (existing.length > 0) {
    const looksLikeOurs = existing.includes('manifest.json') && existing.includes('app');
    if (!looksLikeOurs) {
      console.warn(`  skip mirror: ${target} is not empty and does not look like a previous build`);
      console.warn('         empty it yourself if you really want it overwritten');
      return null;
    }
    for (const entry of existing) {
      await rm(path.join(target, entry), { recursive: true, force: true });
    }
  }

  await copyInto(fromDir, target);
  // The zip goes along too, for uploading from whichever machine.
  await writeFile(path.join(target, path.basename(zipFile)), await readFile(zipFile));
  return target;
}

async function sizeOf(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await sizeOf(full) : (await stat(full)).size;
  }
  return total;
}

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
await mkdir(outDir, { recursive: true });

for (const entry of INCLUDE) {
  await copyInto(path.join(root, entry), path.join(stageDir, entry));
}

/**
 * The store scans the whole package for `manifest.json` and refuses an upload
 * that contains more than one, reading any nested config file of that name as a
 * second extension manifest. That failure only surfaces after uploading, so
 * catch it here instead.
 */
async function findManifests(dir, base = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await findManifests(path.join(dir, entry.name), relative)));
    else if (entry.name === 'manifest.json') found.push(relative);
  }
  return found;
}

const manifests = await findManifests(stageDir);
if (manifests.length !== 1 || manifests[0] !== 'manifest.json') {
  await rm(stageDir, { recursive: true, force: true });
  console.error('cannot package: the store accepts exactly one manifest.json, found:');
  for (const entry of manifests) console.error(`  - ${entry}`);
  console.error('rename the nested one (see scripts/fetch-ai.mjs)');
  process.exit(1);
}

const aiIncluded = await stat(path.join(stageDir, 'vendor', 'ai')).then(() => true).catch(() => false);
const zipName = `pdf-toolbox-${manifest.version}.zip`;
const zipPath = path.join(outDir, zipName);
await rm(zipPath, { force: true });

// bsdtar ships with Windows 10+ and macOS; -a picks the format from the suffix.
execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', stageDir, ...INCLUDE], { stdio: 'inherit' });

const unpacked = await sizeOf(stageDir);
const packed = (await stat(zipPath)).size;

const mirroredTo = await mirror(stageDir, zipPath);
await rm(stageDir, { recursive: true, force: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nwrote dist/${zipName}`);
console.log(`  packed ${mb(packed)}, unpacked ${mb(unpacked)}`);
console.log(`  AI upscaler: ${aiIncluded ? 'included' : 'not included'}`);
if (mirroredTo) console.log(`  mirrored to ${mirroredTo}`);
if (packed > 100 * 1024 * 1024) console.warn('  warning: the Chrome Web Store limit is 100 MB');
console.log('\nNext: see STORE.md — publishing needs your Google account, so it is a manual step.');
