import { HostRequestError, connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountEmpty } from '@openchamber/sdk/ui';
import { compact, seconds } from '../../shared/summary.js';
import { compress, easeToward, nextScale } from '../../shared/chart.js';
import { dotState, mountCells, paintCells } from '../../shared/cells.js';
import { el } from '../../shared/dom.js';

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
let modelLabel = '';

/**
 * Move the headline towards the measured rate instead of snapping to it. The
 * value stays the service's 3 s average; only the way it is drawn is eased, so
 * a 300 ms poll reads as a continuous needle.
 */
function animateSpeed(dt) {
  if (!ui) return;
  shownTps = easeToward(shownTps, targetTps, dt);
  const rounded = Math.round(shownTps);
  if (rounded === lastRounded) return;
  lastRounded = rounded;
  ui.tpsValue.textContent = String(rounded);
}

/**
 * The wire carries the live series as values against a fixed cadence; this turns
 * it back into the {t, v} points the chart draws. `t` is nominal (t0 + i·step),
 * within a few ms of each sample, which is a third of a pixel on a 60 s window.
 */
function seriesPoints(data) {
  const series = data.series;
  if (!series || !Array.isArray(series.v)) return [];
  const step = series.step > 0 ? series.step : 250;
  return series.v.map((value, index) => ({ t: series.t0 + index * step, v: value }));
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
        <span class="speed-last last-line">no finished step yet</span>
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
      <div class="steps-axis" hidden><span class="steps-start"></span><span class="steps-now"></span></div>
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
    lastLine: app.querySelector('.last-line'),
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
    foot: app.querySelector('.foot-text'),
  };
}

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const scaled = value / pow;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * pow;
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

