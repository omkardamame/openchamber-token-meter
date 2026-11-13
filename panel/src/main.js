import { HostRequestError, connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountEmpty } from '@openchamber/sdk/ui';
import { compact, duration, seconds } from '../../shared/summary.js';
import { easeToward, nextScale, seriesPoints, smoothPath } from '../../shared/chart.js';
import { dotState, mountCells, paintCells } from '../../shared/cells.js';
import { el } from '../../shared/dom.js';
import { speedTier } from '../../shared/speed-color.js';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

const POLL_MS = 250;

let sessionId = null;
let timer = null;
let inflight = false;
let mounted = false;
let notice = null;
let noticeView = null;
let ui = null;
let current = null;
let rowNodes = new Map();
let receivedAt = 0;
let liveScale = 1;
let lastSteps = [];
let lastStepsSeq = -1;
let targetTps = 0;
let shownTps = 0;
let lastRounded = -1;
let streamingNow = false;
let lastTier = '';
let modelLabel = '';
let liveHoverX = null;
let stepHover = null;
let lastDrawnSteps = null;
let lastDrawnW = 0;
let lastDrawnH = 0;
let lastDrawnHover = null;
let drawnSteps = [];
let drawnSlot = 0;

// A reader who asked the system for less motion gets the measured number
// without the easing travel; the digits are the same either way.
const REDUCED_MOTION =
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Move the headline towards the measured rate instead of snapping to it. The
 * value stays the service's 3 s average; only the way it is drawn is eased, so
 * a 300 ms poll reads as a continuous needle. The colour follows the number on
 * screen, not the target, so the two never disagree.
 */
function animateSpeed(dt) {
  if (!ui) return;
  shownTps = REDUCED_MOTION ? targetTps : easeToward(shownTps, targetTps, dt);
  const rounded = Math.round(shownTps);
  if (rounded !== lastRounded) {
    lastRounded = rounded;
    ui.tpsValue.textContent = String(rounded);
  }
  paintTier();
}

/**
 * Colour the headline by its tier. This runs on every animation frame, so it
 * writes the attribute only when the tier changes. It classifies the rounded
 * number, the digits on screen, so colour and value turn together at 20/50/90/
 * 150. A quiet or idle rate carries no tier and keeps the neutral text colour:
 * a resting 0 is not a slow stream.
 */
function paintTier() {
  const tier = ui && streamingNow && lastRounded >= 0 ? speedTier(lastRounded) : '';
  if (tier === lastTier) return;
  lastTier = tier;
  if (tier) ui.tpsValue.dataset.tier = tier;
  else delete ui.tpsValue.dataset.tier;
}

/** The host's clock at the last answer, advanced by the time since it arrived. */
function projectedNow(data) {
  return (data.generatedAt || Date.now()) + Math.min(1500, performance.now() - receivedAt);
}

const STATUS = {
  streaming: 'generating',
  idle: 'idle',
  tool: 'running a tool',
  'waiting-permission': 'waiting for permission',
  'waiting-question': 'waiting for answer',
  failed: 'last turn failed',
};

function build() {
  notice = el('div', 'notice');
  root.append(notice);

  const app = el('div', 'meter');
  app.innerHTML = `
    <div class="head">
      <span class="eyebrow"></span>
      <span class="status"><i class="dot"></i><span class="status-label">idle</span></span>
    </div>

    <section class="live">
      <div class="speed">
        <span class="stat-label">live <em>est</em></span>
        <span class="speed-value" title="the session and every streaming subagent, added together"><b class="tps-value">0</b><i>t/s</i></span>
        <span class="speed-note tps-sub">no generation right now</span>
        <span class="speed-last last-line"><span class="last-rate"></span><span class="last-rest"></span></span>
      </div>
      <div class="chart-wrap"><svg class="chart" data-chart="live" aria-hidden="true"></svg></div>
      <div class="axis"><span>60 s ago</span><span class="axis-peak"></span><span>now</span></div>
    </section>

    <section class="block subagents" hidden>
      <div class="block-head" title="Each subagent still working, with its own rate; the headline adds them up"><span>Subagents</span><span class="block-meta subs-meta"></span></div>
      <div class="subs-list"></div>
    </section>

    <section class="block">
      <div class="block-head" title="Every step since the session started, not one turn"><span>Session totals</span><span class="block-meta totals-source"></span></div>
      <div class="grid totals-grid"></div>
    </section>

    <section class="block cost">
      <div class="block-head" title="This session and its subagents"><span>Cost</span></div>
      <div class="grid cost-grid">
        <div class="cell"><span class="cell-label">Total</span><span class="cell-value cost-total">—</span></div>
        <div class="cell"><span class="cell-label">Last turn</span><span class="cell-value cost-turn">—</span></div>
        <div class="cell"><span class="cell-label">Model</span><span class="cell-value cost-model">—</span></div>
        <div class="cell"><span class="cell-label">Effective</span><span class="cell-value cost-rate">—</span></div>
      </div>
      <div class="cost-rates"></div>
    </section>

    <section class="block steps">
      <div class="block-head"><span>Per step</span><span class="block-meta"><span class="steps-count"></span> <span class="steps-avg"></span> <span class="steps-peak"></span></span></div>
      <div class="chart-wrap"><svg class="chart" data-chart="steps" aria-hidden="true"></svg></div>
      <div class="steps-axis" hidden><span class="steps-start"></span><span class="steps-now"></span><span class="steps-hover" hidden></span></div>
      <div class="legend" hidden><span><i class="swatch main"></i>session</span><span><i class="swatch sub"></i>subagent</span></div>
    </section>

    <div class="foot"><span class="foot-text">reading OpenCode usage</span></div>
  `;
  root.append(app);
  return {
    app,
    eyebrow: app.querySelector('.eyebrow'),
    dot: app.querySelector('.dot'),
    statusLabel: app.querySelector('.status-label'),
    tpsValue: app.querySelector('.tps-value'),
    tpsSub: app.querySelector('.tps-sub'),
    lastRate: app.querySelector('.last-rate'),
    lastRest: app.querySelector('.last-rest'),
    live: app.querySelector('[data-chart="live"]'),
    peak: app.querySelector('.axis-peak'),
    grid: app.querySelector('.grid'),
    source: app.querySelector('.totals-source'),
    costTotal: app.querySelector('.cost-total'),
    costTurn: app.querySelector('.cost-turn'),
    costModel: app.querySelector('.cost-model'),
    costRate: app.querySelector('.cost-rate'),
    costRates: app.querySelector('.cost-rates'),
    subsBlock: app.querySelector('.subagents'),
    subsMeta: app.querySelector('.subs-meta'),
    subsList: app.querySelector('.subs-list'),
    legend: app.querySelector('.legend'),
    stepsChart: app.querySelector('[data-chart="steps"]'),
    stepsCount: app.querySelector('.steps-count'),
    stepsAvg: app.querySelector('.steps-avg'),
    stepsPeak: app.querySelector('.steps-peak'),
    stepsAxis: app.querySelector('.steps-axis'),
    stepsStart: app.querySelector('.steps-start'),
    stepsNow: app.querySelector('.steps-now'),
    stepsHover: app.querySelector('.steps-hover'),
    foot: app.querySelector('.foot-text'),
  };
}

