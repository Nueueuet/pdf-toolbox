# Publishing to the Chrome Web Store

Brave installs extensions straight from the Chrome Web Store, so publishing there
covers every one of your machines, Brave and Chrome alike.

**The submission itself has to be done by you.** It needs your Google account,
a one-time \$5 developer registration fee, and acceptance of the developer
agreement — none of which anyone else can do on your behalf. Everything up to
that point is prepared here.

## 1. Build the package

```bash
npm run vendor && npm run vendor:ai && npm run vendor:ocr && npm run package
```

That writes `dist/pdf-toolbox-<version>.zip` — about 18 MB with both the AI
upscaler and the OCR engine, 1.5 MB with neither. Drop either `vendor:` step to
ship a smaller package: the fast upscaler still works without the AI model, and
each tool says plainly when its optional part is not installed rather than
failing at the moment you press the button.

The store's limit is 100 MB, so there is plenty of room either way.

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
Read, edit, merge, split and convert PDFs — and recognise the text in scans. All offline: no upload, no account, no sign-up.
```

### Detailed description

```
PDF Toolbox opens a complete PDF workspace in a new tab. Every tool works on the
same document in the same window — no jumping between pages, no re-uploading a
file for each step.

Everything runs on your own machine. No file is ever uploaded, there is no
account, and there is no analytics or telemetry of any kind — and that goes for
the text recognition too, which most tools can only offer by sending your scans
to a server.

It installs with access to no website at all, and every tool works that way. The
one exception is a switch in the settings, off until you turn it on, that lets
PDF links open here instead of in the browser's viewer; that asks for site access
when you switch it on and gives it back when you switch it off.

READ
• Viewer — where a document opens. Zoom in, drag the page around, and turn pages
  with the arrows at the sides or with the wheel once the whole sheet is visible.
  One page at a time or a continuous stack, and it remembers which you prefer.
• OCR — recognise the text in scanned pages, on your own machine. The words can be
  selected straight away, and they go into the saved PDF as an invisible layer, so
  the file still looks exactly as it did but can be selected and searched. Pages
  that already carry real text are left alone, and a switch shows what was added
  so you can check the result rather than take it on trust.

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
PDF Toolbox is a single-purpose PDF workspace that opens in its own tab.
Everything it does serves that one purpose: viewing a PDF, merging, splitting,
removing, reordering and rotating pages, cropping, compressing, upscaling,
adding text, stamps and watermarks, changing page backgrounds, recognising the
text in scanned pages so it can be selected and searched, converting pages to
PNG, JPG or CSV, and adding or removing a PDF password. All of it runs locally
in the tab. The extension has no content scripts, collects no data, and contacts
no server.

One optional feature, off until the user switches it on in the extension's
settings, lets a PDF link open in that same workspace instead of the browser's
built-in viewer. It serves the same single purpose — editing PDFs — by removing
the download-then-reopen step. It requests site access at the moment it is
switched on and releases that access when it is switched off.
```

**Remote code: No.** Every library and model file is bundled in the package, and
the extension's content security policy (`script-src 'self'`) blocks anything
else from running. Answering "yes" here is both wrong and a guaranteed trip
through a much deeper review.

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

`declarativeNetRequestWithHostAccess`

```
Used only by an optional feature the user switches on themselves: opening PDFs
from the web in the extension's own workspace instead of the browser's viewer.
It installs one redirect rule, which sends a navigation to a .pdf address to the
extension's page so the file can be opened for editing. No rule blocks or alters
any other request, and the rule is removed the moment the feature is switched
off. The host-access variant is used deliberately: it can act only on sites the
user has granted access to, and no access is requested until they turn the
feature on.
```

`optional_host_permissions: http://*/*, https://*/*, file:///*`

```
Requested at runtime, only when the user turns on "Open PDFs in PDF Toolbox",
and only to fetch the PDF the browser was about to display. Nothing is read from
any other page, there are no content scripts, and the fetched file is opened
locally like any other document — it is not transmitted anywhere. Turning the
feature off calls permissions.remove(), so the access is handed back rather than
merely going unused.

file:///* is listed so the same feature can open a PDF the user opens from
their own file manager. It cannot be granted by a runtime request at all: file
access is controlled solely by the "Allow access to file URLs" switch on the
extension's entry in chrome://extensions, which only the user can set, and it
is off unless they set it.
```

`web_accessible_resources`

```
The workspace page (app/index.html) is listed because it is the target of that
one redirect rule; a declarativeNetRequest rule may not redirect to a resource
that is not web accessible. It exposes the editor page itself, which reads no
page data and has no privileged interface beyond the extension's own APIs.
```

**On host permissions.** The extension asks for **no host access at install
time** and works fully without any: every tool operates on files the user hands
it. Site access is requested at runtime by one optional feature and given back
when that feature is switched off. That is worth saying in the listing, because
it is unusual and it is the honest version of "your files never leave your
computer".

