# Publishing to the Chrome Web Store

Brave installs extensions straight from the Chrome Web Store, so publishing there
covers every one of your machines, Brave and Chrome alike.

**The submission itself has to be done by you.** It needs your Google account,
a one-time \$5 developer registration fee, and acceptance of the developer
agreement — none of which anyone else can do on your behalf. Everything up to
that point is prepared here.

## 1. Build the package

```bash
npm run vendor && npm run vendor:ai && npm run package
```

That writes `dist/pdf-toolbox-<version>.zip` (about 5.6 MB with the AI model,
1.5 MB without). Drop `npm run vendor:ai` if you would rather ship a smaller
extension without AI upscaling — the fast upscaler still works, and the tool
explains the option is unavailable.

## 2. Register as a developer, once

<https://chrome.google.com/webstore/devconsole>

- Sign in with a **personal** Google account. A Workspace account can be blocked
  from registering by its admin.
- Pay the one-time \$5 USD fee (card required). It covers the account, not the
  item, so you pay it once no matter how many extensions you publish.
- Under *Account*, set and verify a contact email. The dashboard refuses to
  submit anything until that is done.

## 3. Create the listing

**Upload** `dist/pdf-toolbox-<version>.zip` under *Add new item*.

Fill in the fields below — this is copy you can paste as is.

### Name

```
PDF Toolbox
```

### Short description (132 characters max)

```
Merge, split, compress, convert, crop, sign and edit PDFs in one window. Fully offline — your files never leave your computer.
```

### Detailed description

```
PDF Toolbox opens a complete PDF workspace in a new tab. Every tool works on the
same document in the same window — no jumping between pages, no re-uploading a
file for each step.

Everything runs on your own machine. No file is ever uploaded, there is no
account, and there is no analytics or telemetry of any kind.

ORGANISE
• Merge — combine PDFs and images, reorder by dragging, or type an exact page number
• Split — set as many cut points as you like and get one file per part
• Remove — take pages out, and put them back from a recoverable list
• Rotate — quarter turns or any angle, on any range of pages
• Crop — drag a frame and apply it to one page, a range, or all of them

OPTIMISE
• Compress — four levels, each showing the size you would actually get
• Upscale — redraw pages at higher resolution, or run an ESRGAN model over scans

EDIT
• Write — text boxes with font, size, colour, fill, border and rotation
• Highlight — mark the words you select, the way a word processor does
• Stamps — save a styled text block and reuse it anywhere
• Watermark — across the middle, tiled or in the footer, at any angle
• Background — replace or clear the page background

CONVERT
• PNG, JPG or CSV
• Copy text — select text straight off the pages, or copy whole pages at once

SECURITY
• Add a password and set permissions, or save an unprotected copy

Open source under the MIT licence.
```

### Category

`Productivity` → `Workflow & Planning`

### Privacy practices

This is the part reviewers actually read. Every field below is filled in in
English, because that is what the review team works in, even though the
dashboard itself may be in another language.

**Single purpose**

```
PDF Toolbox is a single-purpose PDF editing workspace that opens in its own tab.
Everything it does serves that one purpose: merging, splitting, removing,
reordering and rotating pages, cropping, compressing, upscaling, adding text,
stamps and watermarks, changing page backgrounds, converting pages to PNG, JPG
or CSV, and adding or removing a PDF password. All of it runs locally in the
tab. The extension has no content scripts, collects no data, and contacts no
server.
```

**Remote code: No.** Every library is bundled in the package, and the extension's
content security policy (`script-src 'self'`) blocks anything else from running.
Answering "yes" here is both wrong and a guaranteed trip through a much deeper
review.

**Data collected: none.** Leave every category unticked, then tick all three
confirmation boxes at the bottom — they are required to submit.

**Privacy policy URL**

```
https://github.com/Nueueuet/pdf-toolbox/blob/main/PRIVACY.md
```

### Permission justifications

Each field takes up to 1000 characters; these fit comfortably.

`storage`

```
Stores the user's saved stamps — reusable text blocks they create themselves —
plus small workspace preferences, using chrome.storage.local. This data stays on
the user's device, is never transmitted, and is removed with the extension.
```

`unlimitedStorage`

```
Documents being edited are held locally while the user works on them. A single
scanned or multi-hundred-page PDF easily exceeds the default storage quota,
which would make edits fail partway through a job. No data is transmitted; the
quota only affects what the extension may keep on the user's own device.
```

`downloads`

```
Saves the files the user produces: the edited PDF, the individual parts created
by the split tool, exported PNG or JPG images, and CSV files. The API is used
only to write these results to the user's own download folder under a meaningful
filename. Nothing is downloaded from the internet.
```

That is the complete list. The extension requests **no host permissions at all**,
which is worth pointing out in the listing: it cannot see any website you visit.

### Screenshots

You need at least one, at 1280×800 or 640×400. Good ones to take:

1. The page grid with several files merged, at 30% zoom
2. The Split tool with cut marks visible between pages
3. The Write tool with a text box selected on a page
4. The Compress tool showing the four estimated sizes

## 4. Submit

Review usually takes a few days. The extension asks only for `storage`,
`unlimitedStorage` and `downloads`, none of which are sensitive, so there is
nothing here that typically drags a review out.

## Until it is published

You can already use it everywhere by loading it unpacked:

`brave://extensions` → Developer mode → Load unpacked → pick this folder.

That works today on every machine you clone the repository to. It survives
restarts; it just shows a "developer mode extensions" notice on startup.
