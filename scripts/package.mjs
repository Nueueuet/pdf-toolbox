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
const INCLUDE = ['manifest.json', 'app', 'background', 'sandbox', 'icons', 'vendor', 'LICENSE', 'THIRD-PARTY.md', 'PRIVACY.md'];

/** Dropped even inside the included trees. */
const EXCLUDE = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Mirrored alongside the extension, though not part of it.
 *
 * Everything an upload needs should sit in one folder: the package, the pictures
 * that go with it, and the text to paste into the dashboard. The browser ignores
 * files it does not know about, so a folder carrying these is still loadable
 * unpacked.
 */
const ALONGSIDE = ['store-assets', 'STORE.md'];

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

/** The build itself goes in here, so the rest of the folder stays legible. */
const UNPACKED_DIR = 'extension';

/**
 * Optionally mirrors everything an upload needs to a folder outside the repo — a
 * synced drive, say, so other machines can load it unpacked without cloning
 * anything. The destination ends up laid out like this:
 *
 *   extension/              the unpacked build — this is the folder to load
 *   store-assets/           screenshots and promotional tiles
 *   pdf-toolbox-<v>.zip     the package to upload
 *   STORE.md                the listing text to paste
 *
 * Only `extension/` is rewritten wholesale on each build. Everything beside it
 * is refreshed but never pruned against the build, so nothing put there by hand
 * is swept away by the next run.
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
    // Either layout counts as ours: the current one, or the flat one this used
    // to write before the build moved into a folder of its own.
    const looksLikeOurs = existing.includes(UNPACKED_DIR)
      || existing.includes('manifest.json')
      || existing.includes('vendor')
      || existing.includes('store-assets');
    if (!looksLikeOurs) {
      console.warn(`  skip mirror: ${target} is not empty and does not look like a previous build`);
      console.warn('         empty it yourself if you really want it overwritten');
      return null;
    }
  }

  /*
   * Copied over the top rather than wiped first.
   *
   * A browser with the extension loaded holds its .wasm files open, and on
   * Windows that makes them undeletable. Deleting first meant one locked file
   * left the destination stripped of everything else — a broken extension. This
   * way the destination is always complete, and stale files are pruned
   * afterwards on a best-effort basis.
   */
  const unpacked = path.join(target, UNPACKED_DIR);
  await copyInto(fromDir, unpacked);
  await writeFile(path.join(target, path.basename(zipFile)), await readFile(zipFile));

  const locked = [];
  for (const extra of ALONGSIDE) {
    const from = path.join(root, extra);
    const info = await stat(from).catch(() => null);
    if (!info) continue;
    const to = path.join(target, extra);
    await copyInto(from, to);
    /*
     * Folders coming from here are generated wholesale, so what is no longer in
     * them has to go. Renaming the screenshots once left both numberings side by
     * side in the mirror — an upload picked from that folder would have mixed
     * them.
     */
    if (info.isDirectory()) locked.push(...await prune(from, to, new Set()));
  }

  // The build is pruned against itself. Nothing else at the top level is
  // touched except the leftovers below, because that is the user's folder.
  locked.push(...await prune(fromDir, unpacked, new Set()));
  locked.push(...await tidyTopLevel(target, path.basename(zipFile)));

  if (locked.length > 0) {
    console.warn(`  note: ${locked.length} old file(s) could not be removed (in use by a browser); harmless`);
  }
  return target;
}

/**
 * Clears out only what this script itself put at the top level in the past: the
 * build, back when it was written loose into the folder, and superseded zips.
 *
 * Deliberately a short list rather than "everything unrecognised". This is a
 * folder somebody keeps their own things in, and a build script has no business
 * deleting what it did not write.
 */
async function tidyTopLevel(target, currentZip) {
  const stale = [];
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return stale;
  }

  for (const entry of entries) {
    const leftFlat = INCLUDE.includes(entry.name);
    const oldZip = /^pdf-toolbox-.*\.zip$/.test(entry.name) && entry.name !== currentZip;
    if (!leftFlat && !oldZip) continue;
    try {
      await rm(path.join(target, entry.name), { recursive: true, force: true });
    } catch {
      stale.push(entry.name);
    }
  }
  return stale;
}

/**
 * Removes anything in `target` that is no longer in `source`. Never throws.
 *
 * @param {Set<string>} keep relative paths that belong there despite not being
 *   part of the build.
 */
async function prune(source, target, keep, base = '') {
  const stale = [];
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return stale;
  }

  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (keep.has(relative)) continue;

    const origin = path.join(source, relative);
    const here = path.join(target, relative);
    const stillWanted = await stat(origin).then(() => true).catch(() => false);

    if (!stillWanted) {
      try {
        await rm(here, { recursive: true, force: true });
      } catch {
        stale.push(relative);
      }
      continue;
    }
    if (entry.isDirectory()) stale.push(...(await prune(source, target, keep, relative)));
  }
  return stale;
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
if (mirroredTo) {
  console.log(`  mirrored to ${mirroredTo}`);
  console.log(`    ${UNPACKED_DIR}/ — load this folder unpacked; the zip, the pictures and STORE.md sit beside it`);
}
if (packed > 100 * 1024 * 1024) console.warn('  warning: the Chrome Web Store limit is 100 MB');
console.log('\nNext: see STORE.md — publishing needs your Google account, so it is a manual step.');
