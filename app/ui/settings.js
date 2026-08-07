/**
 * The settings dialog.
 *
 * One switch so far, and the one that matters most: whether PDFs on the web open
 * here instead of in the browser's own viewer. It is written to be read before
 * it is used — what access it takes, and that turning it off gives that access
 * straight back — because it is the only part of this extension that asks for
 * anything beyond the files you hand it yourself.
 */
import { h, clear } from '../util/dom.js';
import { modal } from './modal.js';
import { toast } from './toast.js';
import * as intercept from '../core/intercept.js';

export function settingsDialog() {
  return modal({
    title: 'Settings',
    width: 520,
    render: () => {
      const body = h('div.settings');
      renderInterception(body);
      return body;
    },
  });
}

async function renderInterception(body) {
  const section = h('section.settings__section');
  clear(body).append(section);

  if (!intercept.supported()) {
    section.append(
      h('h3.settings__title', 'Open PDFs in PDF Toolbox'),
      h('p.settings__text',
        'Only available once the extension is installed in the browser. '
        + 'On the development server there is nothing to intercept.'),
    );
    return;
  }

  const on = await intercept.isOn();
  const state = await intercept.diagnose();
  const files = state.files;

  const toggle = h('input', {
    type: 'checkbox',
    id: 'interceptToggle',
    checked: on,
    onchange: async (event) => {
      // Straight off the click: the browser refuses a permission request that
      // did not come from something the user just did.
      toggle.disabled = true;
      if (event.target.checked) {
        const result = await intercept.turnOn();
        if (!result.ok) {
          toast(result.reason === 'denied'
            ? 'Site access was not granted, so PDFs still open in the browser’s viewer.'
            : 'This browser cannot do that.', { tone: 'error', timeout: 7000 });
        } else {
          toast('PDFs on the web will now open here.', { tone: 'success' });
        }
      } else {
        await intercept.turnOff();
        toast('PDFs open in the browser’s viewer again, and site access has been given back.');
      }
      renderInterception(body);
    },
  });

  section.append(
    h('div.settings__row',
      h('label.switch', { for: 'interceptToggle' },
        toggle,
        h('span.switch__track', h('span.switch__knob')),
      ),
      h('div.settings__copy',
        h('h3.settings__title', h('label', { for: 'interceptToggle' }, 'Open PDFs in PDF Toolbox')),
        h('p.settings__text',
          'Clicking a PDF link takes it straight into this workspace instead of the '
          + 'browser’s viewer, ready to edit.'),
      ),
    ),
    h('div.settings__note',
      on
        ? h('p.settings__text',
          h('strong', 'Access granted. '),
          'The extension can now reach the sites you visit. It uses that for one '
          + 'thing: downloading the PDF you clicked, so it can be opened here. '
          + 'Nothing is sent anywhere, and no page is read.')
        : h('p.settings__text',
          h('strong', 'What this asks for: '),
          'permission to reach the sites you visit. It is needed to download the '
          + 'PDF itself, and it is the only thing in this extension that asks for '
          + 'anything of the sort. Nothing is sent anywhere — the file is fetched '
          + 'and opened on this machine, like every other document here.'),
      h('p.settings__text',
        on
          ? 'Switching this off takes that access away again, not just the redirect. '
            + 'The extension goes back to seeing nothing.'
          : 'Switching it off again takes the access away, not just the redirect, '
            + 'so the extension goes back to seeing nothing.'),
    ),
    // Shown only when it is meant to be working, and only when it is not: a
    // missing rule otherwise looks exactly like a feature that does nothing.
    on && !state.ruleInstalled
      ? h('div.settings__warn',
        h('p.settings__text',
          h('strong', 'Switched on, but no rule is installed. '),
          'Nothing is being intercepted.'),
        state.error
          ? h('p.settings__text', 'The browser said: ', h('code', state.error))
          : null,
        h('button.btn.btn--small', {
          type: 'button',
          onclick: async (event) => {
            event.target.disabled = true;
            const result = await intercept.repair();
            toast(result.ok ? 'The rule is in place now.' : `Still refused: ${result.error ?? result.reason}`,
              { tone: result.ok ? 'success' : 'error', timeout: 8000 });
            renderInterception(body);
          },
        }, 'Put it back'),
      )
      : null,
    h('details.settings__more',
      h('summary', 'What it will and will not catch'),
      h('ul.settings__list',
        h('li', 'Addresses ending in ', h('code', '.pdf'),
          ' — the redirect happens before the request is sent, so there is no '
          + 'content type to go by yet. A PDF served from an address that does '
          + 'not say so opens in the browser’s viewer as before.'),
        h('li', files
          ? h('span',
            h('strong', 'Local files: access is switched on. '),
            'Whether the browser actually lets a local PDF be handed over is its own '
            + 'decision — some builds keep file:// navigations to themselves. If one '
            + 'still opens in the built-in viewer, that is why, and there is nothing '
            + 'here that can change it.')
          : h('span',
            h('strong', 'Local files are not included. '),
            'Switch on “Allow access to file URLs” on this extension’s entry in the '
            + 'browser’s extensions page — only you can set that.')),
        h('li', 'PDFs inside a page — a preview embedded in a web page — are left alone.'),
      ),
    ),
  );
}