/** Four decimal places, for the cost totals. */
function money4(value) {
  return `$${(Number(value) || 0).toFixed(4)}`;
}

/** A 24-hour wall clock for the step chart's start and now labels. */
function clock(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

/** A per-million rate, where the interesting digits are small. */
function rateMoney(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n < 1 ? n.toFixed(2) : n.toFixed(1)}`;
}

/** A model's list rate: 0.003 shows as $0.003, 0.6 as $0.60, 1.2 as $1.20. */
function listRate(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  if (n < 0.001) return `$${n.toFixed(4)}`;
  if (n < 0.01) return `$${n.toFixed(3)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}

/**
 * What this session and its subagents cost: all of it, the turn that is running
 * (or the last one), and the model behind it with its effective rate. The rate
 * is observed, not list price: the extension cannot read a provider's price
 * table, so it divides this session's cost by every token it processed.
 */
function paintCost(data) {
  const cost = data.cost ?? {};
  const totals = data.totals ?? {};
  const turn = data.turn ?? {};
  const total = typeof cost.total === 'number' ? cost.total : (totals.cost ?? 0);
  ui.costTotal.textContent = money4(total);
  ui.costTotal.title = cost.tariff
    ? 'OpenCode’s recorded cost; the active side of the rate table is what the provider charges'
    : 'this session and its subagents, as OpenCode recorded it';
  ui.costTurn.textContent = typeof cost.lastTurn === 'number' ? money4(cost.lastTurn) : '—';
  ui.costTurn.title =
    (data.subagents?.loading ?? 0) > 0 || (data.subagents?.partial ?? 0) > 0 || data.historyPartial
      ? 'history is partial; the last turn can grow'
      : turn.steps > 0
        ? `${turn.steps} step${turn.steps === 1 ? '' : 's'} · ${compact(turn.tokens)} generated tokens`
        : '';
  ui.costModel.textContent = modelLabel || cost.rates?.model || '—';
  ui.costModel.title = modelLabel || cost.rates?.model || '';
  ui.costRate.textContent = typeof cost.perMillion === 'number' ? `${rateMoney(cost.perMillion)} / 1M` : '—';
  ui.costRate.title = 'effective: this session’s cost divided by every token it processed';
  // The model's own list rates, recovered from OpenCode's step costs. They are
  // what the provider charged per million, not the blended rate above. A model
  // switch mid-session shows a dash until the new model has its own steps.
  //
  // A model with a published time-of-day tariff shows both sides, the active
  // one first and in its own colour: peak at 2× is the number that matters
  // while a peak window is open, and the off-peak line stays visible so the
  // pair can be read without a tooltip.
  // A stale recovered rate means the session has moved model; the tariff came
  // from the same model and must go with it. With no recovered rate yet the
  // tariff still stands on its own card.
  const sameModel = !cost.rates || !modelLabel || cost.rates.model === modelLabel;
  const tariff = cost.tariff && sameModel && (!modelLabel || cost.tariff.model === modelLabel) ? cost.tariff : null;
  const rates = cost.rates && sameModel ? cost.rates : null;
  if (tariff?.tiers) {
    const peak = Boolean(tariff.peak);
    const active = peak ? tariff.tiers.peak : tariff.tiers.offPeak;
    const other = peak ? tariff.tiers.offPeak : tariff.tiers.peak;
    const row = (name, tierRates, tier, current) => {
      const node = el('div', 'rate-row');
      node.dataset.tier = tier;
      node.dataset.active = current ? 'true' : 'false';
      node.append(
        el('span', 'rate-name', name),
        el('span', 'rate-num', listRate(tierRates.input)),
        el('span', 'rate-num', listRate(tierRates.output)),
        el('span', 'rate-num', listRate(tierRates.cacheRead)),
      );
      return node;
    };
    const head = el('div', 'rate-row rate-head');
    head.append(
      el('span', 'rate-name', 'rates / 1M'),
      el('span', 'rate-num', 'in'),
      el('span', 'rate-num', 'out'),
      el('span', 'rate-num', 'cache'),
    );
    ui.costRates.replaceChildren(
      head,
      row(peak ? 'peak now' : 'off-peak now', active, peak ? 'peak' : 'off-peak', true),
      row(peak ? 'off-peak' : 'peak', other, peak ? 'off-peak' : 'peak', false),
    );
    ui.costRates.title = `${tariff.provider === 'opencode-go' ? 'OpenCode Go' : tariff.provider} peak: ${tariff.window}; peak is ${tariff.multiplier}× off-peak. ${
      tariff.holidayYear
        ? `Chinese public holidays are off-peak (${tariff.holidayYear} calendar${tariff.holidayStale ? '; update it for the current year' : ''}). `
        : ''
    }${
      tariff.source === 'recovered'
        ? 'rates recovered from this session’s step costs'
        : 'rates from the published price card'
    }.`;
    return;
  }
  ui.costRates.replaceChildren(
    el(
      'span',
      'tier',
      rates
        ? `model rates / 1M · in ${listRate(rates.input)} · out ${listRate(rates.output)} · cache ${listRate(rates.cacheRead)}`
        : cost.ratesNote === 'nonLinear'
          ? 'model rates / 1M · multiple rates; no schedule'
          : 'model rates / 1M · —',
    ),
  );
  ui.costRates.title = rates
    ? `recovered from this session's own step costs for ${rates.model}`
    : cost.rates
      ? `the rates recovered so far are for ${cost.rates.model}, not the session's current ${modelLabel}`
      : cost.tariff
        ? `the tariff shown so far is for ${cost.tariff.model}, not the session's current ${modelLabel}`
        : cost.ratesNote === 'nonLinear'
          ? 'the step costs do not fit one linear price; this provider may charge tiers or a cache-write fee, and the meter has no published schedule for it'
          : cost.ratesNote === 'noCache'
            ? 'no cache-read tokens yet; the fit cannot separate the cache rate'
            : 'not enough differently shaped steps to recover the model’s input, output and cache rates';
}

function drawLive(data) {
  const svg = ui.live;
  const width = Math.max(140, svg.clientWidth || 300);
  const height = Math.max(110, svg.clientHeight || 112);
  const pad = 8;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const series = Array.isArray(data.points) ? data.points : [];
  const now = projectedNow(data);
  const from = now - 60_000;
  const visible = series.filter((point) => point.t >= from && point.t <= now);
  const peakValue = visible.reduce((max, point) => Math.max(max, point.v), 0);
  // References drawn on the chart: the session's average and its best step,
  // worked out by the service over every step it knows.
  const rates = data.rates ?? { avg: 0, peak: 0 };

  // Draw a smoothed curve first: the samples are a 250 ms average already, and
  // the providers arrive in bursts, so a short exponential pass keeps the shape
  // without inventing points the service did not measure. The scale follows the
  // smoothed peak, so the highest point the chart draws touches the top and the
  // rail spends its height on the curve instead of reserving headroom nobody
  // uses. Growing is immediate; a peak leaving the window lowers the scale
  // slowly, which only ever adds temporary headroom, never clips.
  const smooth = [];
  for (const point of visible) {
    const previous = smooth[smooth.length - 1];
    const value = previous === undefined ? point.v : previous + (point.v - previous) * 0.3;
    smooth.push(value);
  }
  const liveTop = smooth.reduce((best, value) => Math.max(best, value), 0);
  // Follow the peak, however low: a 3 t/s stream should fill the plot too. Only
  // an empty window keeps the 8 t/s floor, where the value is 0 anyway.
  liveScale = nextScale(liveScale, [liveTop > 0 ? liveTop : 8]);
  const max = Math.max(1, liveScale);
  // References above the visible peak sit on the top edge rather than leaving
  // the plot; the drawn curve itself can never exceed `max`.
  const share = (value) => Math.min(1, Math.max(0, value) / max);
  const lineY = (value) => height - pad - share(value) * (height - pad * 2);
  const xOf = (point) => ((point.t - from) / 60_000) * width;

  const pieces = [];
  pieces.push(
    `<defs><linearGradient id="tm-live-fill" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="var(--oc-primary)" stop-opacity="0.38" />` +
      `<stop offset="55%" stop-color="var(--oc-primary)" stop-opacity="0.12" />` +
      `<stop offset="100%" stop-color="var(--oc-primary)" stop-opacity="0" />` +
      `</linearGradient></defs>`,
  );

  // The scale down the left edge: the top and the middle of the plot, labelled
  // with the rate they stand for. An empty or all-zero window says nothing,
  // because every number on it would be the 8 t/s floor, not a measurement.
  if (liveTop > 0) {
    const topValue = Math.round(max);
    const halfValue = Math.round(max / 2);
    const topY = lineY(max);
    const halfY = lineY(max / 2);
    pieces.push(
      `<line x1="0" y1="${topY.toFixed(1)}" x2="${width}" y2="${topY.toFixed(1)}" stroke="var(--oc-border)" stroke-width="1" stroke-dasharray="2 4" opacity="0.8" />`,
      `<text x="2" y="${(topY + 10).toFixed(1)}" text-anchor="start" fill="var(--oc-muted)" font-size="9.5" opacity="0.8" data-role="grid-label">${topValue}</text>`,
      `<line x1="0" y1="${halfY.toFixed(1)}" x2="${width}" y2="${halfY.toFixed(1)}" stroke="var(--oc-border)" stroke-width="1" stroke-dasharray="2 4" opacity="0.8" />`,
    );
    // A scale near 1 rounds both lines to the same number; one label is enough.
    if (halfValue !== topValue) {
      pieces.push(
        `<text x="2" y="${(halfY - 3).toFixed(1)}" text-anchor="start" fill="var(--oc-muted)" font-size="9.5" opacity="0.8" data-role="grid-label">${halfValue}</text>`,
      );
    }
  }
  // Where 15, 30 and 45 seconds ago sit. Without them the 60 s window has no
  // marks at all and a shape can only be read by counting pixels.
  for (const part of [0.25, 0.5, 0.75]) {
    pieces.push(
      `<line x1="${(width * part).toFixed(1)}" y1="${pad}" x2="${(width * part).toFixed(1)}" y2="${(height - pad).toFixed(1)}" stroke="var(--oc-border)" stroke-width="1" opacity="0.5" data-role="time-grid" />`,
    );
  }

  let avgLabelY = null;
  if (rates.avg > 0) {
    const y = lineY(rates.avg);
    avgLabelY = y < pad + 10 ? y + 11 : y - 4;
    pieces.push(
      `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" stroke="var(--oc-success)" stroke-width="1" stroke-dasharray="3 3" opacity="0.7" />`,
      `<text x="${width - 2}" y="${avgLabelY.toFixed(1)}" text-anchor="end" fill="var(--oc-success)" font-size="9.5" opacity="0.85">avg ${Math.round(rates.avg)} t/s</text>`,
    );
  }
  if (rates.peak > 0) {
    const y = lineY(rates.peak);
    // Keep the labels apart when the lines are close. Above the average label
    // when there is room, so the peak label stays beside its own (higher) line;
    // on the top edge, stack it below instead of clipping it.
    let labelY = y < pad + 10 ? y + 11 : y - 4;
    if (avgLabelY !== null && Math.abs(labelY - avgLabelY) < 12) {
      const above = avgLabelY - 13;
      labelY = above > pad ? above : avgLabelY + 13;
    }
    if (labelY > height - 2) labelY = (avgLabelY ?? labelY) - 13;
    pieces.push(
      `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" stroke="var(--oc-error)" stroke-width="1" stroke-dasharray="6 3 2 3" opacity="0.65" />`,
      `<text x="${width - 2}" y="${labelY.toFixed(1)}" text-anchor="end" fill="var(--oc-error)" font-size="9.5" opacity="0.95">peak ${Math.round(rates.peak)} t/s</text>`,
    );
  }

  // The sample nearest the pointer. Its rate is the smoothed value the curve
  // draws, and its age is measured from the window's own clock, so the readout
  // names a point a reader can put a finger on.
  let hovered = null;
  if (liveHoverX !== null && smooth.length > 1) {
    let nearest = 0;
    for (let index = 1; index < visible.length; index += 1) {
      if (Math.abs(xOf(visible[index]) - liveHoverX) < Math.abs(xOf(visible[nearest]) - liveHoverX)) nearest = index;
    }
    hovered = { x: xOf(visible[nearest]), y: lineY(smooth[nearest]), value: smooth[nearest], at: visible[nearest].t };
  }

  if (smooth.length > 1) {
    const points = smooth.map((value, index) => ({ x: xOf(visible[index]), y: lineY(value) }));
    const line = smoothPath(points);
    const first = points[0];
    const last = points[points.length - 1];
    const baseline = height - pad;
    pieces.push(
      `<path d="${line} L ${last.x.toFixed(1)},${baseline.toFixed(1)} L ${first.x.toFixed(1)},${baseline.toFixed(1)} Z" fill="url(#tm-live-fill)" data-role="live-fill" />`,
      `<path d="${line}" fill="none" stroke="var(--oc-primary)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" data-role="live-line" />`,
      `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" fill="var(--oc-primary)" />`,
    );
    if (hovered) {
      pieces.push(
        `<line x1="${hovered.x.toFixed(1)}" y1="${pad}" x2="${hovered.x.toFixed(1)}" y2="${baseline.toFixed(1)}" stroke="var(--oc-fg)" opacity="0.35" stroke-width="1" data-role="live-cross" />`,
        `<circle cx="${hovered.x.toFixed(1)}" cy="${hovered.y.toFixed(1)}" r="3" fill="var(--oc-fg)" data-role="live-cross-dot" />`,
      );
    }
  } else if (smooth.length === 1) {
    // One sample is not a baseline: draw the point where it actually sits.
    const x = xOf(visible[0]);
    pieces.push(`<circle cx="${x.toFixed(1)}" cy="${lineY(smooth[0]).toFixed(1)}" r="2.6" fill="var(--oc-primary)" />`);
  } else {
    pieces.push(
      `<line x1="0" y1="${height - pad}" x2="${width}" y2="${height - pad}" stroke="var(--oc-primary)" stroke-width="1.6" opacity="0.45" />`,
    );
  }
  svg.innerHTML = pieces.join('');
  ui.peak.textContent = hovered
    ? `${Math.round(hovered.value)} t/s · ${Math.max(0, Math.round((now - hovered.at) / 1_000))} s ago`
    : peakValue > 0
      ? `live peak ${compact(peakValue)} t/s`
      : '';
}

/**
 * The readout under the step chart: the bar's rate and size, plus the time it
 * ran, what it cost and whose step it was when the service sends them. An older
 * service leaves the last three out rather than printing a hole.
 */
function stepReadout(step) {
  let text = `${Math.round(step.tps)} t/s · ${compact(step.tokens)} tok in ${seconds(step.ms)}`;
  const at = clock(step.at);
  if (at) text += ` · ${at}`;
  if (step.cost > 0) text += ` · ${money4(step.cost)}`;
  if (step.sub) text += ' · subagent';
  return text;
}

function drawSteps(data) {
  const svg = ui.stepsChart;
  const width = Math.max(140, svg.clientWidth || 300);
  const height = Math.max(86, svg.clientHeight || 86);
  const pad = 6;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const all = Array.isArray(data.steps) ? data.steps : [];
  const steps = all.filter((step) => step.tps && step.tps > 0 && !step.aborted);
  // The count is every step the session and its subagents ran, not only the
  // bars the meter can draw or rate.
  const known = data.stepsKnown ?? all.length;
  ui.stepsCount.textContent = `${known} step${known === 1 ? '' : 's'}`;
  ui.stepsCount.title =
    (data.subagents?.loading ?? 0) > 0 || (data.subagents?.partial ?? 0) > 0 || data.historyPartial
      ? 'history is partial; the count is a lower bound'
      : known > all.length
        ? `the last ${all.length} steps are drawn`
        : 'every step the meter keeps';
  // A list that shrank under the pointer has no bar at that index any more.
  if (stepHover !== null && stepHover >= steps.length) stepHover = null;
  const hover = stepHover;
  if (steps.length === 0) {
    ui.stepsAvg.textContent = '';
    ui.stepsPeak.textContent = '';
    ui.stepsAxis.hidden = true;
    ui.stepsHover.hidden = true;
    ui.stepsHover.textContent = '';
    drawnSteps = [];
    drawnSlot = 0;
    if (data.steps === lastDrawnSteps && width === lastDrawnW && height === lastDrawnH) return;
    lastDrawnSteps = data.steps;
    lastDrawnW = width;
    lastDrawnH = height;
    lastDrawnHover = null;
    svg.innerHTML = `<text x="${(width / 2).toFixed(1)}" y="${(height / 2).toFixed(1)}" text-anchor="middle" fill="var(--oc-muted)" font-size="11">no finished steps yet</text>`;
    return;
  }
  ui.stepsAxis.hidden = false;
  ui.stepsStart.textContent = data.stepsFrom ? `start ${clock(data.stepsFrom)}` : '';
  ui.stepsStart.title = 'the first step on the chart';
  ui.stepsNow.textContent = `now ${clock(Date.now())}`;
  ui.stepsNow.title = 'the current time';
  // Tokens over stream time across the bars on screen: the green line and the
  // label describe the same steps the chart draws.
  const totalTokens = steps.reduce((sum, step) => sum + step.tokens, 0);
  const totalMs = steps.reduce((sum, step) => sum + step.ms, 0);
  const average = totalMs > 0 ? (totalTokens / totalMs) * 1000 : 0;
  const peak = steps.reduce((best, step) => Math.max(best, step.tps), 0);
  // The tallest step is the top of the plot: the chart's job is to show the
  // shape of the session against its own best, and any rounding above the peak
  // only left an empty band above the bars.
  const max = peak > 0 ? peak : 1;
  const slot = width / steps.length;
  // With every step on the chart a long session gets one-pixel bars; a gap
  // under half a pixel would just erase them.
  const barWidth = Math.max(1, Math.min(14, slot - 1));
  ui.stepsAvg.textContent = average > 0 ? `avg ${Math.round(average)} t/s` : '';
  ui.stepsPeak.textContent = peak > 0 ? `peak ${Math.round(peak)} t/s` : '';
  // The readout takes the axis row while a bar is under the pointer: the two
  // time labels have nothing to say about one step.
  if (hover === null) {
    ui.stepsHover.hidden = true;
    ui.stepsHover.textContent = '';
    ui.stepsStart.hidden = false;
    ui.stepsNow.hidden = false;
  } else {
    ui.stepsHover.hidden = false;
    ui.stepsHover.textContent = stepReadout(steps[hover]);
    ui.stepsStart.hidden = true;
    ui.stepsNow.hidden = true;
  }
  // The pointer handler maps a position to the bar under it with these, so they
  // always describe the list that was last drawn.
  drawnSteps = steps;
  drawnSlot = slot;
  // Nothing changed: keep the bars, and with them the column the pointer is
  // reading. This runs four times a second and rebuilding a thousand rects each
  // time was the most expensive thing on the page.
  if (data.steps === lastDrawnSteps && width === lastDrawnW && height === lastDrawnH && hover === lastDrawnHover) return;
  lastDrawnSteps = data.steps;
  lastDrawnW = width;
  lastDrawnH = height;
  lastDrawnHover = hover;
  const pieces = [];
  if (hover !== null) {
    pieces.push(
      `<rect x="${(hover * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}" fill="var(--oc-fg)" opacity="0.08" data-role="step-hover-col" />`,
    );
  }
  steps.forEach((step, index) => {
    const h = Math.max(1.5, (step.tps / max) * (height - pad * 2));
    const x = index * slot + (slot - barWidth) / 2;
    const y = height - pad - h;
    const fill = step.sub ? 'var(--oc-info)' : 'var(--oc-primary)';
    const opacity = index === hover ? 1 : 0.4 + 0.6 * (index / Math.max(1, steps.length - 1));
    const role = index === hover ? ' data-role="step-hover"' : '';
    pieces.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}" opacity="${opacity.toFixed(2)}"${role} />`,
    );
  });
  // The session's own average and best step, over the bars drawn: the same
  // numbers the header shows, in the same colours.
  if (average > 0) {
    const avgY = height - pad - (average / max) * (height - pad * 2);
    pieces.push(
      `<line x1="0" y1="${avgY.toFixed(1)}" x2="${width}" y2="${avgY.toFixed(1)}" stroke="var(--oc-success)" stroke-width="1" stroke-dasharray="3 3" opacity="0.75" />`,
    );
  }
  if (peak > 0) {
    const peakY = height - pad - (peak / max) * (height - pad * 2);
    pieces.push(
      `<line x1="0" y1="${peakY.toFixed(1)}" x2="${width}" y2="${peakY.toFixed(1)}" stroke="var(--oc-error)" stroke-width="1" stroke-dasharray="2 3" opacity="0.7" />`,
    );
  }
  svg.innerHTML = pieces.join('');
}

