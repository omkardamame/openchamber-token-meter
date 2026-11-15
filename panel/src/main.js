import { HostRequestError, connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountEmpty } from '@openchamber/sdk/ui';
import { compact, duration, seconds } from '../../shared/summary.js';
import { easeToward, seriesPoints, smoothPath } from '../../shared/chart.js';
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
let lastSteps = [];
let lastStepsSeq = -1;
let targetTps = 0;
let shownTps = 0;
let lastRounded = -1;
let streamingNow = false;
let lastTier = '';
let modelLabel = '';
let liveHoverX = null;
// How much history the live chart draws. Zoom (wheel) widens this; the service
// keeps enough samples to fill it.
let liveWindowMs = 60_000;
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
      <div class="block-head" title="Every step since the session started, not one turn"><span>Session details</span><span class="block-meta totals-source"></span></div>
      <div class="grid totals-grid"></div>
    </section>

    <section class="block cost">
      <div class="block-head" title="This session and its subagents"><span>Cost</span></div>
      <div class="grid cost-grid">
        <div class="cell"><span class="cell-label">Total<i class="api-badge" hidden>API</i></span><span class="cell-value cost-total">—</span></div>
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

    <div class="foot"><span class="foot-text">reading OpenCode usage</span><span class="foot-clock"></span></div>
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
    apiBadge: app.querySelector('.api-badge'),
    footClock: app.querySelector('.foot-clock'),
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

/**
 * The reader's own clock, in their timezone and their 12/24-hour habit: the
 * locale decides both, so nothing here is configured.
 */
function localNow() {
  const now = new Date();
  return `${now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' })} · ${now.toLocaleTimeString(
    undefined,
    { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  )}`;
}

