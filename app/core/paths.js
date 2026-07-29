/**
 * Resolves a repo-root-relative asset path.
 *
 * Inside the extension `chrome.runtime.getURL` gives the chrome-extension://
 * origin. The same files are also served by `npm run dev` for quick iteration in
 * a normal tab, where that API does not exist — hence the fallback.
 */
const ROOT = new URL('../../', import.meta.url).href;

export function assetUrl(path) {
  const clean = String(path).replace(/^\.?\//, '');
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(clean);
  }
  return ROOT + clean;
}

export const IN_EXTENSION = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
