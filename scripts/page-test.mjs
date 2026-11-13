// Page tests: run the built panel and status pages in a real browser against a
// fake host frame, and assert what they draw.
//
// The extension only exists inside OpenChamber, so unit tests can reach the
// service and the shared maths but never the rendering. This harness serves the
// package over http, embeds each page in a same-origin iframe, answers the
// `openchamber.sdk` handshake by hand, and reads the page's own DOM back.
//
//   node scripts/page-test.mjs        (needs agent-browser, else it says so)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smoothPath } from '../shared/chart.js';
import { duration } from '../shared/summary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One canned answer, shaped exactly like the service's.
const state = (over = {}) =>
  ({
    ok: true,
    session: 'ses_page',
    status: 'idle',
    error: null,
    totals: {
      input: 455_000,
      output: 87_000,
      reasoning: 78_000,
      cacheRead: 48_600_000,
      cacheWrite: 0,
      cost: 0.31,
      steps: 165,
      prompt: 49_055_000,
      generated: 165_000,
      consumed: 49_220_000,
      cacheHitRate: 0.9907,
      source: 'usage',
    },
    live: {
      tps: 36,
      charsPerSecond: 313,
      charsPerToken: 0.11,
      ttftMs: 6500,
      lastStep: { tokens: 1100, ms: 7800, tps: 33, aborted: false },
      estimated: true,
    },
    cost: {
      total: 0.31,
      lastTurn: 0.08,
      perMillion: 0.0504,
      rates: { model: 'deepseek-v4.1-flash', input: 0.15, output: 0.6, cacheRead: 0.003 },
      tariff: {
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        peak: true,
        multiplier: 2,
        window: '01:00–04:00 and 06:00–10:00 UTC, Mon–Fri',
        source: 'recovered',
        tiers: {
          offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
          peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
        },
      },
    },
    subagents: { count: 0, running: 0, loading: 0, partial: 0, streaming: 0, tool: 0, active: [] },
    series: { t0: Date.now() - 5000, step: 250, v: [30, 34, 36] },
    stepsSeq: 3,
    stepsFrom: Date.now() - 120_000,
    stepsKnown: 2,
    steps: [
      { tokens: 1100, ms: 7800, tps: 141, aborted: false, at: Date.now() - 60_000, cost: 0.0012 },
      { tokens: 900, ms: 5000, tps: 180, aborted: false, at: Date.now() - 30_000, cost: 0.0034 },
    ],
    turn: { active: false, startedAt: Date.now() - 90_000, tokens: 2000, steps: 2 },
    rates: { avg: 79, peak: 334 },
    stream: { state: 'open' },
    loading: false,
    historyPartial: false,
    generatedAt: Date.now(),
    ...over,
  });

