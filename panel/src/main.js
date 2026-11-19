import { HostRequestError, connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountEmpty, mountTextField } from '@openchamber/sdk/ui';
import { compact, duration, percent, seconds } from '../../shared/summary.js';
import { createCurveMotion, drawDue, easeToward, rateCeiling, rateTicks, seriesPoints, smoothPath, symlogShare } from '../../shared/chart.js';
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
// How much history the live chart draws. The wheel widens it; the service keeps
// a coarse five-minute series beside the 60 s one so there is something to show.
const ZOOM_MIN_MS = 60_000;
const ZOOM_MAX_MS = 3_600_000;
// A notch is a ratio, not a rung: many small steps read as one smooth gesture
// instead of three jumps.
const ZOOM_STEP = 1.18;
const ZOOM_EASE_MS = 170;
// An idle chart only slides sideways: one pixel per step at the default zoom.
// Redrawing it at the display rate rebuilt the same path 60 times a second and
// cost ~25% of a core (issue #1). A poll answer still draws on arrival.
const IDLE_DRAW_MS = 200;
// Long enough to read the wider view, short enough that it is a passing look.
// Hovering the chart holds it; leaving starts the clock again.
// One minute in use. A page test sets window.__zoomResetMs to watch the reset
// happen without making every run wait a minute.
const zoomResetMs = () => Number(window.__zoomResetMs) || 60_000;
let liveWindowMs = ZOOM_MIN_MS;
let liveTargetMs = ZOOM_MIN_MS;
let liveHovering = false;
let zoomResetAt = 0;
// Per step zooms the other way: bars are thinned, not widened, and the count
// eases too so the bars slide in and out instead of blinking.
const STEP_MIN_BARS = 20;
let stepTarget = 0; // 0 means every bar
let stepShown = 0;
let stepFull = 0;
let stepHovering = false;
let stepResetAt = 0;
// Bars the per-step window is scrolled back from the newest one.
let stepPan = 0;
// A member id, or null for the whole tree: the step chart shows one subagent at
// a time when a roster row is selected.
let stepFilter = null;
let stepDrag = null;
let peakLineY = null;
// When the ceiling last rose. A live burst moves it as surely as a finished
// step does, so the age describes the peak on screen, not the last step.
let peakSince = 0;
let peakSinceValue = 0;
let peakSeeded = false;
let liveHoverY = null;
let peakHover = false;
// The chart's ceiling is the session's best step by default; the other mode
// scales to this turn, which is what a long session needs to stay readable.
let ceilingMode = 'session';
let sessionTitle = '';
// The detail list is a look, not a fixture: it closes itself a minute after the
// last hover, and the running-subagent block above is never touched by it.
let subsDetailOpen = false;
let subsDetailUntil = 0;
let subsDetailKey = '';
let stepHover = null;
let lastDrawnSteps = null;
let lastDrawnLimit = null;
let lastDrawnKey = '';
let lastDrawnW = 0;
let lastDrawnH = 0;
let lastDrawnHover = null;
let plottedCeiling = 0;
let drawnSteps = [];
let drawnSlot = 0;
// The bar nodes of the last full draw, so a pointer move can restyle one bar
// and move the highlight column instead of rebuilding a thousand rects.
let drawnBars = [];
let drawnHoverCol = null;
// The last idle flat-zero drawing, so the live loop can skip a picture that
// cannot change (see drawLive).
let lastIdleKey = null;
let lastIdleDrawAt = -Infinity;
const animateCurve = createCurveMotion();

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
        <span class="stat-label" title="Estimated from streamed characters; the latest value is held to now between updates">live</span>
        <span class="speed-value" title="the session and every streaming subagent, added together"><b class="tps-value">0</b><i>t/s</i></span>
        <span class="speed-note tps-sub">no generation right now</span>
        <span class="speed-last last-line"><span class="last-rate"></span><span class="last-rest"></span></span>
      </div>
      <div class="chart-wrap"><svg class="chart" data-chart="live" aria-hidden="true"></svg></div>
      <div class="axis"><span class="axis-from">60 s ago</span><span class="axis-peak"></span><span class="axis-to">now</span></div>
    </section>

    <section class="block subagents" hidden>
      <div class="block-head" title="Each subagent still working, with its own rate; the headline adds them up"><span>Subagents</span><span class="block-meta subs-meta"></span></div>
      <div class="subs-list"></div>
    </section>

    <section class="block">
      <section class="block subs-detail" hidden>
        <div class="block-head" title="Every subagent session in this tree"><span>Subagent sessions</span><span class="block-meta subs-detail-meta"></span></div>
        <div class="subs-detail-list"></div>
      </section>
      <div class="block-head" title="Every step since the session started, not one turn"><span>Session details</span><span class="block-meta totals-source"></span><button type="button" class="chip subs-toggle" hidden></button></div>
      <div class="grid totals-grid"></div>
    </section>

    <section class="block cost">
      <div class="block-head"><span title="This session and its subagents">Cost</span><button type="button" class="chip budget-chip" disabled>set budget</button></div>
      <div class="budget-form" hidden></div>
      <div class="grid cost-grid">
        <div class="cell"><span class="cell-label">Total<i class="api-badge" hidden>API</i></span><span class="cell-value cost-total">—</span></div>
        <div class="cell"><span class="cell-label">Last turn</span><span class="cell-value cost-turn">—</span></div>
        <div class="cell"><span class="cell-label">Model</span><span class="cell-value cost-model">—</span></div>
        <div class="cell"><span class="cell-label">Effective</span><span class="cell-value cost-rate">—</span></div>
      </div>
      <div class="cost-rates"></div>
    </section>

    <section class="block models" hidden>
      <div class="block-head" title="Every model this tree ran, with its own value"><span>Models</span><span class="block-meta models-meta"></span></div>
      <div class="models-list"></div>
    </section>

    <section class="block steps">
      <div class="block-head"><span>Per step <small>linear/log</small></span><span class="block-meta"><span class="steps-count"></span> <span class="steps-avg"></span> <span class="steps-peak"></span></span></div>
      <div class="chart-wrap"><svg class="chart" data-chart="steps" aria-hidden="true"></svg></div>
      <div class="steps-axis" hidden><span class="steps-start"></span><span class="steps-now"></span><span class="steps-hover" hidden></span></div>
      <div class="legend" hidden><span><i class="swatch main"></i>session</span><span><i class="swatch sub"></i>subagent</span></div>
    </section>

    <div class="foot">
      <span class="foot-text">reading OpenCode usage</span>
      <span class="foot-actions">
        <button type="button" class="chip foot-copy" title="this session's numbers as a markdown table">copy stats</button>
        <button type="button" class="chip foot-ceiling" title="the chart's ceiling: the whole session, or this turn">session peak</button>
      </span>
      <span class="foot-clock"></span>
    </div>
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
    axisFrom: app.querySelector('.axis-from'),
    axisTo: app.querySelector('.axis-to'),
    grid: app.querySelector('.grid'),
    source: app.querySelector('.totals-source'),
    costTotal: app.querySelector('.cost-total'),
    costTurn: app.querySelector('.cost-turn'),
    costModel: app.querySelector('.cost-model'),
    costRate: app.querySelector('.cost-rate'),
    costRates: app.querySelector('.cost-rates'),
    apiBadge: app.querySelector('.api-badge'),
    budgetChip: app.querySelector('.budget-chip'),
    budgetForm: app.querySelector('.budget-form'),
    footClock: app.querySelector('.foot-clock'),
    subsBlock: app.querySelector('.subagents'),
    subsMeta: app.querySelector('.subs-meta'),
    subsList: app.querySelector('.subs-list'),
    models: app.querySelector('.models'),
    modelsMeta: app.querySelector('.models-meta'),
    modelsList: app.querySelector('.models-list'),
    subsToggle: app.querySelector('.subs-toggle'),
    subsDetail: app.querySelector('.subs-detail'),
    subsDetailMeta: app.querySelector('.subs-detail-meta'),
    subsDetailList: app.querySelector('.subs-detail-list'),
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
    footCopy: app.querySelector('.foot-copy'),
    footCeiling: app.querySelector('.foot-ceiling'),
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A day and a time, in that order: a step chart can span midnight, and an hour
 * on its own then names two different bars. Built by hand rather than by locale
 * so the axis reads the same width everywhere.
 */
