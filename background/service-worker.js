/**
 * The extension has no popup on purpose — the whole product is the full-page
 * workspace. Clicking the toolbar icon focuses an already-open workspace tab if
 * there is one, otherwise it opens a fresh tab.
 */

import { reconcile } from '../app/core/intercept.js';

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

