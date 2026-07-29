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
• Write — text boxes with font, size, colour, highlight, fill, border and rotation
• Stamps — save a styled text block and reuse it anywhere
• Watermark — across the middle, tiled or in the footer, at any angle
• Background — replace or clear the page background

CONVERT
• PNG, JPG or CSV
• Turn any web page into a PDF

SECURITY
• Add a password and set permissions, or save an unprotected copy

Open source under the MIT licence.
```

### Category

`Productivity` → `Workflow & Planning`

### Privacy practices

This is the part reviewers read closely. Answer it like this:

- **Single purpose**: *Editing PDF files locally in the browser.*
- **Data collected**: none. Tick nothing.
- **Remote code**: **No.** Every library is bundled in the package; the content
  security policy blocks external scripts.
- **Privacy policy URL**:

  ```
  https://github.com/Nueueuet/pdf-toolbox/blob/main/PRIVACY.md
  ```

Permission justifications:

| Permission | Paste this |
| --- | --- |
| `storage`, `unlimitedStorage` | Stores the user's saved stamps, and lets the workspace hold large documents in memory. Nothing is transmitted. |
| `downloads` | Saves the PDF, image and CSV files the user exports. |
| `debugger` (optional) | Only for the "URL to PDF" feature. Chrome's page-to-PDF printer is reachable solely through the DevTools protocol, so the extension attaches to a background tab it opened itself, calls Page.printToPDF, and detaches immediately. It is requested at the moment the user uses that feature, never at install time. |
| Host permissions (optional) | Only for "URL to PDF", and only for the address the user types in. Requested at point of use. |

> The `debugger` permission draws extra review scrutiny — expect a slower first
> review. If you would rather avoid that entirely, remove `debugger` from
> `optional_permissions` in `manifest.json` and drop the URL → PDF tool from
> `app/tools/convert.js`; nothing else depends on it.

### Screenshots

You need at least one, at 1280×800 or 640×400. Good ones to take:

1. The page grid with several files merged, at 30% zoom
2. The Split tool with cut marks visible between pages
3. The Write tool with a text box selected on a page
4. The Compress tool showing the four estimated sizes

## 4. Submit

Review usually takes a few days; the `debugger` permission may make it longer.

## Until it is published

You can already use it everywhere by loading it unpacked:

`brave://extensions` → Developer mode → Load unpacked → pick this folder.

That works today on every machine you clone the repository to. It survives
restarts; it just shows a "developer mode extensions" notice on startup.
