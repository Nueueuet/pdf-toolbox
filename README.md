# PDF Toolbox

A Chrome extension that opens a full PDF editing workspace in a new tab. Clicking
the toolbar icon opens the whole app — there is no popup, and there is no page
per tool: every tool acts on the same document in the same window.

Everything runs locally. No file is ever uploaded anywhere.

The layout is three columns: tools on the left, the page grid in the middle,
and the selected tool's options on the right.

## Install

```bash
npm run setup
```

That fetches the browser builds of pdf-lib, pdf.js and JSZip into `vendor/` and
generates the icons. There is **no build step and no `node_modules`** — the
libraries all ship self-contained browser bundles, and a Chrome MV3 extension can
only run local scripts anyway.

Then, in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick this folder
4. Click the PDF Toolbox icon

Optional — enable AI upscaling (adds ~4 MB of model files):

```bash
npm run vendor:ai
```

Optional — enable OCR (adds ~32 MB of runtime and model weights):

```bash
npm run vendor:ocr
```

## The tools

**Read**

| Tool | What it does |
| --- | --- |
| Viewer | Where a document opens. Zoom with the buttons, `+`/`−` or Ctrl and the wheel; move the page with the wheel, Shift and the wheel for sideways, a tilt wheel, or by holding the middle mouse button and dragging. Once the whole sheet fits, the wheel turns the page instead. Pages can be shown one at a time or stacked continuously, and that choice is remembered. Text stays selectable throughout. |

**Organise**

| Tool | What it does |
| --- | --- |
| Merge | Combine any number of PDFs and images into one document. Reorder by dragging pages, or right-click → *Move to position…* to type a page number. Select several pages first to move them as a block. Switch to the **Files** view to see one cover per file and drag whole files past each other. |
| Split | Cut the document at as many points as you like, all at once. **Click between two pages to add a cut, click the scissors to remove it, drag them to move it.** Open the Split tool and every possible cut position is shown faintly. Each part is saved as `<name> cut 1.pdf`, `<name> cut 2.pdf`, … , bundled into a zip when there are several. |
| Remove | Take pages out. They go to a **Removed pages** list in the panel and can be put back at their original position, individually or all at once. |
| Rotate | Quarter turns in either direction, or any angle, on all pages or a range. |
| Crop | Drag a frame on the page, then apply it to that page, a range, or everything. |

**Optimise**

| Tool | What it does |
| --- | --- |
| Compress | Four levels, each showing the size you would actually get — measured by encoding a sample of your own pages, not guessed from a formula. |
| Upscale | Two modes: **re-render** (redraws the page at 2–4× resolution; instant, and the right choice for text and vector art) and **AI** (an ESRGAN model, for scans and photos where there is nothing left to redraw). |

**Content**

| Tool | What it does |
| --- | --- |
| Write | Text boxes on the page. **Click into the middle to type or select text; drag the edge to move the box**, or the handles to resize it. Font, size, colour, bold/italic, alignment, box fill, border and rotation. **Highlighting applies to the text you selected**, not to the whole box. |
| Stamps | Save a styled text box and reuse it. An inserted stamp is an ordinary text box — editing it on the page does **not** change the saved stamp unless you explicitly save it again. |
| Watermark | Text across the middle, tiled, or along the footer, at any angle and opacity. Also removes watermarks again (see limitations). |
| Background | Replace the page background with a colour or make it transparent, on any range of pages. The threshold slider decides how dingy a scan's "white" is allowed to be. |

**Convert**

| Tool | What it does |
| --- | --- |
| Convert | PNG or JPG (one image per page, at 96–600 dpi) or CSV (text laid out as rows and columns). |
| Copy text | Select text straight off the pages and copy it, or copy everything at once. In the single-page editor text is always selectable; in the grid this tool turns it on, because Chrome switches selection off inside a draggable element — so selecting and reordering take turns. |
| OCR | Recognises the text in scanned pages. The words become selectable straight away — on the enlarged page, in the grid with **Copy text**, and in the saved file. Each page shows a status dot: green for recognised, amber for "this would help", grey for pages that already have real text. Click a dot to do one page, give a range in the panel, or open a page and recognise just that one. Cancelling keeps whatever finished. A switch colours what OCR added against what the PDF already had. |

**Security**

| Tool | What it does |
| --- | --- |
| Lock | Add a password and set permissions (printing, copying, editing, annotating), or save an unprotected copy of a file you opened with its password. |

Page ranges are accepted anywhere you see a page field: `all`, `1-10`,
`1,4,10`, `1`, and also `odd`, `even`, `last` and open ranges like `5-`.

## What it will not do

These are limits worth knowing before you rely on the tool, not bugs:

- **Watermarks baked into the page graphics cannot be removed.** *Remove mine*
  clears watermarks added in this workspace; *Strip embedded* removes PDF
  annotations, which is how many tools add theirs — but that also removes links,
  comments and form fields on those pages. A watermark painted into the page's
  content stream is indistinguishable from the rest of the drawing, and no tool
  can lift it out cleanly.