/** A model's list rate: 0.003 shows as $0.003, 0.15 as $0.15. */
function listRate(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  if (n < 0.001) return `$${n.toFixed(4)}`;
  if (n < 0.01) return `$${n.toFixed(3)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
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
  const total = typeof cost.total === 'number' ? cost.total : (totals.cost ?? 0);
  ui.costTotal.textContent = money4(total);
  ui.costTurn.textContent = typeof cost.lastTurn === 'number' ? money4(cost.lastTurn) : '—';
  ui.costTurn.title =
    (data.subagents?.loading ?? 0) > 0 || (data.subagents?.partial ?? 0) > 0 || data.historyPartial
      ? 'history is partial; the last turn can grow'
      : '';
  ui.costModel.textContent = modelLabel || cost.rates?.model || '—';
  ui.costModel.title = modelLabel || cost.rates?.model || '';
  ui.costRate.textContent = typeof cost.perMillion === 'number' ? `${rateMoney(cost.perMillion)} / 1M` : '—';
  ui.costRate.title = 'effective: this session’s cost divided by every token it processed';
  // The model's own list rates, recovered from OpenCode's step costs. They are
  // what the provider charged per million, not the blended rate above. A model
  // switch mid-session shows a dash until the new model has its own steps.
  const rates = cost.rates && (!modelLabel || cost.rates.model === modelLabel) ? cost.rates : null;
  ui.costRates.textContent = rates
    ? `model rates / 1M · in ${listRate(rates.input)} · out ${listRate(rates.output)} · cache ${listRate(rates.cacheRead)}`
    : 'model rates / 1M · —';
  ui.costRates.title = rates
    ? `recovered from this session's own step costs for ${rates.model}`
    : cost.rates
      ? `the rates recovered so far are for ${cost.rates.model}, not the session's current ${modelLabel}`
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

  // The scale follows what the session usually does, not one spike: a single
  // 1,000 t/s burst next to a 10 t/s stream would flatten the stream to a line.
  // The 92nd percentile is the ceiling, the spike clips at the top, and the
  // peak label still names the true maximum.
  const ranked = visible.map((point) => point.v).sort((a, b) => a - b);
  const typical = ranked.length ? ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.92))] : 0;
  liveScale = nextScale(liveScale, [typical * 1.15, rates.avg * 1.1, 8]);
  const max = niceMax(Math.max(liveScale, 8));

  // Draw a smoothed curve: the samples are a 250 ms average already, and the
  // providers arrive in bursts, so a short exponential pass keeps the shape
  // without inventing points the service did not measure.
  const smooth = [];
  for (const point of visible) {
    const previous = smooth[smooth.length - 1];
    const value = previous === undefined ? point.v : previous + (point.v - previous) * 0.3;
    smooth.push(value);
  }

  const pieces = [];
  pieces.push(
    `<defs><linearGradient id="tm-live-fill" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="var(--oc-primary)" stop-opacity="0.38" />` +
      `<stop offset="55%" stop-color="var(--oc-primary)" stop-opacity="0.12" />` +
      `<stop offset="100%" stop-color="var(--oc-primary)" stop-opacity="0" />` +
      `</linearGradient></defs>`,
  );

  const midY = pad + (height - pad * 2) * 0.5;
  pieces.push(
    `<line x1="0" y1="${midY.toFixed(1)}" x2="${width}" y2="${midY.toFixed(1)}" stroke="var(--oc-border)" stroke-width="1" stroke-dasharray="2 4" opacity="0.8" />`,
  );

  const lineY = (value) => height - pad - compress(value, max) * (height - pad * 2);
  if (rates.avg > 0) {
    const y = lineY(rates.avg);
    const labelY = y < pad + 10 ? y + 11 : y - 4;
    pieces.push(
      `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" stroke="var(--oc-success)" stroke-width="1" stroke-dasharray="3 3" opacity="0.7" />`,
      `<text x="${width - 2}" y="${labelY.toFixed(1)}" text-anchor="end" fill="var(--oc-success)" font-size="9.5" opacity="0.85">avg ${Math.round(rates.avg)} t/s</text>`,
    );
  }
  if (rates.peak > 0) {
    const y = lineY(rates.peak);
    // Below its line when the average is close above it, so the two labels never overlap.
    const near = Math.abs(y - lineY(rates.avg)) < 13;
    const labelY = near || y < pad + 10 ? y + 11 : y - 4;
    pieces.push(
      `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" stroke="var(--oc-error)" stroke-width="1" stroke-dasharray="6 3 2 3" opacity="0.65" />`,
      `<text x="${width - 2}" y="${labelY.toFixed(1)}" text-anchor="end" fill="var(--oc-error)" font-size="9.5" opacity="0.95">peak ${Math.round(rates.peak)} t/s</text>`,
    );
  }

  if (smooth.length > 1) {
    const coords = smooth.map((value, index) => {
      const x = ((visible[index].t - from) / 60_000) * width;
      const y = height - pad - compress(value, max) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const line = coords.join(' ');
    const lastX = coords[coords.length - 1].split(',')[0];
    pieces.push(
      `<polygon points="0,${height - pad} ${line} ${lastX},${height - pad}" fill="url(#tm-live-fill)" />`,
      `<polyline points="${line}" fill="none" stroke="var(--oc-primary)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />`,
    );
    const [cx, cy] = coords[coords.length - 1].split(',');
    pieces.push(`<circle cx="${cx}" cy="${cy}" r="2.6" fill="var(--oc-primary)" />`);
  } else {
    pieces.push(
      `<line x1="0" y1="${height - pad}" x2="${width}" y2="${height - pad}" stroke="var(--oc-primary)" stroke-width="1.6" opacity="0.45" />`,
    );
  }
  svg.innerHTML = pieces.join('');
  ui.peak.textContent = peakValue > 0 ? `live peak ${compact(peakValue)} t/s` : '';
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
  if (steps.length === 0) {
    svg.innerHTML = `<text x="${(width / 2).toFixed(1)}" y="${(height / 2).toFixed(1)}" text-anchor="middle" fill="var(--oc-muted)" font-size="11">no finished steps yet</text>`;
    ui.stepsAvg.textContent = '';
    ui.stepsPeak.textContent = '';
    ui.stepsAxis.hidden = true;
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
  const max = niceMax(peak);
  const slot = width / steps.length;
  // With every step on the chart a long session gets one-pixel bars; a gap
  // under half a pixel would just erase them.
  const barWidth = Math.max(1, Math.min(14, slot - 1));
  const pieces = [];
  steps.forEach((step, index) => {
    const h = Math.max(1.5, (step.tps / max) * (height - pad * 2));
    const x = index * slot + (slot - barWidth) / 2;
    const y = height - pad - h;
    const fill = step.sub ? 'var(--oc-info)' : 'var(--oc-primary)';
    pieces.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}" opacity="${(0.4 + 0.6 * (index / Math.max(1, steps.length - 1))).toFixed(2)}"><title>${step.sub ? 'subagent · ' : ''}${Math.round(step.tps)} t/s · ${compact(step.tokens)} tokens in ${seconds(step.ms)}</title></rect>`,
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
  ui.stepsAvg.textContent = average > 0 ? `avg ${Math.round(average)} t/s` : '';
  ui.stepsPeak.textContent = peak > 0 ? `peak ${Math.round(peak)} t/s` : '';
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
  // The number is eased in animateSpeed; render only says where it should go.
  targetTps = data.status === 'streaming' ? (data.live?.tps ?? 0) : 0;
  if (lastRounded === -1) {
    shownTps = targetTps;
    lastRounded = Math.round(shownTps);
    ui.tpsValue.textContent = String(lastRounded);
  }
  ui.tpsValue.classList.toggle('quiet', data.status === 'streaming' && quiet);
  ui.tpsSub.textContent =
    data.status === 'streaming'
      ? quiet
        ? data.live?.subagent
          ? 'a subagent is thinking · nothing streamed in the last 5 s'
          : 'thinking · nothing streamed in the last 5 s'
        : data.live?.subagent
          ? `${subagents.streaming > 1 ? `${subagents.streaming} subagents are` : 'a subagent is'} generating · ~${compact(data.live?.charsPerSecond ?? 0)} chars/s`
          : `last 5 s · ~${compact(data.live?.charsPerSecond ?? 0)} chars/s`
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
  ui.lastLine.textContent = lastStep?.tps
    ? `last ${Math.round(lastStep.tps)} t/s · ${seconds(lastStep.ms)} · ${compact(lastStep.tokens)} tok${lastSub}`
    : lastStep
      ? `last step ${seconds(lastStep.ms)} · ${compact(lastStep.tokens)} tok · too short to rate${lastSub}`
      : 'no finished step yet';

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
  inflight = true;
  try {
    const result = await host.serviceRequest({
      method: 'GET',
      path: '/state',
      query: { session: sessionId, steps: String(lastStepsSeq) },
    });
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
  lastRounded = -1;
  lastSteps = [];
  lastStepsSeq = -1;
  sessionId = nextSession;
  current = null;
  clearNotice();
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
