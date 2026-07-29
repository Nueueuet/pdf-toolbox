/**
 * Saving results. Uses the downloads API when running as an extension (gives the
 * user a proper "Save as" and a real filename) and falls back to an anchor click
 * for the dev server.
 */
import { IN_EXTENSION } from './paths.js';

function toBlob(data, type = 'application/pdf') {
  if (data instanceof Blob) return data;
  return new Blob([data], { type });
}

export async function saveFile(data, filename, { type, saveAs = false } = {}) {
  const blob = toBlob(data, type);
  const url = URL.createObjectURL(blob);
  try {
    if (IN_EXTENSION && chrome.downloads?.download) {
      await chrome.downloads.download({ url, filename: sanitizeName(filename), saveAs });
      // The download reads the blob asynchronously, so the URL has to outlive
      // this call. A minute is far more than any local write needs.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeName(filename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * @param {{name: string, data: Blob|Uint8Array}[]} entries
 */
export async function saveZip(entries, filename) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('JSZip failed to load');
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(sanitizeName(entry.name), entry.data);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await saveFile(blob, filename, { type: 'application/zip' });
}

/**
 * Saves several files, either individually or bundled, based on how many there
 * are — a dozen separate download prompts is nobody's idea of a good time.
 */
export async function saveMany(entries, { zipName, zipThreshold = 3 } = {}) {
  if (entries.length === 0) return { zipped: false, count: 0 };
  if (entries.length < zipThreshold) {
    for (const entry of entries) await saveFile(entry.data, entry.name, { type: entry.type });
    return { zipped: false, count: entries.length };
  }
  await saveZip(entries, zipName);
  return { zipped: true, count: entries.length };
}

export function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}
