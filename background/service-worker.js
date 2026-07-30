/**
 * The extension has no popup on purpose — the whole product is the full-page
 * workspace. Clicking the toolbar icon focuses an already-open workspace tab if
 * there is one, otherwise it opens a fresh tab.
 */

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
});

