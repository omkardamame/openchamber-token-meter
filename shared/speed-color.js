// The live headline's colour, chosen by rate tier so a fast model reads at a
// glance. The thresholds live here once; the five fixed colours live in each
// page's CSS, because the two frames are separate documents and a rate colour
// must not follow the host theme.

/** Lowest tier first. These names are the `data-tier` values both pages style. */
export const SPEED_TIERS = ['slow', 'steady', 'fast', 'blazing', 'ultra'];

/**
 * The tier for a rate in tokens per second: under 20, 20–50, 50–90, 90–150,
 * above 150. 20, 50 and 90 start the faster tier; 150 is the last blazing rate,
 * as the range says. A value that cannot be measured sits in the lowest tier.
 */
export function speedTier(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 20) return 'slow';
  if (n < 50) return 'steady';
  if (n < 90) return 'fast';
  if (n <= 150) return 'blazing';
  return 'ultra';
}
