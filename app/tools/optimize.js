/** Compress and Upscale — the two tools that trade resolution against file size. */
import { h } from '../util/dom.js';
import { section, field, hint, button, primary, buttonRow, radioCards, checkbox, select } from '../ui/controls.js';
import { renderPageCanvas } from '../core/render.js';
import { buildPdf } from '../core/export.js';
import { saveFile } from '../core/download.js';
import { formatBytes, baseName } from '../util/format.js';
import { progressToast, toast } from '../ui/toast.js';
import { pageScope } from './organize.js';
import { upscaleCanvas, aiAvailable, aiScales, AI_MODEL_NOTE } from '../core/upscale.js';

const COMPRESS_LEVELS = [
  { value: 'light', label: 'Light', description: 'Barely visible change. Good for text documents you still want to print.', dpi: 200, quality: 0.88 },
  { value: 'balanced', label: 'Balanced', description: 'The usual choice — screen-sharp, much smaller.', dpi: 150, quality: 0.76 },
  { value: 'strong', label: 'Strong', description: 'Noticeably softer images, fine for reading on screen.', dpi: 110, quality: 0.6 },
  { value: 'maximum', label: 'Maximum', description: 'Smallest possible file. Expect visible artefacts.', dpi: 72, quality: 0.45 },
];

/**
 * Estimates the compressed size by actually encoding a few pages at the target
 * settings and extrapolating. Slower than a formula, but it does not lie.
 */
async function estimateSize(ws, level, sampleCount = 3) {
  const pages = ws.pages;
  if (pages.length === 0) return 0;

  const step = Math.max(1, Math.floor(pages.length / sampleCount));
  const samples = [];
  for (let i = 0; i < pages.length && samples.length < sampleCount; i += step) samples.push(pages[i]);

  let total = 0;
  for (const page of samples) {
    const { canvas } = await renderPageCanvas(ws, page, { scale: level.dpi / 72 });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', level.quality));
    total += blob.size;
  }
  const perPage = total / samples.length;
  // ~4 KB of object overhead per page, plus a small fixed document header.
  return Math.round(perPage * pages.length + pages.length * 4096 + 2048);
}

const compress = {
  id: 'compress',
  label: 'Compress',
  group: 'Optimise',
  mode: 'any',
  icon: 'M4 14h6v6 M20 10h-6V4 M14 10l7-7 M3 21l7-7',
  blurb: 'Shrink the file by re-encoding pages as images. Every level shows what you would actually get.',
  panel(ctx) {
    const currentSize = h('span.stat__value', '—');
    const cards = radioCards({
      value: 'balanced',
      options: COMPRESS_LEVELS.map((level) => ({
        value: level.value,
        label: level.label,
        description: level.description,
        meta: '…',
      })),
    });

    const warning = h('p.hint.hint--warn');
    let estimates = new Map();
    let estimateRun = 0;

    const refreshEstimates = async () => {
      const run = ++estimateRun;
      const original = [...ctx.ws.sources.values()].reduce((sum, s) => sum + (s.size ?? 0), 0);
      currentSize.textContent = original ? formatBytes(original) : '—';
      warning.textContent = '';

      for (const level of COMPRESS_LEVELS) cards.setMeta(level.value, '…');
      estimates = new Map();
      for (const level of COMPRESS_LEVELS) {
        if (run !== estimateRun) return;
        try {
          const size = await estimateSize(ctx.ws, level);
          if (run !== estimateRun) return;
          estimates.set(level.value, size);
          const saved = original ? Math.round((1 - size / original) * 100) : null;
          cards.setMeta(
            level.value,
            saved == null ? formatBytes(size)
              : saved > 0 ? `${formatBytes(size)} · −${saved}%`
                : `${formatBytes(size)} · +${Math.abs(saved)}%`,
          );
        } catch (err) {
          console.error('estimate failed', err);
          cards.setMeta(level.value, '—');
        }
      }

      // Rasterising a document that is mostly text and vector art costs more
      // bytes than it saves. Say so rather than promising a saving.
      const best = Math.min(...[...estimates.values()]);
      if (original && Number.isFinite(best) && best >= original) {
        warning.textContent = 'This document is already smaller than any compressed version would be — '
          + 'it is mostly text and vector graphics, which have nothing to squeeze out. Compressing it here '
          + 'would make the file larger and the text unselectable.';
      }
    };

    if (ctx.ws.pageCount) refreshEstimates();
    ctx.onClose(ctx.ws.on('pages', refreshEstimates));

    const run = async () => {
      const level = COMPRESS_LEVELS.find((l) => l.value === cards.value);
      const progress = progressToast('Compressing…');
      try {
        const bytes = await buildPdf(ctx.ws, ctx.ws.pages, {
          forceRaster: true,
          rasterDpi: level.dpi,
          rasterMime: 'image/jpeg',
          jpegQuality: level.quality,
          title: ctx.ws.name,
          onProgress: (fraction, message) => progress.update(fraction, message),
        });
        await saveFile(bytes, `${baseName(ctx.ws.name)} compressed.pdf`);
        progress.done(`Saved — ${formatBytes(bytes.length)}`);
      } catch (err) {
        console.error(err);
        progress.fail(`Compression failed: ${err.message}`);
      }
    };

    return h('div',
      section('Current size', h('div.stat', h('span.stat__label', 'Imported files'), currentSize)),
      section('Level', cards, hint('Estimates come from encoding a sample of your pages, not a rule of thumb.'), warning),
      section(null,
        buttonRow(primary('Compress & save', { onclick: run }), button('Re-estimate', { onclick: refreshEstimates })),
        hint('Compressing turns pages into images, so text stops being selectable. The original stays untouched in the workspace.'),
      ),
    );
  },
};

