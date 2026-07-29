/**
 * Vendors the prebuilt browser bundles we need straight from the npm registry.
 *
 * We deliberately avoid `npm install` + a bundler: every library below already
 * ships a self-contained browser build, and a Chrome MV3 extension can only run
 * local scripts anyway. Result: `vendor/` holds everything, and the extension
 * loads unpacked with no build step.
 *
 *   node scripts/fetch-vendor.mjs
 */
import { mkdir, rm, cp, readdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor');
const tmpDir = path.join(root, '.vendor-tmp');

/** Files copied out of each tarball: [pathInTarball, destinationInVendorDir] */
const PACKAGES = [
  {
    name: '@cantoo/pdf-lib',
    // Fork of pdf-lib that adds AES encryption/decryption, which upstream lacks.
    files: [['dist/pdf-lib.esm.js', 'pdf-lib.esm.js']],
  },
  {
    name: '@pdf-lib/fontkit',
    files: [['dist/fontkit.es.js', 'fontkit.es.js']],
  },
  {
    name: 'pdfjs-dist',
    version: '4.10.38',
    files: [
      ['build/pdf.min.mjs', 'pdf.mjs'],
      ['build/pdf.worker.min.mjs', 'pdf.worker.mjs'],
    ],
    dirs: [['cmaps', 'cmaps'], ['standard_fonts', 'standard_fonts']],
  },
  {
    name: 'jszip',
    files: [['dist/jszip.min.js', 'jszip.js']],
  },
];

async function tarballUrl(name, version) {
  const meta = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`).then((r) => r.json());
  const v = version ?? meta['dist-tags'].latest;
  const entry = meta.versions[v];
  if (!entry) throw new Error(`${name}@${v} not found in registry`);
  return { url: entry.dist.tarball, version: v };
}

async function vendor(pkg) {
  const { url, version } = await tarballUrl(pkg.name, pkg.version);
  const slug = pkg.name.replace(/[@/]/g, '_');
  const workDir = path.join(tmpDir, slug);
  await mkdir(workDir, { recursive: true });

  const tgz = path.join(workDir, 'pkg.tgz');
  const buf = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));
  await writeFile(tgz, buf);
  // bsdtar ships with Windows 10+/macOS/most Linux, so no tar library needed.
  execFileSync('tar', ['-xzf', tgz, '-C', workDir]);

  const unpacked = path.join(workDir, 'package');
  for (const [from, to] of pkg.files ?? []) {
    await cp(path.join(unpacked, from), path.join(vendorDir, to));
  }
  for (const [from, to] of pkg.dirs ?? []) {
    await cp(path.join(unpacked, from), path.join(vendorDir, to), { recursive: true });
  }
  console.log(`  ok  ${pkg.name}@${version}`);
}

await rm(tmpDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });
console.log('vendoring browser bundles into vendor/');
for (const pkg of PACKAGES) {
  try {
    await vendor(pkg);
  } catch (err) {
    console.error(`  FAIL ${pkg.name}: ${err.message}`);
    // Listing the tarball helps when a package renames its dist files.
    const slug = pkg.name.replace(/[@/]/g, '_');
    const unpacked = path.join(tmpDir, slug, 'package');
    try {
      console.error('       dist/ contains:', (await readdir(path.join(unpacked, 'dist'))).join(', '));
    } catch {}
    process.exitCode = 1;
  }
}
await rm(tmpDir, { recursive: true, force: true });
