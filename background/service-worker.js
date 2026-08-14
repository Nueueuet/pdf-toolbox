/**
 * The extension has no popup on purpose — the whole product is the full-page
 * workspace. Clicking the toolbar icon focuses an already-open workspace tab if
 * there is one, otherwise it opens a fresh tab.
 */

import { reconcile, isOn, looksLikePdf, workspaceFor } from '../app/core/intercept.js';

const APP_URL = chrome.runtime.getURL('app/index.html');

async function openWorkspace() {
  const existing = await chrome.tabs.query({ url: `${APP_URL}*` });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  return chrome.tabs.create({ url: APP_URL });
}

chrome.action.onClicked.addListener(() => {
  openWorkspace();
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') openWorkspace();
  reconcile();
});

/*
 * The redirect rule survives a restart, but the site access behind it does not
 * have to: it can be taken away from the browser's own extensions page at any
 * time. Checking on every startup, and whenever permissions change, keeps the
 * two from drifting apart — a rule left behind without access would send a PDF
 * to a workspace that then cannot fetch it.
 */
chrome.runtime.onStartup.addListener(() => reconcile());
chrome.permissions.onAdded.addListener(() => reconcile());
chrome.permissions.onRemoved.addListener(() => reconcile());

/*
 * Second way in, for when the redirect rule is installed and correct and the
 * browser simply does not act on it.
 *
 * That is not hypothetical: on one machine the rule works, and on another with
 * the same extension, the same granted access and a rule that reads back
 * identically, PDFs carry on opening in the browser's own viewer. Rather than
 * keep guessing at the difference, this watches for a tab arriving at a PDF and
 * sends it to the workspace itself.
 *
 * It needs no permission of its own: the address of a tab is visible to an
 * extension that already has access to that site, which is exactly the access
 * this feature asks for and nothing more. Where the rule does work this never
 * gets the chance to fire, because by then the tab is already on an
 * extension address, which is not a PDF.
 */
const handled = new Map(); // tab id -> the address already sent onward

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const url = changeInfo.url;
  if (!url || !looksLikePdf(url)) return;
  // Going back to a page we already took over must not bounce it again.
  if (handled.get(tabId) === url) return;
  if (!await isOn()) return;

  handled.set(tabId, url);
  try {
    await chrome.tabs.update(tabId, { url: workspaceFor(url) });
  } catch (err) {
    handled.delete(tabId);
    console.warn('could not hand the document over', err);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => handled.delete(tabId));

