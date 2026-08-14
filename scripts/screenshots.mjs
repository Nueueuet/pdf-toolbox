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
import { mkdir, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cropPng, uniformTail } from './png.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'store-assets');
const PORT = 5199;

/** The store's accepted screenshot size, and the two promo tile sizes. */
const SCENES = [
  /*
   * Order matters: the first is the one the store puts on the item's card, so
   * it leads with the thing nothing else in this category does offline — OCR —
   * followed by the viewer a document actually opens in.
   */
  {
    file: 'screenshot-1-ocr.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=ocr&files=report.pdf&scan=2,4&zoom=0.3&grid=1`,
    caption: 'OCR, showing which pages are scans and which already have text',
  },
  {
    file: 'screenshot-2-viewer.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=viewer&files=report.pdf&page=2&layout=single&nav=1`,
    caption: 'The viewer, with the page field and the arrows at the sides',
  },
  {
    /*
     * An ordinary document rather than the wide test sheet.
     *
     * The blueprint demonstrates the gain better — it goes from 28% to 49% of
     * its true size — but it is a synthetic file with LEFT EDGE and RIGHT EDGE
     * painted on it for the panning test, and that reads as a debugging artefact
     * on a store page. What this shot has to show is the interface getting out
     * of the way, and a real-looking document shows that honestly.
     */
    file: 'screenshot-3-reading.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=viewer&files=report.pdf&page=2&layout=continuous&compact=1`,
    caption: 'Reading mode: the panels collapsed, the tools down to their symbols',
  },
  {
    file: 'screenshot-4-merge.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=merge&zoom=0.3`,
    caption: 'Several files merged, pages reorderable by drag',
  },
  {
    file: 'screenshot-5-split.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=split&zoom=0.3&cuts=2,5`,
    caption: 'Split marks sitting between the pages',
  },
  {
    file: 'screenshot-6-write.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=write&files=report.pdf&annot=1`,
    caption: 'A text box being edited on the page',
  },
  {
    file: 'screenshot-7-compress.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=compress&files=report.pdf&zoom=0.28`,
    caption: 'Compression levels with measured output sizes',
  },
  {
    file: 'screenshot-8-copytext.png',
    width: 1280,
    height: 800,
    url: `/app/index.html?demo=copytext&zoom=0.3`,
    caption: 'Selecting text straight off the pages',
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

/**
 * Runs the browser once and leaves a PNG at `target`.
 *
 * `window` is what the browser is asked for; the page is usually laid out a
 * little shorter than that, which is what `reserve` accounts for.
 */
async function shoot(browser, url, target, window) {
  const profile = path.join(os.tmpdir(), `pdf-toolbox-shot-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--window-size=${window.width},${window.height}`,
    // No --virtual-time-budget: the capture fires on the load event, and the
    // demo holds that event open until its documents are rendered (see
    // App.runDemo). Fast-forwarding the clock would defeat that.
    `--screenshot=${target}`,
    url,
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
}

/**
 * How many pixels of the window the browser keeps to itself.
 *
 * The image is written at the window's size but the page is laid out shorter, so
 * a shot taken naively has a dead band along the bottom. Rather than hard-code
 * what this browser happens to reserve, paint a page that fills its own height
 * and see where it stops.
 */
/** Band height per window size, since it costs an extra capture to find out. */
const reserves = new Map();

async function capture(browser, scene) {
  const target = path.join(outDir, scene.file);
  const url = `http://localhost:${PORT}${scene.url}`;
  const key = `${scene.width}x${scene.height}`;
  let reserve = reserves.get(key) ?? null;

  await shoot(browser, url, target, {
    width: scene.width,
    height: scene.height + (reserve ?? 0),
  });

  try {
    // First time at this size: see how much of the picture the page left blank,
    // then take it again in a window that much taller and cut the band off. The
    // measurement holds for every later scene of the same size.
    if (reserve === null) {
      reserve = uniformTail(await readFile(target));
      reserves.set(key, reserve);
      if (reserve > 0) {
        await shoot(browser, url, target, { width: scene.width, height: scene.height + reserve });
      }
    }
    if (reserve > 0) {
      await writeFile(target, cropPng(await readFile(target), scene.width, scene.height));
    }
    const info = await stat(target);
    return info.size;
  } catch {
    return 0;
  }
}

await mkdir(outDir, { recursive: true });
await ensureSamples();

/*
 * Every capture is retaken from scratch, and anything left over from a previous
 * run goes. A screenshot showing an older tool rail is worse than no screenshot:
 * it advertises a layout the user will not find when they install it.
 */
for (const name of await readdir(outDir)) {
  if (name.endsWith('.png')) await rm(path.join(outDir, name));
}

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
  for (const [size, reserve] of reserves) {
    if (reserve) console.log(`  at ${size} the page fell ${reserve}px short of the window; that band was cropped off`);
  }
} finally {
  server.kill();
}

console.log(`\nassets in store-assets/ — screenshots are 1280x800, which is what the store expects`);