/** A per-million rate, where the interesting digits are small. */
function rateMoney(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n < 1 ? n.toFixed(2) : n.toFixed(1)}`;
}

/** A list rate per million: cheap rates keep their significant digits. */
function listRate(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  if (n < 0.001) return `$${n.toFixed(4)}`;
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Money for a headline: the magnitude decides the precision. A subscription's
 * API value is often four figures, a turn is often cents, and printing
 * `$1180.0000` would bury the number that matters.
 */
function moneyValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  }
  if (Math.abs(value) >= 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

/** One row of the rates table: a label and the four published numbers. */
function rateRow(name, rates, options = {}) {
  const node = el('div', 'rate-row');
  if (options.tier) {
    node.dataset.tier = options.tier;
    node.dataset.active = options.active ? 'true' : 'false';
  }
  node.append(
    el('span', 'rate-name', name),
    el('span', 'rate-num', listRate(rates.input)),
    el('span', 'rate-num', listRate(rates.output)),
    el('span', 'rate-num', listRate(rates.cacheRead)),
    el('span', 'rate-num', listRate(rates.cacheWrite)),
  );
  return node;
}

function rateHead() {
  const head = el('div', 'rate-row rate-head');
  head.append(
    el('span', 'rate-name', 'rates / 1M'),
    el('span', 'rate-num', 'in'),
    el('span', 'rate-num', 'out'),
    el('span', 'rate-num', 'read'),
    el('span', 'rate-num', 'write'),
  );
  return head;
}

/** Where the number came from, when, and whether it disagrees with the record. */
function sourceLine(cost, source) {
  const line = el('div', 'rate-source');
  const parts = [source ?? 'published'];
  if (cost.rates?.checkedAt) parts.push(cost.rates.checkedAt);
  const models = Array.isArray(cost.models) ? cost.models : null;
  if (models && models.length > 1) parts.push(`+${models.length - 1} model${models.length === 2 ? '' : 's'}`);
  line.textContent = parts.join(' · ');
  if (cost.drift) line.append(el('span', 'rate-flag', ' price drift'));
  return line;
}

/** How old a price snapshot is, when it is old enough to say so (spec §9.3). */
function snapshotAge(cost) {
  const at = Date.parse(`${cost.rates?.checkedAt ?? ''}T00:00:00Z`);
  if (!Number.isFinite(at)) return '';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days > 30 ? `, ${days} days old` : '';
}

function ratesTitle(cost, source) {
  const parts = [];
  if (source) parts.push(source);
  if (cost.rates?.checkedAt) parts.push(`snapshot ${cost.rates.checkedAt}${snapshotAge(cost)}`);
  if (cost.rates?.match) parts.push(`matched by ${cost.rates.match}`);
  if (cost.rates?.tier) parts.push(`above ${compact(cost.rates.tier.minContext)} tokens the context tier applies`);
  if (cost.drift) {
    parts.push(
      `API value $${cost.total.toFixed(4)} against $${(cost.billed?.total ?? 0).toFixed(4)} recorded (${(cost.drift.relative * 100).toFixed(1)}%)`,
    );
  }
  const models = Array.isArray(cost.models) ? cost.models : null;
  if (models && models.length > 1) {
    parts.push(
      `this total covers ${models
        .map((entry) => `${entry.name ?? entry.model} ${moneyValue(entry.apiValue)}`)
        .join(', ')}`,
    );
  }
  return parts.join(' · ');
}

/**
 * What this session and its subagents would cost at list rates, the turn that is
 * running (or the last one), the model behind it and its effective rate.
 *
 * The headline is API value, a counterfactual: it is never called spend. The
 * recorded cost stays beside it, in the tooltip and in the billed row, and
 * `mode` says which one the service sent.
 */
function paintCost(data) {
  const cost = data.cost ?? {};
  const turn = data.turn ?? {};
  const api = cost.mode === 'api';
  const priced = typeof cost.total === 'number';
  const floor = cost.lowerBound ? '≥ ' : '';
  const source = cost.rates?.source ?? null;
  const money = api ? moneyValue : money4;

  ui.apiBadge.hidden = !api;
  ui.costTotal.textContent = priced ? `${floor}${money(cost.total)}` : '—';
  ui.costTotal.title = api
    ? priced
      ? [
          `API value at ${source ?? 'published'} rates`,
          `billed ${moneyValue(cost.billed?.total ?? 0)}`,
          cost.lowerBound
            ? `${Math.round((cost.coverage ?? 0) * 100)}% of these tokens have a published rate, so this is a lower bound${
                Array.isArray(cost.unpriced) && cost.unpriced.length
                  ? ` · no rate for ${cost.unpriced
                      .slice(0, 3)
                      .map((entry) => entry.model ?? entry.provider ?? 'an unknown model')
                      .join(', ')}${cost.unpriced.length > 3 ? ` and ${cost.unpriced.length - 3} more` : ''}`
                  : ''
              }`
            : '',
          cost.drift ? 'the rate table disagrees with the recorded cost; open the rates line for both numbers' : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : `no step has a published rate; billed ${moneyValue(cost.billed?.total ?? 0)}`
    : cost.tariff
      ? 'OpenCode’s recorded cost; the active side of the rate table is what the provider charges'
      : 'this session and its subagents, as OpenCode recorded it';

  ui.costTurn.textContent = priced ? `${floor}${money(cost.lastTurn)}` : '—';
  ui.costTurn.title =
    (data.subagents?.loading ?? 0) > 0 || (data.subagents?.partial ?? 0) > 0 || data.historyPartial
      ? 'history is partial; the last turn can grow'
      : turn.steps > 0
        ? `${turn.steps} step${turn.steps === 1 ? '' : 's'} · ${compact(turn.tokens)} generated tokens${
            api ? ' · API value, not the bill' : ''
          }`
        : '';

  // The card's own display name, or the session's model when nothing is priced.
  ui.costModel.textContent = cost.rates?.name || modelLabel || cost.rates?.model || '—';
  ui.costModel.title = cost.rates
    ? `${cost.rates.provider}/${cost.rates.model}${cost.rates.source ? ` · ${cost.rates.source}` : ''}`
    : modelLabel || '';

  // A lower bound's effective rate is computed over the priced tokens only, so
  // it wears the same `~` as the total (spec D13).
  const effective = typeof cost.perMillion === 'number' ? `${rateMoney(cost.perMillion)} / 1M` : '—';
  ui.costRate.textContent = cost.lowerBound && typeof cost.perMillion === 'number' ? `~${effective}` : effective;
  ui.costRate.title = api
    ? `API value divided by ${
        cost.lowerBound ? 'the tokens that have a published rate' : 'every token this tree processed'
      } · billed ${rateMoney(cost.billed?.perMillion ?? 0)} / 1M`
    : 'effective: this session’s cost divided by every token it processed';

  // A card is resolved for the current model, so it is never stale. Recovered
  // rates are keyed by the model id the session ran, and a switch leaves them
  // behind; the tariff is keyed the same way.
  const sameModel = !cost.rates || !modelLabel || cost.rates.model === modelLabel;
  const cardIsCurrent = Boolean(api && cost.rates && cost.rates.match !== 'recovered');
  const tariff = cost.tariff && (cardIsCurrent || sameModel) && (!modelLabel || cost.tariff.model === modelLabel) ? cost.tariff : null;
  const rates = cost.rates && (cardIsCurrent || sameModel) ? cost.rates : null;
  const steps = data.stepsKnown ?? data.totals?.steps ?? 0;

  // Without a book the service sends the recorded cost and rates recovered from
  // its steps. That path keeps its own drawing: an older service must read
  // exactly as it did.
  if (!api) {
    paintRecoveredRates(cost, rates, tariff);
    return;
  }

  // Nothing has finished yet: a card in the book says what the model will cost,
  // not what this session has run. Say that instead of drawing a table of zeroes.
  if (steps === 0) {
    const line = el('div', 'rate-source');
    line.textContent = 'waiting for the first step';
    ui.costRates.replaceChildren(line);
    ui.costRates.title = 'no step has finished yet; the first one brings this session’s rates';
    return;
  }

  if (!rates && !tariff) {
    const line = el('div', 'rate-source');
    line.textContent = 'no published rate';
    ui.costRates.replaceChildren(line);
    ui.costRates.title = 'this model has no published rate, and the meter does not guess one from a neighbour';
    return;
  }

  if (cost.priceNote === 'free' && rates) {
    const line = el('div', 'rate-source');
    line.textContent = `free · in ${listRate(0)} · out ${listRate(0)} · read ${listRate(0)} · write ${listRate(0)}`;
    ui.costRates.replaceChildren(line);
    ui.costRates.title = `${rates.provider}/${rates.model} is published at zero; these tokens would cost nothing at list price`;
    return;
  }

  if (tariff?.tiers) {
    const peak = Boolean(tariff.peak);
    const active = peak ? tariff.tiers.peak : tariff.tiers.offPeak;
    const other = peak ? tariff.tiers.offPeak : tariff.tiers.peak;
    const from = tariff.source === 'recovered' ? 'billed rates' : (rates?.source ?? 'published card');
    ui.costRates.replaceChildren(
      rateHead(),
      rateRow(peak ? 'peak now' : 'off-peak now', active, { active: true, tier: peak ? 'peak' : 'off-peak' }),
      rateRow(peak ? 'off-peak' : 'peak', other, { active: false, tier: peak ? 'off-peak' : 'peak' }),
      sourceLine({ ...cost, rates: rates ?? cost.rates }, from),
    );
    ui.costRates.title = `${from} · ${tariff.provider === 'opencode-go' ? 'OpenCode Go' : tariff.provider} peak: ${tariff.window}; peak is ${tariff.multiplier}× off-peak. ${
      tariff.holidayYear
        ? `Chinese public holidays are off-peak (${tariff.holidayYear} calendar${tariff.holidayStale ? '; update it for the current year' : ''}). `
        : ''
    }${tariff.source === 'recovered' ? 'rates recovered from this session’s step costs' : 'rates from the published price card'}.${
      rates?.checkedAt ? ` Snapshot ${rates.checkedAt}${snapshotAge({ rates })}.` : ''
    }`;
    return;
  }

  const label =
    rates.match === 'recovered'
      ? 'billed'
      : rates.match === 'override'
        ? 'manual'
        : rates.tier
          ? `context >${compact(rates.tier.minContext)}`
          : 'list';
  // An active context tier carries its own four rates; prefer them over the
  // base, so the numbers under a `context >Nk` label are that band's.
  const shown = rates.tier?.rates ? { ...rates, ...rates.tier.rates } : rates;
  ui.costRates.replaceChildren(rateHead(), rateRow(label, shown), sourceLine(cost, rates.source));
  ui.costRates.title = ratesTitle(cost, rates.source);
}

/** The no-book drawing: recovered rates only, exactly as the meter always drew them. */
function paintRecoveredRates(cost, rates, tariff) {
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
    }${tariff.source === 'recovered' ? 'rates recovered from this session’s step costs' : 'rates from the published price card'}.`;
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

