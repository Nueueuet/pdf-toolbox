/** Persisted settings and saved stamps. Falls back to localStorage off-extension. */

const PREFIX = 'pdf-toolbox:';

/** Asked each call, not settled at import, so it follows the page it runs in. */
function inExtension() {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

export async function get(key, fallback = null) {
  if (inExtension() && chrome.storage?.local) {
    const result = await chrome.storage.local.get(PREFIX + key);
    return result[PREFIX + key] ?? fallback;
  }
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function set(key, value) {
  if (inExtension() && chrome.storage?.local) {
    await chrome.storage.local.set({ [PREFIX + key]: value });
    return;
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.warn('could not persist', key, err);
  }
}
