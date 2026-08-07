/**
 * Opening PDFs from the web in this workspace instead of the browser's viewer.
 *
 * Off by default, and deliberately so: it is the one feature here that needs
 * access to websites, which is exactly what the extension otherwise promises it
 * does not have. Turning it on asks for that access at that moment; turning it
 * off hands it straight back, so the extension returns to seeing nothing.
 *
 * How it works: a declarativeNetRequest rule redirects navigations to a `.pdf`
 * address to this app, before the request is sent. The browser never receives a
 * PDF, so its own viewer never comes into play, and the workspace fetches the
 * file itself.
 *
 * Why `declarativeNetRequestWithHostAccess` rather than plain
 * `declarativeNetRequest`: the plain one cannot be an optional permission (the
 * documented list of exclusions covers it), so it would have to be granted at
 * install time, for everyone, whether they want this or not. The host-access
 * variant only acts on sites the extension has been given access to — which is
 * nothing at all until the switch below is turned on.
 */
import { IN_EXTENSION } from './paths.js';
import * as storage from './storage.js';

const SETTING_KEY = 'intercept-pdfs';
const RULE_ID = 1;

/** Sites the redirect may act on. `file://` is not here — see fileAccess(). */
export const ORIGINS = ['http://*/*', 'https://*/*'];

/**
 * The address a PDF is handed over on.
 *
 * Everything after `open=` is the original address, verbatim and unescaped, so
 * it has to be read by slicing rather than with URLSearchParams: a PDF address
 * carrying its own query (`report.pdf?token=…&page=2`) would otherwise be cut
 * at the first `&`. Keeping it last and reading the remainder is exact.
 */
export const OPEN_PARAM = 'open=';

export function targetOf(search = location.search) {
  const at = search.indexOf(OPEN_PARAM);
  return at === -1 ? null : search.slice(at + OPEN_PARAM.length);
}

/** Whether this browser can do it at all — false on the dev server. */
export function supported() {
  return IN_EXTENSION
    && Boolean(chrome.declarativeNetRequest?.updateDynamicRules)
    && Boolean(chrome.permissions?.request);
}

export async function isOn() {
  if (!supported()) return false;
  // Both halves have to hold: the setting the user chose, and access still
  // being granted. Access can be taken away from the browser's own extensions
  // page without this app ever hearing about it.
  return Boolean(await storage.get(SETTING_KEY, false)) && await hasAccess();
}

export function hasAccess() {
  return chrome.permissions.contains({ origins: ORIGINS });
}

/**
 * Whether local files can be opened too.
 *
 * This one cannot be requested: it is the "Allow access to file URLs" switch on
 * the browser's own extensions page, and only the user can set it there.
 */
export async function fileAccess() {
  if (!IN_EXTENSION || !chrome.extension?.isAllowedFileSchemeAccess) return false;
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

function rules(allowFiles) {
  const target = `${chrome.runtime.getURL('app/index.html')}?${OPEN_PARAM}\\0`;
  const rule = {
    id: RULE_ID,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: target } },
    condition: {
      // Address-based, because a redirect happens before there is a response to
      // read a content type from. A PDF served from an address that does not say
      // ".pdf" therefore goes to the browser's viewer as before.
      regexFilter: allowFiles
        ? '^(https?|file)://.*\\.pdf($|\\?)'
        : '^https?://.*\\.pdf($|\\?)',
      resourceTypes: ['main_frame'],
      isUrlFilterCaseSensitive: false,
    },
  };
  return [rule];
}

async function install() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: rules(await fileAccess()),
  });
}

async function uninstall() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
}

/**
 * Turns it on, asking for website access first.
 *
 * Must be called straight from a click: the browser refuses a permission
 * request that did not come from something the user just did.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function turnOn() {
  if (!supported()) return { ok: false, reason: 'unsupported' };

  const granted = await chrome.permissions.request({ origins: ORIGINS });
  if (!granted) return { ok: false, reason: 'denied' };

  await install();
  await storage.set(SETTING_KEY, true);
  return { ok: true };
}

/** Turns it off and gives the access back. */
export async function turnOff({ keepAccess = false } = {}) {
  if (!supported()) return;
  await storage.set(SETTING_KEY, false);
  await uninstall();
  if (!keepAccess) {
    try {
      await chrome.permissions.remove({ origins: ORIGINS });
    } catch (err) {
      // Not fatal: the rule is gone either way, so nothing is being redirected.
      console.warn('could not hand back site access', err);
    }
  }
}

/**
 * Brings the rules back in line with the setting and the access actually held.
 *
 * Run at startup, and whenever permissions change. Dynamic rules outlive a
 * restart, so without this a permission revoked from the browser's extensions
 * page would leave a redirect in place that can no longer fetch anything.
 */
export async function reconcile() {
  if (!supported()) return;
  const wanted = Boolean(await storage.get(SETTING_KEY, false));
  if (wanted && await hasAccess()) await install();
  else await uninstall();
}

/** A sensible file name for a document fetched from an address. */
export function nameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    if (last) return last.toLowerCase().endsWith('.pdf') ? last : `${last}.pdf`;
  } catch {
    // Falls through to the generic name below.
  }
  return 'document.pdf';
}
