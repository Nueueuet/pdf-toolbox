# Third-party libraries

PDF Toolbox itself is MIT licensed (see [LICENSE](LICENSE)). It bundles the
following libraries, each of which keeps its own licence. They are fetched into
`vendor/` by `npm run vendor` and `npm run vendor:ai`, and shipped inside the
packaged extension because a Chrome MV3 extension may not load remote code.

| Library | Used for | Licence |
| --- | --- | --- |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) | Reading and writing PDF files, including encryption | MIT |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Rendering pages and extracting text | Apache License 2.0 |
| [JSZip](https://github.com/Stuk/jszip) | Bundling multi-file exports into a zip | MIT |
| [TensorFlow.js](https://github.com/tensorflow/tfjs) *(optional)* | Running the upscaling model | Apache License 2.0 |
| [ESRGAN-slim](https://github.com/thekevinscott/UpscalerJS) via UpscalerJS *(optional)* | Super-resolution model weights | MIT |

The two optional entries are only present if `npm run vendor:ai` has been run.
Without them the Upscale tool's AI mode is disabled and everything else works
unchanged.

Full licence texts ship inside each package under `vendor/`.
