/** Lock and unlock — adding or removing a PDF password. */
import { h, clear } from '../util/dom.js';
import { section, field, hint, button, primary, buttonRow, checkbox } from '../ui/controls.js';
import { buildPdf } from '../core/export.js';
import { saveFile } from '../core/download.js';
import { baseName } from '../util/format.js';
import { progressToast, toast } from '../ui/toast.js';

const protect = {
  id: 'protect',
  label: 'Lock',
  group: 'Security',
  mode: 'any',
  icon: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  blurb: 'Put a password on the file, or save a copy without one.',
  panel(ctx) {
    const userPassword = h('input.input', { type: 'password', placeholder: 'Password to open the file', autocomplete: 'new-password' });
    const confirmPassword = h('input.input', { type: 'password', placeholder: 'Repeat the password', autocomplete: 'new-password' });
    const ownerPassword = h('input.input', { type: 'password', placeholder: 'Optional — password to change permissions', autocomplete: 'new-password' });

    const allowPrinting = checkbox({ label: 'Allow printing', checked: true });
    const allowCopying = checkbox({ label: 'Allow copying text', checked: true });
    const allowModifying = checkbox({ label: 'Allow editing', checked: false });
    const allowAnnotating = checkbox({ label: 'Allow comments and form filling', checked: true });

    const status = h('div.statuslist');
    const renderStatus = () => {
      clear(status);
      const seen = new Map();
      for (const page of ctx.ws.pages) {
        const source = ctx.ws.source(page);
        if (source) seen.set(source.id, source);
      }
      if (seen.size === 0) {
        status.appendChild(hint('No files loaded.'));
        return;
      }
      for (const source of seen.values()) {
        const locked = Boolean(source.password);
        status.appendChild(h('div.filerow',
          h('span.filerow__name', { title: source.name }, source.name),
          h(`span.pill${locked ? '.pill--warn' : ''}`, locked ? 'was password protected' : 'not protected'),
        ));
      }
    };
    renderStatus();
    ctx.onClose(ctx.ws.on('pages', renderStatus));

    const lock = async () => {
      const password = userPassword.value;
      if (!password) return toast('Enter a password first', { tone: 'error' });
      if (password !== confirmPassword.value) return toast('The two passwords do not match', { tone: 'error' });

      const progress = progressToast('Encrypting…');
      try {
        const bytes = await buildPdf(ctx.ws, ctx.ws.pages, {
          ...ctx.app.exportOptions(),
          title: ctx.ws.name,
          password: {
            user: password,
            owner: ownerPassword.value || password,
            permissions: {
              printing: allowPrinting.checked ? 'highResolution' : undefined,
              copying: allowCopying.checked,
              modifying: allowModifying.checked,
              annotating: allowAnnotating.checked,
              fillingForms: allowAnnotating.checked,
              contentAccessibility: true,
              documentAssembly: allowModifying.checked,
            },
          },
          onProgress: (fraction, message) => progress.update(fraction, message),
        });
        await saveFile(bytes, `${baseName(ctx.ws.name)} protected.pdf`);
        progress.done('Saved with a password');
      } catch (err) {
        console.error(err);
        progress.fail(`Could not encrypt: ${err.message}`);
      }
    };

    const unlock = async () => {
      const progress = progressToast('Saving…');
      try {
        const bytes = await buildPdf(ctx.ws, ctx.ws.pages, {
          ...ctx.app.exportOptions(),
          title: ctx.ws.name,
          onProgress: (fraction, message) => progress.update(fraction, message),
        });
        await saveFile(bytes, `${baseName(ctx.ws.name)} unlocked.pdf`);
        progress.done('Saved without a password');
      } catch (err) {
        console.error(err);
        progress.fail(`Could not save: ${err.message}`);
      }
    };

    return h('div',
      section('Files', status,
        hint('A protected file asks for its password when you add it. Once it is open here, saving produces an unprotected copy.')),
      section('Add a password',
        field('Password', userPassword),
        field('Confirm', confirmPassword),
        field('Owner password', ownerPassword, 'Leave empty to reuse the password above.'),
        h('div.checkgrid', allowPrinting, allowCopying, allowModifying, allowAnnotating),
        buttonRow(primary('Protect & save', { onclick: lock })),
      ),
      section('Remove the password',
        buttonRow(button('Save without a password', { onclick: unlock })),
        hint('This only works for files you were able to open — it is not a way past a password you do not have.'),
      ),
    );
  },
};

export default [protect];