const SUB_STATUS_TEXT = { tool: 'tool', 'waiting-permission': 'permission', 'waiting-question': 'question' };

function subRateText(item) {
  if (item.status === 'streaming') return item.tps >= 1 ? `${Math.round(item.tps)} t/s` : 'thinking';
  return SUB_STATUS_TEXT[item.status] ?? '';
}

/**
 * The rail panel's list of subagents that are still working. The headline above
 * is their sum plus the session's own rate, so each row says what it adds. Six
 * rows fit; the rest are counted.
 */
let subRowNodes = new Map();
let subSignature = '';

function paintSubagents(active, running, total) {
  ui.legend.hidden = total === 0;
  if (active.length === 0) {
    ui.subsBlock.hidden = true;
    if (subSignature) {
      ui.subsList.textContent = '';
      subRowNodes = new Map();
      subSignature = '';
    }
    return;
  }
  ui.subsBlock.hidden = false;
  ui.subsMeta.textContent = running < total ? `${running} running · ${total} total` : `${running} running`;
  const shown = active.slice(0, 6);
  // Rebuild only when who is working changes; a rate ticks every poll and only
  // its text is replaced, so a row can be read or hovered without flicker.
  const signature = `${running}:${total}:${shown.map((item) => `${item.id}:${item.status}:${item.title ?? ''}`).join('|')}`;
  if (signature !== subSignature) {
    subSignature = signature;
    subRowNodes = new Map();
    ui.subsList.textContent = '';
    for (const item of shown) {
      const row = el('div', 'sub-row');
      const dot = el('i', 'dot');
      dot.dataset.state = dotState(item.status);
      const title = el('span', 'sub-title', item.title || 'subagent');
      title.title = item.title || item.id || '';
      const rate = el('span', 'sub-rate', subRateText(item));
      row.append(dot, title, rate);
      subRowNodes.set(item.id, rate);
      ui.subsList.append(row);
    }
    if (running > shown.length) ui.subsList.append(el('div', 'sub-more', `+${running - shown.length} more`));
  }
  for (const item of shown) {
    const rate = subRowNodes.get(item.id);
    if (rate) rate.textContent = subRateText(item);
  }
}

