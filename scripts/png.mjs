/**
 * Just enough PNG to crop a screenshot, with no dependencies.
 *
 * A headless browser writes an image the size of the *window* while laying the
 * page out in something slightly smaller, so captures come out with a dead band
 * along the bottom. Cropping it off needs real pixels, and pulling in an image
 * library for one rectangle would be a poor trade — this is a few dozen lines.
 *
 * Only what Chromium actually writes is handled: 8 bits per channel, no
 * interlacing, no palette. Anything else throws rather than guessing.
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @returns {{ width: number, height: number, channels: number, pixels: Buffer }} */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let header = null;
  const parts = [];
  let at = 8;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (!header) throw new Error('PNG has no header');
  if (header.depth !== 8) throw new Error(`unsupported bit depth ${header.depth}`);
  if (header.interlace !== 0) throw new Error('interlaced PNGs are not handled');

  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`unsupported colour type ${header.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);

  // Undo the per-row filters. Each row is preceded by its filter byte, and the
  // predictors refer to the pixel to the left (a), above (b) and above-left (c).
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: value += paeth(a, b, c); break;
        default: throw new Error(`unknown row filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }

  return { width: header.width, height: header.height, channels, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function encodePng({ width, height, channels, pixels }) {
  const colorType = Number(Object.keys(CHANNELS).find((key) => CHANNELS[key] === channels));
  const stride = width * channels;

  // Written unfiltered: these are screenshots kept on disk for one upload, not
  // something worth spending a filter search on.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Keeps the top-left width x height of an image. */
export function cropPng(file, width, height) {
  const image = decodePng(file);
  if (image.width === width && image.height === height) return file;
  if (image.width < width || image.height < height) {
    throw new Error(`cannot crop ${image.width}x${image.height} up to ${width}x${height}`);
  }

  const stride = width * image.channels;
  const source = image.width * image.channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    image.pixels.copy(pixels, y * stride, y * source, y * source + stride);
  }
  return encodePng({ width, height, channels: image.channels, pixels });
}

/**
 * Height of the dead band a capture ends with, in pixels.
 *
 * Headless lays the page out a little shorter than the window it writes, leaving
 * a strip of nothing but page background along the bottom. That strip is the one
 * part of the picture that is a single flat colour clear across its width — the
 * interface never is, with a white rail down one side and a white panel down the
 * other — so counting those rows up from the bottom measures it exactly, without
 * having to know what any particular browser reserves.
 */
export function uniformTail(file) {
  const { width, height, channels, pixels } = decodePng(file);
  const row = (y) => y * width * channels;
  const same = (a, b) => pixels[a] === pixels[b]
    && pixels[a + 1] === pixels[b + 1]
    && pixels[a + 2] === pixels[b + 2];

  const reference = row(height - 1);
  let count = 0;
  for (let y = height - 1; y >= 0; y--) {
    let flat = true;
    for (let x = 0; x < width; x += 8) {
      if (!same(row(y) + x * channels, reference)) { flat = false; break; }
    }
    if (!flat) break;
    count++;
  }
  // An image that is flat all the way up tells us nothing; treat it as no band.
  return count === height ? 0 : count;
}