const harness = `<!doctype html><meta charset="utf-8"><title>page test</title>
<body style="margin:0;background:#111">
<iframe id="f" src="/__page" style="width:420px;height:900px;border:0"></iframe>
<script>
  const CHANNEL = 'openchamber.sdk';
  const V = 1;
  window.__errors = [];
  window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
  const frame = document.getElementById('f');
  const posts = [];
  window.__posts = posts;
  const ready = (session) => ({
    channel: CHANNEL, v: V, type: 'ready',
    payload: {
      session,
      surface: 'status',
      connection: { connected: true, account: null },
      settings: {},
      locale: 'en',
      theme: { mode: 'dark', tokens: { success: '#4ade80', warning: '#f59e0b', primary: '#e07a3f', info: '#3b82f6', error: '#ef4444' } },
      features: {},
    },
  });
  const pageSession = { id: 'ses_page', title: 'page test', busy: false__MODEL__ };
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    posts.push(message.type);
    const reply = (payload) => frame.contentWindow.postMessage({ channel: CHANNEL, v: V, type: 'result', id: message.id, ok: true, payload }, '*');
    if (message.type === 'hello') {
      frame.contentWindow.postMessage(ready(pageSession), '*');
      return;
    }
    if (message.type === 'service-request') {
      const answer = window.__answer ? window.__answer(message.payload) : window.__answerFor(message.payload);
      if (window.__delayMs) setTimeout(() => reply(answer), window.__delayMs);
      else reply(answer);
      return;
    }
    if (message.type === 'set-height') return;
  });
  window.__delayMs = 0;
  window.__setState = (next) => { window.__state = next; };
  // The service leaves the step list out when the frame already has this
  // sequence, which is what lets the frame keep one array object between polls.
  // Mimic it, so a poll that changed nothing can keep the bars it drew.
  window.__served = { seq: null, signature: '' };
  window.__answerFor = (payload) => {
    const current = window.__state;
    const signature = JSON.stringify(current && current.steps);
    const asked = payload && payload.query ? payload.query.steps : undefined;
    if (
      current &&
      Array.isArray(current.steps) &&
      window.__served.seq !== null &&
      String(asked) === String(window.__served.seq) &&
      signature === window.__served.signature
    ) {
      const { steps, ...rest } = current;
      return { status: 200, body: JSON.stringify(rest) };
    }
    window.__served = { seq: current ? current.stepsSeq : null, signature };
    return { status: 200, body: JSON.stringify(current) };
  };
  // Pointer events are dispatched inside the iframe: the page compares clientX
  // with its own bounding rect, so the coordinates are iframe coordinates.
  window.__hover = (selector, fraction) => {
    const target = frame.contentDocument.querySelector(selector);
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const View = frame.contentWindow;
    target.dispatchEvent(new View.PointerEvent('pointermove', {
      clientX: rect.left + rect.width * fraction,
      clientY: rect.top + rect.height * 0.5,
      bubbles: true,
    }));
    return true;
  };
  window.__leave = (selector) => {
    const target = frame.contentDocument.querySelector(selector);
    if (!target) return false;
    target.dispatchEvent(new frame.contentWindow.PointerEvent('pointerleave', { bubbles: false }));
    return true;
  };
  window.__markStep = () => {
    const rect = frame.contentDocument.querySelector('[data-chart="steps"] rect:not([data-role])');
    if (!rect) return false;
    rect.setAttribute('data-mark', '1');
    return true;
  };
  // A second ready is how the host switches sessions; the SDK re-fires onReady.
  window.__switchSession = (next, id) => {
    window.__state = next;
    frame.contentWindow.postMessage(ready({ ...pageSession, id }), '*');
  };
  // Every value the first totals cell is painted with, so a paint that flashes
  // the session the frame just left can still be caught after the fact.
  window.__trail = [];
  window.__watchTotals = () => {
    const cell = frame.contentDocument.querySelector('.totals-grid .cell-value');
    window.__trail = [cell ? cell.textContent : null];
    new MutationObserver(() => window.__trail.push(cell.textContent)).observe(cell, { childList: true, characterData: true, subtree: true });
  };
  window.__state = __STATE__;
  window.__read = () => {
    const doc = frame.contentDocument;
    const text = doc.body.innerText.replace(/\\s+/g, ' ').trim();
    const dot = doc.querySelector('.dot');
    const rate = doc.querySelector('.tps-value') || doc.querySelector('.tps');
    const rateStyle = rate ? getComputedStyle(rate) : null;
    const last = doc.querySelector('.last-rate');
    const lastStyle = last ? getComputedStyle(last) : null;
    const dotShadow = dot ? getComputedStyle(dot).boxShadow : null;
    const dotHalo = dot ? getComputedStyle(dot, '::before').backgroundImage : null;
    const mini = doc.querySelector('.mini');
    return {
      text,
      dotState: dot ? dot.getAttribute('data-state') : null,
      dotShadow,
      dotHalo,
      miniPad: mini ? getComputedStyle(mini).paddingLeft : null,
      tpsTier: rate ? rate.getAttribute('data-tier') : null,
      tpsColor: rateStyle ? rateStyle.color : null,
      tpsShadow: rateStyle ? rateStyle.textShadow : null,
      tpsWeight: rateStyle ? rateStyle.fontWeight : null,
      tpsTransition: rateStyle ? rateStyle.transitionProperty : null,
      tpsTransitionMs: rateStyle ? rateStyle.transitionDuration : null,
      cells: [...doc.querySelectorAll('.totals-grid .cell-label')].map((n) => n.textContent),
      values: [...doc.querySelectorAll('.totals-grid .cell-value')].map((n) => n.textContent.trim()),
      tps: (doc.querySelector('.tps-value') || doc.querySelector('.tps') || {}).textContent,
      bars: doc.querySelectorAll('[data-chart="steps"] rect:not([data-role="step-hover-col"])').length,
      stepSvg: (doc.querySelector('[data-chart="steps"]') || {}).innerHTML ?? '',
      subsHidden: doc.querySelector('.subagents') ? doc.querySelector('.subagents').hidden : null,
      legendHidden: doc.querySelector('.legend') ? doc.querySelector('.legend').hidden : null,
      legendText: doc.querySelector('.legend') ? doc.querySelector('.legend').innerText.replace(/\\s+/g, ' ').trim() : null,
      stepsAvgColor: doc.querySelector('.steps-avg') ? getComputedStyle(doc.querySelector('.steps-avg')).color : null,
      costModelFont: doc.querySelector('.cost-model') ? getComputedStyle(doc.querySelector('.cost-model')).fontSize : null,
      costTotalFont: doc.querySelector('.cost-total') ? getComputedStyle(doc.querySelector('.cost-total')).fontSize : null,
      costTiers: [...doc.querySelectorAll('.cost-rates .rate-row[data-tier]')].map((node) => ({
        tier: node.getAttribute('data-tier'),
        active: node.getAttribute('data-active'),
        color: getComputedStyle(node).color,
        cells: [...node.querySelectorAll('.rate-num')].map((cell) => cell.textContent),
      })),
      costRatesTitle: (doc.querySelector('.cost-rates') || {}).title,
      ttftFont: (() => {
        const cell = [...doc.querySelectorAll('.totals-grid .cell')].find((node) => node.querySelector('.cell-label')?.textContent === 'TTFT');
        return cell ? getComputedStyle(cell.querySelector('.cell-value')).fontSize : null;
      })(),
      inFont: (() => {
        const cell = [...doc.querySelectorAll('.totals-grid .cell')].find((node) => node.querySelector('.cell-label')?.textContent === 'In');
        return cell ? getComputedStyle(cell.querySelector('.cell-value')).fontSize : null;
      })(),
      consumedFont: (() => {
        const cell = [...doc.querySelectorAll('.totals-grid .cell')].find((node) => node.querySelector('.cell-label')?.textContent === 'Consumed');
        return cell ? getComputedStyle(cell.querySelector('.cell-value')).fontSize : null;
      })(),
      stepsPeakColor: doc.querySelector('.steps-peak') ? getComputedStyle(doc.querySelector('.steps-peak')).color : null,
      lastRateTier: last ? last.getAttribute('data-tier') : null,
      lastRateColor: lastStyle ? lastStyle.color : null,
      lastRateShadow: lastStyle ? lastStyle.textShadow : null,
      lastRateText: last ? last.textContent : null,
      stepsAvgSep: doc.querySelector('.steps-avg') ? getComputedStyle(doc.querySelector('.steps-avg'), '::before').content : null,
      stepsPeakSep: doc.querySelector('.steps-peak') ? getComputedStyle(doc.querySelector('.steps-peak'), '::before').content : null,
      stepsAxisText: doc.querySelector('.steps-axis') ? doc.querySelector('.steps-axis').innerText.replace(/\\s+/g, ' ').trim() : null,
      liveTopY: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        if (!line) return null;
        return Math.round(line.getBBox().y * 10) / 10;
      })(),
      livePolyline: Boolean(doc.querySelector('[data-chart="live"] path[data-role="live-line"]')),
      liveCurve: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        return line ? String(line.getAttribute('d')).includes('C') : false;
      })(),
      liveDots: doc.querySelectorAll('[data-chart="live"] circle:not([data-role])').length,
      liveCross: Boolean(doc.querySelector('[data-chart="live"] [data-role="live-cross"]')),
      gridLabels: [...doc.querySelectorAll('[data-chart="live"] [data-role="grid-label"]')].map((n) => n.textContent),
      timeGrid: doc.querySelectorAll('[data-chart="live"] line[data-role="time-grid"]').length,
      peakText: (doc.querySelector('.axis-peak') || {}).textContent,
      stepsPeakTop: (() => {
        const rects = [...doc.querySelectorAll('[data-chart="steps"] rect:not([data-role="step-hover-col"])')];
        return rects.length ? Math.min(...rects.map((rect) => Number(rect.getAttribute('y')))) : null;
      })(),
      stepMark: Boolean(doc.querySelector('[data-chart="steps"] rect[data-mark="1"]')),
      stepsHoverText: (doc.querySelector('.steps-hover') || {}).textContent,
      stepsHoverHidden: doc.querySelector('.steps-hover') ? doc.querySelector('.steps-hover').hidden : null,
      stepsStartHidden: doc.querySelector('.steps-start') ? doc.querySelector('.steps-start').hidden : null,
      stepsNowHidden: doc.querySelector('.steps-now') ? doc.querySelector('.steps-now').hidden : null,
      statusLabel: (doc.querySelector('.status-label') || {}).textContent,
      costTurnTitle: (doc.querySelector('.cost-turn') || {}).title,
      labels: [...doc.querySelectorAll('svg text')].map((n) => n.textContent),
    };
  };
</script>`;

