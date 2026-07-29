/**
 * Captures the store assets: real screenshots of the running app, plus the two
 * promotional tiles.
 *
 * These are genuine captures of the actual UI with actual documents loaded, not
 * mock-ups — the store expects screenshots to show the product, and a picture
 * that flatters something the extension does not do would be worse than none.
 * A headless Chromium renders each scene at exactly the size the store wants.
 *
 *   node scripts/screenshots.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'store-assets');
const PORT = 5199;

/** The store's accepted screenshot size, and the two promo tile sizes. */
const SCENES = [
  {
    file: 'screenshot-1-merge.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=merge&zoom=0.3`,
    caption: 'Several files merged, pages reorderable by drag',
  },
  {
    file: 'screenshot-2-split.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=split&zoom=0.3&cuts=2,5`,
    caption: 'Split marks sitting between the pages',
  },
  {
    file: 'screenshot-3-write.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=write&files=report.pdf&annot=1`,
    caption: 'A text box being edited on the page',
  },
  {
    file: 'screenshot-4-compress.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=compress&files=report.pdf&zoom=0.28`,
    caption: 'Compression levels with measured output sizes',
  },
  { file: 'promo-small-440x280.png', width: 440, height: 280, url: '/store-assets/promo.html?size=small', caption: 'Small promo tile' },
  { file: 'promo-large-1400x560.png', width: 1400, height: 560, url: '/store-assets/promo.html?size=large', caption: 'Large promo tile' },
];

/**
 * Brave is deliberately last: its headless mode never reaches the screenshot
 * step and the process has to be killed, so it is only worth trying when there
 * is nothing else on the machine.
 */
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await stat(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`no Chromium-based browser found. Tried:\n  ${BROWSER_CANDIDATES.join('\n  ')}`);
}

async function ensureSamples() {
  try {
    const files = await readdir(path.join(root, 'test-files'));
    if (files.some((f) => f.endsWith('.pdf'))) return;
  } catch {}
  console.log('  generating sample PDFs first');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-test-pdfs.mjs')], { stdio: 'inherit' });
}

function startServer() {
  const server = spawn(process.execPath, [path.join(root, 'scripts', 'dev-server.mjs'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server did not start')), 10000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('http://')) {
        clearTimeout(timer);
        resolve(server);
      }
    });
    server.on('error', reject);
  });
}

async function capture(browser, scene) {
  const profile = path.join(os.tmpdir(), `pdf-toolbox-shot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const target = path.join(outDir, scene.file);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--window-size=${scene.width},${scene.height}`,
    // No --virtual-time-budget: the capture fires on the load event, and the
    // demo holds that event open until its documents are rendered (see
    // App.runDemo). Fast-forwarding the clock would defeat that.
    `--screenshot=${target}`,
    `http://localhost:${PORT}${scene.url}`,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(browser, args, { stdio: 'ignore' });
    // Some builds never reach the screenshot step and simply sit there, so the
    // capture is never allowed to block the run indefinitely.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 60000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await rm(profile, { recursive: true, force: true });

  try {
    const info = await stat(target);
    return info.size;
  } catch {
    return 0;
  }
}

await mkdir(outDir, { recursive: true });
await ensureSamples();

const browser = await findBrowser();
console.log(`capturing store assets with ${path.basename(browser)}`);

const server = await startServer();
try {
  for (const scene of SCENES) {
    const size = await capture(browser, scene);
    const kb = Math.round(size / 1024);
    console.log(size > 0
      ? `  ok   ${scene.file}  ${scene.width}x${scene.height}  ${kb} KB  — ${scene.caption}`
      : `  FAIL ${scene.file} — nothing was written`);
    if (size === 0) process.exitCode = 1;
  }
} finally {
  server.kill();
}

console.log(`\nassets in store-assets/ — screenshots are 1280x800, which is what the store expects`);