function clearNotice() {
  noticeView?.dispose();
  noticeView = null;
  if (notice) notice.textContent = '';
}

function showNotice(kind, tone, title, body) {
  if (noticeView) return;
  noticeView = kind === 'empty' ? mountEmpty(notice, { title, body }) : mountBanner(notice, { tone, title, body });
}

function render(data) {
  if (!ui) return;
  if (data.ok === false) {
    showNotice('banner', 'warning', 'Token meter cannot read this session', data.error || 'OpenCode access is not available.');
    return;
  }
  clearNotice();

  // A subagent's chat can reach the host without a model in its context; the
  // recovered rates still know it, so name it instead of leaving a dash.
  if (!modelLabel && data.cost?.rates?.model) {
    modelLabel = data.cost.rates.model;
    ui.eyebrow.textContent = modelLabel;
  }

  const quiet = (data.live?.charsPerSecond ?? 0) < 5;
  const subagents = data.subagents ?? { count: 0, running: 0, loading: 0, streaming: 0, tool: 0, active: [] };
  const activeSubs = Array.isArray(subagents.active) ? subagents.active : [];
  const runningSubs = subagents.running ?? activeSubs.length;
  const loadingSubs = subagents.loading ?? 0;
  const partialSubs = subagents.partial ?? 0;
  const historyPartial = Boolean(data.historyPartial);
  const subLabel = subagents.count > 0 ? `${subagents.count} subagent${subagents.count === 1 ? '' : 's'}` : '';
  ui.dot.dataset.state = dotState(data.status);
  ui.statusLabel.textContent = STATUS[data.status] ?? STATUS.idle;
  // How long the running turn has been going: the same clock the chart uses, so
  // the label and the curve never disagree about "now".
  if (data.turn?.active && data.turn.startedAt) {
    const elapsed = duration(projectedNow(data) - data.turn.startedAt);
    if (elapsed) ui.statusLabel.textContent += ` · ${elapsed}`;
  }
  // The number is eased in animateSpeed; render only says where it should go.
  targetTps = data.status === 'streaming' ? (data.live?.tps ?? 0) : 0;
  if (lastRounded === -1) {
    shownTps = targetTps;
    lastRounded = Math.round(shownTps);
    ui.tpsValue.textContent = String(lastRounded);
  }
  const quietRate = data.status === 'streaming' && quiet;
  streamingNow = data.status === 'streaming' && !quiet;
  ui.tpsValue.classList.toggle('quiet', quietRate);
  paintTier();
  ui.tpsSub.textContent =
    data.status === 'streaming'
      ? quiet
        ? data.live?.subagent
          ? 'a subagent is thinking · nothing streamed in the last 3 s'
          : 'thinking · nothing streamed in the last 3 s'
        : data.live?.subagent
          ? `${subagents.streaming > 1 ? `${subagents.streaming} subagents are` : 'a subagent is'} generating · ~${compact(data.live?.charsPerSecond ?? 0)} chars/s`
          : `last 3 s · ~${compact(data.live?.charsPerSecond ?? 0)} chars/s`
      : data.status === 'tool'
        ? data.live?.subagent
          ? 'a subagent is running a tool · the model is not streaming'
          : 'a tool is running · the model is not streaming'
        : data.status === 'waiting-permission'
          ? 'paused on a permission request'
          : data.status === 'waiting-question'
            ? 'paused on a question'
            : data.live?.ttftMs
            ? `first token took ${seconds(data.live.ttftMs)}`
            : data.loading
              ? 'reading this session’s history'
              : 'no generation right now';

  drawLive(data);
  drawSteps(data);
  paintSubagents(activeSubs, runningSubs, subagents.count ?? 0);

  const lastStep = data.live?.lastStep;
  const lastSub = lastStep?.sub ? ' · subagent' : '';
  const lastCost = typeof data.cost?.lastTurn === 'number' ? ` · ${money4(data.cost.lastTurn)}` : '';
  if (lastStep?.tps) {
    ui.lastRate.textContent = `last ${Math.round(lastStep.tps)} t/s`;
    // Classify the digits on screen, exactly like the headline, so a 19.6 t/s
    // step printed as "20" is not coloured as a slow rate.
    ui.lastRate.dataset.tier = speedTier(Math.round(lastStep.tps));
    ui.lastRest.textContent = ` · ${seconds(lastStep.ms)} · ${compact(lastStep.tokens)} tok${lastSub}${lastCost}`;
  } else {
    ui.lastRate.textContent = '';
    delete ui.lastRate.dataset.tier;
    ui.lastRest.textContent = lastStep
      ? `last step ${seconds(lastStep.ms)} · ${compact(lastStep.tokens)} tok · too short to rate${lastSub}${lastCost}`
      : 'no finished step yet';
  }

  paintCells(rowNodes, data);
  paintCost(data);
  const totals = data.totals ?? {};
  ui.source.textContent = `${totals.source === 'usage' ? 'live' : 'from history'}${subLabel ? ` · ${subLabel}` : ''}`;
  ui.foot.textContent = data.error
    ? `cannot read history: ${data.error}`
    : loadingSubs > 0
      ? `reading ${loadingSubs} subagent histor${loadingSubs === 1 ? 'y' : 'ies'}`
      : partialSubs > 0
        ? `${partialSubs} subagent histor${partialSubs === 1 ? 'y is' : 'ies are'} partial`
        : historyPartial
          ? 'history is partial'
          : data.stream?.state === 'open'
            ? 'live from OpenCode events'
            : data.stream?.state === 'retrying'
              ? 'events reconnecting'
              : data.stream?.state === 'off'
                ? 'totals update each turn · live rate unavailable'
                : 'connecting to OpenCode events';
}