const scenario = (page, answer, model = ", model: 'opencode-go/deepseek-v4.1-flash'") =>
  harness
    .replace('/__page', `/package/${page}`)
    .replace('__STATE__', JSON.stringify(answer))
    .replace('__MODEL__', model);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/panel' || url.pathname === '/status' || url.pathname === '/panel-nomodel' || url.pathname === '/panel-low') {
    const page = url.pathname === '/status' ? 'status/index.html' : 'panel/index.html';
    const answer =
      url.pathname === '/panel-low'
        ? state({ status: 'streaming', live: { ...state().live, tps: 4 }, series: { t0: Date.now() - 2000, step: 250, v: [2, 3, 4] } })
        : state();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(scenario(page, answer, url.pathname === '/panel-nomodel' ? '' : undefined));
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(url.pathname.replace(/^\/package\//, '')));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

const port = 41_873;
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

if (spawnSync('agent-browser', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.log('PAGE TESTS SKIPPED — agent-browser is not installed here');
  process.exit(0);
}

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

// Async on purpose: execFileSync would block the event loop and the test server
// could never answer the page it just opened.
const run_ = promisify(execFile);
const browser = async (args) => (await run_('agent-browser', args, { timeout: 30_000 })).stdout.trim();

const run = async (page) => {
  await browser(['open', `http://127.0.0.1:${port}/${page}`]);
  await browser(['set', 'viewport', '460', '960']);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return {
    read: async () => JSON.parse(JSON.parse(await browser(['eval', 'JSON.stringify(window.__read())']))),
    errors: async () => JSON.parse(JSON.parse(await browser(['eval', 'JSON.stringify(window.__errors)']))),
    set: async (next) => {
      await browser(['eval', `window.__setState(${JSON.stringify(next)})`]);
      await new Promise((resolve) => setTimeout(resolve, 1600));
    },
    switchSession: async (next, id = 'ses_next') => {
      await browser(['eval', `window.__switchSession(${JSON.stringify(next)}, ${JSON.stringify(id)})`]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
    delay: async (ms) => {
      await browser(['eval', `window.__delayMs = ${ms}`]);
    },
    watchTotals: async () => {
      await browser(['eval', 'window.__watchTotals()']);
    },
    hover: async (selector, fraction) => {
      await browser(['eval', `window.__hover(${JSON.stringify(selector)}, ${fraction})`]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    leave: async (selector) => {
      await browser(['eval', `window.__leave(${JSON.stringify(selector)})`]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    markStep: async () => {
      await browser(['eval', 'window.__markStep()']);
    },
    trail: async () => JSON.parse(JSON.parse(await browser(['eval', 'JSON.stringify(window.__trail)']))),
  };
};

/** The headline is eased; a busy browser can paint fewer frames than 1.6 s allows. */
const settle = async (handle, field, want) => {
  let value = await handle.read();
  for (let i = 0; i < 25 && value[field] !== want; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await handle.read();
  }
  return value;
};

try {
  // --- the shared curve and the turn timer ---------------------------------
  const spike = [
    { x: 0, y: 40 },
    { x: 10, y: 40 },
    { x: 20, y: 0 },
    { x: 30, y: 40 },
  ];
  const spikePath = smoothPath(spike);
  const controls = spikePath
    .split(' C ')
    .slice(1)
    .flatMap((segment) => segment.split(' ').slice(0, 2).map((pair) => Number(pair.split(',')[1])));
  check(
    'curve stays inside the samples it was given',
    spikePath.includes('C') && controls.length === 6 && controls.every((y) => y >= 0 && y <= 40),
    controls.join(' | '),
  );
  check('curve draws one sample as a point', smoothPath([{ x: 1, y: 2 }]) === 'M 1.0,2.0', smoothPath([{ x: 1, y: 2 }]));
  check('curve draws nothing for no samples', smoothPath([]) === '', `"${smoothPath([])}"`);
  check(
    'timer reads seconds, minutes and hours',
    duration(42_000) === '42s' &&
      duration(83_000) === '1m 23s' &&
      duration(3_723_000) === '1h 02m' &&
      duration(900) === '',
    [duration(42_000), duration(83_000), duration(3_723_000), `"${duration(900)}"`].join(' | '),
  );

  // --- the panel -----------------------------------------------------------
  const panel = await run('panel');
  const idle = await panel.read();
  check('panel draws all eight cells', idle.cells.join(',') === 'In,Out,Think,Total out,Cache,Cache hit,TTFT,Consumed', idle.cells.join(','));
  check('panel draws the consumed total', idle.values.some((v) => v.startsWith('49.2M')), idle.values.join(' | '));
  check('panel draws the measured ttft', idle.values.some((v) => v.includes('6.5 s')), idle.values.join(' | '));
  check('panel labels the average and the peak', idle.labels.some((l) => l.startsWith('avg 79')) && idle.labels.some((l) => l.startsWith('peak 334')), idle.labels.join(' | '));
  check('panel makes the live curve use the full chart height', idle.liveTopY === 8, String(idle.liveTopY));
  check(
    'panel labels the live scale at half and full height',
    idle.gridLabels.length === 2 &&
      /^\d+$/.test(idle.gridLabels[0]) &&
      Number(idle.gridLabels[0]) > 0 &&
      Math.abs(Number(idle.gridLabels[0]) - 2 * Number(idle.gridLabels[1])) <= 2,
    idle.gridLabels.join(' | '),
  );
  check('panel marks where 15, 30 and 45 seconds ago sit', idle.timeGrid === 3, String(idle.timeGrid));
  check('panel draws the live curve as a smooth path', idle.liveCurve === true, String(idle.liveCurve));
  check(
    'panel says what the last turn was made of',
    idle.costTurnTitle === '2 steps · 2.0k generated tokens',
    String(idle.costTurnTitle),
  );
  check('panel pins the tallest step to the top of its chart', idle.stepsPeakTop === 6, String(idle.stepsPeakTop));
  check('panel shows the last measured step', /last 33 t\/s/.test(idle.text), idle.text.slice(0, 60));
  check(
    'panel puts the last turn cost after the last measured step',
    /last 33 t\/s · 7\.8 s · 1\.1k tok · \$0\.0800/.test(idle.text),
    idle.text.slice(0, 100),
  );
  check(
    'panel colours the last measured step by its tier',
    idle.lastRateTier === 'steady' && idle.lastRateColor === 'rgb(118, 172, 79)' && idle.lastRateShadow === 'none',
    `${idle.lastRateTier} ${idle.lastRateColor} ${idle.lastRateShadow}`,
  );
  // The last line follows the finished step's own rate, not the live headline.
  const hotBase = state();
  await panel.set({ ...hotBase, live: { ...hotBase.live, lastStep: { ...hotBase.live.lastStep, tps: 120 } } });
  const hotLast = await settle(panel, 'lastRateColor', 'rgb(212, 175, 55)');
  check(
    'panel glows a fast last step golden',
    hotLast.lastRateTier === 'blazing' &&
      hotLast.lastRateColor === 'rgb(212, 175, 55)' &&
      /^rgba\(212, 175, 55, 0\.45\) 0px 0px 8px$/.test(String(hotLast.lastRateShadow)),
    `${hotLast.lastRateTier} ${hotLast.lastRateColor} ${hotLast.lastRateShadow}`,
  );

  const oneBase = state();
  await panel.set({ ...oneBase, series: { t0: Date.now() - 1000, step: 250, v: [120] } });
  const onePoint = await panel.read();
  check(
    'panel draws a single live sample at its value, not as a baseline',
    onePoint.liveDots === 1 && onePoint.livePolyline === false,
    `${onePoint.liveDots} dots, line ${onePoint.livePolyline}`,
  );

  // A resting session samples zeros; the 8 t/s floor is not a measured scale.
  await panel.set({ ...oneBase, series: { t0: Date.now() - 2000, step: 250, v: [0, 0, 0, 0] } });
  const flat = await panel.read();
  check('panel leaves the scale unlabelled while nothing was measured', flat.gridLabels.length === 0, flat.gridLabels.join(' | '));

  const boundaryBase = state();
  await panel.set({ ...boundaryBase, live: { ...boundaryBase.live, lastStep: { ...boundaryBase.live.lastStep, tps: 19.6 } } });
  const boundaryLast = await panel.read();
  check(
    'panel colours the last step by the digits it prints',
    boundaryLast.lastRateTier === 'steady' && /last 20 t\/s/.test(boundaryLast.text),
    `${boundaryLast.lastRateTier} ${boundaryLast.text.slice(0, 40)}`,
  );
  check('panel sits on a dim dot when idle', idle.dotState === 'idle', String(idle.dotState));
  check('panel hides the subagent list and legend when there are none', idle.subsHidden === true && idle.legendHidden === true, `${idle.subsHidden}/${idle.legendHidden}`);
  check('panel shows the per-step average and peak together', /avg 156 t\/s.*peak 180 t\/s/.test(idle.text), idle.text.slice(0, 120));
  check('panel dots the step header', String(idle.stepsAvgSep).includes('·') && String(idle.stepsPeakSep).includes('·'), `${idle.stepsAvgSep} ${idle.stepsPeakSep}`);
  check('panel counts every step it keeps', /2 steps/.test(idle.text), idle.text.slice(0, 120));
  check('panel colours the per-step average green', idle.stepsAvgColor === 'rgb(74, 222, 128)', String(idle.stepsAvgColor));
  check('panel colours the peak red', idle.stepsPeakColor === 'rgb(239, 68, 68)', String(idle.stepsPeakColor));
  check(
    'panel shows the steps start and current time',
    /start \d\d:\d\d:\d\d/.test(idle.stepsAxisText ?? '') && /now \d\d:\d\d:\d\d/.test(idle.stepsAxisText ?? ''),
    String(idle.stepsAxisText),
  );
  check('panel sets Consumed to the same size as the other stats', idle.consumedFont === idle.inFont, `${idle.consumedFont}/${idle.inFont}`);
  check(
    'panel shows total cost, last-turn cost, model and rate',
    /Total \$0\.3100/i.test(idle.text) &&
      /Last turn \$0\.0800/i.test(idle.text) &&
      /deepseek-v4\.1-flash/.test(idle.text) &&
      /\$0\.05 \/ 1M/.test(idle.text),
    idle.text.slice(-160),
  );
  check(
    'panel matches the model and TTFT fonts to the other stats',
    idle.costModelFont === idle.costTotalFont && idle.ttftFont === idle.inFont,
    `${idle.costModelFont}/${idle.costTotalFont} · ${idle.ttftFont}/${idle.inFont}`,
  );
  check(
    'panel puts the active peak row above the off-peak row',
    idle.costTiers?.[0]?.tier === 'peak' &&
      idle.costTiers[0].active === 'true' &&
      idle.costTiers[0].cells.join('|') === '$0.30|$1.20|$0.006' &&
      idle.costTiers?.[1]?.tier === 'off-peak' &&
      idle.costTiers[1].active === 'false' &&
      idle.costTiers[1].cells.join('|') === '$0.15|$0.60|$0.003',
    JSON.stringify(idle.costTiers),
  );
  check(
    'panel marks the active peak row in the warning colour',
    idle.costTiers?.[0]?.color === 'rgb(245, 158, 11)',
    String(idle.costTiers?.[0]?.color),
  );

  await panel.set(state({ cost: { ...state().cost, tariff: { ...state().cost.tariff, peak: false } } }));
  const offPeak = await panel.read();
  check(
    'panel puts the active off-peak row first',
    offPeak.costTiers?.[0]?.tier === 'off-peak' &&
      offPeak.costTiers[0].active === 'true' &&
      offPeak.costTiers[0].cells.join('|') === '$0.15|$0.60|$0.003' &&
      offPeak.costTiers?.[1]?.tier === 'peak' &&
      offPeak.costTiers[1].cells.join('|') === '$0.30|$1.20|$0.006',
    JSON.stringify(offPeak.costTiers),
  );

  await panel.set(state({ cost: { ...state().cost, rates: null } }));
  const cardOnly = await panel.read();
  check(
    'panel draws the tariff card before a rate is recovered',
    cardOnly.costTiers.length === 2 &&
      cardOnly.costTiers[0].tier === 'peak' &&
      cardOnly.costTiers[0].cells.join('|') === '$0.30|$1.20|$0.006',
    JSON.stringify(cardOnly.costTiers),
  );

  await panel.set(state({ cost: { ...state().cost, tariff: null } }));
  const flatModel = await panel.read();
  check(
    'panel falls back to one recovered line for a flat-priced model',
    /model rates \/ 1M · in \$0\.15 · out \$0\.60 · cache \$0\.003/.test(flatModel.text) && flatModel.costTiers.length === 0,
    JSON.stringify(flatModel.costTiers),
  );

  await panel.set(state({ cost: { ...state().cost, rates: null, tariff: null, ratesNote: 'nonLinear' } }));
  const nonLinear = await panel.read();
  check(
    'panel explains a provider with more than one price and no schedule',
    nonLinear.costTiers.length === 0 &&
      /multiple rates; no schedule/.test(nonLinear.text) &&
      /no published schedule/.test(nonLinear.costRatesTitle ?? ''),
    String(nonLinear.costRatesTitle),
  );

  await panel.set(state({ cost: { ...state().cost, rates: null, tariff: null, ratesNote: 'noCache' } }));
  const noCache = await panel.read();
  check(
    'panel explains a fit with no cache reads',
    /cannot separate the cache rate/.test(noCache.costRatesTitle ?? ''),
    String(noCache.costRatesTitle),
  );

  await panel.set({ ...state(), stepsKnown: 5 });
  const totalCount = await panel.read();
  check('panel counts steps older than the drawn list', /5 steps/.test(totalCount.text), totalCount.text.slice(0, 120));

  await panel.set({ ...state(), subagents: { count: 5, running: 0, loading: 2, streaming: 0, tool: 0, active: [] } });
  const loading = await panel.read();
  check('panel says when subagent histories are still loading', /reading 2 subagent histories/.test(loading.text), loading.text.slice(-100));

  await panel.set({ ...state(), subagents: { count: 5, running: 0, loading: 0, partial: 2, streaming: 0, tool: 0, active: [] } });
  const subPartial = await panel.read();
  check('panel says when subagent histories are partial', /2 subagent histories are partial/.test(subPartial.text), subPartial.text.slice(-100));

  await panel.set({ ...state(), historyPartial: true });
  const partial = await panel.read();
  check('panel says when the session history is partial', /history is partial/.test(partial.text), partial.text.slice(-100));

  await panel.set(state({ status: 'streaming' }));
  const streaming = await settle(panel, 'tps', '36');
  check('panel draws the live rate while generating', streaming.tps === '36', String(streaming.tps));
  check('panel breathes the dot while generating', streaming.dotState === 'streaming', String(streaming.dotState));
  check(
    'panel glows the dot with a round halo instead of a box-shadow',
    streaming.dotShadow === 'none' && /^radial-gradient/.test(streaming.dotHalo ?? ''),
    `${streaming.dotShadow} | ${(streaming.dotHalo ?? '').slice(0, 44)}`,
  );
  check(
    'panel colours a 36 t/s rate green and keeps it semibold',
    streaming.tpsTier === 'steady' &&
      streaming.tpsColor === 'rgb(118, 172, 79)' &&
      streaming.tpsWeight === '600' &&
      streaming.tpsShadow === 'none',
    `${streaming.tpsTier} ${streaming.tpsColor} ${streaming.tpsWeight} ${streaming.tpsShadow}`,
  );
  check(
    'panel transitions the rate colour',
    String(streaming.tpsTransition).includes('color') &&
      String(streaming.tpsTransitionMs)
        .split(',')
        .every((duration) => duration.trim() === '0.25s'),
    `${streaming.tpsTransition} ${streaming.tpsTransitionMs}`,
  );

  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 12 } }));
  const slowRate = await settle(panel, 'tps', '12');
  check(
    'panel turns the live rate matte red below 20 t/s without a glow',
    slowRate.tpsTier === 'slow' && slowRate.tpsColor === 'rgb(201, 106, 106)' && slowRate.tpsShadow === 'none',
    `${slowRate.tpsTier} ${slowRate.tpsColor} ${slowRate.tpsShadow}`,
  );

  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 68 } }));
  const fastRate = await settle(panel, 'tps', '68');
  check(
    'panel turns the live rate sky blue from 50 t/s without a glow',
    fastRate.tpsTier === 'fast' && fastRate.tpsColor === 'rgb(59, 130, 246)' && fastRate.tpsShadow === 'none',
    `${fastRate.tpsTier} ${fastRate.tpsColor} ${fastRate.tpsShadow}`,
  );

  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 120 } }));
  const blazingRate = await settle(panel, 'tps', '120');
  check(
    'panel turns the live rate golden from 90 t/s and glows',
    blazingRate.tpsTier === 'blazing' &&
      blazingRate.tpsColor === 'rgb(212, 175, 55)' &&
      /^rgba\(212, 175, 55, 0\.45\) 0px 0px 8px$/.test(String(blazingRate.tpsShadow)),
    `${blazingRate.tpsTier} ${blazingRate.tpsColor} ${blazingRate.tpsShadow}`,
  );

  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 240 } }));
  const ultraRate = await settle(panel, 'tps', '240');
  check(
    'panel turns the live rate violet above 150 t/s and glows',
    ultraRate.tpsTier === 'ultra' &&
      ultraRate.tpsColor === 'rgb(168, 85, 247)' &&
      /^rgba\(168, 85, 247, 0\.45\) 0px 0px 8px$/.test(String(ultraRate.tpsShadow)),
    `${ultraRate.tpsTier} ${ultraRate.tpsColor} ${ultraRate.tpsShadow}`,
  );

  // "thinking": a stream is open but no characters arrived, so the number is
  // muted and carries no tier however high it was a moment ago.
  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 120, charsPerSecond: 0 } }));
  const quietRate = await settle(panel, 'tps', '120');
  check('panel drops the tier when nothing is streaming', quietRate.tpsTier === null, `${quietRate.tpsTier} ${quietRate.tpsColor}`);
  check(
    'panel names the 3 s window while nothing streams',
    /thinking · nothing streamed in the last 3 s/.test(quietRate.text),
    quietRate.text.slice(0, 90),
  );
  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 41, charsPerSecond: 0, subagent: true } }));
  const quietSub = await panel.read();
  check(
    'panel names the 3 s window for a quiet subagent too',
    /a subagent is thinking · nothing streamed in the last 3 s/.test(quietSub.text),
    quietSub.text.slice(0, 100),
  );
  await panel.set(state({ status: 'streaming' }));
  const streamingNote = await panel.read();
  check(
    'panel names the live window as the last 3 s',
    /last 3 s · ~313 chars\/s/.test(streamingNote.text),
    streamingNote.text.slice(0, 100),
  );
  // The turn timer rides the status label, against the service's own clock.
  const turnBase = state();
  await panel.set({ ...turnBase, status: 'streaming', turn: { active: true, startedAt: Date.now() - 65_000, tokens: 2000, steps: 2 } });
  const turnRunning = await panel.read();
  check('panel times the turn that is running', /^generating · 1m 0\ds$/.test(turnRunning.statusLabel ?? ''), String(turnRunning.statusLabel));
  await panel.set({ ...state(), turn: { active: false, startedAt: Date.now() - 90_000, tokens: 2000, steps: 2 } });
  const turnIdle = await panel.read();
  check('panel shows no timer when no turn is running', turnIdle.statusLabel === 'idle', String(turnIdle.statusLabel));
  await panel.set(state({ status: 'idle' }));
  const settledIdle = await settle(panel, 'tps', '0');
  check('panel lets a resting rate keep the neutral colour', settledIdle.tpsTier === null, `${settledIdle.tpsTier} ${settledIdle.tpsColor}`);

  // The host sends a second ready when the open session changes; nothing from
  // the old session may survive it.
  const fastSession = state({ status: 'streaming', live: { ...state().live, tps: 209, lastStep: { ...state().live.lastStep, tps: 120 } } });
  await panel.set(fastSession);
  const beforeSwitch = await settle(panel, 'tps', '209');
  check('panel shows a fast live rate before the switch', beforeSwitch.tps === '209' && beforeSwitch.tpsTier === 'ultra', `${beforeSwitch.tps} ${beforeSwitch.tpsTier}`);
  await panel.switchSession(state({ status: 'idle', live: { ...state().live, tps: 0, lastStep: null } }), 'ses_switched');
  const switched = await panel.read();
  check(
    'panel starts a switched session from zero, with no stale tier or last step',
    switched.tps === '0' &&
      switched.tpsTier === null &&
      switched.lastRateTier === null &&
      switched.lastRateText === '' &&
      switched.liveTopY === 8,
    `${switched.tps} ${switched.tpsTier} ${switched.lastRateTier} ${JSON.stringify(switched.lastRateText)} ${switched.liveTopY}`,
  );

  // A slow service must not leave the old session's numbers under the new
  // session's name, and an answer it sends for the session that just left must
  // not paint it back. The trail records every value the totals cell took.
  const slowOld = state({ status: 'idle', live: { ...state().live, tps: 0 }, totals: { ...state().totals, input: 999_000, consumed: 999_000 } });
  await panel.set(slowOld);
  check('panel draws the session before a slow switch', /999k/.test((await panel.read()).text), '999k');
  await panel.delay(1500);
  await new Promise((resolve) => setTimeout(resolve, 320));
  await panel.watchTotals();
  await panel.switchSession(state({ status: 'idle', live: { ...state().live, tps: 0 }, totals: { ...state().totals, input: 7_000, consumed: 9_000 } }), 'ses_slow');
  const cleanSwitch = await panel.read();
  check('panel clears the totals the moment the session switches', !/999k/.test(cleanSwitch.text), cleanSwitch.text.slice(0, 60));
  await panel.delay(0);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const trail = (await panel.trail()).slice(1);
  check(
    'panel never paints an answer for the session it left',
    !trail.some((value) => String(value).startsWith('999k')),
    trail.join(' | ').slice(0, 120),
  );
  const finalRead = await panel.read();
  check('panel draws the session it switched to', /7\.0k/.test(finalRead.text), finalRead.text.slice(0, 60));

  // an answer that leaves the step list off must keep the bars already drawn
  const cached = state({ status: 'streaming' });
  delete cached.steps;
  await panel.set(cached);
  const reused = await panel.read();
  check('panel keeps its bars when the list is omitted', reused.bars > 0, `${reused.bars} bars`);

  // --- per-step hover -------------------------------------------------------
  await panel.set(state({ status: 'idle' }));
  const stepBase = await panel.read();
  check('panel draws one bar per rated step', stepBase.bars === 2, `${stepBase.bars} bars`);
  // A poll with the same list must not rebuild the bars: a marked one survives
  // three polls, and with them any hover the pointer had found.
  await panel.markStep();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const stepStill = await panel.read();
  check('panel keeps its bars between polls with an unchanged step list', stepStill.stepMark === true, 'marked rect still drawn');
  await panel.hover('[data-chart="steps"]', 0.75);
  const stepHover = await panel.read();
  check('panel counts both bars while one is hovered', stepHover.bars === 2, `${stepHover.bars} bars`);
  check(
    'panel reads the hovered step under the pointer',
    /^180 t\/s · 900 tok in 5\.0 s · \d\d:\d\d:\d\d · \$0\.0034$/.test(stepHover.stepsHoverText ?? ''),
    String(stepHover.stepsHoverText),
  );
  check(
    'panel hides the two axis times while a step is hovered',
    stepHover.stepsHoverHidden === false && stepHover.stepsStartHidden === true && stepHover.stepsNowHidden === true,
    `${stepHover.stepsHoverHidden}/${stepHover.stepsStartHidden}/${stepHover.stepsNowHidden}`,
  );
  await panel.leave('[data-chart="steps"]');
  const stepLeft = await panel.read();
  check(
    'panel puts the axis back when the pointer leaves',
    stepLeft.stepsHoverHidden === true &&
      stepLeft.stepsStartHidden === false &&
      stepLeft.stepsNowHidden === false &&
      /start \d\d:\d\d:\d\d/.test(stepLeft.stepsAxisText ?? '') &&
      /now \d\d:\d\d:\d\d/.test(stepLeft.stepsAxisText ?? ''),
    `${stepLeft.stepsHoverHidden}/${stepLeft.stepsStartHidden}/${stepLeft.stepsNowHidden} ${stepLeft.stepsAxisText}`,
  );
  await panel.set(state({ steps: [{ tokens: 900, ms: 5000, tps: 180, aborted: false }] }));
  await panel.hover('[data-chart="steps"]', 0.5);
  const oldStore = await panel.read();
  check(
    'panel reads a step from an older service without a time or a cost',
    oldStore.stepsHoverText === '180 t/s · 900 tok in 5.0 s',
    String(oldStore.stepsHoverText),
  );
  await panel.leave('[data-chart="steps"]');

  // --- live hover -----------------------------------------------------------
  const wideSeries = { t0: Date.now() - 59_000, step: 250, v: Array(236).fill(40) };
  await panel.set(state({ series: wideSeries }));
  const wide = await panel.read();
  check('panel draws a whole minute of live samples', wide.peakText === 'live peak 40 t/s', String(wide.peakText));
  await panel.hover('[data-chart="live"]', 0.5);
  const hoveredLive = await panel.read();
  check(
    'panel reads the rate and the age under the live pointer',
    /^40 t\/s · \d+ s ago$/.test(hoveredLive.peakText ?? '') && hoveredLive.liveCross === true,
    `${hoveredLive.peakText} / cross ${hoveredLive.liveCross}`,
  );
  await panel.leave('[data-chart="live"]');
  const leftLive = await panel.read();
  check(
    'panel goes back to the live peak when the pointer leaves',
    leftLive.peakText === 'live peak 40 t/s' && leftLive.liveCross === false,
    `${leftLive.peakText} / cross ${leftLive.liveCross}`,
  );



  await panel.set(state({ status: 'tool' }));
  const tool = await panel.read();
  check('panel says a tool is running', /a tool is running/.test(tool.text), tool.text.slice(0, 60));
  check('panel glows orange for a tool', tool.dotState === 'tool', String(tool.dotState));
  check('panel drops the rate tier when only a tool runs', tool.tpsTier === null, `${tool.tpsTier} ${tool.tpsColor}`);

  // a parent whose subagent is generating: the headline is the tree's
  const subState = (over = {}) => {
    const base = state();
    return {
      ...base,
      status: 'streaming',
      live: { ...base.live, tps: 41, subagent: true, lastStep: { ...base.live.lastStep, sub: true } },
      subagents: {
        count: 2,
        running: 1,
        loading: 0,
        streaming: 1,
        tool: 0,
        active: [{ id: 'ses_page_child', title: 'SA-2 store+route coupon validation', status: 'streaming', tps: 37 }],
      },
      steps: [{ tokens: 500, ms: 2000, tps: 250, aborted: false, sub: true }],
      ...over,
    };
  };
  await panel.set(subState());
  const subagent = await panel.read();
  check('panel names the subagent behind the rate', /a subagent is generating/.test(subagent.text), subagent.text.slice(0, 90));
  check('panel says how many subagents are in the totals', /2 subagents/.test(subagent.text), subagent.text.slice(0, 90));
  check('panel marks the last step as a subagent’s', /last 33 t\/s .*subagent/.test(subagent.text), subagent.text.slice(-90));
  await panel.hover('[data-chart="steps"]', 0.5);
  const subStep = await panel.read();
  check(
    'panel names the subagent in the hovered step',
    subStep.bars === 1 && / · subagent$/.test(subStep.stepsHoverText ?? ''),
    `${subStep.bars} bars · ${subStep.stepsHoverText}`,
  );
  await panel.leave('[data-chart="steps"]');
  check('panel breathes the dot while a subagent generates', subagent.dotState === 'streaming', String(subagent.dotState));
  check('panel lists the running subagent with its own rate', subagent.subsHidden === false && /1 running · 2 total/.test(subagent.text) && /SA-2 store\+route coupon validation/.test(subagent.text) && /37 t\/s/.test(subagent.text), subagent.text.slice(0, 120));
  check('panel labels the bars: session and subagent', subagent.legendHidden === false && subagent.legendText === 'session subagent', String(subagent.legendText));
  await panel.set(subState({ status: 'tool' }));
  const subTool = await panel.read();
  check('panel says the subagent is running a tool', /a subagent is running a tool/.test(subTool.text), subTool.text.slice(0, 90));
  const mismatchState = state();
  mismatchState.cost = { ...mismatchState.cost, rates: { model: 'other-model', input: 1, output: 2, cacheRead: 3 } };
  await panel.set(mismatchState);
  const mismatch = await panel.read();
  check('panel hides rates that belong to another model', /model rates \/ 1M · —/.test(mismatch.text), mismatch.text.slice(-120));

  await panel.set({ ok: false, error: 'OpenCode access is not available.', totals: null });
  const broken = await panel.read();
  check('panel explains a refused answer', /cannot read this session/.test(broken.text), broken.text.slice(0, 70));
  check('panel runs without an exception', (await panel.errors()).length === 0, (await panel.errors()).join(' | '));

  // A count just under a million rounds to 1.0M, never "1000k".
  await panel.set(state({ totals: { ...state().totals, input: 999_700, prompt: 999_700 } }));
  const roundedCount = await panel.read();
  check('panel rounds a count just under a million to 1.0M', /^1\.0M/.test(roundedCount.values[0]), roundedCount.values[0]);

  const noModel = await run('panel-nomodel');
  const nm = await noModel.read();
  check(
    'panel names the model from its rates when the host omits it',
    /deepseek-v4\.1-flash/.test(nm.text) && !/Model\s+—/i.test(nm.text),
    nm.text.slice(0, 100),
  );

  const low = await run('panel-low');
  const lowRate = await low.read();
  check('panel fills the chart for a low rate too', lowRate.liveTopY === 8, `${lowRate.liveTopY} at ${lowRate.tps} t/s`);

  // --- the Work Status section --------------------------------------------
  const status = await run('status');
  const sIdle = await status.read();
  check('status draws all eight cells', sIdle.cells.join(',') === 'In,Out,Think,Total out,Cache,Cache hit,TTFT,Consumed', sIdle.cells.join(','));
  check('status draws the consumed total', sIdle.values.some((v) => v.startsWith('49.2M')), sIdle.values.join(' | '));
  check(
    'status has no cost or footer below the stats',
    !/\$/.test(sIdle.text) && !/first token/.test(sIdle.text),
    sIdle.text.slice(-80),
  );
  check('status shows the last measured step', /last 33 t\/s/.test(sIdle.text), sIdle.text.slice(0, 60));
  check(
    'status colours the last measured step by its tier',
    sIdle.lastRateTier === 'steady' && sIdle.lastRateColor === 'rgb(118, 172, 79)' && sIdle.lastRateShadow === 'none',
    `${sIdle.lastRateTier} ${sIdle.lastRateColor} ${sIdle.lastRateShadow}`,
  );
  const statusHotBase = state();
  await status.set({ ...statusHotBase, live: { ...statusHotBase.live, lastStep: { ...statusHotBase.live.lastStep, tps: 120 } } });
  const sHotLast = await settle(status, 'lastRateColor', 'rgb(212, 175, 55)');
  check(
    'status glows a fast last step golden',
    sHotLast.lastRateTier === 'blazing' &&
      sHotLast.lastRateColor === 'rgb(212, 175, 55)' &&
      /^rgba\(212, 175, 55, 0\.45\) 0px 0px 8px$/.test(String(sHotLast.lastRateShadow)),
    `${sHotLast.lastRateTier} ${sHotLast.lastRateColor} ${sHotLast.lastRateShadow}`,
  );

  const sBoundaryBase = state();
  await status.set({ ...sBoundaryBase, live: { ...sBoundaryBase.live, lastStep: { ...sBoundaryBase.live.lastStep, tps: 150.4 } } });
  const sBoundary = await status.read();
  check(
    'status colours the last step by the digits it prints',
    sBoundary.lastRateTier === 'blazing' && /last 150 t\/s/.test(sBoundary.text),
    `${sBoundary.lastRateTier} ${sBoundary.text.slice(0, 40)}`,
  );
  check('status sets Consumed to the same size as the other stats', sIdle.consumedFont === sIdle.inFont, `${sIdle.consumedFont}/${sIdle.inFont}`);

  await status.set(state({ status: 'streaming' }));
  const sStreaming = await settle(status, 'tps', '36');
  check('status draws the live rate while generating', sStreaming.tps === '36', String(sStreaming.tps));
  check('status breathes the dot while generating', sStreaming.dotState === 'streaming', String(sStreaming.dotState));
  check(
    'status glows the dot with a round halo the frame has room for',
    sStreaming.dotShadow === 'none' &&
      /^radial-gradient/.test(sStreaming.dotHalo ?? '') &&
      Number.parseFloat(sStreaming.miniPad) >= 7,
    `${sStreaming.dotShadow} | ${(sStreaming.dotHalo ?? '').slice(0, 44)} | pad ${sStreaming.miniPad}`,
  );
  check(
    'status colours a 36 t/s rate green and keeps it semibold',
    sStreaming.tpsTier === 'steady' &&
      sStreaming.tpsColor === 'rgb(118, 172, 79)' &&
      sStreaming.tpsWeight === '600' &&
      sStreaming.tpsShadow === 'none',
    `${sStreaming.tpsTier} ${sStreaming.tpsColor} ${sStreaming.tpsWeight} ${sStreaming.tpsShadow}`,
  );

  await status.set(state({ status: 'streaming', live: { ...state().live, tps: 120 } }));
  const sBlazing = await settle(status, 'tps', '120');
  check(
    'status turns the live rate golden from 90 t/s and glows',
    sBlazing.tpsTier === 'blazing' &&
      sBlazing.tpsColor === 'rgb(212, 175, 55)' &&
      /^rgba\(212, 175, 55, 0\.45\) 0px 0px 8px$/.test(String(sBlazing.tpsShadow)),
    `${sBlazing.tpsTier} ${sBlazing.tpsColor} ${sBlazing.tpsShadow}`,
  );

  await status.set(state({ status: 'idle' }));
  const sIdleRate = await settle(status, 'tps', '0');
  check('status lets a resting rate keep the neutral colour', sIdleRate.tpsTier === null, `${sIdleRate.tpsTier} ${sIdleRate.tpsColor}`);

  const statusBase = state();
  await status.set({
    ...statusBase,
    status: 'streaming',
    live: { ...statusBase.live, tps: 41, subagent: true, lastStep: { ...statusBase.live.lastStep, sub: true } },
    subagents: { count: 2, running: 1, streaming: 1, tool: 0 },
  });
  const sSub = await status.read();
  check('status marks a subagent step', /last 33 t\/s · sub/.test(sSub.text), sSub.text.slice(0, 80));

  const fastStatus = state({ status: 'streaming', live: { ...state().live, tps: 209, lastStep: { ...state().live.lastStep, tps: 120 } } });
  await status.set(fastStatus);
  await settle(status, 'tps', '209');
  await status.switchSession(state({ status: 'idle', live: { ...state().live, tps: 0, lastStep: null } }), 'ses_switched');
  const statusSwitched = await status.read();
  check(
    'status starts a switched session from zero, with no stale tier or last step',
    statusSwitched.tps === '0' && statusSwitched.tpsTier === null && statusSwitched.lastRateTier === null && statusSwitched.lastRateText === '',
    `${statusSwitched.tps} ${statusSwitched.tpsTier} ${statusSwitched.lastRateTier}`,
  );

  // Same rule as the panel: no stale totals, and no late answer for the session
  // that left may paint it back.
  const statusSlowOld = state({ status: 'idle', live: { ...state().live, tps: 0 }, totals: { ...state().totals, input: 999_000, consumed: 999_000 } });
  await status.set(statusSlowOld);
  check('status draws the session before a slow switch', /999k/.test((await status.read()).text), '999k');
  await status.delay(2000);
  await new Promise((resolve) => setTimeout(resolve, 620));
  await status.watchTotals();
  await status.switchSession(state({ status: 'idle', live: { ...state().live, tps: 0 }, totals: { ...state().totals, input: 7_000, consumed: 9_000 } }), 'ses_slow');
  const statusClean = await status.read();
  check('status clears the totals the moment the session switches', !/999k/.test(statusClean.text), statusClean.text.slice(0, 60));
  await status.delay(0);
  await new Promise((resolve) => setTimeout(resolve, 2400));
  const statusTrail = (await status.trail()).slice(1);
  check(
    'status never paints an answer for the session it left',
    !statusTrail.some((value) => String(value).startsWith('999k')),
    statusTrail.join(' | ').slice(0, 120),
  );
  const statusFinal = await status.read();
  check('status draws the session it switched to', /7\.0k/.test(statusFinal.text), statusFinal.text.slice(0, 60));

  // A section with no chat open says why it is empty instead of drawing a box.
  await status.switchSession(state(), null);
  const statusEmpty = await status.read();
  check('status says why it is empty with no session', /Open a chat to read its usage/.test(statusEmpty.text), statusEmpty.text.slice(0, 60));
  check('status runs without an exception', (await status.errors()).length === 0, (await status.errors()).join(' | '));
} finally {
  server.close();
  try {
    await browser(['close']);
  } catch {
    /* the browser may already be gone */
  }
}

console.log(failures === 0 ? '\nPAGE TESTS PASSED' : `\n${failures} PAGE TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