- **Compressing a text-only PDF makes it bigger.** Compression works by turning
  pages into images, and a page of text is far smaller as text. The panel
  measures this and says so rather than promising a saving it cannot deliver.
- **Some edits cost text selection.** Free-angle rotation, background changes,
  compression and upscaling re-draw the page as a bitmap. Merging, splitting,
  removing, quarter-turn rotation, cropping and text boxes all keep the page
  vector and the text selectable.
- **CSV extraction is a heuristic.** A PDF stores glyphs at coordinates, not
  tables; columns are recovered from the spacing. Check the result before relying
  on it. On a scan, run OCR first — there is no text to extract otherwise.
- **OCR is a guess, however good a one.** Roughly a second per page, and the
  result is what a model read, not what the page says. The inspection switch is
  there so you can check it rather than trust it.
- **Unlocking needs the password.** Removing a password means saving a copy of a
  file you were already able to open.
- **Text boxes use the 14 standard PDF fonts** (Helvetica, Times, Courier, with
  bold and italic). Characters outside Latin-1 are replaced rather than dropping
  the export.

## Publishing

```bash
npm run package
```

Builds `dist/pdf-toolbox-<version>.zip` for the Chrome Web Store — which Brave
installs from too. **[STORE.md](STORE.md)** has the listing copy, the permission
justifications reviewers ask for, and the steps. The submission itself needs a
Google account and a one-time \$5 developer fee, so that part is yours to do.

Every upload needs a higher `version` in `manifest.json` than the last one, and
each update goes through review again.

To keep an unpacked copy somewhere else in sync — a synced drive, so other
machines can load it without cloning — put that folder's absolute path in
`mirror.local.txt` (gitignored) or set `PDF_TOOLBOX_MIRROR`. `npm run package`
then refreshes it, and refuses to touch a folder that is neither empty nor a
previous build.

Until it is in the store, *Load unpacked* works on every machine and survives
restarts.

## Contributing

Issues and pull requests are welcome. Two things worth knowing before you change
anything that touches the page:

- **Run the tests** (`npm run dev`, then <http://localhost:5175/tests/>). They
  are round-trip tests for a reason — see below.
- **All coordinate maths lives in `app/core/geometry.js`.** If you find yourself
  writing a rotation or an offset anywhere else, that is the bug.

## Development

```bash
npm run dev      # serves the app at http://localhost:5175
npm run check    # verifies the manifest and every import resolves
```

The dev server sends the extension's own content security policy, so code that
only breaks once installed breaks here too. `--no-csp` turns that off.

That matters more than it sounds: OCR's image library evaluates strings as
JavaScript, which Manifest V3 forbids on an extension page and no setting can
permit. It runs in a sandboxed page for that reason — see `sandbox/`.

### Tests

```bash
npm run test-files   # generate sample PDFs
npm run dev
```

Then open <http://localhost:5175/tests/>.

The suite is deliberately made of round-trip tests: each case writes a real PDF,
reads it back with pdf.js, and compares it against the preview the user was
shown. Nearly every subtle bug in a PDF editor is a coordinate bug, and that is
the only way to catch them. The rotation sign error that made annotations land in
the wrong place on `/Rotate 90` pages — while looking perfectly fine at 0° and
180° — was found exactly this way.

## How it fits together

```
manifest.json          MV3 manifest; no popup, the icon opens app/index.html
background/            service worker: opens (or focuses) the workspace tab
sandbox/               the OCR engine, isolated because it needs eval
app/
  core/
    workspace.js       the document model every tool reads and writes
    geometry.js        display ↔ user space; all the rotation maths lives here
    render.js          page → canvas (thumbnails, previews, raster export)
    export.js          pages → PDF, vector where possible, raster where needed
    annots.js          text box layout, shared by the preview and the exporter
    fonts.js           metrics and line breaking, from pdf-lib's own font data
    upscale.js         re-render and ESRGAN upscaling
    text.js            text extraction for CSV
  ui/                  page grid, single-page editor, panel controls, modals
  tools/               one entry per tool in the left rail
vendor/                pdf-lib, pdf.js, JSZip (+ optional TensorFlow.js & model)
tests/                 round-trip test suite
```

The central idea is that a *page* is a cheap reference into a source file plus
the edits stacked on it — rotation, crop, annotations, an optional bitmap
override. Merge, split, remove and reorder are then just operations on one array,
which is why they compose instead of each needing its own pipeline, and why undo
only has to snapshot that array rather than any file bytes.

## Privacy

Nothing is uploaded, there is no account, and there is no analytics or
telemetry. See [PRIVACY.md](PRIVACY.md).

## Licence

MIT — see [LICENSE](LICENSE). The bundled libraries keep their own licences,
listed in [THIRD-PARTY.md](THIRD-PARTY.md).
