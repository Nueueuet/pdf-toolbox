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

const aiIncluded = await stat(path.join(stageDir, 'vendor', 'ai')).then(() => true).catch(() => false);
const zipName = `pdf-toolbox-${manifest.version}.zip`;
const zipPath = path.join(outDir, zipName);
await rm(zipPath, { force: true });

// bsdtar ships with Windows 10+ and macOS; -a picks the format from the suffix.
execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', stageDir, ...INCLUDE], { stdio: 'inherit' });

const unpacked = await sizeOf(stageDir);
const packed = (await stat(zipPath)).size;
await rm(stageDir, { recursive: true, force: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nwrote dist/${zipName}`);
console.log(`  packed ${mb(packed)}, unpacked ${mb(unpacked)}`);
console.log(`  AI upscaler: ${aiIncluded ? 'included' : 'not included'}`);
if (packed > 100 * 1024 * 1024) console.warn('  warning: the Chrome Web Store limit is 100 MB');
console.log('\nNext: see STORE.md — publishing needs your Google account, so it is a manual step.');
