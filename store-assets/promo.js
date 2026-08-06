/*
 * Its own file rather than an inline script: the dev server sends the
 * extension's content security policy, which forbids inline script — and when
 * this was inline it was silently blocked, so the tiles were captured unstyled.
 */
const size = new URLSearchParams(location.search).get('size') || 'large';
document.body.dataset.size = size;
document.documentElement.dataset.demoReady = 'true';
