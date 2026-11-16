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

// Panel axes: the first 100 t/s get 35% of the plot and bursts share the
// logarithmic remainder. The ceiling is the actual peak: a session under
// 100 t/s is drawn linearly at full height so its peak is the top edge, never
// a fixed 250/300 that would leave the peak halfway up. Display geometry only.
export function rateCeiling(value) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, value) : 1;
}

export function symlogShare(value, maximum) {
  const max = rateCeiling(maximum);
  const v = Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;
  // No log band exists below the threshold: use the whole height.
  if (max <= 100) return v / max;
  return v <= 100 ? 0.35 * v / 100 : 0.35 + 0.65 * Math.log10(v / 100) / Math.log10(max / 100);
}

export function rateTickLabel(value) {
  return value >= 1000 ? `${Number((value / 1000).toPrecision(3))}k` : String(value);
}

/** Clean ticks, extended by decades rather than capped at a 3k burst.
 * Greedy pixel spacing keeps labels apart even in the short history chart. */
export function rateTicks(maximum, height, minGap = 22) {
  const max = rateCeiling(maximum);
  const candidates = new Set([0, 10, 20, 25, 50, 75, 100].filter((value) => value <= max));
  for (let power = 2; power <= Math.floor(Math.log10(max)); power += 1) {
    for (const multiple of [1, 2, 2.5, 3, 5]) {
      const value = multiple * 10 ** power;
      if (value >= 250 && value <= max) candidates.add(value);
    }
  }
  const ticks = [];
  let previousLabelY = Infinity;
  for (const value of [...candidates].sort((a, b) => a - b)) {
    const share = symlogShare(value, max);
    const y = height - share * height;
    const labelY = y < 10 ? y + 10 : y - 3;
    if (!ticks.length || previousLabelY - labelY >= minGap) {
      ticks.push({ value, share, label: rateTickLabel(value) });
      previousLabelY = labelY;
    }
  }
  return ticks;
}

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
  let peakAt = null;
  for (const step of steps ?? []) {
    if (!step?.tps || step.tps <= 0 || step.aborted) continue;
    tokens += step.tokens;
    ms += step.ms;
    if (step.tps > peak) {
      peak = step.tps;
      // When the best step ran: the chart pins its scale to this number, so the
      // frame has to be able to say how old it is.
      peakAt = typeof step.at === 'number' ? step.at : null;
    }
  }
  return { avg: ms > 0 ? (tokens / ms) * 1000 : 0, peak, peakAt };
}

/**
 * One step of a value moving towards a target, for a headline that should read
 * as a needle rather than a jump. `tau` is the time constant in ms: the value
 * covers ~63% of the gap in that time and never overshoots. `snap` is in the
 * value's units: 0.4 t/s for digits, a small fraction for curve geometry.
 */
export function easeToward(current, target, dt, tau = 160, snap = 0.4) {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < snap ? target : next;
}

/** Display-only interpolation of normalized curve heights. Retained samples
 * keep their animation state by timestamp; a new rightmost sample starts at
 * the preceding height instead of jumping on a poll. The map is bounded by
 * the visible points and an empty list resets it for a session switch.
 * Ease in screen fractions so a changed axis also moves the curve smoothly. */
export function createCurveMotion() {
  let shown = new Map();
  let lastAt = null;
  let lastTime = null;
  let lastValue = null;
  return (points, at, reducedMotion = false) => {
    if (!points.length) {
      shown.clear();
      lastAt = lastTime = lastValue = null;
      return [];
    }
    const dt = lastAt === null ? 0 : Math.min(200, Math.max(0, at - lastAt));
    const next = new Map();
    let previous = lastValue;
    const result = points.map((point) => {
      const target = Number.isFinite(point.v) ? Math.min(1, Math.max(0, point.v)) : 0;
      const seed = shown.get(point.t) ?? (lastTime !== null && point.t > lastTime ? previous ?? target : target);
      const value = reducedMotion ? target : easeToward(seed, target, dt, 160, 0.0001);
      next.set(point.t, value);
      previous = value;
      return { t: point.t, v: value };
    });
    shown = next;
    lastAt = at;
    lastTime = points.at(-1).t;
    lastValue = result.at(-1).v;
    return result;
  };
}

/**
 * Full scale for the next frame.
 * Growing immediately keeps a new peak from being clipped; shrinking slowly
 * keeps the rest of the curve from bobbing whenever the peak bucket changes.
 */
export function nextScale(previous, values, dt = 100) {
  const target = Math.max(1, ...values);
  if (!Number.isFinite(previous) || previous <= 0) return target;
  if (target >= previous) return target;
  // Preserve the original 6% decay per 100 ms, independent of display rate.
  return previous + (target - previous) * (1 - 0.94 ** (Math.max(0, dt) / 100));
}

/**
 * The wire carries the live series as values plus each sample's own offset from
 * t0 (`d`, in ms). An older service sends only the values; those are placed on
 * its nominal cadence, which then is the best the frame can know.
 */
export function seriesPoints(data) {
  const series = data.series;
  if (!series || !Array.isArray(series.v)) return [];
  const step = series.step > 0 ? series.step : 250;
  const offsets = Array.isArray(series.d) && series.d.length === series.v.length ? series.d : null;
  return series.v.map((value, index) => ({ t: series.t0 + (offsets ? offsets[index] : index * step), v: value }));
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
