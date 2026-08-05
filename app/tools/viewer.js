/**
 * Viewer: the tool you land in, because reading a document comes before
 * changing it.
 *
 * It owns no document state — the surface does the work. This panel only
 * exposes what to look at and how, and remembers those choices between
 * sessions, since a reading layout is a habit rather than a per-document
 * decision.
 */
import { h } from '../util/dom.js';
import { section, field, hint, button, buttonRow, select, radioCards } from '../ui/controls.js';
import * as storage from '../core/storage.js';

const SETTINGS_KEY = 'viewer';

export async function loadViewerSettings() {
  const saved = await storage.get(SETTINGS_KEY, {});
  const layouts = ['single', 'continuous', 'horizontal'];
  return {
    layout: layouts.includes(saved.layout) ? saved.layout : 'single',
    zoom: typeof saved.zoom === 'number' ? saved.zoom : null,
  };
}

export function saveViewerSettings(settings) {
  return storage.set(SETTINGS_KEY, settings);
}

const viewer = {
  id: 'viewer',
  label: 'Viewer',
  group: 'Read',
  mode: 'viewer',
  icon: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  blurb: 'Read the document. Zoom in, drag the page around, and scroll from one page to the next.',
  panel(ctx) {
    const view = ctx.app.viewer;

    const layout = radioCards({
      value: view.layout,
      options: [
        {
          value: 'single',
          label: 'One page at a time',
          description: 'The wheel turns the page once the whole sheet is visible.',
        },
        {
          value: 'continuous',
          label: 'Continuous, downwards',
          description: 'Pages stacked below one another; scrolling runs straight across the join.',
        },
        {
          value: 'horizontal',
          label: 'Side by side',
          description: 'Pages in a row, read left to right — the arrangement the page grid uses.',
        },
      ],
      onchange: (value) => {
        view.setLayout(value);
        ctx.app.persistViewerSettings();
      },
    });

    const zoomLevel = select({
      value: 'fit',
      options: [
        { value: 'fit', label: 'Fit the window' },
        { value: '0.5', label: '50%' },
        { value: '0.75', label: '75%' },
        { value: '1', label: '100%' },
        { value: '1.5', label: '150%' },
        { value: '2', label: '200%' },
        { value: '4', label: '400%' },
      ],
      onchange: (value) => {
        view.setZoom(value === 'fit' ? null : Number(value));
        ctx.app.persistViewerSettings();
      },
    });

    // Kept in step when the zoom is changed from the wheel or the keyboard.
    const syncZoom = (zoom, isFit) => {
      zoomLevel.value = isFit ? 'fit' : String(zoom);
      if (!isFit && zoomLevel.value !== String(zoom)) zoomLevel.value = 'fit';
      readout.textContent = `${Math.round(zoom * 100)}%`;
    };
    const readout = h('span.viewer__zoomvalue', '100%');
    ctx.app.onViewerZoom = syncZoom;
    ctx.onClose(() => { ctx.app.onViewerZoom = null; });
    syncZoom(view.effectiveZoom(), view.zoom === null);

    return h('div',
      section('Zoom',
        h('div.inline',
          button('−', { onclick: () => view.zoomBy(-1), title: 'Zoom out (minus key)' }),
          readout,
          button('+', { onclick: () => view.zoomBy(1), title: 'Zoom in (plus key)' }),
        ),
        field(null, zoomLevel),
        buttonRow(button('Fit the window', { onclick: () => { view.setZoom(null); ctx.app.persistViewerSettings(); } })),
      ),
      section('Page layout', layout,
        hint('Remembered for next time.'),
      ),
      section('Moving around',
        hint('Wheel scrolls · Shift and wheel moves sideways · hold the middle mouse button '
          + 'to drag the page · Ctrl and wheel zooms · arrow keys, Page Up and Page Down work '
          + 'too. Only the document moves — the toolbars stay put.'),
      ),
    );
  },
};

export default [viewer];
