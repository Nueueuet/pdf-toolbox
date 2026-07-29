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

/**
 * URL -> PDF. Chrome can already print any page to PDF, but only through the
 * DevTools protocol, which a page-context script cannot reach. So the workspace
 * asks the service worker to do it: open the URL in a background tab, attach the
 * debugger, call Page.printToPDF, then clean up.
 */
async function urlToPdf({ url, options = {} }) {
  let tab;
  let attached = false;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id);

    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    attached = true;
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');

    const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.printToPDF', {
      printBackground: options.printBackground ?? true,
      landscape: options.landscape ?? false,
      scale: options.scale ?? 1,
      paperWidth: options.paperWidth ?? 8.27, // A4 in inches
      paperHeight: options.paperHeight ?? 11.69,
      marginTop: options.margin ?? 0.4,
      marginBottom: options.margin ?? 0.4,
      marginLeft: options.margin ?? 0.4,
      marginRight: options.margin ?? 0.4,
      transferMode: 'ReturnAsBase64',
    });

    return { ok: true, base64: result.data };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    if (attached && tab) {
      try {
        await chrome.debugger.detach({ tabId: tab.id });
      } catch {}
    }
    if (tab) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {}
    }
  }
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // A page that never fires `complete` (long-polling, video) is still worth
      // printing, so treat the timeout as "good enough" rather than an error.
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Give late-loading webfonts and images a moment to paint.
        setTimeout(resolve, 600);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab closed before it finished loading'));
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'url-to-pdf') {
    urlToPdf(message).then(sendResponse);
    return true; // keep the message channel open for the async reply
  }
  return false;
});
