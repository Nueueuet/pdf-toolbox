# Privacy policy

**PDF Toolbox does not collect, transmit, or store any personal data.**

## What happens to your files

Every PDF and image you open stays in the browser tab. Files are read with the
`File` API, edited in memory, and written back out with the browser's download
mechanism. Nothing is uploaded. There is no server, no account, no analytics, no
telemetry, and no third-party requests of any kind.

You can verify this: the extension's content security policy forbids loading or
contacting anything outside the extension itself, and the source is public.

The one request the extension ever makes to the internet is described under
*Opening PDFs from the web* below, and only if you switch that on: it downloads
the PDF you just clicked, from the address you clicked, the same way the browser
would have. It uploads nothing.

## What is stored on your device

| What | Where | Why |
| --- | --- | --- |
| Saved stamps | `chrome.storage.local` | So your reusable text blocks survive a restart. |
| Your reading and settings choices | `chrome.storage.local` | Page layout, zoom, and whether PDF links open here. |

That is the entire list. It never leaves your computer, and removing the
extension removes it.

## Permissions, and why each one is needed

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Saving your stamps and settings, and letting the workspace hold large documents in memory. |
| `downloads` | Saving the PDFs, images and CSV files you export. |
| `declarativeNetRequestWithHostAccess` | Only for the optional feature below. It can act only on sites you have granted access to — which is none, unless you turn that feature on. |

The extension installs with **no access to any website**, and it has no content
scripts, so it never runs code on the pages you visit and never sees their
contents.

## Opening PDFs from the web

There is one switch, in the extension's settings, that is **off unless you turn
it on**: *Open PDFs in PDF Toolbox*. With it on, clicking a PDF link opens the
file in the workspace instead of the browser's viewer.

- Turning it on asks for permission to access websites. That is used for exactly
  one thing: downloading the PDF you clicked, so it can be opened for editing.
- No page is read, no content script is injected, and no other request is
  touched, changed or blocked.
- Turning it off removes the redirect **and** gives the access back
  (`chrome.permissions.remove`), so the extension returns to seeing nothing.
- You can also revoke it yourself at any time from the extension's entry in
  `chrome://extensions`.

## Contact

Please open an issue on the project's repository.