function handleError(error) {
  const code = error instanceof HostRequestError ? error.code : '';
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'NO_SERVICE' || code === 'NOT_GRANTED' || code === 'SERVICE_FAILED' || code === 'DISABLED') {
    showNotice(
      'banner',
      'warning',
      'The token service is not running',
      code === 'SERVICE_FAILED'
        ? `The local service stopped: ${message}`
        : 'Open Settings → Extensions → Token Meter and allow the local service, then reopen this panel.',
    );
    return;
  }
  showNotice('banner', 'error', 'Token meter could not read the session', message);
}

let failures = 0;
let pollGeneration = 0;

function stopPolling() {
  pollGeneration += 1;
  if (timer) clearTimeout(timer);
  timer = null;
}

function startPolling() {
  stopPolling();
  if (!sessionId) return;
  // A poll already in flight when the session changes must not schedule a
  // second chain: two chains meant two requests per tick.
  const generation = pollGeneration;
  const loop = async () => {
    if (generation !== pollGeneration) return;
    await poll();
    if (generation !== pollGeneration || !sessionId) return;
    const delay = failures > 0 ? Math.min(5_000, POLL_MS * 2 ** Math.min(4, failures)) : POLL_MS;
    timer = setTimeout(() => void loop(), delay);
  };
  void loop();
}

