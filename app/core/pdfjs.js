/** Single place where pdf.js is configured, so the worker path is set exactly once. */
import * as pdfjsLib from '../../vendor/pdf.mjs';
import { assetUrl } from './paths.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('vendor/pdf.worker.mjs');

const COMMON_OPTIONS = {
  cMapUrl: assetUrl('vendor/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('vendor/standard_fonts/'),
  // Rendering happens on canvases we own; no need for pdf.js to inject its own.
  isEvalSupported: false,
};

/**
 * Opens a PDF for rendering and text extraction.
 *
 * pdf.js neuters the ArrayBuffer it is handed, so callers must pass a copy they
 * are willing to lose — `Workspace.addFile` keeps the pristine bytes separately
 * for pdf-lib.
 *
 * @throws {PasswordException} when the file needs a password and none was given.
 */
export async function openDocument(bytes, { password } = {}) {
  const task = pdfjsLib.getDocument({ data: bytes, password, ...COMMON_OPTIONS });
  return task.promise;
}

export function isPasswordError(err) {
  return err?.name === 'PasswordException' || /password/i.test(err?.message ?? '');
}

export { pdfjsLib };
