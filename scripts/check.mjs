/**
 * Pre-flight check before loading the extension in Chrome.
 *
 * Catches the failures that are otherwise only visible as a blank tab: a file
 * referenced by the manifest or an import that is not actually on disk.
 *
 *   node scripts/check.mjs
 */
import { readFile, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const note = (message) => problems.push(message);

const exists = async (relative) => {
  try {
    await stat(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
};

// --- manifest ---------------------------------------------------------------
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

const referenced = [
  manifest.background?.service_worker,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);

for (const file of referenced) {
  if (!(await exists(file))) note(`manifest references a missing file: ${file}`);
}
if (manifest.manifest_version !== 3) note('manifest_version should be 3');

/*
 * OCR compiles WebAssembly, which Chrome refuses unless the policy says so. If
 * the policy is malformed Chrome silently falls back to its default and the
 * failure surfaces much later as an unexplained WebAssembly error, so check it
 * here where the cause is obvious.
 */
const csp = manifest.content_security_policy?.extension_pages ?? '';
if (await exists('vendor/ocr/models.json') && !csp.includes("'wasm-unsafe-eval'")) {
  note("the OCR engine needs 'wasm-unsafe-eval' in content_security_policy.extension_pages");
}
for (const directive of csp.split(';').map((d) => d.trim()).filter(Boolean)) {
  const name = directive.split(/\s+/)[0];
  if (!['script-src', 'object-src', 'script-src-elem', 'script-src-attr'].includes(name)) {
    note(`content_security_policy directive "${name}" may be rejected by Chrome, which would drop the whole policy`);
  }
}

// --- module graph -----------------------------------------------------------
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(relative)));
    else if (entry.name.endsWith('.js')) out.push(relative);
  }
  return out;
}

/** Every file under `dir`, whatever its extension. Returns [] if it is missing. */
async function walkAll(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkAll(relative)));
    else out.push(relative);
  }
  return out;
}

const sources = [...(await walk('app')), ...(await walk('background')), ...(await walk('tests'))];
const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

for (const file of sources) {
  const text = await readFile(path.join(root, file), 'utf8');
  for (const match of text.matchAll(IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) {
      note(`${file}: bare import "${specifier}" — the extension has no bundler`);
      continue;
    }
    const target = path.join(path.dirname(path.join(root, file)), specifier);
    try {
      await stat(target);
    } catch {
      note(`${file}: imports "${specifier}" which does not exist`);
    }
  }
}

// --- html assets ------------------------------------------------------------
for (const page of ['app/index.html', 'tests/index.html']) {
  const html = await readFile(path.join(root, page), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https?:|data:|#)/.test(ref)) continue;
    const target = path.join(path.dirname(path.join(root, page)), ref);
    try {
      await stat(target);
    } catch {
      note(`${page}: references "${ref}" which does not exist`);
    }
  }
}

// --- vendored libraries -----------------------------------------------------
for (const file of ['vendor/pdf-lib.esm.js', 'vendor/pdf.mjs', 'vendor/pdf.worker.mjs', 'vendor/jszip.js']) {
  if (!(await exists(file))) note(`missing ${file} — run "npm run vendor"`);
}
const aiReady = await exists('vendor/ai/models.json');

// A nested manifest.json makes the Chrome Web Store reject the upload, so flag
// one as soon as it appears rather than at submission time.
for (const stray of await walkAll('vendor')) {
  if (stray.endsWith('/manifest.json')) note(`${stray} would be read as a second extension manifest — rename it`);
}

// --- report -----------------------------------------------------------------
if (problems.length === 0) {
  console.log(`ok — ${sources.length} modules, manifest v${manifest.manifest_version}, AI upscaler ${aiReady ? 'installed' : 'not installed (optional)'}`);
} else {
  console.error(`${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
