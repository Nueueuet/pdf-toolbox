/**
 * Generates sample PDFs in `test-files/` so the tools can be exercised without
 * hunting for real documents. Not shipped with the extension.
 *
 *   node scripts/make-test-pdfs.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, degrees } from '../vendor/pdf-lib.esm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test-files');
await mkdir(outDir, { recursive: true });

/** A plain multi-page report with a table, so CSV export has something to find. */
async function report() {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const rows = [
    ['Region', 'Quarter', 'Revenue', 'Units'],
    ['North', 'Q1', '128400', '3120'],
    ['North', 'Q2', '141050', '3390'],
    ['South', 'Q1', '98220', '2410'],
    ['South', 'Q2', '105980', '2655'],
    ['East', 'Q1', '176300', '4180'],
    ['East', 'Q2', '169420', '3990'],
  ];

  for (let n = 1; n <= 5; n++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Quarterly report — page ${n}`, { x: 56, y: 770, size: 22, font: bold, color: rgb(0.09, 0.13, 0.17) });
    page.drawText('Generated for testing PDF Toolbox.', { x: 56, y: 744, size: 11, font: body, color: rgb(0.4, 0.47, 0.53) });
    page.drawLine({ start: { x: 56, y: 732 }, end: { x: 539, y: 732 }, thickness: 1, color: rgb(0.85, 0.89, 0.93) });

    rows.forEach((row, index) => {
      const y = 690 - index * 22;
      const font = index === 0 ? bold : body;
      const columns = [56, 180, 300, 430];
      row.forEach((cell, column) => {
        page.drawText(cell, { x: columns[column], y, size: 11, font, color: rgb(0.13, 0.18, 0.23) });
      });
    });

    page.drawText(
      'Body copy so the page is not empty. Lorem ipsum dolor sit amet, consectetur adipiscing elit,\n'
      + 'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,\n'
      + 'quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
      { x: 56, y: 470, size: 11, font: body, lineHeight: 16, color: rgb(0.24, 0.3, 0.36) },
    );
    page.drawRectangle({ x: 56, y: 150, width: 483, height: 250, borderColor: rgb(0.8, 0.85, 0.9), borderWidth: 1 });
    page.drawText(`${n}`, { x: 290, y: 90, size: 12, font: body, color: rgb(0.55, 0.62, 0.68) });
  }

  await writeFile(path.join(outDir, 'report.pdf'), await doc.save());
}

/** Mixed page sizes and rotations — the geometry code's stress test. */
async function mixed() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  const specs = [
    { size: [595.28, 841.89], rotate: 0, label: 'A4 portrait, /Rotate 0' },
    { size: [841.89, 595.28], rotate: 0, label: 'A4 landscape, /Rotate 0' },
    { size: [595.28, 841.89], rotate: 90, label: 'A4 portrait, /Rotate 90' },
    { size: [595.28, 841.89], rotate: 270, label: 'A4 portrait, /Rotate 270' },
    { size: [420, 595], rotate: 180, label: 'A5 portrait, /Rotate 180' },
  ];

  for (const spec of specs) {
    const page = doc.addPage(spec.size);
    page.setRotation(degrees(spec.rotate));
    page.drawText(spec.label, { x: 40, y: spec.size[1] - 70, size: 15, font, color: rgb(0.1, 0.1, 0.1) });
    // Corner markers make it obvious if rotation or cropping flips something.
    page.drawText('TL', { x: 16, y: spec.size[1] - 28, size: 13, font, color: rgb(0.85, 0.15, 0.15) });
    page.drawText('BR', { x: spec.size[0] - 40, y: 16, size: 13, font, color: rgb(0.15, 0.35, 0.85) });
    page.drawRectangle({ x: 8, y: 8, width: spec.size[0] - 16, height: spec.size[1] - 16, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
  }

  await writeFile(path.join(outDir, 'mixed-pages.pdf'), await doc.save());
}

/** Two short files, for merging. */
async function shorts() {
  for (const [name, text, color] of [['invoice', 'INVOICE 2026-114', rgb(0.1, 0.4, 0.2)], ['appendix', 'APPENDIX A', rgb(0.4, 0.1, 0.4)]]) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let n = 1; n <= 2; n++) {
      const page = doc.addPage([595.28, 841.89]);
      page.drawText(`${text} — sheet ${n}`, { x: 60, y: 740, size: 20, font, color });
    }
    await writeFile(path.join(outDir, `${name}.pdf`), await doc.save());
  }
}

/**
 * A wide sheet in the shape of a building drawing: far too broad to fit, so
 * panning has to reach both its left and its right edge.
 */
async function blueprint() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const [w, ph] = [2384, 842]; // A1 landscape-ish, roughly 3:1
  const page = doc.addPage([w, ph]);

  page.drawRectangle({ x: 0, y: 0, width: w, height: ph, color: rgb(0.06, 0.16, 0.36) });
  for (let x = 40; x < w; x += 40) {
    page.drawLine({ start: { x, y: 0 }, end: { x, y: ph }, thickness: 0.5, color: rgb(0.2, 0.32, 0.55) });
  }
  for (let y = 40; y < ph; y += 40) {
    page.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: 0.5, color: rgb(0.2, 0.32, 0.55) });
  }
  // Labels in the far corners: if either is unreachable, panning is broken.
  page.drawText('LEFT EDGE', { x: 24, y: ph / 2, size: 34, font, color: rgb(1, 0.85, 0.3) });
  page.drawText('RIGHT EDGE', { x: w - 250, y: ph / 2, size: 34, font, color: rgb(1, 0.85, 0.3) });
  page.drawText('SITE PLAN — SHEET A-101', { x: 24, y: ph - 60, size: 26, font, color: rgb(1, 1, 1) });

  await writeFile(path.join(outDir, 'blueprint.pdf'), await doc.save());
}

await report();
await mixed();
await shorts();
await blueprint();
console.log(`wrote sample PDFs to ${path.relative(process.cwd(), outDir)}`);