async function poll() {
  if (!sessionId || inflight || document.hidden) return;
  const asked = sessionId;
  inflight = true;
  try {
    const result = await host.serviceRequest({
      method: 'GET',
      path: '/state',
      query: { session: asked, steps: String(lastStepsSeq) },
    });
    // The frame may have moved to another session while this was in flight. The
    // answer describes the session that just left, so it must not paint.
    if (asked !== sessionId) return;
    const data = JSON.parse(result.body);
    // An omitted list means the sequence matched: keep the copy already drawn.
    if (Array.isArray(data.steps)) {
      lastSteps = data.steps;
      lastStepsSeq = data.stepsSeq;
    } else {
      data.steps = lastSteps;
    }
    // Expanded once here: drawLive runs twelve times a second, and rebuilding
    // 240 objects per frame was pure garbage for the collector to sweep.
    data.points = seriesPoints(data);
    current = data;
    receivedAt = performance.now();
    failures = 0;
    render(data);
  } catch (error) {
    // A failure for the session that just left says nothing about this one.
    if (asked !== sessionId) return;
    failures += 1;
    handleError(error);
  } finally {
    inflight = false;
  }
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (!mounted) {
    mounted = true;
    ui = build();
    rowNodes = mountCells(ui.grid);
    const observer = new ResizeObserver(() => {
      if (current) {
        drawLive(current);
        drawSteps(current);
      }
    });
    observer.observe(ui.live);
    observer.observe(ui.stepsChart);
    // Hover is read from the pointer rather than a <title>: a native tooltip
    // takes a second to open, cannot be styled and cannot hold the whole
    // readout. Both handlers stay attached for the life of the frame.
    ui.live.addEventListener('pointermove', (event) => {
      liveHoverX = event.clientX - ui.live.getBoundingClientRect().left;
      if (current) drawLive(current);
    });
    ui.live.addEventListener('pointerleave', () => {
      liveHoverX = null;
      if (current) drawLive(current);
    });
    ui.stepsChart.addEventListener('pointermove', (event) => {
      if (drawnSteps.length === 0 || !(drawnSlot > 0)) return;
      const x = event.clientX - ui.stepsChart.getBoundingClientRect().left;
      const index = Math.min(drawnSteps.length - 1, Math.max(0, Math.floor(x / drawnSlot)));
      if (index === stepHover) return;
      stepHover = index;
      if (current) drawSteps(current);
    });
    ui.stepsChart.addEventListener('pointerleave', () => {
      if (stepHover === null) return;
      stepHover = null;
      if (current) drawSteps(current);
    });
    // Redraw between polls against the projected clock, but only while tokens
    // are moving and at a rate a 60 s curve needs: rebuilding the path at
    // 60 fps bought nothing and burnt CPU on every idle session.
    let lastPaint = 0;
    let lastFrame = 0;
    const paint = (stamp) => {
      const dt = lastFrame ? Math.min(200, stamp - lastFrame) : 16;
      lastFrame = stamp;
      if (ui && !document.hidden) {
        animateSpeed(dt);
        const moving = current && (current.status === 'streaming' || current.status === 'tool');
        if (moving && stamp - lastPaint >= 80) {
          lastPaint = stamp;
          drawLive(current);
        }
      }
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
  }
  const model = ctx.session?.model;
  modelLabel = typeof model === 'string' ? model.replace(/^.*\//, '') : typeof model?.name === 'string' ? model.name : '';
  ui.eyebrow.textContent = modelLabel;
  const nextSession = ctx.session?.id ?? null;
  if (nextSession === sessionId) return;
  // A new session starts from zero: the frame keeps painting before the first
  // answer arrives, so the previous session's digits, tier, chart scale and
  // last-step line must not survive the switch.
  targetTps = 0;
  shownTps = 0;
  lastRounded = 0;
  streamingNow = false;
  lastTier = '';
  liveScale = 1;
  ui.tpsValue.textContent = '0';
  delete ui.tpsValue.dataset.tier;
  ui.lastRate.textContent = '';
  ui.lastRest.textContent = 'no finished step yet';
  delete ui.lastRate.dataset.tier;
  lastSteps = [];
  lastStepsSeq = -1;
  // The drawn chart belongs to the session that left: force the empty one.
  lastDrawnSteps = null;
  stepHover = null;
  liveHoverX = null;
  sessionId = nextSession;
  current = null;
  clearNotice();
  // Everything on screen describes the session that left: its totals, cost,
  // steps, curve and subagents. Painted empty here, they cannot sit under the
  // new session's name until its first answer lands.
  paintCells(rowNodes, {});
  paintCost({});
  paintSubagents([], 0, 0);
  drawSteps({ steps: [], stepsKnown: 0 });
  drawLive({ points: [], rates: { avg: 0, peak: 0 } });
  // An empty window raises the curve's floor to 8 t/s; the session that follows
  // must be free to choose its own scale from the first sample.
  liveScale = 1;
  ui.source.textContent = '';
  if (!sessionId) {
    ui.app.style.display = 'none';
    stopPolling();
    showNotice('empty', 'neutral', 'No session open', 'Open a chat and this panel follows it.');
    return;
  }
  ui.app.style.display = '';
  startPolling();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll();
});