// ----------------------------------------------------------------- upscale

const UPSCALE_MODES = [
  {
    value: 'render',
    label: 'Re-render sharper',
    description: 'Redraws the page at a higher resolution. Instant, and ideal when the page has real text or vector art.',
  },
  {
    value: 'ai',
    label: 'AI super-resolution',
    description: 'Runs an ESRGAN model over each page. Best for scans and photos, where there is no vector art to redraw.',
  },
];

const upscale = {
  id: 'upscale',
  label: 'Upscale',
  group: 'Optimise',
  mode: 'any',
  icon: 'M3 8V5a2 2 0 0 1 2-2h3 M16 3h3a2 2 0 0 1 2 2v3 M21 16v3a2 2 0 0 1-2 2h-3 M8 21H5a2 2 0 0 1-2-2v-3 M9 12h6 M12 9v6',
  blurb: 'Increase the resolution of pages. Choose the fast renderer for documents, the AI model for scans.',
  panel(ctx) {
    const scope = pageScope(ctx);
    const modes = radioCards({
      value: 'render',
      options: UPSCALE_MODES.map((mode) => ({ ...mode, meta: '' })),
    });
    const factor = select({
      value: '2',
      options: [
        { value: '2', label: '2× (150 → 300 dpi)' },
        { value: '3', label: '3× (150 → 450 dpi)' },
        { value: '4', label: '4× (150 → 600 dpi)' },
      ],
    });
    const sharpen = checkbox({ label: 'Sharpen after upscaling', checked: true });
    const status = h('p.hint');

    const RENDER_SCALES = [
      { value: '2', label: '2× (150 → 300 dpi)' },
      { value: '3', label: '3× (150 → 450 dpi)' },
      { value: '4', label: '4× (150 → 600 dpi)' },
    ];
    let available = false;
    let aiFactors = [];

    // The AI models are per-factor, so the scale list has to follow the mode.
    const syncFactors = () => {
      const wanted = factor.value;
      const options = modes.value === 'ai'
        ? aiFactors.map((n) => ({ value: String(n), label: `${n}× (ESRGAN model)` }))
        : RENDER_SCALES;
      factor.replaceChildren(...options.map((opt) => {
        const el = document.createElement('option');
        el.value = opt.value;
        el.textContent = opt.label;
        return el;
      }));
      factor.value = options.some((o) => o.value === wanted) ? wanted : options[0]?.value ?? '2';
    };

    const syncAvailability = async () => {
      available = await aiAvailable();
      aiFactors = available ? await aiScales() : [];
      modes.setMeta('ai', available ? `${aiFactors.join('×, ')}× ready` : 'not installed');
      modes.querySelector('input[value="ai"]').disabled = !available;
      status.textContent = available ? '' : AI_MODEL_NOTE;
      if (!available && modes.value === 'ai') modes.value = 'render';
      syncFactors();
    };
    modes.addEventListener('change', syncFactors);
    syncAvailability();

    const run = async () => {
      const pages = scope.resolve();
      if (!pages) return;
      if (pages.length === 0) return toast('No pages matched', { tone: 'error' });

      const mode = modes.value;
      const scaleFactor = Number(factor.value);
      const progress = progressToast('Upscaling…');
      try {
        const results = [];
        for (const [index, page] of pages.entries()) {
          progress.update(index / pages.length, `Page ${index + 1} of ${pages.length}`);
          // Render at the base resolution first; the upscaler works from there,
          // which is what makes the AI path meaningful for scanned input.
          const { canvas } = await renderPageCanvas(ctx.ws, page, { scale: 150 / 72 });
          const output = await upscaleCanvas(canvas, {
            mode,
            factor: scaleFactor,
            sharpen: sharpen.checked,
            onProgress: (f) => progress.update((index + f) / pages.length, `Page ${index + 1} of ${pages.length}`),
          });
          const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
          results.push({ page, blob, width: output.width, height: output.height });
        }

        ctx.commit(`Upscale ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`, () => {
          for (const { page, blob, width, height } of results) {
            if (page.rasterId) ctx.ws.releaseRaster(page.rasterId);
            page.rasterId = ctx.ws.putRaster({ blob, url: URL.createObjectURL(blob), width, height, mime: 'image/png' });
            page.meta.upscaled = `${mode} ${scaleFactor}×`;
          }
        });
        progress.done(`Upscaled ${results.length} ${results.length === 1 ? 'page' : 'pages'}`);
      } catch (err) {
        console.error(err);
        progress.fail(`Upscale failed: ${err.message}`);
      }
    };

    const revert = () => {
      const pages = scope.resolve();
      if (!pages) return;
      ctx.commit('Undo upscale', () => {
        for (const page of pages) {
          if (page.rasterId) ctx.ws.releaseRaster(page.rasterId);
          page.rasterId = null;
          delete page.meta.upscaled;
        }
      });
    };

    return h('div',
      section('Pages', scope.el),
      section('Method', modes, status),
      section('Amount', field('Scale', factor), sharpen),
      section(null,
        buttonRow(primary('Upscale', { onclick: run }), button('Revert', { onclick: revert })),
        hint('Upscaled pages are stored as images, which makes the file larger and the text unselectable.'),
      ),
    );
  },
};

export default [compress, upscale];