// The live chart's SVG is built once per size; after that only attributes
// change. Rebuilding the tree every frame meant parsing a new SVG 12.5 times a
// second, which is why the curve stepped instead of moving, and why raising the
// rate any further was too expensive to consider.
const LIVE_PARTS = [
  'avg',
  'avg-label',
  'baseline',
  'cross',
  'cross-dot',
  'dot',
  'fill',
  'half-grid',
  'half-label',
  'line',
  'peak',
  'peak-label',
  'time-0.25',
  'time-0.5',
  'time-0.75',
  'top-grid',
  'top-label',
];
let liveSkeleton = null;
let liveSkeletonKey = '';

function ensureLive(svg, width, height, pad) {
  const key = `${Math.round(width)}x${Math.round(height)}`;
  if (liveSkeletonKey === key && liveSkeleton) return liveSkeleton;
  liveSkeletonKey = key;
  const timeLines = [0.25, 0.5, 0.75]
    .map(
      (part) =>
        `<line data-n="time-${part}" x1="${(width * part).toFixed(1)}" y1="${pad}" x2="${(width * part).toFixed(1)}" y2="${(height - pad).toFixed(1)}" stroke="var(--oc-border)" stroke-width="1" opacity="0.5" data-role="time-grid" />`,
    )
    .join('');
  svg.innerHTML =
    `<defs><linearGradient id="tm-live-fill" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="var(--oc-primary)" stop-opacity="0.38" />` +
    `<stop offset="55%" stop-color="var(--oc-primary)" stop-opacity="0.12" />` +
    `<stop offset="100%" stop-color="var(--oc-primary)" stop-opacity="0" />` +
    `</linearGradient></defs>` +
    `<line data-n="top-grid" x1="0" x2="${width}" stroke="var(--oc-border)" stroke-width="1" stroke-dasharray="2 4" opacity="0.8" />` +
    `<text data-n="top-label" x="2" text-anchor="start" fill="var(--oc-muted)" font-size="9.5" opacity="0.8" data-role="grid-label"></text>` +
    `<line data-n="half-grid" x1="0" x2="${width}" stroke="var(--oc-border)" stroke-width="1" stroke-dasharray="2 4" opacity="0.8" />` +
    `<text data-n="half-label" x="2" text-anchor="start" fill="var(--oc-muted)" font-size="9.5" opacity="0.8" data-role="grid-label"></text>` +
    timeLines +
    `<line data-n="baseline" x1="0" x2="${width}" stroke="var(--oc-primary)" stroke-width="1.6" opacity="0.45" />` +
    `<path data-n="fill" fill="url(#tm-live-fill)" data-role="live-fill" />` +
    `<path data-n="line" fill="none" stroke="var(--oc-primary)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" data-role="live-line" />` +
    `<circle data-n="dot" r="2.6" fill="var(--oc-primary)" />` +
    `<line data-n="avg" x1="0" x2="${width}" stroke="var(--oc-success)" stroke-width="1" stroke-dasharray="3 3" opacity="0.7" data-role="live-avg" />` +
    `<text data-n="avg-label" x="${width - 2}" text-anchor="end" fill="var(--oc-success)" font-size="9.5" opacity="0.85"></text>` +
    `<line data-n="peak" x1="0" x2="${width}" stroke="var(--oc-error)" stroke-width="1" stroke-dasharray="2 3" opacity="0.65" data-role="live-peak" />` +
    `<text data-n="peak-label" x="${width - 2}" text-anchor="end" fill="var(--oc-error)" font-size="9.5" opacity="0.95"></text>` +
    `<line data-n="cross" stroke="var(--oc-fg)" opacity="0.35" stroke-width="1" data-role="live-cross" />` +
    `<circle data-n="cross-dot" r="3" fill="var(--oc-fg)" data-role="live-cross-dot" />`;
  const nodes = {};
  for (const node of svg.querySelectorAll('[data-n]')) nodes[node.getAttribute('data-n')] = node;
  liveSkeleton = nodes;
  return nodes;
}

