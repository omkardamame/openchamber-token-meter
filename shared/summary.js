// Formatting shared by the rail panel and the Work Status section.
// One copy, so a token renders the same in both places.

export function compact(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`;
  // Rounding a count just under a million must not read "1000k".
  if (n >= 10_000) {
    const thousands = Math.round(n / 1_000);
    return thousands >= 1_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${thousands}k`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function percent(value, decimals = 0) {
  const n = Number(value) || 0;
  let text = (n * 100).toFixed(decimals);
  if (decimals > 0) text = text.replace(/\.?0+$/, '');
  return `${text}%`;
}

export function seconds(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '—';
  if (n < 1_000) return `${Math.round(n)} ms`;
  return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)} s`;
}

/**
 * Elapsed time for a turn timer: "42s", "1m 03s", "1h 02m". The smaller unit is
 * zero-padded so the label keeps one width while it counts, and anything under
 * a second says nothing at all: a timer that reads "0s" for a tick is noise.
 */
export function duration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 1_000) return '';
  const total = Math.floor(n / 1_000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