### The sandbox, if a reviewer asks

Since the OCR release the manifest declares a sandboxed page whose policy
includes `'unsafe-eval'`. That draws attention, so here is the honest account of
it — paste this into any reply:

```
The extension includes an optional offline OCR engine (PaddleOCR, running via
ONNX Runtime and OpenCV, both bundled). OpenCV's WebAssembly build evaluates
strings as JavaScript, which an extension page may not do. Rather than weaken
the extension's own policy — which Manifest V3 does not allow in any case — the
engine runs in a sandboxed page, as documented for exactly this situation.

The sandboxed page has no access to chrome.* APIs, no host permissions, and no
access to the extension's origin. It communicates only by postMessage: the
workspace sends image pixels, the sandbox returns recognised words and their
positions. It never touches the network; the model weights are bundled in the
package and handed to it by the parent page.
```

Nothing else in the extension runs in the sandbox, and everything continues to
work with the OCR files absent — the tool simply reports that the engine is not
installed.

### Screenshots and promotional tiles

```bash
npm run screenshots
```

That writes everything the listing needs into `store-assets/`, captured from the
running app with real documents loaded — not mock-ups. Retake them whenever the
interface changes: a screenshot showing a tool rail the user will not find is
worse than no screenshot at all.

Upload the seven in this order. The store puts the **first** one on the item's
card, so it leads with the thing nothing else in this category does offline.

| # | File | Shows |
| --- | --- | --- |
| 1 | `screenshot-1-ocr.png` | OCR, with two scanned pages marked amber and three grey ones it can tell already have text |
| 2 | `screenshot-2-viewer.png` | The viewer: page field, zoom, the arrows at the sides, both page layouts |
| 3 | `screenshot-3-merge.png` | Three files merged into one grid |
| 4 | `screenshot-4-split.png` | Cut marks between pages, and the parts they will produce |
| 5 | `screenshot-5-write.png` | A text box being edited on the page |
| 6 | `screenshot-6-compress.png` | Four compression levels with measured sizes |
| 7 | `screenshot-7-copytext.png` | Selecting text straight off the pages |

Both promotional tiles are produced by the same command:
`promo-small-440x280.png` and `promo-large-1400x560.png`. The small tile is the
only one the store requires; the large one is needed to be considered for
featuring.

## 4. Submit

Review usually takes a few days. The extension asks only for `storage`,
`unlimitedStorage` and `downloads`, none of which are sensitive, so there is
nothing here that typically drags a review out.

## Updating a listing that is already live

Same dashboard, *Package* → *Upload new package*, with a higher `version` in
`manifest.json` than the published one. The listing text and images are not
carried over from the zip — they are edited separately, and whatever is there
stays until you change it. So after a release that adds features:

1. Upload the new zip.
2. Replace the short and detailed description with the copy above.
3. Delete the old screenshots and upload the current `store-assets/` set. Ones
   showing an older tool rail are worse than none: they promise a layout that is
   no longer there.
4. Replace both promotional tiles.

Each update goes through review again, and the previous version stays live until
the new one is approved.

### The release that added PDF interception

This one changes more than the usual update, because it is the first release
that asks for anything beyond the files the user hands over. Everything below
has to be redone, not just checked:

| Where | What changed | Source |
| --- | --- | --- |
| *Package* | Upload `dist/pdf-toolbox-<version>.zip` | built by `npm run package` |
| *Store listing* → Description | Now names the viewer, OCR, and the interception switch | [Detailed description](#detailed-description) |
| *Store listing* → Short description | Rewritten | [Short description](#short-description-132-characters-max) |
| *Store listing* → Screenshots | All seven replaced | `store-assets/screenshot-*.png` |
| *Store listing* → Promo tiles | Both replaced | `store-assets/promo-*.png` |
| *Privacy* → Single purpose | Now covers the optional feature | [Single purpose](#privacy-practices) |
| *Privacy* → Permission justifications | **Three new fields appear**: `declarativeNetRequestWithHostAccess`, the optional host permissions, and `web_accessible_resources` | [Permission justifications](#permission-justifications) |
| *Privacy* → Data usage | Still nothing collected — but the three certification boxes have to be ticked again | — |

The privacy policy URL does not change; the document behind it does, and it is
already published with the repository.

**Expect a slower review than usual.** Host permissions — even optional ones —
and `<all_urls>` in `web_accessible_resources` are what reviewers look at
hardest. The single-purpose statement and the justifications above are written
to answer that before it is asked: nothing is requested at install, the access is
requested at the moment the user switches the feature on, and it is handed back
when they switch it off.

## Until it is published

You can already use it everywhere by loading it unpacked:

`brave://extensions` → Developer mode → Load unpacked → pick this folder.

That works today on every machine you clone the repository to. It survives
restarts; it just shows a "developer mode extensions" notice on startup.
