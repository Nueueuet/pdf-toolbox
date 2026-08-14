/*
 * Starts fetching a handed-over PDF before anything else runs.
 *
 * A classic script on purpose, and placed above the module tag: classic scripts
 * execute as soon as they arrive, whereas a module waits for the whole graph it
 * belongs to — a megabyte and a half of PDF library among it — to be downloaded
 * and evaluated first. Everything this file does is therefore already under way
 * while that is still happening, which on a slow machine is most of the wait.
 *
 * It deliberately knows almost nothing: the parameter name, and how to ask for
 * a file. The app picks the promise up from here and does the rest.
 */
(function startHandover() {
  var PARAM = 'open=';
  var at = location.search.indexOf(PARAM);
  if (at === -1) return;

  // Everything after `open=` is the original address, verbatim — a PDF address
  // carrying its own query would be cut short by anything that parses fields.
  var url = location.search.slice(at + PARAM.length);
  if (!/^(https?|file):\/\//i.test(url)) return;

  var promise = fetch(url, { credentials: 'include' });
  // Nobody is waiting yet, and a rejection with no listener is reported as an
  // unhandled error. The app attaches the real handling when it gets here.
  promise.catch(function ignore() {});

  window.__pdfToolboxHandover = { url: url, response: promise };
})();
