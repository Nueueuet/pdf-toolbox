# Privacy policy

**PDF Toolbox does not collect, transmit, or store any personal data.**

## What happens to your files

Every PDF and image you open stays in the browser tab. Files are read with the
`File` API, edited in memory, and written back out with the browser's download
mechanism. Nothing is uploaded. There is no server, no account, no analytics, no
telemetry, and no third-party requests of any kind.

You can verify this: the extension's content security policy forbids loading or
contacting anything outside the extension itself, and the source is public.

## What is stored on your device

| What | Where | Why |
| --- | --- | --- |
| Saved stamps | `chrome.storage.local` | So your reusable text blocks survive a restart. |

That is the entire list. It never leaves your computer, and removing the
extension removes it.

## Permissions, and why each one is needed

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Saving your stamps, and letting the workspace hold large documents in memory. |
| `downloads` | Saving the PDFs, images and CSV files you export. |

That is the whole list. The extension asks for **no access to any website**, and
it has no content scripts, so it never runs code on the pages you visit and never
sees their contents.

## Contact

Please open an issue on the project's repository.
