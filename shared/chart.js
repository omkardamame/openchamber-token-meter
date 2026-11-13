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

/**
 * The wire carries the live series as values against a fixed cadence; this turns
 * it back into the {t, v} points the charts draw. `t` is nominal (t0 + i·step),
 * within a few ms of each sample, which is a third of a pixel on a 60 s window.
 */
export function seriesPoints(data) {
  const series = data.series;
  if (!series || !Array.isArray(series.v)) return [];
  const step = series.step > 0 ? series.step : 250;
  return series.v.map((value, index) => ({ t: series.t0 + index * step, v: value }));
}

/**
 * A smooth SVG path through {x, y} points, one cubic Bézier per segment, with
 * Fritsch-Carlson tangents. The tangents are chosen so the curve cannot rise
 * above the higher of its two samples or dip below the lower one: a chart of a
 * measured rate must not draw a rate the service never reported. The points
 * must have strictly increasing x.
 */
export function smoothPath(points) {
  const list = Array.isArray(points) ? points : [];
  const round = (value) => value.toFixed(1);
  if (list.length === 0) return '';
  if (list.length === 1) return `M ${round(list[0].x)},${round(list[0].y)}`;
  const n = list.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = list[i + 1].x - list[i].x;
    slope[i] = (list[i + 1].y - list[i].y) / dx[i];
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Clamp a tangent that is more than three times its segment's slope: three is
  // the steepest a monotone cubic may be without overshooting its samples.
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * slope[i];
        m[i + 1] = t * b * slope[i];
      }
    }
  }
  let d = `M ${round(list[0].x)},${round(list[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const x0 = list[i].x;
    const y0 = list[i].y;
    const x1 = list[i + 1].x;
    const y1 = list[i + 1].y;
    const c1x = x0 + dx[i] / 3;
    const c1y = y0 + (m[i] * dx[i]) / 3;
    const c2x = x1 - dx[i] / 3;
    const c2y = y1 - (m[i + 1] * dx[i]) / 3;
    d += ` C ${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(x1)},${round(y1)}`;
  }
  return d;
}
