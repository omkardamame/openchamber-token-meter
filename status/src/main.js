import { HostRequestError, connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner } from '@openchamber/sdk/ui';
import { seconds } from '../../shared/summary.js';
import { compress, easeToward, nextScale, seriesPoints, smoothPath } from '../../shared/chart.js';
import { dotState, mountCells, paintCells } from '../../shared/cells.js';
import { el } from '../../shared/dom.js';
import { speedTier } from '../../shared/speed-color.js';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

const POLL_MS = 500;

let sessionId = null;
let timer = null;
let inflight = false;
let mounted = false;
let notice = null;
let banner = null;
let ui = null;
let current = null;
let cellNodes = new Map();
let failures = 0;
let pollGeneration = 0;
let lastHeight = 0;
let receivedAt = 0;
let sparkScale = 1;
let lastStepsSeq = -1;
let targetTps = 0;
let shownTps = 0;
let lastRounded = -1;
let streamingNow = false;
let lastTier = '';

// The same rule as the panel: a reader who asked for less motion reads the
// measured number, drawn without the easing travel.
const REDUCED_MOTION =
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Same easing as the panel: the value is measured, the movement is drawn. The
 * colour follows the number on screen, not the target, so the two never
 * disagree.
 */
function animateSpeed(dt) {
  if (!ui) return;
  shownTps = REDUCED_MOTION ? targetTps : easeToward(shownTps, targetTps, dt);
  const rounded = Math.round(shownTps);
  if (rounded !== lastRounded) {
    lastRounded = rounded;
    ui.tps.textContent = String(rounded);
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
  if (tier) ui.tps.dataset.tier = tier;
  else delete ui.tps.dataset.tier;
}

/** The host's clock at the last answer, advanced by the time since it arrived. */
function projectedNow(data) {
  return (data.generatedAt || Date.now()) + Math.min(1500, performance.now() - receivedAt);
}

/**
 * The section is exactly as tall as its content, whatever the labels say today.
 * It measures #root, which carries no height of its own: measuring a root that
 * stretches to the frame would feed the frame's height back into the next
 * measurement and the section would creep taller on every render.
 */
function fitHeight() {
  const content = ui?.app ? ui.app.scrollHeight : 0;
  const noticeHeight = notice ? notice.scrollHeight : 0;
  const measured = Math.ceil(content + noticeHeight) + 6;
  const next = Math.min(320, Math.max(24, measured));
  if (next === lastHeight) return;
  lastHeight = next;
  void host.setHeight(next).catch((error) => {
    // An older host may not resize sections; say so once, never silently.
    if (lastHeight === next) lastHeight = 0;
    console.warn('token meter: setHeight was refused', error);
  });
}

function build() {
  notice = el('div', 'notice');
  root.append(notice);
  const app = el('div', 'mini');
  app.innerHTML = `
    <div class="line">
      <span class="dot"></span>
      <div class="speed">
        <span class="speed-value" title="the session and every streaming subagent, added together"><b class="tps">0</b><span class="unit">t/s</span></span>
        <span class="last"><span class="last-rate"></span><span class="last-rest"></span></span>
      </div>
      <svg class="spark" data-chart="spark" height="30" aria-hidden="true"></svg>
    </div>
    <div class="grid totals-grid"></div>
  `;
  root.append(app);
  return {
    app,
    dot: app.querySelector('.dot'),
    tps: app.querySelector('.tps'),
    lastRate: app.querySelector('.last-rate'),
    lastRest: app.querySelector('.last-rest'),
    spark: app.querySelector('[data-chart="spark"]'),
    grid: app.querySelector('.grid'),
  };
}

function drawSpark(data) {
  const svg = ui.spark;
  const width = Math.max(60, svg.clientWidth || 120);
  const height = 30;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const series = Array.isArray(data.points) ? data.points : [];
  const now = projectedNow(data);
  const from = now - 60_000;
  const visible = series.filter((point) => point.t >= from && point.t <= now);
  // Same rule as the panel: follow the typical rate, let a lone spike clip.
  const ranked = visible.map((point) => point.v).sort((a, b) => a - b);
  const typical = ranked.length ? ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.92))] : 0;
  sparkScale = nextScale(sparkScale, [typical * 1.15, 1]);
  const max = Math.max(sparkScale, 1);
  if (visible.length < 2) {
    svg.innerHTML = `<line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke="var(--oc-primary)" stroke-width="1.2" opacity="0.4" />`;
    return;
  }
  let smoothed = 0;
  const points = visible.map((point, index) => {
    smoothed = index === 0 ? point.v : smoothed + (point.v - smoothed) * 0.3;
    return {
      x: ((point.t - from) / 60_000) * width,
      y: height - 1 - compress(smoothed, max) * (height - 3),
    };
  });
  // The same monotone curve as the panel: the spark shows the shape of a
  // measured rate, so it must not draw a number the service never reported. The
  // fill hangs from the curve down to the bottom edge.
  const line = smoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  svg.innerHTML = [
    `<defs><linearGradient id="tm-spark-fill" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0%" stop-color="var(--oc-primary)" stop-opacity="0.4" />`,
    `<stop offset="100%" stop-color="var(--oc-primary)" stop-opacity="0" />`,
    `</linearGradient></defs>`,
    `<path d="${line} L ${last.x.toFixed(1)},${height} L ${first.x.toFixed(1)},${height} Z" fill="url(#tm-spark-fill)" />`,
    `<path d="${line}" fill="none" stroke="var(--oc-primary)" stroke-width="1.3" stroke-linejoin="round" />`,
  ].join('');
}

