/** Persisted settings and saved stamps. Falls back to localStorage off-extension. */
import { IN_EXTENSION } from './paths.js';

const PREFIX = 'pdf-toolbox:';

export async function get(key, fallback = null) {
  if (IN_EXTENSION && chrome.storage?.local) {
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
  if (IN_EXTENSION && chrome.storage?.local) {
    await chrome.storage.local.set({ [PREFIX + key]: value });
    return;
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.warn('could not persist', key, err);
  }
}
