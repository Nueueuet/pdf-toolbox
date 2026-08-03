/**
 * Drives the suite and renders the results.
 *
 * A separate file rather than an inline script, so the page works under the same
 * content security policy the extension runs with — inline scripts are refused
 * there, and a test page that cannot run under production rules is not testing
 * production.
 */
import { run } from './suite.js';

const list = document.getElementById('list');
const summary = document.getElementById('summary');

const results = await run((result) => {
  const item = document.createElement('li');
  item.className = result.ok ? 'ok' : 'fail';

  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = result.ok ? '✓' : '✕';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = result.name;

  const ms = document.createElement('span');
  ms.className = 'ms';
  ms.textContent = `${result.ms} ms`;

  if (!result.ok) {
    const error = document.createElement('span');
    error.className = 'err';
    error.textContent = result.error;
    name.appendChild(error);
  }

  item.append(mark, name, ms);
  list.appendChild(item);
});

const failed = results.filter((r) => !r.ok);
summary.textContent = failed.length
  ? `${failed.length} of ${results.length} tests failed`
  : `All ${results.length} tests passed`;
summary.style.color = failed.length ? '#dc2626' : '#16a34a';
window.__results = results;