function dateClock(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock(at)}`;
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
        cost.lowerBound ? 'the tokens that have a published rate' : 'the tokens in the priced steps'
      } · billed ${rateMoney(cost.billed?.perMillion ?? 0)} / 1M${
        // The record can hold more steps than the meter keeps; say so, so the
        // Consumed cell and this rate can be reconciled.
        data.stepsKnown && data.steps?.length && data.stepsKnown > data.steps.length
          ? ` · the record holds ${compact(data.stepsKnown)} steps, ${compact(data.steps.length)} kept`
          : ''
      }`
    : 'effective: this session’s cost divided by every token it processed';

  // A card is resolved for the current model, so it is never stale. Recovered
  // rates are keyed by the model id the session ran, and a switch leaves them
  // behind; the tariff is keyed the same way.
  const sameModel = !cost.rates || !modelLabel || cost.rates.model === modelLabel;
  const cardIsCurrent = Boolean(api && cost.rates && cost.rates.match !== 'recovered');
  const tariff = cost.tariff && (cardIsCurrent || sameModel) && (!modelLabel || cost.tariff.model === modelLabel) ? cost.tariff : null;
  const rates = cost.rates && (cardIsCurrent || sameModel) ? cost.rates : null;
  const steps = data.stepsKnown ?? data.totals?.steps ?? 0;
  // A record-seeded answer can carry real usage before any step list arrives.
  const hasUsage = (data.totals?.consumed ?? 0) > 0;

  // Without a book the service sends the recorded cost and rates recovered from
  // its steps. That path keeps its own drawing: an older service must read
  // exactly as it did.
  if (!api) {
    paintRecoveredRates(cost, rates, tariff);
    return;
  }

  // Nothing has finished yet: a card in the book says what the model will cost,
  // not what this session has run. Say that instead of drawing a table of zeroes.
  if (steps === 0 && !hasUsage) {
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

// The reader's spending limits, in dollars of the Cost block's own headline
// (API value with a price book, the recorded cost without). Kept in the
// extension's server storage, so one setting covers every session and frame.
const BUDGET_KEY = 'budget';
let budget = { session: null, turn: null };
// Which limits already toasted, so a limit speaks once per session or turn.
const budgetToasted = new Set();
// The first answer after a switch, a load or a save only marks what is already
// over: opening an expensive old session, or setting a limit below the current
// number, is not news.
let budgetQuiet = true;

/** A stored limit is a positive dollar amount, or no limit at all. */
function limitOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeBudget(value) {
  return { session: limitOf(value?.session), turn: limitOf(value?.turn) };
}

/** A field's text as a limit: empty is no limit, `$` is allowed. */
function parseLimit(text) {
  const trimmed = String(text ?? '').trim().replace(/^\$/, '').trim();
  if (!trimmed) return { value: null };
  const value = Number(trimmed);
  return limitOf(value) === null ? { error: 'a dollar amount above 0, like 5 or 0.50' } : { value };
}

/**
 * Colour the numbers that passed their limit, say how much of it is used on
 * the chip, and toast once when a limit is crossed while the panel watches.
 */
function paintBudget(data) {
  const cost = data?.cost ?? {};
  const money = cost.mode === 'api' ? moneyValue : money4;
  const total = typeof cost.total === 'number' ? cost.total : null;
  const turnValue = typeof cost.lastTurn === 'number' ? cost.lastTurn : null;
  const overSession = budget.session !== null && total !== null && total >= budget.session;
  const overTurn = budget.turn !== null && turnValue !== null && turnValue >= budget.turn;
  ui.costTotal.dataset.over = overSession ? 'true' : 'false';
  ui.costTurn.dataset.over = overTurn ? 'true' : 'false';
  if (overSession) ui.costTotal.title = `${ui.costTotal.title} · at or over your ${money(budget.session)} session budget`;
  if (overTurn) ui.costTurn.title = `${ui.costTurn.title} · at or over your ${money(budget.turn)} turn budget`;

  const shares = [];
  const lines = [];
  if (budget.session !== null) {
    lines.push(`session ${total === null ? '—' : money(total)} of ${money(budget.session)}`);
    if (total !== null) shares.push(total / budget.session);
  }
  if (budget.turn !== null) {
    lines.push(`turn ${turnValue === null ? '—' : money(turnValue)} of ${money(budget.turn)}`);
    if (turnValue !== null) shares.push(turnValue / budget.turn);
  }
  const chip = ui.budgetChip;
  if (!chip.disabled) {
    chip.textContent = lines.length === 0 ? 'set budget' : shares.length ? `budget ${Math.round(Math.max(...shares) * 100)}%` : 'budget set';
    chip.title = lines.length ? `${lines.join(' · ')} · click to change` : 'warn when this session or one turn passes a dollar amount';
  }
  chip.dataset.over = overSession || overTurn ? 'true' : 'false';

  if (!data || !sessionId) return;
  const due = [];
  if (overSession) due.push([`${sessionId}|session|${budget.session}`, `this session reached your ${money(budget.session)} budget (${money(total)})`]);
  if (overTurn) {
    due.push([
      `${sessionId}|turn|${data.turn?.startedAt ?? ''}|${budget.turn}`,
      `this turn reached your ${money(budget.turn)} budget (${money(turnValue)})`,
    ]);
  }
  for (const [key, message] of due) {
    if (budgetToasted.has(key)) continue;
    budgetToasted.add(key);
    if (budgetQuiet) continue;
    host.toast({ kind: 'info', message: `Token Meter: ${message}` }).catch((error) => {
      console.warn('token meter: the budget toast was refused', error);
    });
  }
  budgetQuiet = false;
}

/** The two limits as fields, built fresh each time the form opens. */
function openBudgetForm() {
  const form = ui.budgetForm;
  const draft = {
    session: budget.session === null ? '' : String(budget.session),
    turn: budget.turn === null ? '' : String(budget.turn),
  };
  const fields = el('div', 'budget-fields');
  const actions = el('div', 'budget-actions');
  form.replaceChildren(fields, actions);
  const sessionField = mountTextField(fields, {
    label: 'Session, $',
    value: draft.session,
    placeholder: 'no limit',
    onChange: (value) => {
      draft.session = value;
      sessionField.update({ error: undefined });
    },
  });
  const turnField = mountTextField(fields, {
    label: 'Turn, $',
    value: draft.turn,
    placeholder: 'no limit',
    onChange: (value) => {
      draft.turn = value;
      turnField.update({ error: undefined });
    },
  });
  const store = (next) => {
    const write = next.session === null && next.turn === null ? host.storage.delete(BUDGET_KEY) : host.storage.set(BUDGET_KEY, next);
    return write.then(() => {
      budget = next;
      budgetQuiet = true;
      closeBudgetForm();
      // The whole answer, not only the budget: the titles carry the old limit.
      if (current) render(current);
      else paintBudget(null);
    });
  };
  const fail = (error) => sessionField.update({ error: `not saved: ${error?.message ?? error}` });
  mountButton(actions, {
    label: 'Save',
    size: 'xs',
    onClick: () => {
      const session = parseLimit(draft.session);
      const turn = parseLimit(draft.turn);
      sessionField.update({ error: session.error });
      turnField.update({ error: turn.error });
      if (session.error || turn.error) return;
      store({ session: session.value, turn: turn.value }).catch(fail);
    },
  });
  mountButton(actions, {
    label: 'Clear',
    size: 'xs',
    variant: 'ghost',
    onClick: () => store({ session: null, turn: null }).catch(fail),
  });
  form.hidden = false;
  ui.budgetChip.setAttribute('aria-expanded', 'true');
}

function closeBudgetForm() {
  ui.budgetForm.hidden = true;
  ui.budgetForm.replaceChildren();
  ui.budgetChip.setAttribute('aria-expanded', 'false');
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
  'scale',
  'line',
  'peak',
  'peak-label',
  'time-0.25',
  'time-0.5',
  'time-0.75',
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
    `<g data-n="scale"></g>` +
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

/** Shared axis geometry for both panel charts. Labels sit inside the existing
 * plot, with no new gutter or change to pointer coordinates. */
function scaleGrid(maximum, width, height, pad) {
  return rateTicks(maximum, height - 2 * pad).map((tick) => {
    const y = height - pad - tick.share * (height - 2 * pad);
    return `<line x1="0" x2="${width}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--oc-border)" stroke-dasharray="2 4" opacity="0.6" />` +
      `<text x="2" y="${(y < pad + 10 ? y + 10 : y - 3).toFixed(1)}" fill="var(--oc-muted)" font-size="8.5" data-role="grid-label">${tick.label}</text>`;
  }).join('');
}

/** The best step of this turn, 0 when there is no turn to measure. */
function turnPeakOf(data) {
  const from = data.turn?.startedAt;
  if (!from) return 0;
  let best = 0;
  for (const step of Array.isArray(data.steps) ? data.steps : []) {
    if ((step.at ?? 0) >= from && step.tps > best) best = step.tps;
  }
  return best;
}

/** A button that says what it did for a moment, then goes back to its name. */
function flash(node, text) {
  if (!node.dataset.label) node.dataset.label = node.textContent;
  node.textContent = text;
  clearTimeout(node.flashTimer);
  node.flashTimer = setTimeout(() => {
    if (node.dataset.label) node.textContent = node.dataset.label;
  }, 1_200);
}

/** This session's numbers as a markdown table, for a note or a PR. */
function statsMarkdown(data) {
  const t = data.totals ?? {};
  const c = data.cost ?? {};
  const members = Array.isArray(data.subagents?.members) ? data.subagents.members : [];
  const lines = [
    `**Token meter — ${sessionTitle || data.session || 'session'}**`,
    '',
    '| | |',
    '|---|---|',
    `| Session | ${sessionTitle || data.session || '—'} |`,
    `| In | ${compact(t.input)} |`,
    `| Out | ${compact(t.output)} |`,
    `| Think | ${compact(t.reasoning)} |`,
    `| Total out | ${compact((t.output ?? 0) + (t.reasoning ?? 0))} |`,
    `| Cache | ${compact(t.cacheRead)} |`,
    `| Cache hit | ${percent(t.cacheHitRate ?? 0, 2)} |`,
    `| TTFT | ${seconds(data.live?.ttftMs ?? 0) || '—'} |`,
    `| Consumed | ${compact(t.consumed ?? 0)} |`,
  ];
  if (c.rates?.name) lines.push(`| Model | ${c.rates.name} |`);
  if (c.mode === 'api' && typeof c.total === 'number') {
    lines.push(`| API value | ${c.lowerBound ? '≥ ' : ''}$${c.total.toFixed(4)} |`);
  }
  if (data.historyPartial || (data.subagents?.partial ?? 0) > 0) lines.push('| Note | history is partial |');
  lines.push(`| At | ${localNow()} |`);
  if (typeof c.billed?.total === 'number') lines.push(`| Billed | $${c.billed.total.toFixed(4)} |`);
  return lines.join('\n');
}

function drawLive(data) {
  const svg = ui.live;
  const width = Math.max(140, svg.clientWidth || 300);
  const height = Math.max(110, svg.clientHeight || 112);
  const pad = 8;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const nodes = ensureLive(svg, width, height, pad);
  // Three resolutions: the fine 250 ms series, the 1 s one for the minutes, and
  // the 10 s one for the hour. Each is drawn only over the span it covers.
  const source = liveWindowMs > 300_500 && Array.isArray(data.pointsWide)
    ? data.pointsWide
    : liveWindowMs > ZOOM_MIN_MS + 500 && Array.isArray(data.pointsLong)
      ? data.pointsLong
      : data.points;
  const series = Array.isArray(source) ? source : [];
  const now = projectedNow(data);
  const from = now - liveWindowMs;
  const windowSeconds = Math.round(liveWindowMs / 1_000);
  // Seconds up close, minutes once the number would be noise.
  ui.axisFrom.textContent =
    windowSeconds >= 3_600
      ? '1 h ago'
      : windowSeconds >= 120
        ? `${Math.floor(windowSeconds / 60)} min ago`
        : `${windowSeconds} s ago`;
  ui.axisTo.textContent = 'now';
  ui.axisTo.removeAttribute('title');
  const visible = series.filter((point) => point.t >= from && point.t <= now);
  const peakValue = visible.reduce((max, point) => Math.max(max, point.v), 0);
  // References drawn on the chart: the session's average and its best step,
  // worked out by the service over every step it knows.
  const rates = data.rates ?? {};
  rates.avg = Number(rates.avg) || 0;
  rates.peak = Number(rates.peak) || 0;

  // A finished turn leaves a flat zero line. Redrawing it on every animation
  // frame wrote the same path 61 times a second; one draw per second is enough
  // for the peak's age label to keep ticking, and the pointer gets a draw of
  // its own. Only a visible window with no rate at all takes this short path.
  const flatZero = visible.length > 0 && visible.every((point) => point.v === 0);
  if (flatZero && liveHoverX === null && liveHoverY === null) {
    const idleTurnPeak = ceilingMode === 'turn' ? turnPeakOf(data) : 0;
    const idleCeiling = rateCeiling(Math.max(idleTurnPeak > 0 ? idleTurnPeak : rates.peak, rates.avg));
    // The left edge of a flat line is not a picture: a first sample a pixel
    // younger or older looks the same, so the whole-second clock is the only
    // thing that changes the drawing. The session is in the key because the
    // peak label is rebuilt from its own peak age on a switch.
    const sessionKey = data.session ?? sessionId ?? '';
    const idleKey = `${sessionKey}|${width}|${height}|${liveWindowMs}|${ceilingMode}|${idleTurnPeak}|${rates.avg}|${rates.peak}|${idleCeiling}|${Math.floor(now / 1_000)}`;
    if (idleKey === lastIdleKey) return;
    lastIdleKey = idleKey;
  } else {
    lastIdleKey = null;
  }

  // Smooth in rate units, then map to the axis: geometry never feeds back into
  // a measured value, a reference line's rate or the hover readout.
  const smooth = [];
  for (const point of visible) {
    const previous = smooth[smooth.length - 1];
    const value = previous === undefined ? point.v : previous + (point.v - previous) * 0.3;
    smooth.push(value);
  }
  // A finished turn's final sample is zero; easing it would leave the held
  // tail above the baseline (the "long line at 100" the owner saw). The end
  // point is the measured value, so it is drawn as measured.
  const newestSample = visible[visible.length - 1];
  if (newestSample && newestSample.v === 0 && smooth.length) smooth[smooth.length - 1] = 0;
  const liveTop = smooth.reduce((best, value) => Math.max(best, value), 0);
  const turnPeak = ceilingMode === 'turn' ? turnPeakOf(data) : 0;
  const turnMode = ceilingMode === 'turn' && turnPeak > 0;
  // Retain the existing peak selection (finished step or visible live burst).
  // The ceiling is the peak itself; a smaller one is drawn at its actual value.
  const ceilingPeak = Math.max(turnMode ? turnPeak : rates.peak, liveTop);
  const max = rateCeiling(Math.max(ceilingPeak, rates.avg));
  const share = (value) => symlogShare(value, max);
  const lineY = (value) => height - pad - share(value) * (height - pad * 2);
  // A changed ceiling remaps every point at once. Easing that remap made the
  // whole curve slide when a finished step raised the peak (the "compensating
  // for scale" slope at a turn's end); only sample values may travel.
  const scaleJump = max !== plottedCeiling;
  plottedCeiling = max;
  const plotted = animateCurve(
    visible.map((point, index) => ({ t: point.t, v: share(smooth[index]) })),
    performance.now(),
    REDUCED_MOTION || scaleJump,
  );
  const plottedY = (index) => height - pad - plotted[index].v * (height - pad * 2);
  const xOf = (point) => ((point.t - from) / liveWindowMs) * width;
  const baseline = height - pad;

  // Rebuild the small tick group only when its values or scale change, not on
  // every animation frame. Empty plots retain their quiet baseline.
  const gridKey = liveTop > 0 ? `${max}|${width}|${height}` : '';
  if (nodes.scale.dataset.key !== gridKey) {
    nodes.scale.dataset.key = gridKey;
    nodes.scale.innerHTML = gridKey ? scaleGrid(max, width, height, pad) : '';
  }

  let avgLabelY = null;
  if (rates.avg > 0 && rates.avg <= max) {
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

  if (ceilingPeak > 0) {
    const y = lineY(ceilingPeak);
    peakLineY = y;
    // How old the best step is: the scale is pinned to it, so "peak 337" beside
    // a 20 t/s stream needs the date to make sense.
    if (!peakSeeded) {
      peakSeeded = true;
      peakSinceValue = ceilingPeak;
      peakSince = rates.peakAt ?? now;
    }
    if (ceilingPeak > peakSinceValue + 0.05) {
      peakSinceValue = ceilingPeak;
      peakSince = now;
    }
    const age = peakSince ? duration(now - peakSince) : '';
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
    nodes['peak-label'].textContent = `${turnMode ? 'turn peak' : 'peak'} ${Math.round(ceilingPeak)} t/s${age ? ` · ${age} ago` : ''}`;
    nodes['peak-label'].setAttribute('y', labelY.toFixed(1));
    showPart(nodes.peak, true);
    showPart(nodes['peak-label'], true);
  } else {
    peakLineY = null;
    showPart(nodes.peak, false);
    showPart(nodes['peak-label'], false);
  }

  // The sample nearest the pointer. Geometry follows the smoothed curve, but
  // the readout keeps the sample's raw rate, never a logarithmic coordinate.
  let hovered = null;
  if (liveHoverX !== null && smooth.length > 1) {
    let nearest = 0;
    for (let index = 1; index < visible.length; index += 1) {
      if (Math.abs(xOf(visible[index]) - liveHoverX) < Math.abs(xOf(visible[nearest]) - liveHoverX)) nearest = index;
    }
    hovered = { x: xOf(visible[nearest]), y: plottedY(nearest), value: visible[nearest].v, at: visible[nearest].t };
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

  // The line always reaches `now`: a live reading is current, and a finished
  // one is zero at its end, so the held tail is the flat line the meter has
  // always drawn rather than a gap before the edge.
  if (smooth.length > 1) {
    const points = plotted.map((point, index) => ({ x: xOf(visible[index]), y: plottedY(index) }));
    const line = smoothPath(points);
    const first = points[0];
    const last = points[points.length - 1];
    const endX = last.x < width ? width : last.x;
    const heldLine = endX > last.x ? `${line} L ${endX.toFixed(1)},${last.y.toFixed(1)}` : line;
    nodes.line.setAttribute('d', heldLine);
    nodes.fill.setAttribute(
      'd',
      `${heldLine} L ${endX.toFixed(1)},${baseline.toFixed(1)} L ${first.x.toFixed(1)},${baseline.toFixed(1)} Z`,
    );
    nodes.dot.setAttribute('cx', endX.toFixed(1));
    nodes.dot.setAttribute('cy', last.y.toFixed(1));
    showPart(nodes.line, true);
    showPart(nodes.fill, true);
    showPart(nodes.dot, true);
    showPart(nodes.baseline, false);
  } else if (smooth.length === 1) {
    // One sample is still a reading at now.
    nodes.dot.setAttribute('cx', width.toFixed(1));
    nodes.dot.setAttribute('cy', plottedY(0).toFixed(1));
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

  if (liveHoverY !== null && peakLineY !== null) peakHover = Math.abs(liveHoverY - peakLineY) < 6;
  if (peakHover && ceilingPeak > 0) {
    // The line's own step: the label above it already carries the age, this
    // adds the shape of the step that set the ceiling.
    const step = (data.steps ?? []).find((item) => Math.abs(item.tps - ceilingPeak) < 0.05);
    ui.peak.textContent = step
      ? `peak ${Math.round(ceilingPeak)} t/s · ${compact(step.tokens)} tok in ${seconds(step.ms)}${step.sub ? ' · subagent' : ''}`
      : `peak ${Math.round(ceilingPeak)} t/s`;
  } else {
    ui.peak.textContent = hovered
      ? `${Math.round(hovered.value)} t/s · ${Math.max(0, Math.round((now - hovered.at) / 1_000))} s ago`
      : peakValue > 0
        ? `live peak ${compact(peakValue)} t/s`
        : '';
  }
}

/**
 * The readout under the step chart: the bar's rate and size, plus the time it
 * ran, what it cost and whose step it was when the service sends them. An older
 * service leaves the last three out rather than printing a hole.
 */
function stepReadout(step) {
  // In and out apart, in the order the step spent them: a step that read 90k
  // and wrote 2k is a different animal from one that read 2k and wrote 90k.
  let text = `${Math.round(step.tps)} t/s${Number.isFinite(step.in) ? ` · in ${compact(step.in)}` : ''} · out ${compact(step.tokens)} in ${seconds(step.ms)}`;
  const at = dateClock(step.at);
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
  const rated = all
    .filter((step) => step.tps && step.tps > 0 && !step.aborted)
    .filter((step) => !stepFilter || step.sub === stepFilter);
  // Zooming in here means drawing fewer bars, never fewer numbers in the header.
  // A step arriving grows the list; the eased count has to grow with it, or the
  // chart draws one bar fewer than it has for a beat and re-lays out twice.
  const grew = Math.max(0, rated.length - stepFull);
  stepShown = stepShown === 0 ? rated.length : Math.min(rated.length, stepShown + grew);
  stepFull = rated.length;
  const shownBars = Math.min(rated.length, Math.max(1, Math.round(stepShown)));
  const limit = shownBars >= rated.length ? 0 : shownBars;
  // The window ends `stepPan` bars before the newest one, so the same drag works
  // at any zoom level.
  const panMax = Math.max(0, rated.length - shownBars);
  stepPan = Math.min(panMax, Math.max(0, stepPan));
  const endIndex = rated.length - Math.round(stepPan);
  const startIndex = Math.max(0, endIndex - shownBars);
  const steps = rated.slice(startIndex, endIndex);
  // What the bars depend on besides the list itself: a filter or a pan picks a
  // different slice of the same list, and the cache below must see that.
  const drawKey = `${stepFilter ?? ''}|${startIndex}|${endIndex}`;
  // The count is every step the session and its subagents ran, not only the
  // bars the meter can draw or rate.
  const known = data.stepsKnown ?? all.length;
  ui.stepsCount.textContent = `${known} step${known === 1 ? '' : 's'}`;
  if (stepFilter) {
    ui.stepsCount.title = `showing one subagent's steps`;
  } else ui.stepsCount.title =
    (data.subagents?.loading ?? 0) > 0 || (data.subagents?.partial ?? 0) > 0 || data.historyPartial
      ? 'history is partial; the count is a lower bound'
      : limit
        ? stepPan > 0
          ? `zoomed in: ${limit} of ${all.length} steps drawn, ending ${Math.round(stepPan)} back`
          : `zoomed in: the last ${limit} of ${all.length} steps are drawn`
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
    drawnBars = [];
    drawnHoverCol = null;
    stepHover = null;
    if (data.steps === lastDrawnSteps && limit === lastDrawnLimit && drawKey === lastDrawnKey && width === lastDrawnW && height === lastDrawnH) return;
    lastDrawnSteps = data.steps;
    lastDrawnLimit = limit;
    lastDrawnKey = drawKey;
    lastDrawnW = width;
    lastDrawnH = height;
    lastDrawnHover = null;
    const emptyText = stepFilter
      ? 'no rated steps for this subagent yet'
      : all.length > 0 || known > 0
        ? 'no rated steps yet'
        : 'no finished steps yet';
    svg.innerHTML = `<text x="${(width / 2).toFixed(1)}" y="${(height / 2).toFixed(1)}" text-anchor="middle" fill="var(--oc-muted)" font-size="11">${emptyText}</text>`;
    return;
  }
  ui.stepsAxis.hidden = false;
  const firstDrawn = steps[0]?.at ?? data.stepsFrom;
  ui.stepsStart.textContent = firstDrawn ? `start ${dateClock(firstDrawn)}` : '';
  ui.stepsStart.title = 'the first step on the chart';
  const lastDrawnAt = steps.at(-1)?.at ?? null;
  const atRightEdge = stepPan === 0;
  ui.stepsNow.textContent = atRightEdge ? `now ${dateClock(Date.now())}` : `last ${dateClock(lastDrawnAt)}`;
  ui.stepsNow.title = atRightEdge ? 'the current time' : 'the newest step on the chart';
  // Tokens over stream time across the bars on screen: the green line and the
  // label describe the same steps the chart draws.
  const totalTokens = steps.reduce((sum, step) => sum + step.tokens, 0);
  const totalMs = steps.reduce((sum, step) => sum + step.ms, 0);
  const average = totalMs > 0 ? (totalTokens / totalMs) * 1000 : 0;
  const peak = steps.reduce((best, step) => Math.max(best, step.tps), 0);
  const max = rateCeiling(peak);
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
  const sameGeometry =
    data.steps === lastDrawnSteps &&
    limit === lastDrawnLimit &&
    drawKey === lastDrawnKey &&
    width === lastDrawnW &&
    height === lastDrawnH;
  // Nothing changed: keep the bars, and with them the column the pointer is
  // reading. This runs four times a second and rebuilding a thousand rects each
  // time was the most expensive thing on the page.
  if (sameGeometry && hover === lastDrawnHover) return;
  // Only the pointer moved: restyle the bar that left and the one that arrived,
  // and slide the highlight column. Rebuilding every rect for a pointer move
  // cost 6.6 ms with 1,000 bars.
  if (sameGeometry && drawnBars.length === steps.length) {
    const opacityAt = (index) => (index === hover ? 1 : 0.4 + 0.6 * (index / Math.max(1, drawnBars.length - 1)));
    const paintBar = (index) => {
      const node = drawnBars[index];
      if (!node) return;
      node.setAttribute('opacity', opacityAt(index).toFixed(2));
      if (index === hover) node.setAttribute('data-role', 'step-hover');
      else node.removeAttribute('data-role');
    };
    if (lastDrawnHover !== null) paintBar(lastDrawnHover);
    if (hover === null) {
      drawnHoverCol?.remove();
      drawnHoverCol = null;
    } else {
      paintBar(hover);
      if (!drawnHoverCol) {
        drawnHoverCol = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        drawnHoverCol.setAttribute('y', '0');
        drawnHoverCol.setAttribute('height', String(height));
        drawnHoverCol.setAttribute('fill', 'var(--oc-fg)');
        drawnHoverCol.setAttribute('opacity', '0.08');
        drawnHoverCol.setAttribute('data-role', 'step-hover-col');
        svg.insertBefore(drawnHoverCol, drawnBars[0] ?? null);
      }
      drawnHoverCol.setAttribute('x', (hover * slot).toFixed(1));
      drawnHoverCol.setAttribute('width', slot.toFixed(1));
    }
    lastDrawnHover = hover;
    return;
  }
  lastDrawnSteps = data.steps;
  lastDrawnLimit = limit;
  lastDrawnKey = drawKey;
  lastDrawnW = width;
  lastDrawnH = height;
  lastDrawnHover = hover;
  const pieces = [scaleGrid(max, width, height, pad)];
  if (hover !== null) {
    pieces.push(
      `<rect x="${(hover * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}" fill="var(--oc-fg)" opacity="0.08" data-role="step-hover-col" />`,
    );
  }
  steps.forEach((step, index) => {
    const h = Math.max(1.5, symlogShare(step.tps, max) * (height - pad * 2));
    const x = index * slot + (slot - barWidth) / 2;
    const y = height - pad - h;
    const fill = step.sub ? 'var(--oc-info)' : 'var(--oc-primary)';
    const opacity = index === hover ? 1 : 0.4 + 0.6 * (index / Math.max(1, steps.length - 1));
    const role = index === hover ? ' data-role="step-hover"' : '';
    pieces.push(
      `<rect data-bar="step" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}" opacity="${opacity.toFixed(2)}"${role} />`,
    );
  });
  // The session's own average and best step, over the bars drawn: the same
  // numbers the header shows, in the same colours.
  if (average > 0) {
    const avgY = height - pad - symlogShare(average, max) * (height - pad * 2);
    pieces.push(
      `<line data-role="step-avg" x1="0" y1="${avgY.toFixed(1)}" x2="${width}" y2="${avgY.toFixed(1)}" stroke="var(--oc-success)" stroke-width="1" stroke-dasharray="3 3" opacity="0.75" />`,
    );
  }
  if (peak > 0) {
    const peakY = height - pad - symlogShare(peak, max) * (height - pad * 2);
    pieces.push(
      `<line data-role="step-peak" x1="0" y1="${peakY.toFixed(1)}" x2="${width}" y2="${peakY.toFixed(1)}" stroke="var(--oc-error)" stroke-width="1" stroke-dasharray="2 3" opacity="0.7" />`,
    );
  }
  svg.innerHTML = pieces.join('');
  drawnBars = [...svg.querySelectorAll('rect[data-bar="step"]')];
  drawnHoverCol = svg.querySelector('rect[data-role="step-hover-col"]');
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

/**
 * Every subagent session in the tree, not only the running ones: name, what it
 * consumed, what it cost, its average and best rate, and when it last moved.
 * Opens from the `N subagents` chip and closes itself a minute later.
 */
/**
 * The roster grows and shrinks instead of appearing: its own height is the only
 * honest size, so it is measured, transitioned, then released.
 */
function openSubsDetail() {
  const node = ui.subsDetail;
  node.hidden = false;
  node.style.maxHeight = '0px';
  node.style.opacity = '0';
  // Two frames: one for the browser to see the zero, one to start the move.
  requestAnimationFrame(() => {
    node.style.maxHeight = `${node.scrollHeight}px`;
    node.style.opacity = '1';
  });
  setTimeout(() => {
    if (!subsDetailOpen) return;
    node.style.maxHeight = 'none';
  }, 240);
}

function closeSubsDetail() {
  const node = ui.subsDetail;
  if (node.hidden) return;
  node.style.maxHeight = `${node.scrollHeight}px`;
  node.style.opacity = '1';
  requestAnimationFrame(() => {
    node.style.maxHeight = '0px';
    node.style.opacity = '0';
  });
  setTimeout(() => {
    if (subsDetailOpen) return;
    node.hidden = true;
    node.style.maxHeight = '';
    node.style.opacity = '';
  }, 220);
}

/** Every model the tree ran, with what it contributed and what was billed. */
function paintModels(cost) {
  const models = Array.isArray(cost?.models) ? cost.models : [];
  if (models.length < 2) {
    ui.models.hidden = true;
    return;
  }
  ui.models.hidden = false;
  ui.modelsMeta.textContent = `${models.length} models`;
  const nodes = [];
  for (const model of models) {
    const row = el('div', 'model-row');
    const name = el('span', 'model-name', model.name || model.model || 'model');
    name.title = `${model.provider}/${model.model}`;
    const value = el('span', 'model-value', `$${(model.apiValue ?? 0).toFixed(2)}`);
    const meta = el('span', 'model-meta');
    const drift = model.drift ? ` · drift ${(model.drift * 100).toFixed(1)}%` : '';
    meta.textContent = `${compact(model.consumed ?? 0)} tok · billed ${money4(model.billed ?? 0)}${drift}`;
    row.append(name, value, meta);
    nodes.push(row);
  }
  ui.modelsList.replaceChildren(...nodes);
}

function paintSubsDetail(members, total = 0) {
  const list = Array.isArray(members) ? members : [];
  if (!subsDetailOpen || list.length === 0) {
    if (!subsDetailOpen && ui.subsDetail.hidden) {
      ui.subsDetailList.replaceChildren();
      ui.subsDetailMeta.textContent = '';
      subsDetailKey = '';
    }
    return;
  }
  ui.subsDetail.hidden = false;
  ui.subsDetailMeta.textContent = `${Math.max(list.length, total)} in this tree`;
  const key = list.map((item) => `${item.id}:${item.steps}:${item.lastAt}:${item.cost}:${item.status}:${item.consumed}`).join('|');
  if (key === subsDetailKey) return;
  subsDetailKey = key;
  const now = Date.now();
  const nodes = [];
  // The list is rebuilt whenever a member's numbers move; a reader on the
  // keyboard keeps their place across that.
  const focused = ui.subsDetailList.contains(document.activeElement) ? document.activeElement.dataset.member : null;
  let refocus = null;
  for (const item of list) {
    const row = el('div', 'sub-detail');
    row.dataset.member = item.id;
    if (stepFilter === item.id) row.dataset.selected = 'true';
    // A row is a toggle for the step chart's filter, so it is one to a keyboard
    // and a screen reader as well as to the pointer.
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-pressed', stepFilter === item.id ? 'true' : 'false');
    if (focused === item.id) refocus = row;
    const toggle = () => {
      stepFilter = stepFilter === item.id ? null : item.id;
      subsDetailKey = '';
      if (current) {
        paintSubsDetail(current.subagents?.members ?? []);
        drawSteps(current);
      }
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    const head = el('div', 'sub-detail-head');
    const dot = el('i', 'dot');
    dot.dataset.state = dotState(item.status);
    const title = el('span', 'sub-detail-title', item.title || item.id || 'subagent');
    title.title = item.title || item.id || '';
    const age = item.lastAt ? duration(now - item.lastAt) : '';
    const when = el('span', 'sub-detail-when', !item.lastAt ? 'never' : age ? `${age} ago` : 'just now');
    head.append(dot, title, when);
    const stats = el('div', 'sub-detail-stats');
    // A record-seeded member has tokens but no step list yet; "0 steps" would
    // claim it did nothing.
    const stepsText = item.steps > 0 ? ` · ${item.steps} step${item.steps === 1 ? '' : 's'}` : '';
    stats.textContent = `${compact(item.consumed ?? 0)} tok · ${item.cost > 0 ? money4(item.cost) : '$0'} · avg ${Math.round(item.avgTps ?? 0)} t/s · peak ${Math.round(item.peakTps ?? 0)} t/s${stepsText}`;
    row.append(head, stats);
    nodes.push(row);
  }
  ui.subsDetailList.replaceChildren(...nodes);
  refocus?.focus();
}

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
      // No animation means no animationend: drop the class on the clock too.
      setTimeout(() => node.classList.remove('sub-in'), 220);
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
            : data.loading
              ? 'reading this session’s history'
              : 'no generation right now';

  const members = Array.isArray(subagents.members) ? subagents.members : [];
  // A filter on a member that has left the tree (an hour quiet) has no row
  // left to click it off with, and would hold the chart empty: let it go.
  if (stepFilter && !members.some((item) => item.id === stepFilter)) stepFilter = null;
  drawLive(data);
  drawSteps(data);
  paintSubagents(activeSubs, runningSubs, subagents.count ?? 0);
  const roster = Math.max(members.length, subagents.count ?? 0);
  ui.subsToggle.hidden = roster === 0;
  ui.subsToggle.textContent = `${roster} subagent${roster === 1 ? '' : 's'}`;
  ui.subsToggle.dataset.filtered = stepFilter ? 'true' : 'false';
  ui.subsToggle.title = stepFilter
    ? 'the step chart is filtered to one subagent; open the list to change it'
    : 'every subagent session in this tree';
  paintSubsDetail(members, subagents.count ?? 0);

  const lastStep = data.live?.lastStep;
  // What the turn has consumed so far, not what the last step generated: the
  // line answers "what did this turn cost", and the step answers a different one.
  const turnConsumed = Number.isFinite(data.turn?.consumed) ? data.turn.consumed : null;
  const consumedText = turnConsumed === null ? '' : ` · ${compact(turnConsumed)} tok`;
  // Only name the owner when there is somebody else in the tree to tell apart.
  const lastSub = lastStep?.sub ? ' · subagent' : (data.subagents?.count ?? 0) > 0 ? ' · main' : '';
  const lastCost = typeof data.cost?.lastTurn === 'number' ? ` · ${money4(data.cost.lastTurn)}` : '';
  if (lastStep?.tps) {
    ui.lastRate.textContent = `last ${Math.round(lastStep.tps)} t/s`;
    // Classify the digits on screen, exactly like the headline, so a 19.6 t/s
    // step printed as "20" is not coloured as a slow rate.
    ui.lastRate.dataset.tier = speedTier(Math.round(lastStep.tps));
    ui.lastRest.textContent = ` · ${seconds(lastStep.ms)}${consumedText}${lastSub}${lastCost}`;
  } else {
    ui.lastRate.textContent = '';
    delete ui.lastRate.dataset.tier;
    ui.lastRest.textContent = lastStep
      ? `last step ${seconds(lastStep.ms)}${consumedText} · too short to rate${lastSub}${lastCost}`
      : 'no finished step yet';
  }

  paintCells(rowNodes, data);
  paintCost(data);
  paintModels(data.cost);
  paintBudget(data);
  const totals = data.totals ?? {};
  // `live` says the session is working right now, not where the numbers came
  // from: an idle session keeps its usage record, and labelling a frozen number
  // "live" is the one thing a dashboard must not do.
  const working =
    data.status === 'streaming' ||
    data.status === 'tool' ||
    data.status === 'waiting-permission' ||
    data.status === 'waiting-question';
  const origin = working ? 'live' : totals.source === 'history' ? 'from history' : '';
  ui.source.textContent = origin;
  const recording = data.recording ?? null;
  const noLiveSamples = !Array.isArray(data.points) || data.points.length === 0;
  ui.foot.textContent = data.error
    ? `cannot read history: ${data.error}`
    : recording?.error
      ? `unable to save graph: ${recording.error}`
      : loadingSubs > 0
        ? `reading ${loadingSubs} subagent histor${loadingSubs === 1 ? 'y' : 'ies'}`
        : partialSubs > 0
          ? `${partialSubs} subagent histor${partialSubs === 1 ? 'y is' : 'ies are'} partial`
          : historyPartial
            ? 'history is partial'
            : recording?.state === 'unrecorded' && data.status === 'idle' && noLiveSamples
                ? 'no live recording yet · the next turn records automatically'
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
    // A quarter second while a turn runs, a second when nothing does: the panel
    // sits open all day, and an idle one has nothing new to read.
    const busy = current && (current.status === 'streaming' || current.status === 'tool');
    const base = busy ? POLL_MS : 1_000;
    const delay = failures > 0 ? Math.min(5_000, POLL_MS * 2 ** Math.min(4, failures)) : base;
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
    // Expanded once per answer, not per display frame: polling updates the
    // measurements while requestAnimationFrame scrolls their existing history.
    data.points = seriesPoints(data);
    // The coarse series carries its own offsets: a quiet collector stops
    // ticking, so its buckets are not a contiguous grid.
    const wide = data.seriesWide;
    data.pointsWide = Array.isArray(wide?.v)
      ? wide.v.map((value, index) => ({
          t: wide.t0 + (Array.isArray(wide.d) && wide.d.length === wide.v.length ? wide.d[index] : index * (wide.step || 10_000)),
          v: value,
        }))
      : null;
    const long = data.seriesLong;
    data.pointsLong = Array.isArray(long?.v)
      ? long.v.map((value, index) => ({
          t: long.t0 + (Array.isArray(long.d) && long.d.length === long.v.length ? long.d[index] : index * (long.step || 1_000)),
          v: value,
        }))
      : null;
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
      const rect = ui.live.getBoundingClientRect();
      liveHoverX = event.clientX - rect.left;
      // A few pixels around the ceiling line read out the step behind it: the
      // label gives the age, this gives the step that set it.
      liveHoverY = event.clientY - rect.top;
      peakHover = peakLineY !== null && Math.abs(liveHoverY - peakLineY) < 6;
      if (current) drawLive(current);
    });
    ui.live.addEventListener('pointerleave', () => {
      liveHoverX = null;
      liveHoverY = null;
      peakHover = false;
      if (current) drawLive(current);
    });
    // The wheel moves a target; the frame loop eases the drawn window towards
    // it, so both directions are one smooth movement with as many steps as the
    // hand makes. Hovering holds the view, leaving restarts the clock.
    ui.live.addEventListener(
      'wheel',
      (event) => {
        if (!current) return;
        event.preventDefault();
        liveHovering = true;
        const ratio = event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        liveTargetMs = Math.min(ZOOM_MAX_MS, Math.max(ZOOM_MIN_MS, liveTargetMs * ratio));
        zoomResetAt = performance.now() + zoomResetMs();
      },
      { passive: false },
    );
    ui.live.addEventListener('pointerenter', () => {
      liveHovering = true;
    });
    ui.live.addEventListener('pointerleave', () => {
      liveHovering = false;
      zoomResetAt = performance.now() + zoomResetMs();
    });
    ui.stepsChart.addEventListener(
      'wheel',
      (event) => {
        if (!current) return;
        event.preventDefault();
        stepHovering = true;
        const floor = Math.min(STEP_MIN_BARS, stepFull || STEP_MIN_BARS);
        const from = stepTarget > 0 ? stepTarget : stepFull || floor;
        const next = event.deltaY < 0 ? Math.max(floor, from * 0.8) : Math.min(stepFull || floor, from * 1.25);
        stepTarget = next >= (stepFull || floor) - 0.5 ? 0 : next;
        stepResetAt = performance.now() + zoomResetMs();
      },
      { passive: false },
    );
    ui.stepsChart.addEventListener('pointerenter', () => {
      stepHovering = true;
    });
    ui.stepsChart.addEventListener('pointerleave', () => {
      stepHovering = false;
      stepResetAt = performance.now() + zoomResetMs();
    });
    // A reader who tabs into the roster keeps it open; the timer restarts on
    // every focus move and only closes it after they leave.
    ui.subsDetail.addEventListener('focusin', () => {
      subsDetailUntil = performance.now() + zoomResetMs();
    });
    ui.subsToggle.addEventListener('click', () => {
      subsDetailOpen = !subsDetailOpen;
      subsDetailKey = '';
      subsDetailUntil = performance.now() + zoomResetMs();
      if (current) paintSubsDetail(current.subagents?.members ?? []);
      if (subsDetailOpen) openSubsDetail();
      else closeSubsDetail();
    });
    ui.footCopy.addEventListener('click', async () => {
      if (!current) return;
      const text = statsMarkdown(current);
      try {
        // The guest frame is sandboxed without allow-same-origin, so the
        // clipboard API is blocked there by permissions policy. The host owns
        // the clipboard; navigator.clipboard is only the fallback for the page
        // test's same-origin frame.
        if (typeof host.writeClipboard === 'function') await host.writeClipboard(text);
        else await navigator.clipboard.writeText(text);
        flash(ui.footCopy, 'copied');
      } catch (error) {
        ui.footCopy.title = String(error?.message ?? error);
        flash(ui.footCopy, 'copy failed');
      }
    });
    // The limits load once; until they do the chip cannot open a form that
    // would save over them. A failed read says why and stays shut.
    ui.budgetChip.setAttribute('aria-expanded', 'false');
    host.storage
      .get(BUDGET_KEY)
      .then((value) => {
        budget = normalizeBudget(value);
        budgetQuiet = true;
        ui.budgetChip.disabled = false;
        if (current) render(current);
        else paintBudget(null);
      })
      .catch((error) => {
        ui.budgetChip.title = `budget unavailable: ${error?.message ?? error}`;
        console.warn('token meter: could not read the budget', error);
      });
    ui.budgetChip.addEventListener('click', () => {
      if (ui.budgetForm.hidden) openBudgetForm();
      else closeBudgetForm();
    });
    ui.footCeiling.addEventListener('click', () => {
      ceilingMode = ceilingMode === 'session' ? 'turn' : 'session';
      ui.footCeiling.textContent = ceilingMode === 'turn' ? 'turn peak' : 'session peak';
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
    // Drag the step window back through history. The chart keeps no scrollbar:
    // the gesture is the scrollbar, and the window snaps back with the zoom.
    ui.stepsChart.addEventListener('pointerdown', (event) => {
      if (!current || drawnSteps.length === 0 || !(drawnSlot > 0)) return;
      stepDrag = { pan: stepPan, x: event.clientX, slot: drawnSlot };
      ui.stepsChart.setPointerCapture?.(event.pointerId);
    });
    ui.stepsChart.addEventListener('pointermove', (event) => {
      if (!stepDrag) return;
      event.preventDefault();
      const moved = (event.clientX - stepDrag.x) / stepDrag.slot;
      stepPan = Math.max(0, stepDrag.pan + moved);
      stepHover = null;
      drawSteps(current);
    });
    const endDrag = () => {
      if (!stepDrag) return;
      stepDrag = null;
      stepResetAt = performance.now() + zoomResetMs();
    };
    ui.stepsChart.addEventListener('pointerup', endDrag);
    ui.stepsChart.addEventListener('pointercancel', endDrag);
    // History still moves left when a session becomes idle. Follow the display
    // clock, not the poll or pointer clock; a fixed 16 ms gate also skips half
    // the callbacks on a 120 Hz display. Hidden frames do no drawing.
    let lastFrame = 0;
    const paint = (stamp) => {
      // The next frame is booked before any drawing: an exception below still
      // reaches the console, but it can no longer stop the headline, the zoom
      // and the reset clocks for the life of the frame.
      requestAnimationFrame(paint);
      const dt = lastFrame ? Math.min(200, stamp - lastFrame) : 16;
      lastFrame = stamp;
      if (ui && !document.hidden) {
        animateSpeed(dt);
        // Both charts ease towards their target every frame, so a gesture and
        // its reset are the same movement in opposite directions.
        const at = performance.now();
        if (!liveHovering && liveTargetMs !== ZOOM_MIN_MS && at > zoomResetAt) liveTargetMs = ZOOM_MIN_MS;
        const liveZoomChanged = liveWindowMs !== liveTargetMs;
        if (liveZoomChanged) {
          // A reader who asked for less motion gets the new window at once.
          const k = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt / ZOOM_EASE_MS);
          liveWindowMs += (liveTargetMs - liveWindowMs) * k;
          if (Math.abs(liveTargetMs - liveWindowMs) < 40) liveWindowMs = liveTargetMs;
        }
        // Streaming, zoom and a hover readout follow the display clock; an idle
        // graph only slides sideways, so it redraws on the idle clock instead
        // of rebuilding the same path on every frame (issue #1). `dt` above is
        // still the real elapsed time, so every ease keeps its time constant,
        // and a poll answer draws on arrival through render().
        const liveFullRate = streamingNow || liveZoomChanged || liveHoverX !== null;
        if (
          current &&
          (!REDUCED_MOTION || liveZoomChanged) &&
          drawDue(liveFullRate, lastIdleDrawAt, at, IDLE_DRAW_MS)
        ) {
          lastIdleDrawAt = at;
          drawLive(current);
        }
        if (
          subsDetailOpen &&
          !ui.subsDetail.matches(':hover') &&
          !ui.subsDetail.contains(document.activeElement) &&
          at > subsDetailUntil
        ) {
          subsDetailOpen = false;
          subsDetailKey = '';
          closeSubsDetail();
        }
        if (!stepHovering && (stepTarget !== 0 || stepPan > 0) && at > stepResetAt) {
          stepTarget = 0;
          stepPan = 0;
        }
        const wanted = stepTarget > 0 ? stepTarget : stepFull;
        if (stepFull > 0 && Math.abs(stepShown - wanted) > 0.5) {
          const k = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt / ZOOM_EASE_MS);
          stepShown += (wanted - stepShown) * k;
          if (Math.abs(stepShown - wanted) < 0.5) stepShown = wanted;
          if (current) drawSteps(current);
        }
      }
    };
    requestAnimationFrame(paint);
    // The reader's own clock at the bottom: the rail doubles as a dashboard, and
    // a screenshot of it should say when it was taken.
    if (ui.footClock) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      ui.footClock.title = zone ? `your time · ${zone}` : 'your time';
      const tickClock = () => {
        if (ui && !document.hidden) ui.footClock.textContent = localNow();
      };
      tickClock();
      setInterval(tickClock, 1_000);
    }
  }
  const model = ctx.session?.model;
  sessionTitle = typeof ctx.session?.title === 'string' ? ctx.session.title : '';
  ui.eyebrow.title = sessionTitle || '';
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
  liveWindowMs = ZOOM_MIN_MS;
  liveTargetMs = ZOOM_MIN_MS;
  stepTarget = 0;
  stepShown = 0;
  stepFull = 0;
  stepPan = 0;
  stepDrag = null;
  stepFilter = null;
  subsDetailOpen = false;
  subsDetailKey = '';
  ui.subsDetail.hidden = true;
  ui.subsDetail.style.maxHeight = '';
  ui.subsDetail.style.opacity = '';
  ui.subsDetailList.replaceChildren();
  ui.subsDetailMeta.textContent = '';
  ui.subsToggle.hidden = true;
  // The drawn chart belongs to the session that left: force the empty one, and
  // never let the idle skip compare against the previous session's drawing.
  lastDrawnSteps = null;
  lastIdleKey = null;
  stepHover = null;
  liveHoverX = null;
  liveHoverY = null;
  peakHover = false;
  peakSeeded = false;
  peakSince = 0;
  peakSinceValue = 0;
  sessionId = nextSession;
  current = null;
  clearNotice();
  // Everything on screen describes the session that left: its totals, cost,
  // steps, curve and subagents. Painted empty here, they cannot sit under the
  // new session's name until its first answer lands.
  paintCells(rowNodes, {});
  paintCost({});
  paintModels({});
  budgetQuiet = true;
  paintBudget(null);
  // The header too: the session that left may have been generating, and its
  // breathing dot and turn timer must not sit under the new session's name
  // for the first load (up to six seconds on a long history).
  ui.dot.dataset.state = dotState('idle');
  ui.statusLabel.textContent = STATUS.idle;
  ui.tpsSub.textContent = 'no generation right now';
  paintSubagents([], 0, 0);
  drawSteps({ steps: [], stepsKnown: 0 });
  drawLive({ points: [], rates: { avg: 0, peak: 0 } });
  ui.source.textContent = '';
  // The footer names the previous session's recording or stream; it must not
  // sit under the new session's name until the first answer lands.
  ui.foot.textContent = '';
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
