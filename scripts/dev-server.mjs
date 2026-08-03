/**
 * Static server for iterating on the workspace without reloading the extension.
 *
 * Everything except `chrome.*` behaves identically here, which covers the whole
 * editing pipeline. URL -> PDF is the one feature that genuinely needs the
 * extension, and it says so in the UI.
 *
 *   node scripts/dev-server.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5175);

/**
 * The extension's own content security policy is applied by default.
 *
 * A permissive dev server hides exactly the bugs that only appear once
 * installed — code that evaluates strings, an inline script, a library that
 * needs a sandbox. All of those cost an afternoon each when they surface in
 * somebody else's browser instead of here. `--no-csp` opts out.
 */
const enforceCsp = !process.argv.includes('--no-csp');
const POLICIES = JSON.parse(
  await readFile(path.join(root, 'manifest.json'), 'utf8'),
).content_security_policy ?? {};
const EXTENSION_CSP = POLICIES.extension_pages ?? '';
/*
 * The sandbox has its own, looser policy in the real extension — dropping the
 * `sandbox` token, which only makes sense in a manifest, not in a header.
 */
const SANDBOX_CSP = (POLICIES.sandbox ?? '').replace(/^\s*sandbox[^;]*;\s*/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    /*
     * Used only by the screenshot script. A headless capture runs with
     * --virtual-time-budget, which fast-forwards timers but pauses the virtual
     * clock while a network request is outstanding. Holding one request open is
     * therefore the only reliable way to grant real wall-clock time for
     * thumbnails to finish rendering before the shot is taken.
     */
    if (url.pathname === '/__wait') {
      const ms = Math.min(20000, Math.max(0, Number(url.searchParams.get('ms')) || 0));
      await new Promise((resolve) => setTimeout(resolve, ms));
      res.writeHead(204).end();
      return;
    }

    let filePath = path.join(root, decodeURIComponent(url.pathname));

    if (url.pathname === '/') filePath = path.join(root, 'app', 'index.html');

    // Keep requests inside the project.
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!info) {
      res.writeHead(404).end('Not found');
      return;
    }

    const body = await readFile(filePath);
    const headers = {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (enforceCsp) {
      const inSandbox = url.pathname.startsWith('/sandbox/');
      const policy = inSandbox ? SANDBOX_CSP : EXTENSION_CSP;
      if (policy) headers['Content-Security-Policy'] = policy;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err?.message ?? err));
  }
}).listen(port, () => {
  console.log(`PDF Toolbox dev server: http://localhost:${port}/`);
  if (enforceCsp) console.log(`  enforcing the extension policy: ${EXTENSION_CSP}`);
});
