// Chart helpers shared by the rail panel and the Work Status section.
// Ported from the idea in openchamber-live-tps (MIT, wwwzzzxxx) that a curve
// should pan instead of jumping: grow the scale at once, let it shrink slowly.

/**
 * Where a value sits in the plot, as a fraction from 0 (baseline) to 1 (top).
 *
 * The first `LINEAR_SHARE` of the height is linear up to the ceiling; anything
 * above it is squeezed into the rest. One 1,000 t/s burst above a 10 t/s
 * stream therefore stays visible near the top instead of being cut off at it,
 * and the stream keeps its shape.
 */
export const LINEAR_SHARE = 0.76;

export function compress(value, ceiling) {
  if (!(ceiling > 0)) return 0;
  const v = Math.max(0, value);
  if (v <= ceiling) return (v / ceiling) * LINEAR_SHARE;
  const over = (v - ceiling) / ceiling;
  return LINEAR_SHARE + (1 - LINEAR_SHARE) * (1 - 1 / (1 + over * 2));
}

/**
 * Average and best rate over measured steps: tokens ÷ stream time, and the
 * fastest single step. Steps without a measured span are left out of both, so
 * the two numbers describe the same set of steps.
 */
export function ratesOf(steps) {
  let tokens = 0;
  let ms = 0;
  let peak = 0;
  for (const step of steps ?? []) {
    if (!step?.tps || step.tps <= 0 || step.aborted) continue;
    tokens += step.tokens;
    ms += step.ms;
    if (step.tps > peak) peak = step.tps;
  }
  return { avg: ms > 0 ? (tokens / ms) * 1000 : 0, peak };
}

/**
 * One step of a value moving towards a target, for a headline that should read
 * as a needle rather than a jump. `tau` is the time constant in ms: the value
 * covers ~63% of the gap in that time and never overshoots.
 */
export function easeToward(current, target, dt, tau = 160) {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 0.4 ? target : next;
}

/**
 * Full scale for the next frame.
 * Growing immediately keeps a new peak from being clipped; shrinking slowly
 * keeps the rest of the curve from bobbing whenever the peak bucket changes.
 */
export function nextScale(previous, values) {
  const target = Math.max(1, ...values);
  if (!Number.isFinite(previous) || previous <= 0) return target;
  if (target >= previous) return target;
  return previous + (target - previous) * 0.06;
}