function clearNotice() {
  banner?.dispose();
  banner = null;
  if (notice) notice.textContent = '';
}

function render(data) {
  if (data.ok === false) {
    if (banner) return;
    banner = mountBanner(notice, {
      tone: 'warning',
      title: 'Token meter is not reading OpenCode',
      body: data.error || 'Allow the extension in Settings → Extensions.',
    });
    return;
  }
  clearNotice();
  paintCells(cellNodes, data);
  const streaming = data.status === 'streaming';
  ui.dot.dataset.state = dotState(data.status);
  const quiet = (data.live?.charsPerSecond ?? 0) < 5;
  targetTps = streaming ? (data.live?.tps ?? 0) : 0;
  if (lastRounded === -1) {
    shownTps = targetTps;
    lastRounded = Math.round(shownTps);
    ui.tps.textContent = String(lastRounded);
  }
  const quietRate = streaming && quiet;
  streamingNow = streaming && !quiet;
  ui.tps.classList.toggle('quiet', quietRate);
  paintTier();
  const lastStep = data.live?.lastStep;
  const lastSub = lastStep?.sub ? ' · sub' : '';
  if (data.status === 'tool') {
    ui.lastRate.textContent = '';
    delete ui.lastRate.dataset.tier;
    ui.lastRest.textContent = data.live?.subagent ? 'subagent tool' : 'running a tool';
  } else if (lastStep?.tps) {
    ui.lastRate.textContent = `last ${Math.round(lastStep.tps)} t/s`;
    // Classify the digits on screen, exactly like the headline, so a 19.6 t/s
    // step printed as "20" is not coloured as a slow rate.
    ui.lastRate.dataset.tier = speedTier(Math.round(lastStep.tps));
    ui.lastRest.textContent = lastSub;
  } else {
    ui.lastRate.textContent = '';
    delete ui.lastRate.dataset.tier;
    ui.lastRest.textContent = lastStep ? `last step ${seconds(lastStep.ms)} · too short to rate${lastSub}` : 'no finished step yet';
  }

  drawSpark(data);
  fitHeight();
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
    // The section may have moved to another session while this was in flight;
    // the answer is about the session that left and must not paint.
    if (asked !== sessionId) return;
    const data = JSON.parse(result.body);
    // This surface draws no steps: it keeps the sequence only, so the service
    // leaves the list off the answer.
    if (typeof data.stepsSeq === 'number') lastStepsSeq = data.stepsSeq;
    data.points = seriesPoints(data);
    current = data;
    receivedAt = performance.now();
    failures = 0;
    render(data);
  } catch (error) {
    if (asked !== sessionId) return;
    failures += 1;
    const code = error instanceof HostRequestError ? error.code : '';
    if (!banner) {
      banner = mountBanner(notice, {
        tone: 'warning',
        title: 'Token meter is not running',
        body:
          code === 'SERVICE_FAILED'
            ? `The local service stopped: ${error instanceof Error ? error.message : String(error)}`
            : 'Open Settings → Extensions → Token Meter and allow the local service.',
      });
    }
  } finally {
    inflight = false;
  }
}

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

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (!mounted) {
    mounted = true;
    ui = build();
    cellNodes = mountCells(ui.grid);
    const observer = new ResizeObserver(() => {
      if (current) drawSpark(current);
    });
    observer.observe(ui.spark);
    // Redraw between polls against the projected clock, but only while tokens
    // are moving: a 60 s curve gains nothing from 60 fps, and an idle section
    // should not repaint at all.
    let lastPaint = 0;
    let lastFrame = 0;
    const paint = (stamp) => {
      const dt = lastFrame ? Math.min(200, stamp - lastFrame) : 16;
      lastFrame = stamp;
      if (!document.hidden) {
        animateSpeed(dt);
        const moving = current && (current.status === 'streaming' || current.status === 'tool');
        if (moving && stamp - lastPaint >= 100) {
          lastPaint = stamp;
          drawSpark(current);
        }
      }
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
    fitHeight();
  }
  const nextSession = ctx.session?.id ?? null;
  if (nextSession === sessionId) return;
  // Same reset as the panel: no digits, tier, spark scale or last-step line
  // from the previous session may survive the switch.
  targetTps = 0;
  shownTps = 0;
  lastRounded = 0;
  streamingNow = false;
  lastTier = '';
  sparkScale = 1;
  ui.tps.textContent = '0';
  delete ui.tps.dataset.tier;
  ui.lastRate.textContent = '';
  ui.lastRest.textContent = 'no finished step yet';
  delete ui.lastRate.dataset.tier;
  lastStepsSeq = -1;
  sessionId = nextSession;
  current = null;
  clearNotice();
  // The cells describe the session that left; painted empty, they cannot sit
  // under the new session's name until its first answer lands.
  paintCells(cellNodes, {});
  drawSpark({ points: [] });
  fitHeight();
  if (!sessionId) {
    stopPolling();
    ui.app.style.display = 'none';
    // The host still draws the section title, so say why the body is empty
    // instead of handing it a blank box.
    if (!banner) notice.replaceChildren(el('span', 'empty-note', 'Open a chat to read its usage.'));
    fitHeight();
    return;
  }
  ui.app.style.display = '';
  startPolling();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll();
});
