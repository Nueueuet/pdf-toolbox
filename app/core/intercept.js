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
import * as storage from './storage.js';

const SETTING_KEY = 'intercept-pdfs';
const ERROR_KEY = 'intercept-error';
const RULE_ID = 1;

/** Sites the redirect may act on. */
export const ORIGINS = ['http://*/*', 'https://*/*'];

/**
 * Local files, asked for separately.
 *
 * The switch on the browser's extensions page does not grant this — it only
 * makes it grantable. Without asking as well, the extension holds no access to
 * `file://` at all, and then neither mechanism can touch a local PDF: a rule
 * only acts where there is access, and a tab's address stays hidden from an
 * extension that has none. That is why local files never worked, on any machine,
 * however the switch was set.
 *
 * Asked for on its own so that a refusal costs only local files rather than the
 * whole feature.
 */
export const FILE_ORIGIN = 'file:///*';

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

/**
 * Whether this browser can do it at all — false on the dev server.
 *
 * Asked each time rather than settled at import: what is on offer here depends
 * on the page this runs in, not on when the module happened to load.
 */
export function supported() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
  return Boolean(chrome.declarativeNetRequest?.updateDynamicRules)
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
  if (typeof chrome === 'undefined' || !chrome.extension?.isAllowedFileSchemeAccess) return false;
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

/**
 * The one rule.
 *
 * The redirect target has to be listed in the manifest's
 * `web_accessible_resources`, or the redirect fails and the browser opens the
 * PDF itself as though no rule existed — silently, which is a miserable thing to
 * debug.
 *
 * `file://` is always in the pattern rather than only when file access happens
 * to be granted. Whether that access exists is decided by a switch on the
 * browser's own extensions page, which this code is never told about, so a rule
 * built around what was true at the time would go stale the moment the switch
 * moved. A rule covering an address the extension has no access to simply does
 * not act, which is exactly the wanted behaviour anyway.
 */
function rules() {
  const target = `${chrome.runtime.getURL('app/index.html')}?${OPEN_PARAM}\\0`;
  return [{
    id: RULE_ID,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: target } },
    condition: {
      // Address-based, because a redirect happens before there is a response to
      // read a content type from. A PDF served from an address that does not say
      // ".pdf" therefore goes to the browser's viewer as before.
      regexFilter: '^(https?|file)://.*\\.pdf($|\\?)',
      resourceTypes: ['main_frame'],
      isUrlFilterCaseSensitive: false,
    },
  }];
}

/**
 * @returns {Promise<string|null>} the browser's complaint, or null if it took it.
 *
 * The error is handed back rather than thrown because the one thing worse than a
 * refused rule is a refused rule nobody hears about: the symptom is that PDFs
 * carry on opening in the browser's own viewer, which looks exactly like a
 * feature that was never switched on.
 */
async function install() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: rules(),
    });
    await storage.set(ERROR_KEY, null);
    return null;
  } catch (err) {
    const message = err?.message ?? String(err);
    await storage.set(ERROR_KEY, message);
    console.error('the browser refused the redirect rule', err);
    return message;
  }
}

export function lastError() {
  return storage.get(ERROR_KEY, null);
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

  /*
   * Recorded before asking, not after.
   *
   * Granting fires permissions.onAdded, which sends the background worker into
   * reconcile() — and reconcile() decides what to do by reading this very
   * setting. Left until afterwards, it would still say "off" at that moment, and
   * the reconcile would tear down the rule this call is in the middle of
   * installing. That race is not theoretical: it left the feature switched on
   * with no rule behind it, every single time.
   */
  await storage.set(SETTING_KEY, true);

  // Local files are worth asking for in the same breath, but only where the
  // browser could say yes: with its file switch off the request is refused, and
  // refused together with the web access it was bundled with.
  const wanted = await fileAccess() ? [...ORIGINS, FILE_ORIGIN] : ORIGINS;

  /*
   * Asking can fail outright rather than merely being refused — a manifest whose
   * optional permissions the browser did not accept is the usual reason, and it
   * throws instead of answering false. Left uncaught that is a switch which does
   * nothing at all and says nothing either.
   */
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: wanted });
    // Bundled with file access and turned down: the web half is worth having on
    // its own, so ask again without it rather than leaving with nothing.
    if (!granted && wanted.length > ORIGINS.length) {
      granted = await chrome.permissions.request({ origins: ORIGINS });
    }
  } catch (err) {
    const message = err?.message ?? String(err);
    await storage.set(SETTING_KEY, false);
    await storage.set(ERROR_KEY, message);
    console.error('the browser refused to ask for site access', err);
    return { ok: false, reason: 'refused', error: message };
  }

  if (!granted) {
    await storage.set(SETTING_KEY, false);
    return { ok: false, reason: 'denied' };
  }

  const error = await install();
  return error ? { ok: false, reason: 'refused', error } : { ok: true };
}

