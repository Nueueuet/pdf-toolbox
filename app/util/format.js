export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "report.pdf" -> "report"; used to derive output names like "report cut 1.pdf". */
export function baseName(fileName) {
  return String(fileName ?? 'document').replace(/\.pdf$/i, '').trim() || 'document';
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** #rrggbb -> {r,g,b} in 0..1, the range pdf-lib's rgb() wants. */
export function hexToUnit(hex) {
  const clean = String(hex ?? '#000000').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