/** A node that is not drawn this frame is hidden, never removed. */
const showPart = (node, on) => node.setAttribute('visibility', on ? 'visible' : 'hidden');
/** A hidden path also loses its `d`: an empty box is a truth a test or a hit test can read. */
const hidePath = (node) => {
  node.setAttribute('visibility', 'hidden');
  node.removeAttribute('d');
};
const placeY = (node, y, width) => {
  node.setAttribute('y1', y.toFixed(1));
  node.setAttribute('y2', y.toFixed(1));
  node.setAttribute('x2', width);
};

function drawLive(data) {
  const svg = ui.live;
  const width = Math.max(140, svg.clientWidth || 300);
  const height = Math.max(110, svg.clientHeight || 112);
  const pad = 8;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const nodes = ensureLive(svg, width, height, pad);
  const series = Array.isArray(data.points) ? data.points : [];
  const now = projectedNow(data);
  const from = now - liveWindowMs;
  const visible = series.filter((point) => point.t >= from && point.t <= now);
  const peakValue = visible.reduce((max, point) => Math.max(max, point.v), 0);
  // References drawn on the chart: the session's average and its best step,
  // worked out by the service over every step it knows.
  const rates = data.rates ?? { avg: 0, peak: 0 };

  // Draw a smoothed curve first: the samples are a 250 ms average already, and
  // the providers arrive in bursts, so a short exponential pass keeps the shape
  // without inventing points the service did not measure. The scale follows the
  // session's peak, so the plot's top is the number on the red line and the
  // line cannot drift; only a live estimate above that peak raises the ceiling.
  const smooth = [];
  for (const point of visible) {
    const previous = smooth[smooth.length - 1];
    const value = previous === undefined ? point.v : previous + (point.v - previous) * 0.3;
    smooth.push(value);
  }
  const liveTop = smooth.reduce((best, value) => Math.max(best, value), 0);
  // The top of the plot is the session's peak: its fastest finished step. The
  // red line sits on that edge and the curve scales under it, so the line means
  // what its label says instead of sliding as the window's own maximum moved.
  // The window's smoothed top still sets the scale when it beats the peak — a
  // live estimate is allowed to exceed the best finished step, and that sample
  // must not be drawn above the plot. The 8 t/s floor is for an empty window,
  // where every value on the axis would otherwise be zero.
  const max = Math.max(8, rates.peak, liveTop);
  const share = (value) => Math.min(1, Math.max(0, value) / max);
  const lineY = (value) => height - pad - share(value) * (height - pad * 2);
  const xOf = (point) => ((point.t - from) / liveWindowMs) * width;
  const baseline = height - pad;

  // The scale down the left edge: the top and the middle of the plot, labelled
  // with the rate they stand for. An empty or all-zero window says nothing,
  // because every number on it would be the 8 t/s floor, not a measurement.
  if (liveTop > 0) {
    const topValue = Math.round(max);
    const halfValue = Math.round(max / 2);
    const topY = lineY(max);
    const halfY = lineY(max / 2);
    placeY(nodes['top-grid'], topY, width);
    placeY(nodes['half-grid'], halfY, width);
    nodes['top-label'].textContent = String(topValue);
    nodes['top-label'].setAttribute('y', (topY + 10).toFixed(1));
    showPart(nodes['top-grid'], true);
    showPart(nodes['top-label'], true);
    // A scale near 1 rounds both lines to the same number; one label is enough.
    nodes['half-label'].textContent = String(halfValue);
    nodes['half-label'].setAttribute('y', (halfY - 3).toFixed(1));
    showPart(nodes['half-grid'], true);
    showPart(nodes['half-label'], halfValue !== topValue);
  } else {
    for (const name of ['top-grid', 'top-label', 'half-grid', 'half-label']) showPart(nodes[name], false);
  }

  let avgLabelY = null;
  if (rates.avg > 0) {
    const y = lineY(rates.avg);
    avgLabelY = y < pad + 10 ? y + 11 : y - 4;
    placeY(nodes.avg, y, width);
    nodes['avg-label'].textContent = `avg ${Math.round(rates.avg)} t/s`;
    nodes['avg-label'].setAttribute('y', avgLabelY.toFixed(1));
    showPart(nodes.avg, true);
    showPart(nodes['avg-label'], true);
  } else {
    showPart(nodes.avg, false);
    showPart(nodes['avg-label'], false);
  }

  if (rates.peak > 0) {
    const y = lineY(rates.peak);
    // How old the best step is: the scale is pinned to it, so "peak 337" beside
    // a 20 t/s stream needs the date to make sense.
    const age = rates.peakAt ? duration(now - rates.peakAt) : '';
    // Keep the labels apart when the lines are close. Above the average label
    // when there is room, so the peak label stays beside its own (higher) line;
    // on the top edge, stack it below instead of clipping it.
    let labelY = y < pad + 10 ? y + 11 : y - 4;
    if (avgLabelY !== null && Math.abs(labelY - avgLabelY) < 12) {
      const above = avgLabelY - 13;
      labelY = above > pad ? above : avgLabelY + 13;
    }
    if (labelY > height - 2) labelY = (avgLabelY ?? labelY) - 13;
    placeY(nodes.peak, y, width);
    nodes['peak-label'].textContent = `peak ${Math.round(rates.peak)} t/s${age ? ` · ${age} ago` : ''}`;
    nodes['peak-label'].setAttribute('y', labelY.toFixed(1));
    showPart(nodes.peak, true);
    showPart(nodes['peak-label'], true);
  } else {
    showPart(nodes.peak, false);
    showPart(nodes['peak-label'], false);
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
  if (hovered) {
    const cross = nodes.cross;
    cross.setAttribute('x1', hovered.x.toFixed(1));
    cross.setAttribute('x2', hovered.x.toFixed(1));
    cross.setAttribute('y1', String(pad));
    cross.setAttribute('y2', baseline.toFixed(1));
    nodes['cross-dot'].setAttribute('cx', hovered.x.toFixed(1));
    nodes['cross-dot'].setAttribute('cy', hovered.y.toFixed(1));
    showPart(cross, true);
    showPart(nodes['cross-dot'], true);
  } else {
    showPart(nodes.cross, false);
    showPart(nodes['cross-dot'], false);
  }

  if (smooth.length > 1) {
    const points = smooth.map((value, index) => ({ x: xOf(visible[index]), y: lineY(value) }));
    const line = smoothPath(points);
    const first = points[0];
    const last = points[points.length - 1];
    nodes.line.setAttribute('d', line);
    nodes.fill.setAttribute(
      'd',
      `${line} L ${last.x.toFixed(1)},${baseline.toFixed(1)} L ${first.x.toFixed(1)},${baseline.toFixed(1)} Z`,
    );
    nodes.dot.setAttribute('cx', last.x.toFixed(1));
    nodes.dot.setAttribute('cy', last.y.toFixed(1));
    showPart(nodes.line, true);
    showPart(nodes.fill, true);
    showPart(nodes.dot, true);
    showPart(nodes.baseline, false);
  } else if (smooth.length === 1) {
    // One sample is not a baseline: draw the point where it actually sits.
    nodes.dot.setAttribute('cx', xOf(visible[0]).toFixed(1));
    nodes.dot.setAttribute('cy', lineY(smooth[0]).toFixed(1));
    showPart(nodes.dot, true);
    hidePath(nodes.line);
    hidePath(nodes.fill);
    showPart(nodes.baseline, false);
  } else {
    showPart(nodes.dot, false);
    hidePath(nodes.line);
    hidePath(nodes.fill);
    showPart(nodes.baseline, true);
  }

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
// One row per running subagent, keyed by id, so a new one can slide in and a
// finished one can fade out instead of the list being rebuilt under the reader.
let subRows = new Map();

function paintSubagents(active, running, total) {
  ui.legend.hidden = total === 0;
  if (active.length === 0) {
    // Every row leaves at once. The block stays up until the last one has
    // finished fading: hiding it first would cut the animation off.
    const leaving = subRows.size;
    for (const [id, row] of subRows) {
      retireSubRow(id, row.node);
      subRows.delete(id);
    }
    if (ui.subsMore?.parentNode) ui.subsMore.remove();
    if (!leaving) ui.subsBlock.hidden = true;
    else setTimeout(() => {
      if (subRows.size === 0) ui.subsBlock.hidden = true;
    }, 160);
    return;
  }
  ui.subsBlock.hidden = false;
  ui.subsMeta.textContent = running < total ? `${running} running · ${total} total` : `${running} running`;
  const shown = active.slice(0, 6);
  const keep = new Set(shown.map((item) => item.id));

  // A row that is gone fades out where it was; the block keeps its height until
  // the animation ends, so the list does not jump under the pointer.
  for (const [id, row] of subRows) {
    if (keep.has(id)) continue;
    retireSubRow(id, row.node);
    subRows.delete(id);
  }

  for (const item of shown) {
    // A subagent that comes back while its row is still fading takes the row
    // over instead of leaving a ghost behind.
    const ghost = ui.subsList.querySelector(`[data-sub="${item.id}"]`);
    let row = subRows.get(item.id);
    if (row && row.node !== ghost) {
      row = undefined;
      subRows.delete(item.id);
    }
    if (ghost && !row) ghost.remove();
    if (!row) {
      const node = el('div', 'sub-row');
      node.dataset.sub = item.id;
      const dot = el('i', 'dot');
      const title = el('span', 'sub-title');
      const rate = el('span', 'sub-rate');
      node.append(dot, title, rate);
      row = { dot, node, rate, title };
      subRows.set(item.id, row);
      // The enter animation lives in CSS, so a reduced-motion reader gets none.
      node.classList.add('sub-in');
      node.addEventListener('animationend', () => node.classList.remove('sub-in'), { once: true });
    }
    row.dot.dataset.state = dotState(item.status);
    row.title.textContent = item.title || 'subagent';
    row.title.title = item.title || item.id || '';
    row.rate.textContent = subRateText(item);
    // appendChild moves an existing node, which is the whole reorder.
    ui.subsList.append(row.node);
  }

  const more = running > shown.length ? `+${running - shown.length} more` : '';
  if (more) {
    if (!ui.subsMore) ui.subsMore = el('div', 'sub-more');
    ui.subsMore.textContent = more;
    ui.subsList.append(ui.subsMore);
  } else if (ui.subsMore?.parentNode) {
    ui.subsMore.remove();
  }
}

/** Fade a row out, then drop it. Removing it at once would make the list snap. */
function retireSubRow(id, node) {
  if (node.dataset.leaving === id) return;
  node.dataset.leaving = id;
  node.classList.add('sub-out');
  const drop = () => node.remove();
  node.addEventListener('animationend', drop, { once: true });
  // A reader who asked for no motion gets no animationend: drop it on a timer.
  setTimeout(drop, 200);
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
  // `live` says the session is working right now, not where the numbers came
  // from: an idle session keeps its usage record, and labelling a frozen number
  // "live" is the one thing a dashboard must not do.
  const working = data.status === 'streaming' || data.status === 'tool' || data.status === 'waiting-permission';
  const origin = working ? 'live' : totals.source === 'history' ? 'from history' : '';
  ui.source.textContent = [origin, subLabel].filter(Boolean).join(' · ');
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
        // The update is a handful of attribute writes now, so the curve can
        // follow the screen instead of stepping at 12.5 fps.
        if (moving && stamp - lastPaint >= 16) {
          lastPaint = stamp;
          drawLive(current);
        }
      }
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
    // The reader's own clock at the bottom: the rail doubles as a dashboard, and
    // a screenshot of it should say when it was taken.
    if (ui.footClock) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      ui.footClock.title = zone ? `your time · ${zone}` : 'your time';
      const tickClock = () => {
        if (ui) ui.footClock.textContent = localNow();
      };
      tickClock();
      setInterval(tickClock, 1_000);
    }
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