/** Puts the rule back after a failure, without going through the permission again. */
export async function repair() {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  if (!await hasAccess()) return { ok: false, reason: 'denied' };
  await storage.set(SETTING_KEY, true);
  const error = await install();
  return error ? { ok: false, reason: 'refused', error } : { ok: true };
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
  const wanted = Boolean(await storage.get(SETTING_KEY, false)) && await hasAccess();

  /*
   * Only written when it actually differs.
   *
   * This runs on every browser start, and rewriting the rule set makes the
   * browser re-index it — work done during the busiest moment there is, for no
   * change at all. Reading first is far cheaper than writing.
   */
  const installed = await chrome.declarativeNetRequest.getDynamicRules();
  const present = installed.some((rule) => rule.id === RULE_ID);
  if (wanted === present) return;

  if (wanted) await install();
  else await uninstall();
}

/**
 * What the browser actually has installed, for the settings dialog to show.
 *
 * Worth surfacing rather than assuming: a rule can be rejected — a redirect
 * target that is not web accessible is the classic way — and the only sign of it
 * otherwise is that PDFs quietly keep opening in the browser's own viewer.
 */
export async function diagnose() {
  if (!supported()) return { supported: false };

  const [installed, access, files, error, granted] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules().catch((err) => ({ err })),
    hasAccess(),
    fileAccess(),
    lastError(),
    // Optional chaining, not just a catch: a browser without it throws on the
    // call itself, and a diagnostic that crashes is worse than a missing line.
    chrome.permissions.getAll?.().catch(() => null) ?? null,
  ]);

  const rules = Array.isArray(installed) ? installed : [];
  return {
    supported: true,
    version: chrome.runtime.getManifest?.().version ?? null,
    id: chrome.runtime.id,
    wanted: Boolean(await storage.get(SETTING_KEY, false)),
    access,
    files,
    grantedOrigins: granted?.origins ?? null,
    // The switch on the extensions page and an actual grant are two different
    // things, and only the second one lets anything touch a local file.
    fileOriginGranted: Boolean(granted?.origins?.some((o) => o.startsWith('file://'))),
    ruleInstalled: rules.some((rule) => rule.id === RULE_ID),
    ruleCount: rules.length,
    rule: rules.find((rule) => rule.id === RULE_ID) ?? null,
    rulesError: installed?.err ? String(installed.err.message ?? installed.err) : null,
    error,
    target: chrome.runtime.getURL('app/index.html'),
  };
}

/** The same thing as text, for pasting into a bug report. */
export async function diagnosticReport() {
  const state = await diagnose();
  return JSON.stringify(state, null, 2);
}

/**
 * Whether an address is one this feature is meant to take over.
 *
 * The same judgement the redirect rule makes, written once so the rule and the
 * fallback below it cannot drift apart.
 */
export function looksLikePdf(url) {
  return /^(https?|file):\/\/.*\.pdf($|\?)/i.test(url);
}

/** Where such an address gets handed to. */
export function workspaceFor(url) {
  return `${chrome.runtime.getURL('app/index.html')}?${OPEN_PARAM}${url}`;
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
