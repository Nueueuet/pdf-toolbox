/**
 * Generates the extension icons as PNGs.
 *
 * There is no canvas in plain Node, so this rasterises a few signed-distance
 * shapes by hand and writes the PNG chunks directly. Keeps the repo free of an
 * image dependency and makes the icon easy to tweak.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'icons');

const SS = 4; // supersampling factor, gives us cheap anti-aliasing

/** Distance from point to a rounded rectangle; negative means inside. */
function roundedRectSdf(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Colour + alpha of the icon at a point in 0..1 space. */
function sample(u, v) {
  const BG_TOP = [56, 132, 255];
  const BG_BOTTOM = [29, 78, 216];
  const tile = roundedRectSdf(u, v, 0.5, 0.5, 0.5, 0.5, 0.22);
  if (tile > 0) return [0, 0, 0, 0];

  let rgb = mix(BG_TOP, BG_BOTTOM, v);
  let alpha = 255;

  // Sheet of paper, with the top-right corner folded away.
  const sheet = roundedRectSdf(u, v, 0.5, 0.52, 0.19, 0.27, 0.035);
  const foldCut = u + v - 0.88; // half-plane slicing off the corner
  const folded = foldCut > 0 && v < 0.36;
  if (sheet < 0 && !folded) {
    rgb = [255, 255, 255];
    // Text lines on the sheet, left aligned with a ragged right edge.
    for (const [ly, right] of [[0.5, 0.66], [0.59, 0.62], [0.68, 0.66], [0.77, 0.55]]) {
      if (Math.abs(v - ly) < 0.019 && u > 0.35 && u < right) rgb = mix(BG_TOP, BG_BOTTOM, 0.55);
    }
  } else if (sheet < 0 && folded && foldCut < 0.05) {
    rgb = [186, 212, 255]; // shaded crease along the fold
  }

  return [rgb[0], rgb[1], rgb[2], alpha];
}

function renderRgba(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  await writeFile(file, encodePng(size, renderRgba(size)));
  console.log(`  ok  icons/icon${size}.png`);
}
