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
import { createCurveMotion, drawDue, nextScale, rateCeiling, rateTicks, seriesPoints, smoothPath, symlogShare } from '../shared/chart.js';
import { duration } from '../shared/summary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The panel's own end-of-graph label, so a saved title can be pinned exactly. */
const dateClockOf = (ms) => {
  const date = new Date(ms);
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
};

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
    series: { t0: Date.now() - 5000, step: 250, d: [0, 250, 500], v: [30, 34, 36] },
    stepsSeq: 3,
    stepsFrom: Date.now() - 120_000,
    stepsKnown: 2,
    steps: [
      { tokens: 1100, ms: 7800, tps: 141, aborted: false, at: Date.now() - 60_000, cost: 0.0012 },
      { tokens: 900, ms: 5000, tps: 180, aborted: false, at: Date.now() - 30_000, cost: 0.0034 },
    ],
    turn: { active: false, consumed: 2_000, startedAt: Date.now() - 90_000, steps: 2, tokens: 2000 },
    rates: { avg: 79, peak: 334, peakAt: Date.now() - 8 * 60_000 },
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
  // Errors thrown inside an iframe do not reach this window's error event.
  const watchFrame = () => {
    try {
      const w = frame.contentWindow;
      if (!w || w.__meterWatched) return false;
      w.__meterWatched = true;
      w.addEventListener('error', (event) => window.__errors.push(String(event.message)));
      w.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
      return true;
    } catch {
      return false;
    }
  };
  const watchTimer = setInterval(() => { if (watchFrame()) clearInterval(watchTimer); }, 20);
  frame.addEventListener('load', watchFrame);
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
    // The SDK posts frame heights as resize; older hosts used set-height.
    if (message.type === 'resize' || message.type === 'set-height') {
      window.__heights.push(message.payload.height);
      if (message.type === 'resize') reply({});
      return;
    }
    // The extension's server storage, kept in this page, and every toast the
    // frame asked for, so a test can count them.
    if (message.type === 'storage') {
      const op = message.payload.op;
      const key = message.payload.key;
      if (op === 'get') reply({ storage: true, op, found: key in window.__storage, value: window.__storage[key] });
      else if (op === 'set') { window.__storage[key] = message.payload.value; reply({ storage: true, op }); }
      else if (op === 'delete') { delete window.__storage[key]; reply({ storage: true, op }); }
      else reply({ storage: true, op: 'keys', keys: Object.keys(window.__storage).sort() });
      return;
    }
    if (message.type === 'toast') {
      window.__toasts.push(message.payload);
      reply({});
      return;
    }
  });
  window.__storage = {};
  window.__toasts = [];
  window.__heights = [];
  // Dot height on each animation frame after an answer, to catch easing that
  // should have been a single remap.
  window.__dotFrames = (next, count) => new Promise((resolve) => {
    const view = frame.contentWindow;
    const doc = frame.contentDocument;
    window.__setState(next);
    const out = [];
    let left = count;
    const step = () => {
      const dot = doc.querySelector('[data-n="dot"]');
      out.push(dot ? Number(Number(dot.getAttribute('cy')).toFixed(2)) : null);
      if (left-- <= 0) resolve(out); else view.requestAnimationFrame(step);
    };
    view.requestAnimationFrame(step);
  });
  // Type into a field the way a reader does: the value, then an input event.
  window.__type = (selector, text) => {
    const frame = document.getElementById('f');
    const node = frame.contentDocument.querySelector(selector);
    if (!node) return false;
    node.value = text;
    node.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
    return true;
  };
  window.__budget = () => {
    const doc = document.getElementById('f').contentDocument;
    const form = doc.querySelector('.budget-form');
    return {
      chip: doc.querySelector('.budget-chip').textContent,
      chipDisabled: doc.querySelector('.budget-chip').disabled,
      chipOver: doc.querySelector('.budget-chip').dataset.over ?? null,
      formShown: Boolean(form) && !form.hidden && getComputedStyle(form).display !== 'none',
      fields: [...doc.querySelectorAll('.budget-form input')].length,
      errors: [...doc.querySelectorAll('.budget-form .oc-sdk-field-note')].filter((n) => !n.hidden).map((n) => n.textContent),
      totalOver: doc.querySelector('.cost-total').dataset.over ?? null,
      turnOver: doc.querySelector('.cost-turn').dataset.over ?? null,
      totalTitle: doc.querySelector('.cost-total').title,
      stored: window.__storage.budget ?? null,
      toasts: window.__toasts.map((t) => t.message),
    };
  };
  window.__delayMs = 0;
  window.__setState = (next) => { window.__state = next; };
  // The reset is a minute in use; the frame reads this at call time.
  window.__fastZoomReset = (ms) => {
    document.getElementById('f').contentWindow.__zoomResetMs = ms;
    return true;
  };
  window.__click = (selector) => {
    const node = document.getElementById('f').contentDocument.querySelector(selector);
    if (!node) return false;
    node.click();
    return true;
  };
  window.__key = (selector, key) => {
    const frame = document.getElementById('f');
    const node = frame.contentDocument.querySelector(selector);
    if (!node) return false;
    node.focus();
    node.dispatchEvent(new frame.contentWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    return frame.contentDocument.activeElement === frame.contentDocument.querySelector(selector);
  };
  // One wheel notch, then the axis label after a fixed number of frames: what a
  // reader sees right after the gesture, eased or not.
  window.__wheelFrames = (selector, deltaY, frames) => new Promise((resolve) => {
    const frame = document.getElementById('f');
    const view = frame.contentWindow;
    const node = frame.contentDocument.querySelector(selector);
    if (!node) { resolve(null); return; }
    node.dispatchEvent(new view.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
    let left = frames;
    const next = () => {
      if (left-- <= 0) { resolve(frame.contentDocument.querySelector('.axis-from').textContent); return; }
      view.requestAnimationFrame(next);
    };
    view.requestAnimationFrame(next);
  });
  window.__wheel = (selector, deltaY) => {
    const frame = document.getElementById('f');
    const node = frame.contentDocument.querySelector(selector);
    if (!node) return false;
    node.dispatchEvent(new frame.contentWindow.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
    return true;
  };
  window.__hoverAt = (selector, x, y) => {
    const frame = document.getElementById('f');
    const node = frame.contentDocument.querySelector(selector);
    if (!node) return false;
    node.dispatchEvent(
      new frame.contentWindow.PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }),
    );
    return true;
  };
  window.__leave = (selector) => {
    const frame = document.getElementById('f');
    const node = frame.contentDocument.querySelector(selector);
    if (!node) return false;
    node.dispatchEvent(new frame.contentWindow.PointerEvent('pointerleave', { bubbles: true }));
    return true;
  };
  // How often a chart path is actually redrawn: count mutations of its own d
  // attribute for a while. A 12.5 fps chart answers about 7 in 600 ms.
  window.__drawRate = (ms, selector = '[data-chart="live"] path[data-role="live-line"]') => new Promise((resolve) => {
    const frame = document.getElementById('f');
    const line = frame.contentDocument.querySelector(selector);
    if (!line) { resolve(-1); return; }
    let count = 0;
    const observer = new MutationObserver(() => { count += 1; });
    observer.observe(line, { attributeFilter: ['d'], attributes: true });
    setTimeout(() => { observer.disconnect(); resolve(count); }, ms);
  });
  // Count actual path changes against the browser's own animation frames,
  // without a pointer event. Poll-only drawing can pass a mutation counter
  // while still visibly stepping, so measure distinct geometry per frame.
  window.__chartCadence = (ms) => new Promise((resolve) => {
    const view = frame.contentWindow;
    const lineNow = () => frame.contentDocument.querySelector('[data-role="live-line"], [data-chart="spark"] path[stroke]');
    let previous = lineNow().getAttribute('d');
    let frames = 0;
    let changed = 0;
    let started = null;
    const sample = (stamp) => {
      if (started === null) started = stamp;
      const next = lineNow().getAttribute('d');
      if (next !== previous) changed += 1;
      previous = next;
      frames += 1;
      if (stamp - started >= ms) resolve({ frames, changed });
      else view.requestAnimationFrame(sample);
    };
    view.requestAnimationFrame(sample);
  });
  // How the idle slide moves the drawn curve: transform changes per animation
  // frame, with no path rebuild.
  window.__slideRate = (ms) => new Promise((resolve) => {
    const view = frame.contentWindow;
    const group = frame.contentDocument.querySelector('[data-chart="live"] [data-n="scroll"]');
    if (!group) { resolve({ frames: 0, moves: 0 }); return; }
    let previous = group.getAttribute('transform');
    let frames = 0;
    let moves = 0;
    let started = null;
    const sample = (stamp) => {
      if (started === null) started = stamp;
      const next = group.getAttribute('transform');
      if (next !== previous) moves += 1;
      previous = next;
      frames += 1;
      if (stamp - started >= ms) resolve({ frames, moves });
      else view.requestAnimationFrame(sample);
    };
    view.requestAnimationFrame(sample);
  });
  // The sliding curve must still cover the right edge at its largest offset.
  // getBBox is local to the path, so subtract the group's translate by hand.
  window.__edgeCover = (ms) => new Promise((resolve) => {
    const view = frame.contentWindow;
    const doc = frame.contentDocument;
    const svg = doc.querySelector('[data-chart="live"]');
    const line = svg && svg.querySelector('path[data-role="live-line"]');
    const group = svg && svg.querySelector('[data-n="scroll"]');
    if (!line || !group) { resolve({ width: 0, min: 0 }); return; }
    const width = svg.clientWidth;
    let worst = Infinity;
    let started = null;
    const sample = (stamp) => {
      if (started === null) started = stamp;
      const match = /translate\\((-?[\\d.]+)/.exec(group.getAttribute('transform') || '');
      const shift = Math.abs(match ? Number(match[1]) : 0);
      const box = line.getBBox();
      worst = Math.min(worst, box.x + box.width - shift);
      if (stamp - started >= ms) resolve({ width, min: Math.round(worst * 100) / 100 });
      else view.requestAnimationFrame(sample);
    };
    view.requestAnimationFrame(sample);
  });
  // Drive the existing frame loop with 120 Hz timestamps to catch a fixed
  // 16 ms gate even on a test machine whose display only runs at 60 Hz.
  window.__fastFrames = async () => {
    const view = frame.contentWindow;
    const original = view.requestAnimationFrame;
    const queue = [];
    view.requestAnimationFrame = (callback) => { queue.push(callback); return queue.length; };
    const svg = frame.contentDocument.querySelector('[data-chart="live"], [data-chart="spark"]');
    const set = svg.setAttribute;
    let draws = 0;
    try {
      // Let the already-booked real frame run and queue the next one here.
      await new Promise((resolve) => original.call(view, resolve));
      svg.setAttribute = function(name, value) {
        if (name === 'viewBox') draws += 1;
        return set.call(this, name, value);
      };
      const start = view.performance.now();
      for (let index = 1; index <= 40; index += 1) {
        for (const callback of queue.splice(0)) callback(start + index * 1000 / 120);
      }
      return draws;
    } finally {
      svg.setAttribute = set;
      view.requestAnimationFrame = original;
      for (const callback of queue) original.call(view, callback);
    }
  };
  window.__hiddenDraws = async (ms) => {
    const doc = frame.contentDocument;
    Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
    try {
      await new Promise((resolve) => frame.contentWindow.requestAnimationFrame(resolve));
      return await window.__drawRate(ms);
    } finally {
      delete doc.hidden;
    }
  };
  // Capture the curve's vertical rise, not just its horizontal scrolling or
  // repeated writes of an unchanged path. Start before the next poll arrives.
  window.__curveRise = (next) => new Promise((resolve) => {
    const view = frame.contentWindow;
    const doc = frame.contentDocument;
    const trace = [];
    let started = null;
    window.__setState(next);
    const sample = (stamp) => {
      if (started === null) started = stamp;
      const dot = doc.querySelector('[data-n="dot"]');
      const line = doc.querySelector('[data-chart="spark"] path[stroke]');
      const numbers = line?.getAttribute('d')?.match(/-?[0-9]+(?:[.][0-9]+)?/g);
      const y = dot ? Number(dot.getAttribute('cy')) : numbers ? Number(numbers.at(-1)) : null;
      const rate = Number((doc.querySelector('.tps-value, .tps') || {}).textContent);
      trace.push({ y, rate });
      if (stamp - started >= 1400) resolve(trace);
      else view.requestAnimationFrame(sample);
    };
    view.requestAnimationFrame(sample);
  });
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
  // A pointer move over the step chart must restyle bars, not rebuild them.
  window.__hoverChurn = (moves) => {
    const svg = frame.contentDocument.querySelector('[data-chart="steps"]');
    if (!svg) return JSON.stringify({ added: -1, bars: 0, moves });
    const rect = svg.getBoundingClientRect();
    const View = frame.contentWindow;
    const watch = new MutationObserver(() => {});
    watch.observe(svg, { childList: true, subtree: true });
    for (let index = 0; index < moves; index += 1) {
      svg.dispatchEvent(
        new View.PointerEvent('pointermove', {
          bubbles: true,
          clientX: rect.left + rect.width * (0.15 + (0.7 * index) / moves),
          clientY: rect.top + rect.height * 0.5,
        }),
      );
    }
    const added = watch.takeRecords().reduce((sum, record) => sum + record.addedNodes.length, 0);
    watch.disconnect();
    const lit = svg.querySelector('rect[data-role="step-hover"]');
    const column = svg.querySelector('rect[data-role="step-hover-col"]');
    return JSON.stringify({
      added,
      bars: svg.querySelectorAll('rect[data-bar="step"]').length,
      litOpacity: lit ? lit.getAttribute('opacity') : null,
      litCount: svg.querySelectorAll('rect[data-role="step-hover"]').length,
      columnWidth: column ? Number(column.getAttribute('width')) : null,
      moves,
    });
  };
  // How many times the live curve's path data is rewritten over a window of time.
  window.__liveWrites = (ms) =>
    new Promise((resolve) => {
      const line = frame.contentDocument.querySelector('[data-role="live-line"]');
      if (!line) {
        resolve(JSON.stringify({ writes: -1 }));
        return;
      }
      let writes = 0;
      const watch = new MutationObserver((records) => {
        writes += records.filter((record) => record.attributeName === 'd').length;
      });
      watch.observe(line, { attributes: true, attributeFilter: ['d'] });
      window.setTimeout(() => {
        watch.takeRecords();
        watch.disconnect();
        resolve(JSON.stringify({ writes }));
      }, ms);
    });
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
      liveCaption: (doc.querySelector('.stat-label') || {}).textContent ?? null,
      bars: doc.querySelectorAll('[data-chart="steps"] rect:not([data-role="step-hover-col"])').length,
      stepSvg: (doc.querySelector('[data-chart="steps"]') || {}).innerHTML ?? '',
      chartGeometry: ['live', 'steps'].map((name) => {
        const svg = doc.querySelector('[data-chart="' + name + '"]');
        if (!svg) return null;
        return {
          height: svg.clientHeight,
          ticks: [...svg.querySelectorAll('[data-role="grid-label"]')].map((n) => ({ label: n.textContent, y: Number(n.getAttribute('y')) })),
          bars: [...svg.querySelectorAll('rect:not([data-role])')].map((n) => ({ y: Number(n.getAttribute('y')), h: Number(n.getAttribute('height')) })),
          dotY: Number(svg.querySelector('[data-n="dot"]')?.getAttribute('cy')),
          dotX: Number(svg.querySelector('[data-n="dot"]')?.getAttribute('cx')),
          avgY: Number(svg.querySelector('[data-role="live-avg"], [data-role="step-avg"]')?.getAttribute('y1')),
          peakY: Number(svg.querySelector('[data-role="live-peak"], [data-role="step-peak"]')?.getAttribute('y1')),
        };
      }),
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
      costRows: [...doc.querySelectorAll('.cost-rates .rate-row:not(.rate-head)')].map((node) => ({
        label: (node.querySelector('.rate-name') || {}).textContent ?? '',
        cells: [...node.querySelectorAll('.rate-num')].map((cell) => cell.textContent),
        active: node.getAttribute('data-active'),
        tier: node.getAttribute('data-tier'),
        color: getComputedStyle(node).color,
      })),
      costTotal: (doc.querySelector('.cost-total') || {}).textContent,
      costTotalTitle: (doc.querySelector('.cost-total') || {}).title ?? null,
      costTurn: (doc.querySelector('.cost-turn') || {}).textContent,
      costModel: (doc.querySelector('.cost-model') || {}).textContent,
      costRate: (doc.querySelector('.cost-rate') || {}).textContent,
      costRateTitle: (doc.querySelector('.cost-rate') || {}).title ?? null,
      apiBadge: doc.querySelector('.api-badge') ? !doc.querySelector('.api-badge').hidden : null,
      costSource: (doc.querySelector('.cost-rates .rate-source') || {}).textContent ?? null,
      costFlag: (doc.querySelector('.cost-rates .rate-flag') || {}).textContent ?? null,
      costOverflow: (() => {
        const node = doc.querySelector('.cost-rates');
        return node ? node.scrollWidth - node.clientWidth : null;
      })(),
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
      lastRestText: (doc.querySelector('.last-rest') || {}).textContent ?? null,
      stepsAvgSep: doc.querySelector('.steps-avg') ? getComputedStyle(doc.querySelector('.steps-avg'), '::before').content : null,
      stepsPeakSep: doc.querySelector('.steps-peak') ? getComputedStyle(doc.querySelector('.steps-peak'), '::before').content : null,
      stepsAxisText: doc.querySelector('.steps-axis') ? doc.querySelector('.steps-axis').innerText.replace(/\\s+/g, ' ').trim() : null,
      liveTopY: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        if (!line) return null;
        return Math.round(line.getBBox().y * 10) / 10;
      })(),
      livePolyline: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        return Boolean(line && line.getAttribute('d'));
      })(),
      liveCurve: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        return line ? String(line.getAttribute('d')).includes('C') : false;
      })(),
      liveDots: [...doc.querySelectorAll('[data-chart="live"] circle:not([data-role])')].filter(
        (node) => node.getAttribute('visibility') !== 'hidden',
      ).length,
      liveCross: (() => {
        const node = doc.querySelector('[data-chart="live"] [data-role="live-cross"]');
        return Boolean(node && node.getAttribute('visibility') !== 'hidden');
      })(),
      liveRight: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        if (!line) return null;
        const box = line.getBBox();
        return Math.round((box.x + box.width) * 10) / 10;
      })(),
      liveWidth: (() => {
        const svg = doc.querySelector('[data-chart="live"]');
        return svg ? svg.clientWidth : null;
      })(),
      gridLabels: [...doc.querySelectorAll('[data-chart="live"] [data-role="grid-label"]')]
        .filter((node) => node.getAttribute('visibility') !== 'hidden')
        .map((node) => node.textContent),
      peakLineY: (() => {
        const line = doc.querySelector('[data-chart="live"] line[data-role="live-peak"]');
        return line ? Number(line.getAttribute('y1')) : null;
      })(),
      peakDash: (() => {
        const line = doc.querySelector('[data-chart="live"] line[data-role="live-peak"]');
        return line ? line.getAttribute('stroke-dasharray') : null;
      })(),
      totalsSource: (doc.querySelector('.totals-source') || {}).textContent ?? null,
      sectionHead: [...doc.querySelectorAll('.block-head span')].map((n) => n.textContent),
      footClock: (doc.querySelector('.foot-clock') || {}).textContent ?? null,
      footText: (doc.querySelector('.foot-text') || {}).textContent ?? null,
      subsToggle: (doc.querySelector('.subs-toggle') || {}).textContent ?? null,
      subsDetailShown: doc.querySelector('.subs-detail') ? !doc.querySelector('.subs-detail').hidden : null,
      subsDetailDisplay: doc.querySelector('.subs-detail') ? getComputedStyle(doc.querySelector('.subs-detail')).display : null,
      modelsDisplay: doc.querySelector('.models') ? getComputedStyle(doc.querySelector('.models')).display : null,
      modelsText: doc.querySelector('.models') ? doc.querySelector('.models').innerText.replace(/\\s+/g, ' ').trim() : null,
      dotStateNow: (doc.querySelector('.dot') || { dataset: {} }).dataset.state ?? null,
      subRows: [...doc.querySelectorAll('.sub-detail')].map((node) => ({
        member: node.dataset.member,
        role: node.getAttribute('role'),
        tabIndex: node.tabIndex,
        pressed: node.getAttribute('aria-pressed'),
      })),
      stepFills: [...doc.querySelectorAll('[data-chart="steps"] rect:not([data-role])')].map((node) => node.getAttribute('fill')),
      stepsCountTitle: (doc.querySelector('.steps-count') || {}).title ?? null,
      stepsNowText: (doc.querySelector('.steps-now') || {}).textContent ?? null,
      gridFont: (() => {
        const node = doc.querySelector('[data-chart="live"] [data-role="grid-label"]');
        return node ? getComputedStyle(node).fontSize : null;
      })(),
      legendBottom: doc.querySelector('.legend') ? doc.querySelector('.legend').getBoundingClientRect().bottom : null,
      footTop: doc.querySelector('.foot') ? doc.querySelector('.foot').getBoundingClientRect().top : null,
      neededHeight: Math.ceil((doc.querySelector('.mini')?.scrollHeight ?? 0) + (doc.querySelector('.notice')?.scrollHeight ?? 0)) + 6,
      subsDetailText: (() => {
        const section = doc.querySelector('.subs-detail');
        if (!section) return null;
        const list = section.querySelector('.subs-detail-list');
        const rows = list ? list.children.length : 'nolist';
        const text = section.textContent.replace(/\\s+/g, ' ').trim().slice(0, 140);
        return (section.hidden ? 'hidden' : 'shown') + ' rows=' + rows + ' text=' + text;
      })(),
      axisFrom: (doc.querySelector('.axis-from') || {}).textContent ?? null,
      axisTo: (doc.querySelector('.axis-to') || {}).textContent ?? null,
      axisToTitle: (doc.querySelector('.axis-to') || {}).title ?? null,
      peakLabelText: (doc.querySelector('.axis-peak') || {}).textContent ?? null,
      ceilingChip: (doc.querySelector('.foot-ceiling') || {}).textContent ?? null,
      livePathD: (() => {
        const line = doc.querySelector('[data-chart="live"] path[data-role="live-line"]');
        return line ? line.getAttribute('d') : null;
      })(),
      liveClip: (() => {
        const group = doc.querySelector('[data-chart="live"] [data-n="scroll"]');
        const rect = doc.querySelector('#tm-live-clip rect');
        if (!group || !rect) return null;
        return { attr: group.getAttribute('clip-path'), width: Number(rect.getAttribute('width')) };
      })(),
      sparkD: (() => {
        const line = doc.querySelector('[data-chart="spark"] path[data-role="spark-line"]');
        return line ? line.getAttribute('d') : null;
      })(),
      subIds: [...doc.querySelectorAll('.sub-row[data-sub]')].map((node) => node.dataset.sub),
      subOut: doc.querySelectorAll('.sub-row.sub-out').length,
      avgLineY: (() => {
        const line = doc.querySelector('[data-chart="live"] line[data-role="live-avg"]');
        return line ? Number(line.getAttribute('y1')) : null;
      })(),
      mainAvgY: (() => {
        const line = doc.querySelector('[data-chart="live"] line[data-role="live-main-avg"]');
        return line && line.getAttribute('visibility') !== 'hidden' ? Number(line.getAttribute('y1')) : null;
      })(),
      mainPeakY: (() => {
        const line = doc.querySelector('[data-chart="live"] line[data-role="live-main-peak"]');
        return line && line.getAttribute('visibility') !== 'hidden' ? Number(line.getAttribute('y1')) : null;
      })(),
      refLabelYs: (() => {
        const nodes = doc.querySelectorAll('[data-chart="live"] text[data-n$="-label"]');
        return [...nodes]
          .filter((node) => node.getAttribute('visibility') !== 'hidden')
          .map((node) => Number(node.getAttribute('y')))
          .sort((a, b) => a - b);
      })(),
      refLabelFonts: (() => {
        const nodes = doc.querySelectorAll('[data-chart="live"] text[data-n$="-label"]');
        return [...nodes]
          .filter((node) => node.getAttribute('visibility') !== 'hidden')
          .map((node) => getComputedStyle(node).fontSize);
      })(),
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

// A second suite (or a parallel verify) must not fight for the same port.
const port = Number(process.env.PAGE_TEST_PORT ?? 41_873);
// Nor for the shared default agent-browser session: another agent's `open`
// would navigate this suite's tab, and this suite's `close` would shut theirs.
process.env.AGENT_BROWSER_SESSION ||= `token-meter-page-${process.pid}`;
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

if (spawnSync('agent-browser', ['--version'], { stdio: 'ignore' }).status !== 0) {
  // A gate that reports a green without running is the one thing the rules
  // forbid: say it could not run, and fail.
  console.error('PAGE TESTS DID NOT RUN — agent-browser is not installed here');
  process.exit(1);
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
  // The harness defines __read after the host handshake. A fixed wait failed
  // when another suite shared the machine; wait for the function instead.
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      ready = (await browser(['eval', 'typeof window.__read === "function"'])).trim() === 'true';
    } catch {
      ready = false;
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`page harness did not become ready: ${page}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
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
    drawRate: async (ms = 600, selector) =>
      Number(JSON.parse(await browser(['eval', `window.__drawRate(${ms}${selector ? `, ${JSON.stringify(selector)}` : ''})`]))),
    screenshot: async (file) => browser(['screenshot', file]),
    chartCadence: async (ms = 600) => JSON.parse(JSON.parse(await browser(['eval', `(async () => JSON.stringify(await window.__chartCadence(${ms})))()`]))),
    fastFrames: async () => Number(JSON.parse(await browser(['eval', 'window.__fastFrames()']))),
    slideRate: async (ms = 500) => JSON.parse(JSON.parse(await browser(['eval', `(async () => JSON.stringify(await window.__slideRate(${ms})))()`]))),
    edgeCover: async (ms = 400) => JSON.parse(JSON.parse(await browser(['eval', `(async () => JSON.stringify(await window.__edgeCover(${ms})))()`]))),
    hiddenDraws: async (ms = 600) => Number(JSON.parse(await browser(['eval', `window.__hiddenDraws(${ms})`]))),
    curveRise: async (next) => JSON.parse(JSON.parse(await browser(['eval', `(async () => JSON.stringify(await window.__curveRise(${JSON.stringify(next)})))()`]))),
    fastZoomReset: async (ms) => {
      const done = Boolean(JSON.parse(await browser(['eval', `window.__fastZoomReset(${ms})`])));
      return done;
    },
    click: async (selector) => Boolean(JSON.parse(await browser(['eval', `window.__click(${JSON.stringify(selector)})`]))),
    type: async (selector, text) => Boolean(JSON.parse(await browser(['eval', `window.__type(${JSON.stringify(selector)}, ${JSON.stringify(text)})`]))),
    budget: async () => JSON.parse(JSON.parse(await browser(['eval', 'JSON.stringify(window.__budget())']))),
    heights: async () => JSON.parse(JSON.parse(await browser(['eval', 'JSON.stringify(window.__heights)']))),
    dotFrames: async (next, count) => JSON.parse(JSON.parse(await browser(['eval', `(async () => JSON.stringify(await window.__dotFrames(${JSON.stringify(next)}, ${count})))()`]))),
    wheelFrames: async (selector, deltaY, frames) =>
      JSON.parse(await browser(['eval', `window.__wheelFrames(${JSON.stringify(selector)}, ${deltaY}, ${frames})`])),
    key: async (selector, key) => Boolean(JSON.parse(await browser(['eval', `window.__key(${JSON.stringify(selector)}, ${JSON.stringify(key)})`]))),
    wheel: async (selector, deltaY) => {
      const done = Boolean(JSON.parse(await browser(['eval', `window.__wheel(${JSON.stringify(selector)}, ${deltaY})`])));
      await new Promise((resolve) => setTimeout(resolve, 120));
      return done;
    },
    hoverPeak: async () => {
      const done = Boolean(JSON.parse(await browser(['eval', 'window.__hoverPeak()'])));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return done;
    },
    hoverAt: async (selector, x, y) => {
      const done = Boolean(JSON.parse(await browser(['eval', `window.__hoverAt(${JSON.stringify(selector)}, ${x}, ${y})`])));
      await new Promise((resolve) => setTimeout(resolve, 120));
      return done;
    },
    leave: async (selector) => Boolean(JSON.parse(await browser(['eval', `window.__leave(${JSON.stringify(selector)})`]))),
    wait: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    hoverChurn: async (moves) => JSON.parse(JSON.parse(await browser(['eval', `window.__hoverChurn(${moves})`]))),
    liveWrites: async (ms) => JSON.parse(JSON.parse(await browser(['eval', `(async () => await window.__liveWrites(${ms}))()`]))),
    trail: async () => JSON.parse(JSON.parse(await browser(['eval', 'JSON.stringify(window.__trail)']))),
  };
};

/** The headline is eased; a busy browser can paint fewer frames than 1.6 s allows. */
const settle = async (handle, field, want) => {
  let value = await handle.read();
  const reached = (data) => typeof field === 'function' ? field(data) : data[field] === want;
  for (let i = 0; i < 25 && !reached(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await handle.read();
  }
  return value;
};

const measureCurveRise = async (surface) => {
  // Keep the scale stable with a high-rate history, then change the newest
  // sample only: a poll-step jump cannot hide behind a scrolling X coordinate.
  const values = Array.from({ length: 240 }, (_, i) => i < 230 ? 400 : 20);
  const before = state({
    status: 'streaming',
    live: { ...state().live, tps: 20 },
    rates: { avg: 150, peak: 3000 },
    series: { t0: Date.now() - 59_750, step: 250, v: values },
  });
  await surface.set(before);
  const after = { ...before, generatedAt: Date.now(), live: { ...before.live, tps: 200 }, series: { ...before.series, v: [...values.slice(0, -1), 200] } };
  const trace = await surface.curveRise(after);
  const intermediate = trace.filter((sample) => sample.rate > 20 && sample.rate < 200 && sample.y !== null);
  return { frames: intermediate.length, heights: new Set(intermediate.map((sample) => sample.y)).size };
};

try {
  const curveMotion = createCurveMotion();
  curveMotion([{ t: 1, v: 0 }], 0);
  const halfway = curveMotion([{ t: 1, v: 1 }], 160)[0].v;
  check('curve motion uses the headline time constant without overshoot', Math.abs(halfway - (1 - Math.exp(-1))) < 1e-12);
  const addedMotion = createCurveMotion();
  addedMotion([{ t: 1, v: 0.2 }], 0);
  const added = addedMotion([{ t: 1, v: 0.2 }, { t: 2, v: 0.9 }], 0);
  check('a newly arriving sample begins at the preceding displayed height', added[1].v === 0.2);
  const atRate = (hz) => {
    const motion = createCurveMotion();
    motion([{ t: 1, v: 0 }], 0);
    let result;
    for (let i = 1; i <= hz / 2; i += 1) result = motion([{ t: 1, v: 1 }], i * 1000 / hz)[0].v;
    return result;
  };
  check('curve easing takes the same time at 60 and 120 Hz', Math.abs(atRate(60) - atRate(120)) < 1e-12);
  curveMotion([], 200);
  check('an empty curve resets motion so the next session inherits no heights', curveMotion([{ t: 1, v: 0.1 }], 201)[0].v === 0.1);
  check('reduced motion reads the target height immediately', curveMotion([{ t: 1, v: 0.8 }], 202, true)[0].v === 0.8);
  // The idle paint clock both surfaces share: five draws a second at rest,
  // every callback while something animates.
  check('the paint clock lets the first idle frame through', drawDue(false, -Infinity, 5_000, 200));
  check('the paint clock holds an idle frame inside 200 ms', !drawDue(false, 5_000, 5_199, 200));
  check('the paint clock releases the idle frame at 200 ms', drawDue(false, 5_000, 5_200, 200));
  check('the paint clock draws every callback while something animates', drawDue(true, 5_000, 5_001, 200));
  let idleClock = -Infinity;
  let idleDrawsInSecond = 0;
  for (let at = 0; at < 1_000; at += 1_000 / 60) {
    if (drawDue(false, idleClock, at, 200)) {
      idleClock = at;
      idleDrawsInSecond += 1;
    }
  }
  check('a second of idle callbacks is five draws, not sixty', idleDrawsInSecond === 5, `${idleDrawsInSecond} draws`);
  const scaleAfter = (hz) => {
    let scale = 1000;
    for (let i = 0; i < hz; i += 1) scale = nextScale(scale, [100], 1000 / hz);
    return scale;
  };
  check('spark scale decay is time-based rather than faster at high refresh', Math.abs(scaleAfter(60) - scaleAfter(120)) < 1e-9 && Math.abs(scaleAfter(60) - (100 + 900 * 0.94 ** 10)) < 1e-9);

  // Graph change: independent expected positions, including boundary, floor,
  // non-finite inputs and tick spacing at short/tall chart sizes.
  check('scale: zero and the linear threshold are exact', symlogShare(0, 3000) === 0 && symlogShare(50, 3000) === 0.175 && symlogShare(100, 3000) === 0.35);
  check('scale: 250 stays legible beneath a 3k spike', Math.abs(symlogShare(250, 3000) - (0.35 + 0.65 * Math.log10(2.5) / Math.log10(30))) < 1e-12 && symlogShare(250, 3000) > 0.5);
  check(
    'scale: the ceiling is the peak, and invalid input is safe',
    rateCeiling(0) === 1 && rateCeiling(NaN) === 1 && rateCeiling(Infinity) === 1 &&
      symlogShare(-1, 300) === 0 && symlogShare(Infinity, 300) === 0 && symlogShare(1000, 0) === 1,
  );
  const scaleValues = [0, 1, 50, 99.99999, 100, 100.00001, 250, 1000, 3000];
  check('scale: continuous and strictly increasing through 100', scaleValues.every((v, i) => i === 0 || symlogShare(v, 3000) > symlogShare(scaleValues[i - 1], 3000)) && Math.abs(symlogShare(100.00001, 3000) - symlogShare(99.99999, 3000)) < 1e-6);
  const tickCases = [74, 98, 184, 800].flatMap((height) => [300, 3000, 30000, 1e6].map((max) => ({ height, max, ticks: rateTicks(max, height) })));
  check('scale: ticks never overlap, even above 3k or in a short chart', tickCases.every(({ height, max, ticks }) => ticks.every((tick, i) => {
    const labelY = (t) => { const y = height * (1 - t.share); return y < 10 ? y + 10 : y - 3; };
    return tick.value <= max && (i === 0 || labelY(ticks[i - 1]) - labelY(tick) >= 22 - 1e-9);
  })));
  check('scale: ticks extend dynamically beyond 3k with k labels', rateTicks(30000, 800).some((t) => t.value >= 10000 && t.label.endsWith('k')));
  const peakTicks = rateTicks(142, 200);
  check('scale: the last tick labels the ceiling, not a lower round number', peakTicks.at(-1).share === 1 && peakTicks.at(-1).label === '142', JSON.stringify(peakTicks.map((t) => t.label)));
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
    'an older series keeps the nominal cadence',
    seriesPoints({ series: { t0: 1000, step: 250, v: [1, 2, 3] } })
      .map((point) => point.t)
      .join(',') === '1000,1250,1500',
    seriesPoints({ series: { t0: 1000, step: 250, v: [1, 2, 3] } })
      .map((point) => point.t)
      .join(','),
  );
  check(
    'a current series keeps each sample’s own time',
    seriesPoints({ series: { t0: 1000, step: 250, d: [0, 250, 1500], v: [1, 2, 3] } })
      .map((point) => point.t)
      .join(',') === '1000,1250,2500',
    seriesPoints({ series: { t0: 1000, step: 250, d: [0, 250, 1500], v: [1, 2, 3] } })
      .map((point) => point.t)
      .join(','),
  );
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
  check('panel keeps the live caption uncluttered', idle.liveCaption === 'live', JSON.stringify(idle.liveCaption));
  check('panel removes the first-token sentence but retains TTFT in the grid', !/first token took/.test(idle.text) && idle.values.includes('6.5 s'), idle.text.slice(0, 130));
  await panel.set(
    state({ status: 'streaming', generatedAt: Date.now(), series: { t0: Date.now() - 2000, step: 250, v: [40, 60] } }),
  );
  const anchored = await panel.read();
  check(
    'a current live sample keeps the dot on the now edge',
    anchored.chartGeometry[0].dotX === anchored.liveWidth && anchored.liveRight >= anchored.liveWidth,
    `${anchored.chartGeometry[0].dotX}/${anchored.liveRight} of ${anchored.liveWidth}`,
  );
  await panel.set(state());
  check('panel draws all eight cells', idle.cells.join(',') === 'In,Out,Think,Total out,Cache,Cache hit,TTFT,Consumed', idle.cells.join(','));
  check(
    'the sliding curve is clipped to the plot, not the panel padding',
    idle.liveClip?.attr === 'url(#tm-live-clip)' && idle.liveClip.width === idle.liveWidth,
    JSON.stringify(idle.liveClip),
  );
  // `.block` sets display: flex, which outranks the browser's own [hidden]
  // rule: a single-model session drew an empty "Models" heading.
  check('panel draws no Models block for one model', idle.modelsDisplay === 'none', `${idle.modelsDisplay} "${idle.modelsText}"`);
  check('panel draws the consumed total', idle.values.some((v) => v.startsWith('49.2M')), idle.values.join(' | '));
  check('panel draws the measured ttft', idle.values.some((v) => v.includes('6.5 s')), idle.values.join(' | '));
  check('panel labels the average and the peak', idle.labels.some((l) => l.startsWith('avg 79')) && idle.labels.some((l) => l.startsWith('peak 334')), idle.labels.join(' | '));
  // A subagent's steps can move the tree's average and peak. The main pair is
  // the session's own; it is drawn only when the service says the two differ.
  check(
    'panel hides the main-session references when there are no subagent steps',
    idle.mainAvgY === null && idle.mainPeakY === null && !idle.labels.some((label) => label.startsWith('main ')),
    `${idle.mainAvgY}, ${idle.mainPeakY} · ${idle.labels.join(' | ')}`,
  );
  const pairAt = Date.now();
  const mainRatesState = state({
    subagents: { count: 1, running: 0, loading: 0, partial: 0, streaming: 0, tool: 0, active: [] },
    rates: { avg: 79, peak: 334, peakAt: pairAt - 480_000, main: { avg: 62, peak: 120, peakAt: pairAt - 300_000 } },
    generatedAt: pairAt,
  });
  await panel.set(mainRatesState);
  const bothPairs = await panel.read();
  check(
    'panel draws the main-session average and peak beside the tree’s',
    bothPairs.mainAvgY !== null &&
      bothPairs.mainPeakY !== null &&
      bothPairs.mainAvgY > bothPairs.mainPeakY &&
      bothPairs.mainAvgY > 8 &&
      bothPairs.mainAvgY < bothPairs.chartGeometry[0].height - 8,
    `main avg y ${bothPairs.mainAvgY}, main peak y ${bothPairs.mainPeakY}, tree ${bothPairs.chartGeometry[0].avgY}/${bothPairs.chartGeometry[0].peakY}`,
  );
  check(
    'panel labels the main pair as the main session’s',
    bothPairs.labels.some((label) => /^main avg 62 t\/s$/.test(label)) &&
      bothPairs.labels.some((label) => /^main peak 120 t\/s( · \d+m \d+s ago)?$/.test(label)),
    bothPairs.labels.join(' | '),
  );
  check(
    'the four reference labels share one font size',
    bothPairs.refLabelFonts.length === 4 && new Set(bothPairs.refLabelFonts).size === 1,
    bothPairs.refLabelFonts.join(', '),
  );
  await panel.screenshot(path.join(process.env.TMPDIR ?? '/tmp', 'token-meter-panel-main-pair.png'));
  // Four labels on a 200px plot: two near the top edge can collide, and the
  // frame has to move one down rather than print them on top of each other.
  await panel.set({
    ...mainRatesState,
    generatedAt: Date.now(),
    rates: { avg: 79, peak: 334, main: { avg: 330, peak: 334 } },
  });
  const crowdedPairs = await panel.read();
  check(
    'four reference labels stay apart when their lines are close',
    crowdedPairs.refLabelYs.length === 4 &&
      crowdedPairs.refLabelYs.every((y, index, all) => index === 0 || y - all[index - 1] >= 11) &&
      crowdedPairs.refLabelYs.at(-1) <= crowdedPairs.chartGeometry[0].height - 2,
    crowdedPairs.refLabelYs.join(', '),
  );
  await panel.set(state());
  const noMainPair = await panel.read();
  check(
    'panel hides the main pair again when the service sends none',
    noMainPair.mainAvgY === null && noMainPair.mainPeakY === null,
    `${noMainPair.mainAvgY}, ${noMainPair.mainPeakY}`,
  );
  check(
    'panel draws the curve under the peak line, not over it',
    idle.livePolyline && idle.liveTopY > idle.peakLineY && idle.liveTopY > 8,
    `curve ${idle.liveTopY}, peak line ${idle.peakLineY}`,
  );
  check(
    'panel labels clean linear/log ticks with small side numbers',
    idle.gridLabels.includes('0') && idle.gridLabels.includes('100') && idle.gridLabels.includes('334') && idle.gridFont === '8.5px',
    idle.gridLabels.join(' | '),
  );
  check('panel marks where 15, 30 and 45 seconds ago sit', idle.timeGrid === 3, String(idle.timeGrid));
  check('panel draws the live curve as a smooth path', idle.liveCurve === true, String(idle.liveCurve));
  check(
    'panel says what the last turn was made of',
    idle.costTurnTitle === '2 steps · 2.0k generated tokens',
    String(idle.costTurnTitle),
  );
  const idleStepPlot = idle.chartGeometry[1].height - 12;
  check('panel puts a low peak on the top edge instead of a fixed ceiling', Math.abs(idle.stepsPeakTop - 6) < 0.11, String(idle.stepsPeakTop));
  check('panel shows the last measured step', /last 33 t\/s/.test(idle.text), idle.text.slice(0, 60));
  check(
    'panel puts the last turn cost after the last measured step',
    /last 33 t\/s · 7\.8 s · 2\.0k tok · \$0\.0800/.test(idle.text),
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
  check('a single live sample is held at the now edge', onePoint.chartGeometry[0].dotX === onePoint.liveWidth, `${onePoint.chartGeometry[0].dotX} of ${onePoint.liveWidth}`);
  // A held tail is not a rescaled timeline: older samples keep their real X
  // positions, and only a horizontal extension reaches the current edge.
  const heldNow = Date.now();
  await panel.set(state({ generatedAt: heldNow, series: { t0: heldNow - 15_000, step: 1000, v: [60, 120, 180] } }));
  const held = await panel.read();
  const historyPart = held.livePathD.split(' L ')[0];
  const coordinates = historyPart.match(/-?[\d]+(?:\.[\d]+)?/g).map(Number);
  const oldEndX = coordinates.at(-2);
  check(
    'the curve always reaches the now edge',
    // The held tail runs past the edge by the maximum slide, so the idle
    // transform still covers it; the group's clip path trims the extra pixels.
    held.liveRight >= held.liveWidth,
    `${oldEndX} last sample, ${held.liveRight} curve end of ${held.liveWidth}`,
  );

  // A finished step can raise the session peak and so the ceiling. The remap
  // must be one frame, not a visible slide of the whole curve.
  const jumpNow = Date.now();
  const preJump = state({ status: 'streaming', generatedAt: jumpNow, rates: { avg: 80, peak: 150, peakAt: jumpNow - 5000 }, series: { t0: jumpNow - 4000, step: 250, v: [60, 90, 120, 140] } });
  await panel.set(preJump);
  const jumpState = { ...preJump, status: 'idle', generatedAt: Date.now(), rates: { avg: 80, peak: 900, peakAt: Date.now() }, series: { t0: jumpNow - 4000, step: 250, v: [60, 90, 120, 140, 0] } };
  const jumpFrames = await panel.dotFrames(jumpState, 30);
  check(
    'a changed ceiling remaps the curve in one frame, not a slide',
    new Set(jumpFrames.filter((y) => y !== null)).size <= 2,
    jumpFrames.join(','),
  );
  await panel.set(state());

  // A finished graph holds its zero to the edge: a flat line at `now`, never a
  // gap before it.
  const idleAt = Date.now() - 10_000;
  await panel.set(state({ generatedAt: Date.now(), series: { t0: idleAt, step: 1000, v: [40, 0] } }));
  const idleCurve = await panel.read();
  const idleBox = idleCurve.chartGeometry[0];
  check(
    'a finished graph holds its flat zero to the now edge',
    idleBox.dotX === idleCurve.liveWidth && idleCurve.liveRight >= idleCurve.liveWidth && idleBox.dotY >= idleBox.height - 9,
    `dot ${idleBox.dotX} of ${idleCurve.liveWidth}, y ${idleBox.dotY} of ${idleBox.height}`,
  );
  // A flat zero line cannot change between seconds, so the live loop must not
  // rewrite its path on every animation frame (61 writes/s before).
  await panel.set(state({ generatedAt: Date.now(), series: { t0: Date.now() - 4_000, step: 250, v: [0, 0, 0, 0, 0, 0] } }));
  await panel.wait(300);
  const idleWrites = await panel.liveWrites(1_000);
  check(
    'an idle flat graph is drawn once a second, not once a frame',
    idleWrites.writes >= 0 && idleWrites.writes <= 2,
    `${idleWrites.writes} path writes in 1 s`,
  );
  // The skip is for a picture that cannot change. A new peak changes the label
  // and the ceiling, so it must draw at once even over a flat window.
  const flatPeak = state({
    generatedAt: Date.now(),
    rates: { avg: 0, peak: 900, peakAt: Date.now() - 300_000 },
    series: { t0: Date.now() - 4_000, step: 250, v: [0, 0, 0, 0] },
  });
  await panel.set(flatPeak);
  await panel.wait(300);
  await panel.set({ ...flatPeak, generatedAt: Date.now(), rates: { avg: 0, peak: 150, peakAt: Date.now() - 1_000 } });
  const relabeled = await panel.read();
  const peakLabels = relabeled.labels.filter((text) => /^peak \d/.test(text));
  check(
    'a flat graph still redraws when its peak label changes',
    peakLabels.some((text) => /^peak 150 t\/s/.test(text)) && !peakLabels.some((text) => /^peak 900 t\/s/.test(text)),
    peakLabels.join(' · ') || 'no peak label',
  );
  await panel.set(state());

  // A resting session samples zeros; the axis floor is not a measured scale.
  await panel.set({ ...oneBase, series: { t0: Date.now() - 2000, step: 250, v: [0, 0, 0, 0] } });
  const flat = await panel.read();
  check('panel leaves the scale unlabelled while nothing was measured', flat.gridLabels.length === 0, flat.gridLabels.join(' | '));
  await panel.set(state({ stepsSeq: 905, stepsKnown: 2, steps: [
    { tokens: 1, ms: 80, tps: null, aborted: false, at: Date.now() - 2000 },
    { tokens: 1, ms: 120, tps: null, aborted: false, at: Date.now() - 1000 },
  ] }));
  const unrated = await panel.read();
  check(
    'panel says no rated steps, not no finished steps, when steps exist',
    /no rated steps yet/.test(unrated.stepSvg) && !/no finished steps yet/.test(unrated.stepSvg),
    unrated.stepSvg.slice(0, 120),
  );

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
    /start \d{1,2} [A-Z][a-z]{2} \d\d:\d\d:\d\d/.test(idle.stepsAxisText ?? '') && /now \d{1,2} [A-Z][a-z]{2} \d\d:\d\d:\d\d/.test(idle.stepsAxisText ?? ''),
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

  // ------------------------------------------------------------ API value
  // The same block when the service sends a booked price: API value as the
  // headline, billed beside it, four published rates and their source.
  const CLAUDE_CARD = {
    cacheRead: 0.2,
    cacheWrite: 5,
    checkedAt: '2026-11-14',
    input: 4,
    match: 'alias',
    model: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    output: 20,
    provider: 'anthropic',
    source: 'Anthropic list',
    tier: null,
    timeTier: null,
  };
  const priced = (cost = {}) => ({
    ...state(),
    cost: {
      billed: { lastTurn: 0, perMillion: 0, total: 0 },
      coverage: 1,
      drift: null,
      lastTurn: 0.42,
      lowerBound: false,
      mode: 'api',
      perMillion: 0.081,
      priceNote: 'noBilledCost',
      rates: CLAUDE_CARD,
      ratesNote: null,
      tariff: null,
      total: 1180,
      ...cost,
    },
  });

  await panel.set(priced());
  const claudeUi = await panel.read();
  check(
    'UI-01 the total is API value with a badge',
    claudeUi.costTotal === '$1,180.00' && claudeUi.apiBadge === true,
    `${claudeUi.costTotal}, badge ${claudeUi.apiBadge}`,
  );
  check(
    'UI-02 four published rates and the card source',
    claudeUi.costRows.length === 1 &&
      claudeUi.costRows[0].cells.length === 4 &&
      claudeUi.costRows[0].cells.join('|') === '$4.00|$20.00|$0.20|$5.00' &&
      /Anthropic list · 2026-11-14/.test(claudeUi.costSource ?? ''),
    `${claudeUi.costSource} · ${JSON.stringify(claudeUi.costRows)}`,
  );
  check('UI-02 the model cell names the card', claudeUi.costModel === 'Claude Opus 5.5', String(claudeUi.costModel));
  check(
    'UI-02 the last turn is API value too',
    claudeUi.costTurn === '$0.4200',
    String(claudeUi.costTurn),
  );

  const gptCard = { ...CLAUDE_CARD, cacheRead: 0.05, cacheWrite: 1.25, input: 1, match: 'exact', model: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', output: 5, provider: 'openai', source: 'OpenAI list' };
  await panel.set(priced({ lastTurn: 0.11, rates: gptCard, total: 31.43 }));
  const gptUi = await panel.read();
  check(
    'UI-03 an OpenAI session shows its own card',
    gptUi.costTotal === '$31.43' && gptUi.costModel === 'GPT-6.1 Terra' && /OpenAI list/.test(gptUi.costSource ?? ''),
    `${gptUi.costTotal} ${gptUi.costModel} ${gptUi.costSource}`,
  );

  const ccCard = { ...CLAUDE_CARD, model: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'commandcode', source: 'Command Code list' };
  await panel.set(priced({ rates: ccCard, total: 12.4 }));
  const ccUi = await panel.read();
  check(
    'UI-04 a Command Code session shows its own card',
    ccUi.costTotal === '$12.40' && /Command Code list/.test(ccUi.costSource ?? ''),
    `${ccUi.costTotal} ${ccUi.costSource}`,
  );

  const goCard = { ...CLAUDE_CARD, cacheRead: 0.003, cacheWrite: 0, input: 0.15, match: 'exact', model: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', output: 0.6, provider: 'opencode-go', source: 'OpenCode Go card', timeTier: 'peak' };
  const goTariff = { ...state().cost.tariff, source: 'card' };
  await panel.set(priced({ rates: goCard, tariff: goTariff, total: 1.5 }));
  const goPeakUi = await panel.read();
  check(
    'UI-05 the active peak row comes first, four cells',
    goPeakUi.costRows.length === 2 &&
      goPeakUi.costRows[0].label === 'peak now' &&
      goPeakUi.costRows[0].active === 'true' &&
      goPeakUi.costRows[0].cells.length === 4 &&
      goPeakUi.costRows[0].cells.join('|') === '$0.30|$1.20|$0.006|$0' &&
      goPeakUi.costRows[1].active === 'false',
    JSON.stringify(goPeakUi.costRows),
  );
  check(
    'UI-05 the active peak row keeps its colour',
    goPeakUi.costRows[0].color === 'rgb(245, 158, 11)',
    String(goPeakUi.costRows[0].color),
  );

  await panel.set(priced({ rates: { ...goCard, timeTier: 'off-peak' }, tariff: { ...goTariff, peak: false }, total: 0.75 }));
  const goOffUi = await panel.read();
  check(
    'UI-06 the active off-peak row comes first',
    goOffUi.costRows[0].label === 'off-peak now' &&
      goOffUi.costRows[0].cells.join('|') === '$0.15|$0.60|$0.003|$0' &&
      goOffUi.costRows[1].label === 'peak',
    JSON.stringify(goOffUi.costRows),
  );

  await panel.set(priced({ total: 4 }));
  const flatUi = await panel.read();
  check(
    'UI-07 a flat card is one list row',
    flatUi.costRows.length === 1 && flatUi.costRows[0].label === 'list' && flatUi.costRows[0].cells.length === 4,
    JSON.stringify(flatUi.costRows),
  );

  await panel.set(priced({ rates: { ...CLAUDE_CARD, checkedAt: null, match: 'recovered', name: null, model: 'deepseek-v4.1-flash', provider: 'requesty', source: 'billed rates' }, total: 0.44 }));
  const billedUi = await panel.read();
  check(
    'UI-08 recovered rates are labeled as billed',
    billedUi.costRows.length === 1 && billedUi.costRows[0].label === 'billed' && /billed rates/.test(billedUi.costSource ?? ''),
    `${billedUi.costRows[0]?.label} ${billedUi.costSource}`,
  );

  await panel.set(priced({ lastTurn: null, perMillion: null, priceNote: 'noPrice', rates: null, total: null }));
  const noPriceUi = await panel.read();
  check(
    'UI-09 no card reads as no published rate',
    noPriceUi.costTotal === '—' && noPriceUi.costSource === 'no published rate',
    `${noPriceUi.costTotal} ${noPriceUi.costSource}`,
  );

  await panel.set(priced({ coverage: 0.5, lowerBound: true, priceNote: 'partial', total: 12, unpriced: [{ consumed: 1e6, model: 'unknown/model', provider: 'nowhere' }] }));
  const partialUi = await panel.read();
  check(
    'UI-10 a partial tree carries the floor mark',
    partialUi.costTotal === '≥ $12.00' && /lower bound/.test(partialUi.costTotalTitle ?? ''),
    `${partialUi.costTotal} ${String(partialUi.costTotalTitle).slice(0, 60)}`,
  );
  check(
    'UI-23 the floor mark names the unpriced model',
    /no rate for unknown\/model/.test(partialUi.costTotalTitle ?? ''),
    String(partialUi.costTotalTitle).slice(-80),
  );
  check(
    'UI-24 a lower bound marks the effective rate too',
    /^~\$/.test(partialUi.costRate ?? '') && /published rate/.test(partialUi.costRateTitle ?? ''),
    `${partialUi.costRate} · ${String(partialUi.costRateTitle).slice(0, 60)}`,
  );
  // The record can hold more steps than the meter keeps (1,000 per member);
  // the Effective tooltip says how many were priced. The note was written and
  // then overwritten by the tooltip's own assignment, so it never showed.
  await panel.set({ ...priced(), stepsKnown: 1_500, stepsSeq: 77 });
  const keptUi = await panel.read();
  check(
    'UI-25 the effective rate says when the record holds more steps than were kept',
    / · the record holds 1\.5k steps, 2 kept$/.test(keptUi.costRateTitle ?? ''),
    String(keptUi.costRateTitle).slice(-80),
  );
  await panel.set(priced());
  const keptUiBack = await panel.read();
  check('UI-25 and says nothing when every step was priced', !/record holds/.test(keptUiBack.costRateTitle ?? ''), String(keptUiBack.costRateTitle).slice(-60));

  const staleCard = {
    ...CLAUDE_CARD,
    checkedAt: new Date(Date.now() - 61 * 86_400_000).toISOString().slice(0, 10),
  };
  await panel.set(priced({ rates: staleCard }));
  const staleUi = await panel.read();
  check(
    'UI-25 a stale snapshot says how old it is',
    /\d+ days old/.test(staleUi.costRatesTitle ?? ''),
    String(staleUi.costRatesTitle).slice(0, 90),
  );

  await panel.set(
    priced({
      models: [
        { apiValue: 1180, billed: 0, model: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', rates: CLAUDE_CARD },
        { apiValue: 31.43, billed: 0, model: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', provider: 'openai', rates: gptCard },
      ],
    }),
  );
  const multiUi = await panel.read();
  check(
    'UI-11 a multi-model tree says so',
    /\+1 model\b/.test(multiUi.costSource ?? '') && /Claude Opus 5\.5/.test(multiUi.costRatesTitle ?? ''),
    `${multiUi.costSource} · ${String(multiUi.costRatesTitle).slice(0, 80)}`,
  );

  await panel.set(priced({ billed: { lastTurn: 0, perMillion: 0, total: 1156.86 }, drift: { model: 'claude-opus-5-5', relative: 0.02 }, priceNote: 'drift' }));
  const driftUi = await panel.read();
  check(
    'UI-12 drift is a flag, never a prefix',
    driftUi.costFlag === ' price drift' &&
      driftUi.costTotal === '$1,180.00' &&
      !/≈/.test(driftUi.costTotal ?? '') &&
      /1156\.8600/.test(driftUi.costRatesTitle ?? ''),
    `${driftUi.costTotal} ${driftUi.costFlag} ${String(driftUi.costRatesTitle).slice(0, 90)}`,
  );

  await panel.set(priced({ rates: ccCard, total: 12.4 }));
  const switchedUi = await panel.read();
  check(
    'UI-13 a new model leaves no stale card',
    switchedUi.costModel === 'DeepSeek V4.1 Flash' && /Command Code/.test(switchedUi.costSource ?? '') && !/Anthropic/.test(switchedUi.costSource ?? ''),
    `${switchedUi.costModel} ${switchedUi.costSource}`,
  );

  await panel.set(priced({ total: 0.0842 }));
  const tinyUi = await panel.read();
  check('UI-14 small money keeps four decimals', tinyUi.costTotal === '$0.0842', String(tinyUi.costTotal));
  check(
    'UI-15 the rates tooltip names source, date and match',
    /Anthropic list/.test(claudeUi.costRatesTitle ?? '') &&
      /2026-11-14/.test(claudeUi.costRatesTitle ?? '') &&
      /matched by alias/.test(claudeUi.costRatesTitle ?? ''),
    String(claudeUi.costRatesTitle),
  );

  const emptyTotals = { ...state().totals, cacheRead: 0, cacheWrite: 0, consumed: 0, generated: 0, input: 0, output: 0, prompt: 0, reasoning: 0, steps: 0 };
  await panel.set({ ...priced({ lastTurn: null, perMillion: null, priceNote: 'noPrice', rates: null, total: null }), stepsKnown: 0, totals: emptyTotals });
  const emptyUi = await panel.read();
  check(
    'UI-16 an empty session waits for its first step',
    emptyUi.costTotal === '—' && emptyUi.costSource === 'waiting for the first step',
    `${emptyUi.costTotal} ${emptyUi.costSource}`,
  );

  const freeCard = { ...CLAUDE_CARD, cacheRead: 0, cacheWrite: 0, input: 0, model: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free', output: 0, provider: 'opencode', source: 'OpenCode Zen list' };
  await panel.set(priced({ lastTurn: 0, priceNote: 'free', rates: freeCard, total: 0 }));
  const freeUi = await panel.read();
  check(
    'UI-17 a free model reads as free, not as a dash',
    freeUi.costTotal === '$0.0000' && /^free · in \$0 · out \$0 · read \$0 · write \$0$/.test(freeUi.costSource ?? ''),
    `${freeUi.costTotal} ${freeUi.costSource}`,
  );

  await panel.set(priced());
  const fitUi = await panel.read();
  check('UI-18 the rates row does not overflow the rail', fitUi.costOverflow === 0, `${fitUi.costOverflow}px`);

  await panel.set({ ...priced({ lastTurn: null, perMillion: null, priceNote: 'noPrice', total: null }), stepsKnown: 0, totals: emptyTotals });
  const waitingCard = await panel.read();
  check(
    'UI-21 a known card with no steps still waits',
    waitingCard.costTotal === '—' && waitingCard.costSource === 'waiting for the first step' && waitingCard.costRows.length === 0,
    `${waitingCard.costTotal} ${waitingCard.costSource} ${waitingCard.costRows.length} rows`,
  );

  // A record-seeded answer has usage before any step list arrives; saying
  // "waiting for the first step" over real tokens is wrong.
  await panel.set({ ...priced({ total: 3 }), stepsKnown: 0 });
  const seededUi = await panel.read();
  check(
    'UI-21b a record-seeded answer draws its card instead of waiting',
    seededUi.costTotal === '$3.0000' && seededUi.costSource !== 'waiting for the first step',
    `${seededUi.costTotal} ${seededUi.costSource}`,
  );

  await panel.set(priced({ rates: { ...CLAUDE_CARD, match: 'override', source: 'manual override' } }));
  const manualUi = await panel.read();
  check(
    'UI-22 an override reads as manual',
    manualUi.costRows[0]?.label === 'manual' && /manual override/.test(manualUi.costSource ?? ''),
    `${manualUi.costRows[0]?.label} ${manualUi.costSource}`,
  );

  await panel.set(
    priced({
      rates: { ...CLAUDE_CARD, tier: { minContext: 272000, rates: { cacheRead: 0.1, cacheWrite: 2.5, input: 2, output: 7.5 } } },
    }),
  );
  const tierUi = await panel.read();
  check(
    'UI-22 an active context tier names its threshold',
    tierUi.costRows[0]?.label === 'context >272k' && tierUi.costRows[0].cells[0] === '$2.00',
    `${tierUi.costRows[0]?.label} ${tierUi.costRows[0]?.cells.join('|')}`,
  );

  await panel.set(state());
  const legacyUi = await panel.read();
  check(
    'UI-19 a service without a book claims nothing',
    legacyUi.apiBadge === false &&
      legacyUi.costTotal === '$0.3100' &&
      legacyUi.costRows.length === 2 &&
      legacyUi.costRows[0].label === 'peak now',
    `${legacyUi.costTotal} badge ${legacyUi.apiBadge}, ${legacyUi.costRows.length} rows`,
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
      switched.lastRateText === '',
    `${switched.tps} ${switched.tpsTier} ${switched.lastRateTier} ${JSON.stringify(switched.lastRateText)}`,
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
  check('panel clears the footer the moment the session switches', cleanSwitch.footText === '', JSON.stringify(cleanSwitch.footText));
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

  // The header and the Models block belong to the session too: a generating,
  // two-model session must not leave its dot, its turn timer or its model list
  // under the next session's name while that one's first answer is on its way.
  const twoModels = state({
    status: 'streaming',
    turn: { active: true, consumed: 10, startedAt: Date.now() - 125_000, steps: 1, tokens: 5 },
    cost: {
      ...state().cost,
      mode: 'api',
      models: [
        { apiValue: 3, billed: 0, consumed: 1000, drift: null, model: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic' },
        { apiValue: 1, billed: 0, consumed: 1000, drift: null, model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'anthropic' },
      ],
    },
  });
  await panel.set(twoModels);
  const twoRead = await panel.read();
  check(
    'panel lists two models and times a running turn before a switch',
    twoRead.modelsDisplay === 'flex' && /Claude Haiku 5\.5/.test(twoRead.modelsText ?? '') && /^generating · 2m/.test(twoRead.statusLabel ?? ''),
    `${twoRead.modelsDisplay} ${twoRead.statusLabel}`,
  );
  await panel.delay(1500);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await panel.switchSession(state({ status: 'idle' }), 'ses_header');
  const headerSwitch = await panel.read();
  check(
    'panel clears the header and the Models block the moment the session switches',
    headerSwitch.dotStateNow === 'idle' && headerSwitch.statusLabel === 'idle' && headerSwitch.modelsDisplay === 'none',
    `${headerSwitch.dotStateNow} "${headerSwitch.statusLabel}" models ${headerSwitch.modelsDisplay}`,
  );
  await panel.delay(0);
  await new Promise((resolve) => setTimeout(resolve, 1800));

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
    /^180 t\/s · out 900 in 5\.0 s · \d{1,2} [A-Z][a-z]{2} \d\d:\d\d:\d\d · \$0\.0034$/.test(stepHover.stepsHoverText ?? ''),
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
      /start \d{1,2} [A-Z][a-z]{2} \d\d:\d\d:\d\d/.test(stepLeft.stepsAxisText ?? '') &&
      /now \d{1,2} [A-Z][a-z]{2} \d\d:\d\d:\d\d/.test(stepLeft.stepsAxisText ?? ''),
    `${stepLeft.stepsHoverHidden}/${stepLeft.stepsStartHidden}/${stepLeft.stepsNowHidden} ${stepLeft.stepsAxisText}`,
  );
  const churn = await panel.hoverChurn(40);
  check(
    'a pointer move restyles the bars instead of redrawing the chart',
    churn.added <= 2 &&
      churn.bars >= 2 &&
      churn.litCount === 1 &&
      churn.litOpacity === '1.00' &&
      churn.columnWidth > 0,
    `${churn.added} nodes added over ${churn.moves} moves, ${churn.bars} bars, lit ${churn.litCount} at ${churn.litOpacity}, column ${churn.columnWidth}`,
  );
  await panel.leave('[data-chart="steps"]');
  await panel.set(state({ steps: [{ tokens: 900, ms: 5000, tps: 180, aborted: false }] }));
  await panel.hover('[data-chart="steps"]', 0.5);
  const oldStore = await panel.read();
  check(
    'panel reads a step from an older service without a time or a cost',
    oldStore.stepsHoverText === '180 t/s · out 900 in 5.0 s',
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

  // A finished recording keeps the live clock: history leaves the window as
  // time passes instead of freezing at an "ended" edge with a flat tail.
  const finishedAt = Date.now() - 3 * 3_600_000;
  await panel.set(
    state({
      generatedAt: Date.now(),
      recording: { state: 'saved', startedAt: finishedAt - 60_000, endedAt: finishedAt, lastSampleAt: finishedAt, error: null },
      series: { t0: finishedAt - 59_750, step: 250, v: Array.from({ length: 240 }, () => 30) },
    }),
  );
  const finishedUi = await panel.read();
  check(
    'a finished recording keeps scrolling with the live clock',
    finishedUi.axisFrom === '60 s ago' &&
      finishedUi.axisTo === 'now' &&
      finishedUi.axisToTitle === '' &&
      !/recorded graph/.test(finishedUi.footText ?? '') &&
      finishedUi.gridLabels.length === 0,
    `${finishedUi.axisFrom} / ${finishedUi.axisTo} / title ${JSON.stringify(finishedUi.axisToTitle)} / ${finishedUi.footText} / ticks ${finishedUi.gridLabels.join(',')}`,
  );
  await panel.set(state({ status: 'idle', recording: { state: 'unrecorded', startedAt: null, endedAt: null, lastSampleAt: null, error: null }, series: { t0: Date.now() - 1000, step: 250, v: [] } }));
  const unrecordedUi = await panel.read();
  check(
    'a never-recorded idle session still says so',
    /no live recording yet/.test(unrecordedUi.footText ?? ''),
    String(unrecordedUi.footText),
  );
  await panel.set(state());

  // A poll is 250 ms plus its own round trip, and every poll samples the series:
  // the last 240 samples span ~75 s at a 312 ms cadence. They belong at their own
  // times, so the curve still ends at "now" instead of 15 s short of it.
  const driftNow = Date.now();
  await panel.set(
    state({
      generatedAt: driftNow,
      series: {
        t0: driftNow - 239 * 312 - 20,
        step: 250,
        d: Array.from({ length: 240 }, (_, index) => index * 312),
        v: Array.from({ length: 240 }, (_, index) => 30 + (index % 7)),
      },
    }),
  );
  const drifted = await panel.read();
  check(
    'the curve ends at now even when the samples drift',
    drifted.liveRight !== null && drifted.liveWidth !== null && drifted.liveRight >= drifted.liveWidth,
    `right ${drifted.liveRight} of ${drifted.liveWidth}`,
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
  check(
    'panel says how many subagents are in the tree',
    /2 subagents/.test(subagent.text),
    String(subagent.subsToggle ?? subagent.text.slice(0, 90)),
  );
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
  check(
    'panel scales the plot to the session peak, not the window',
    lowRate.liveTopY > 8 && lowRate.peakLineY === 8 && lowRate.gridLabels.includes('334'),
    `curve ${lowRate.liveTopY}, peak line ${lowRate.peakLineY}, axis ${lowRate.gridLabels[0]}`,
  );

  // The red line is the plot's ceiling: it sits on the top edge and stays there
  // between reads, instead of drifting down while an old scale eased away.
  const steady = await panel.read();
  check(
    'panel pins a peak above the floor to the top of the plot',
    steady.peakLineY === 8 && steady.gridLabels.includes('334'),
    `y ${steady.peakLineY}, axis ${steady.gridLabels[0]}`,
  );
  check(
    'UI-26 the peak says how old it is',
    /peak 334 t\/s · 8m 00s ago/.test(steady.text),
    String(steady.text).slice(0, 90),
  );
  check('UI-27 the peak line is dotted like the step chart', steady.peakDash === '2 3', String(steady.peakDash));
  check(
    'UI-28 the section is called Session details',
    steady.sectionHead.includes('Session details') && !steady.sectionHead.includes('Session totals'),
    steady.sectionHead.join(' | '),
  );
  check(
    'UI-29 the foot carries the reader’s clock',
    /^.+ · \d{1,2}:\d{2}:\d{2}(\s?[AP]M)?$/.test(steady.footClock ?? ''),
    String(steady.footClock),
  );
  await panel.set(state({ status: 'idle' }));
  const idleUi = await panel.read();
  check(
    'UI-30 an idle session does not say live',
    idleUi.totalsSource === '' || idleUi.totalsSource === null,
    JSON.stringify(idleUi.totalsSource),
  );

  const twoSubs = {
    ...state(),
    subagents: {
      active: [
        { id: 'ses_sub_a', status: 'streaming', title: 'reading the spec', tps: 40 },
        { id: 'ses_sub_b', status: 'streaming', title: 'writing tests', tps: 22 },
      ],
      count: 2,
      loading: 0,
      partial: 0,
      running: 2,
      streaming: 2,
      tool: 0,
    },
  };
  await panel.set(twoSubs);
  const subsA = await panel.read();
  await panel.set({
    ...twoSubs,
    subagents: { ...twoSubs.subagents, active: twoSubs.subagents.active.map((item) => ({ ...item, tps: item.tps + 5 })) },
  });
  const subsB = await panel.read();
  check(
    'UI-32 subagent rows are keyed, not rebuilt, so they can animate',
    subsA.subIds.join(',') === 'ses_sub_a,ses_sub_b' &&
      subsB.subIds.join(',') === subsA.subIds.join(',') &&
      subsB.subOut === 0 &&
      subsA.text.includes('reading the spec'),
    `${subsA.subIds.join(',')} then ${subsB.subIds.join(',')}`,
  );

  await panel.set(state({ status: 'streaming' }));
  const workingUi = await panel.read();
  check('UI-30 a working session says live', workingUi.totalsSource === 'live', String(workingUi.totalsSource));
  const draws = await panel.drawRate(600);
  check(
    'UI-31 the live curve redraws at frame rate, not 12.5 fps',
    draws >= 15,
    `${draws} redraws in 600 ms (12.5 fps would give ~7)`,
  );
  const busyCadence = await panel.chartCadence();
  check('UI-31 generating scroll follows display frames without pointer input', busyCadence.frames >= 10 && busyCadence.changed >= busyCadence.frames * 0.8, JSON.stringify(busyCadence));
  const highRefreshDraws = await panel.fastFrames();
  check('UI-31 a 120 Hz display is not capped by a 16 ms redraw gate', highRefreshDraws === 40, `${highRefreshDraws} draws / 40 frames`);
  const panelRise = await measureCurveRise(panel);
  check('rail curve rises through intermediate heights alongside the eased number', panelRise.frames >= 6 && panelRise.heights >= 6, JSON.stringify(panelRise));
  // An idle session still slides its history left, but the loop redraws it at
  // 5 fps instead of at the display rate: rebuilding the same curve on every
  // frame cost ~25% of a core and half the window server (issue #1). An answer
  // from the service still draws on arrival, so the newest point is never late.
  await panel.set(state({ status: 'idle' }));
  await panel.wait(300);
  const idleDraws = await panel.drawRate(1_000);
  check(
    'UI-31 an idle graph redraws about 5 times a second, not on every display frame',
    idleDraws >= 4 && idleDraws <= 10,
    `${idleDraws} path writes in 1 s`,
  );
  const idleCadence = await panel.chartCadence();
  check(
    'UI-31 idle history keeps advancing, in 200 ms steps',
    idleCadence.frames >= 10 && idleCadence.changed >= 2 && idleCadence.changed <= idleCadence.frames * 0.4,
    JSON.stringify(idleCadence),
  );
  // The path is rebuilt five times a second; the slide moves the same drawing
  // on every frame, so the history still scrolls smoothly at idle.
  const idleSlide = await panel.slideRate(500);
  check(
    'UI-31 an idle curve slides on every frame without a path rebuild',
    idleSlide.frames >= 10 && idleSlide.moves >= idleSlide.frames * 0.8,
    JSON.stringify(idleSlide),
  );
  const edgeCover = await panel.edgeCover(400);
  check(
    'UI-31 the sliding curve still covers the right edge',
    edgeCover.width > 0 && edgeCover.min >= edgeCover.width - 0.01,
    JSON.stringify(edgeCover),
  );
  await panel.screenshot(path.join(process.env.TMPDIR ?? '/tmp', 'token-meter-panel-idle.png'));
  // A zoom and a pointer readout are real motion: they keep every display
  // frame, or the ease turns back into 200 ms steps.
  await panel.wheel('[data-chart="live"]', 120);
  const zoomDraws = await panel.fastFrames();
  check('UI-31 a zoom ease still draws on every display frame', zoomDraws >= 20, `${zoomDraws} draws / 40 frames`);
  await panel.wheel('[data-chart="live"]', -120);
  await panel.wait(500);
  await panel.hoverAt('[data-chart="live"]', 120, 60);
  const hoverDraws = await panel.fastFrames();
  check('UI-31 a pointer readout still draws on every display frame', hoverDraws === 40, `${hoverDraws} draws / 40 frames`);
  await panel.leave('[data-chart="live"]');
  const hiddenDraws = await panel.hiddenDraws();
  check('UI-31 hidden frames do not redraw the live chart', hiddenDraws === 0, `${hiddenDraws} draws while hidden`);
  await panel.set(state({ totals: { ...state().totals, source: 'history' } }));
  const historyUi = await panel.read();
  check(
    'UI-30 a cold read says from history',
    historyUi.totalsSource === 'from history',
    String(historyUi.totalsSource),
  );

  // The long series the zoom needs: one value per second for five minutes.
  const longSeries = {
    t0: Date.now() - 300_000,
    step: 1_000,
    d: Array.from({ length: 300 }, (_, index) => index * 1_000),
    v: Array.from({ length: 300 }, (_, index) => 20 + (index % 7) * 3),
  };
  const hourSeries = {
    t0: Date.now() - 3_600_000,
    step: 10_000,
    d: Array.from({ length: 360 }, (_, index) => index * 10_000),
    v: Array.from({ length: 360 }, (_, index) => 10 + (index % 11) * 2),
  };
  await panel.set(state({ seriesLong: longSeries, seriesWide: hourSeries }));
  const atRest = await panel.read();
  check('UI-34 the live chart starts on the 60 s window', atRest.axisFrom === '60 s ago', String(atRest.axisFrom));
  await panel.wheel('[data-chart="live"]', 120);
  const early = await panel.read();
  await panel.wait(60);
  const later = await panel.read();
  await panel.wait(400);
  const eased = await panel.read();
  check(
    'UI-34 a wheel notch eases out over several frames',
    /^\d+ s ago$/.test(early.axisFrom ?? '') &&
      /^\d+ s ago$/.test(later.axisFrom ?? '') &&
      Number.parseInt(early.axisFrom, 10) > 60 &&
      Number.parseInt(later.axisFrom, 10) >= Number.parseInt(early.axisFrom, 10) &&
      Number.parseInt(later.axisFrom, 10) <= 71 &&
      Number.parseInt(eased.axisFrom, 10) > Number.parseInt(early.axisFrom, 10) &&
      Number.parseInt(eased.axisFrom, 10) === 71,
    `${early.axisFrom} → ${later.axisFrom} → ${eased.axisFrom}`,
  );
  // Eight more notches from 70.8 s land on 70.8 x 1.18^8 = 266 s: still inside
  // the five-minute band that the 1 s series covers. Wait for the ease to
  // finish so the assertion reads the target, not whichever frame it caught.
  for (let notch = 0; notch < 8; notch += 1) await panel.wheel('[data-chart="live"]', 120);
  await panel.wait(500);
  const fourMinutes = await panel.read();
  check(
    'UI-34 eight more notches reach four minutes on the 1 s series',
    fourMinutes.axisFrom === '4 min ago' && Boolean(fourMinutes.livePathD),
    `${fourMinutes.axisFrom} d=${String(fourMinutes.livePathD).slice(0, 20)}`,
  );
  for (let notch = 0; notch < 18; notch += 1) await panel.wheel('[data-chart="live"]', 120);
  await panel.wait(500);
  const widest = await panel.read();
  check(
    'UI-34 it reaches an hour on the 10 s series',
    widest.axisFrom === '1 h ago' && Boolean(widest.livePathD),
    `${widest.axisFrom} d=${String(widest.livePathD).slice(0, 20)}`,
  );
  for (let notch = 0; notch < 32; notch += 1) await panel.wheel('[data-chart="live"]', -120);
  const closest = await panel.read();
  check('UI-34 the wheel narrows it back to the floor', closest.axisFrom === '60 s ago', String(closest.axisFrom));
  // The reset path itself, with its minute shortened to what a test can wait.
  await panel.fastZoomReset(400);
  await panel.wheel('[data-chart="live"]', 120);
  const armed = await panel.read();
  // The reset waits for the pointer to leave: that is what "not hovering" means.
  await panel.leave('[data-chart="live"]');
  await panel.wait(1_400);
  const resetUi = await panel.read();
  check(
    'UI-34 the zoom resets itself once the pointer is away',
    armed.axisFrom !== '60 s ago' && resetUi.axisFrom === '60 s ago',
    `${armed.axisFrom} then ${resetUi.axisFrom}`,
  );
  await panel.fastZoomReset(60_000);

  const manySteps = Array.from({ length: 150 }, (_, index) => ({
    aborted: false,
    at: Date.now() - (150 - index) * 1_000,
    cost: 0,
    in: 4_000 + index,
    ms: 900,
    tokens: 60 + (index % 5) * 10,
    tps: 60 + (index % 5) * 10,
  }));
  await panel.set(state({ steps: manySteps, stepsKnown: manySteps.length, stepsSeq: 9 }));
  const manyBars = await panel.read();
  await panel.wheel('[data-chart="steps"]', -120);
  const fewBars = await panel.read();
  check(
    'UI-35 a step-chart notch thins the bars, gradually',
    manyBars.bars === 150 && fewBars.bars < 150 && fewBars.bars > 100,
    `${manyBars.bars} then ${fewBars.bars} bars`,
  );
  await panel.hover('[data-chart="steps"]', 0.6);
  const readout = await panel.read();
  check(
    'UI-39 the step readout names in and out apart',
    /^\d+ t\/s · in 4\.[01]k · out \d+ in \d+(\.\d)? (s|ms) · \d{1,2} [A-Z][a-z]{2} \d\d:\d\d:\d\d( · \$[\d.]+)?$/.test(readout.stepsHoverText ?? ''),
    String(readout.stepsHoverText).slice(0, 90),
  );
  await panel.leave('[data-chart="steps"]');

  await panel.set(state({ status: 'streaming', steps: manySteps, stepsKnown: manySteps.length, stepsSeq: 9, turn: { active: true, consumed: 5_500_000, startedAt: Date.now() - 120_000, steps: 3, tokens: 2_000 } }));
  const turnLine = await panel.read();
  check(
    'UI-40 the last line carries the turn’s consumed tokens',
    /· 5\.5M tok/.test(turnLine.lastRestText ?? ''),
    String(turnLine.text).slice(0, 80),
  );

  await panel.set(
    state({
      subagents: {
        active: [],
        count: 2,
        loading: 0,
        members: [
          { avgTps: 120, consumed: 4_200_000, cost: 0.0123, id: 'ses_sub_a', lastAt: Date.now() - 90_000, peakTps: 340, status: 'idle', steps: 12, title: 'reading the spec', tps: 0 },
          { avgTps: 80, consumed: 1_100_000, cost: 0.004, id: 'ses_sub_b', lastAt: Date.now() - 300_000, peakTps: 150, status: 'idle', steps: 5, title: 'writing tests', tps: 0 },
        ],
        partial: 0,
        running: 0,
        streaming: 0,
        tool: 0,
      },
    }),
  );
  const subsClosed = await panel.read();
  check('UI-41 a closed roster draws nothing', subsClosed.subsDetailDisplay === 'none', String(subsClosed.subsDetailDisplay));
  check('UI-41 the tree count is a chip beside Session details', subsClosed.subsToggle === '2 subagents', String(subsClosed.subsToggle));
  await panel.click('.subs-toggle');
  const subsOpen = await panel.read();
  check(
    'UI-41 the roster header counts the tree, not just the rows shown',
    /2 in this tree/.test(subsOpen.subsDetailText ?? ''),
    String(subsOpen.subsDetailText).slice(0, 80),
  );
  check(
    'UI-41 clicking it lists every subagent session with its own numbers',
    subsOpen.subsDetailShown === true && subsOpen.subsDetailDisplay === 'flex' &&
      /reading the spec/.test(subsOpen.subsDetailText ?? '') &&
      /4\.2M tok/.test(subsOpen.subsDetailText ?? '') &&
      /avg 120 t\/s/.test(subsOpen.subsDetailText ?? '') &&
      /peak 340 t\/s/.test(subsOpen.subsDetailText ?? '') &&
      /ago/.test(subsOpen.subsDetailText ?? ''),
    `${subsOpen.subsDetailShown} ${String(subsOpen.subsDetailText).slice(0, 200)}`,
  );
  await panel.click('.subs-toggle');
  await panel.wait(400);

  // Clicking a roster row filters the step chart at once. The bars were cached
  // on the list object alone, so the filter waited for the next step to land:
  // on a quiet session it never showed.
  const filterBase = state();
  const filtered = {
    ...filterBase,
    stepsSeq: 40,
    steps: [...filterBase.steps, { aborted: false, at: Date.now() - 10_000, cost: 0.002, ms: 4000, sub: 'ses_sub_a', tokens: 400, tps: 100 }],
    subagents: { ...state().subagents, count: 2, members: [
      { avgTps: 100, consumed: 4_000, cost: 0.002, id: 'ses_sub_a', lastAt: Date.now() - 10_000, peakTps: 100, status: 'idle', steps: 1, title: 'reading the spec', tps: 0 },
      { avgTps: 80, consumed: 1_100, cost: 0.004, id: 'ses_sub_b', lastAt: Date.now() - 300_000, peakTps: 150, status: 'idle', steps: 5, title: 'writing tests', tps: 0 },
    ] },
  };
  await panel.set(filtered);
  const unfiltered = await panel.read();
  await panel.click('.subs-toggle');
  await panel.wait(400);
  await panel.click('.sub-detail[data-member="ses_sub_a"]');
  await panel.wait(300);
  const oneMember = await panel.read();
  check(
    'panel filters the step chart the moment a roster row is clicked',
    unfiltered.stepFills.length === 3 && oneMember.stepFills.length === 1 && oneMember.stepFills[0] === 'var(--oc-info)',
    `${unfiltered.stepFills.length} -> ${oneMember.stepFills.join(',')}`,
  );
  await panel.click('.sub-detail[data-member="ses_sub_a"]');
  await panel.wait(300);
  const wholeTree = await panel.read();
  check('panel draws the whole tree again on a second click', wholeTree.stepFills.length === 3, `${wholeTree.stepFills.length} bars`);

  // The rows are toggles to a keyboard too: focusable, announced as buttons
  // with their pressed state, and Enter filters exactly as a click does.
  const rowA = wholeTree.subRows.find((row) => row.member === 'ses_sub_a');
  check(
    'panel exposes each roster row as a focusable toggle',
    Boolean(rowA) && rowA.role === 'button' && rowA.tabIndex === 0 && rowA.pressed === 'false',
    JSON.stringify(rowA),
  );
  const keptFocus = await panel.key('.sub-detail[data-member="ses_sub_a"]', 'Enter');
  await panel.wait(300);
  const keyed = await panel.read();
  check(
    'panel filters on Enter and keeps the focus on the row',
    keptFocus && keyed.stepFills.length === 1 && keyed.subRows.find((row) => row.member === 'ses_sub_a')?.pressed === 'true',
    `focus ${keptFocus}, ${keyed.stepFills.length} bars, ${JSON.stringify(keyed.subRows)}`,
  );
  await panel.key('.sub-detail[data-member="ses_sub_a"]', ' ');
  await panel.wait(300);

  // The filtered member leaves the tree (quiet for an hour): its row and its
  // steps are gone, and the filter must go with them, not hold the chart empty.
  await panel.click('.sub-detail[data-member="ses_sub_a"]');
  await panel.wait(300);
  await panel.set({ ...state(), stepsSeq: 41, subagents: { ...state().subagents, count: 1, members: [filtered.subagents.members[1]] } });
  const orphan = await panel.read();
  check(
    'panel drops a filter whose member has left the tree',
    orphan.stepFills.length === 2 && orphan.stepsCountTitle !== "showing one subagent's steps",
    `${orphan.stepFills.length} bars, title "${orphan.stepsCountTitle}"`,
  );
  await panel.click('.subs-toggle');
  await panel.wait(400);

  await panel.set(state({ stream: { state: 'retrying', error: 'socket closed' } }));
  const cutUi = await panel.read();
  check(
    'UI-33 a dropped stream says so in the footer',
    cutUi.footText === 'events reconnecting',
    String(cutUi.footText),
  );
  await panel.set(state());
  const backUi = await panel.read();
  check('UI-33 the footer returns to live', backUi.footText === 'live from OpenCode events', String(backUi.footText));
  // A sustained burst, not one sample: the curve is smoothed, so a single
  // 250 ms spike never reaches the peak and must not move the line.
  await panel.set(state({ series: { d: [0, 250, 500, 750, 1000, 1250], step: 250, t0: Date.now() - 6_000, v: [30, 900, 900, 900, 900, 900] } }));
  const burst = await panel.read();
  check(
    'panel keeps the peak line on the top edge through a burst, and scales to it',
    burst.peakLineY === 8 && burst.gridLabels.at(-1) !== '334',
    `y ${burst.peakLineY}, axis ${burst.gridLabels[0]} with a sustained 900 t/s burst`,
  );
  await panel.set(state());
  const settled = await panel.read();
  check(
    'panel returns the peak line to the top as soon as the burst passes',
    settled.peakLineY === 8,
    `y ${settled.peakLineY}`,
  );

  // Graph change: the rendered points, bars and both references must share
  // the very same geometry while their numbers remain in raw t/s units.
  const graphRates = [50, 100, 250, 3000];
  const graphState = state({
    rates: { avg: 150, peak: 3000 },
    stepsSeq: 800,
    stepsKnown: 4,
    steps: graphRates.map((tps, i) => ({ tps, ms: 2000, tokens: tps * 2, at: Date.now() - (4 - i) * 1000, aborted: false })),
    series: { t0: Date.now() - 2000, step: 250, v: [250, 250, 250] },
  });
  const expectedShare = (v, max = 3000) => max <= 100 ? v / max : v <= 100 ? 0.35 * v / 100 : 0.35 + 0.65 * Math.log10(v / 100) / Math.log10(max / 100);
  const expectedY = (v, g, pad, max = 3000) => g.height - pad - expectedShare(v, max) * (g.height - 2 * pad);
  await panel.set(graphState);
  const graphRead = await settle(panel, (data) => Math.abs(data.chartGeometry[0].dotY - expectedY(250, data.chartGeometry[0], 8)) < 0.11);
  const [liveG, stepG] = graphRead.chartGeometry;
  check('graph: a 250 t/s live trace uses over half the plot under a 3k peak', Math.abs(liveG.dotY - expectedY(250, liveG, 8)) < 0.11 && (liveG.height - 8 - liveG.dotY) / (liveG.height - 16) > 0.5, JSON.stringify(liveG));
  check('graph: live average and peak use the same mapping', Math.abs(liveG.avgY - expectedY(150, liveG, 8)) < 0.11 && liveG.peakY === 8);
  check('graph: every history bar uses the same linear/log mapping', stepG.bars.length === 4 && stepG.bars.every((bar, i) => Math.abs(bar.y - expectedY(graphRates[i], stepG, 6)) < 0.11), JSON.stringify(stepG.bars));
  check('graph: history average is transformed after averaging raw rates', Math.abs(stepG.avgY - expectedY(850, stepG, 6)) < 0.11 && stepG.peakY === 6, JSON.stringify(stepG));
  check('graph: both charts show non-overlapping ticks with a clean live caption', [liveG, stepG].every((g) => g.ticks.every((t, i) => i === 0 || g.ticks[i - 1].y - t.y >= 21.9)) && graphRead.liveCaption === 'live');
  await panel.hover('[data-chart="live"]', 0.99);
  const rawLive = await panel.read();
  check('graph: live hover still reads raw t/s, not the transformed coordinate', /^250 t\/s ·/.test(rawLive.peakText ?? ''), rawLive.peakText);
  await panel.leave('[data-chart="live"]');
  await panel.hover('[data-chart="steps"]', 0.625);
  const rawStep = await panel.read();
  check('graph: step hover still reads raw t/s', /^250 t\/s/.test(rawStep.stepsHoverText ?? ''), rawStep.stepsHoverText);
  await panel.leave('[data-chart="steps"]');
  await panel.set({ ...graphState, rates: { avg: 150, peak: 12000 }, series: { ...graphState.series, v: [250, 250, 250] } });
  const giantGraph = await settle(panel, (data) => Math.abs(data.chartGeometry[0].dotY - expectedY(250, data.chartGeometry[0], 8, 12000)) < 0.11);
  check('graph: the axis grows dynamically beyond the example 3k spike', Math.abs(giantGraph.chartGeometry[0].dotY - expectedY(250, giantGraph.chartGeometry[0], 8, 12000)) < 0.11 && giantGraph.gridLabels.some((label) => label.endsWith('k')), giantGraph.gridLabels.join(' | '));
  await panel.set({ ...graphState, rates: { avg: 60, peak: 100 }, series: { ...graphState.series, v: [60] } });
  const slowGraph = await settle(panel, (data) => Math.abs(data.chartGeometry[0].dotY - expectedY(60, data.chartGeometry[0], 8, 300)) < 0.11);
  check(
    'graph: a low peak is the ceiling, with no fixed floor',
    Math.abs(slowGraph.chartGeometry[0].dotY - expectedY(60, slowGraph.chartGeometry[0], 8, 100)) < 0.11 &&
      Math.abs(slowGraph.peakLineY - expectedY(100, slowGraph.chartGeometry[0], 8, 100)) < 0.11,
    `dot ${slowGraph.chartGeometry[0].dotY}, peak ${slowGraph.peakLineY}`,
  );

  // --- budget ----------------------------------------------------------------
  // A limit is set from the Cost block's chip, stored in the extension's server
  // storage, colours the number that reached it and toasts once when a number
  // crosses it while the panel watches. The canned answer has no book: its
  // total is $0.31 recorded, its last turn $0.08.
  const SESSION_FIELD = '.budget-fields > :nth-child(1) input';
  const TURN_FIELD = '.budget-fields > :nth-child(2) input';
  const SAVE = '.budget-actions > :nth-child(1)';
  const CLEAR = '.budget-actions > :nth-child(2)';
  const costAt = (total) => state({ cost: { ...state().cost, total } });
  await panel.set(state());
  const budgetIdle = await panel.budget();
  check(
    'budget: the chip offers a limit once storage has answered',
    !budgetIdle.chipDisabled && budgetIdle.chip === 'set budget' && budgetIdle.totalOver === 'false' && !budgetIdle.formShown,
    JSON.stringify(budgetIdle),
  );
  await panel.click('.budget-chip');
  await panel.wait(200);
  await panel.type(SESSION_FIELD, 'lots');
  await panel.click(SAVE);
  await panel.wait(200);
  const budgetBad = await panel.budget();
  check(
    'budget: two fields, and a limit that is not an amount is refused, not stored',
    budgetBad.formShown && budgetBad.fields === 2 && /dollar amount above 0/.test(budgetBad.errors.join(' ')) && budgetBad.stored === null,
    JSON.stringify(budgetBad),
  );
  await panel.type(SESSION_FIELD, '0.25');
  await panel.type(TURN_FIELD, '$1');
  await panel.click(SAVE);
  await panel.wait(300);
  const budgetOver = await panel.budget();
  check(
    'budget: a saved limit is stored and the number that reached it turns warning',
    JSON.stringify(budgetOver.stored) === '{"session":0.25,"turn":1}' &&
      !budgetOver.formShown &&
      budgetOver.totalOver === 'true' &&
      budgetOver.turnOver === 'false' &&
      budgetOver.chip === 'budget 124%' &&
      budgetOver.chipOver === 'true' &&
      /at or over your \$0\.2500 session budget/.test(budgetOver.totalTitle),
    JSON.stringify(budgetOver),
  );
  check('budget: setting a limit below the current number does not toast', budgetOver.toasts.length === 0, JSON.stringify(budgetOver.toasts));
  await panel.click('.budget-chip');
  await panel.wait(200);
  await panel.type(SESSION_FIELD, '0.5');
  await panel.type(TURN_FIELD, '');
  await panel.click(SAVE);
  await panel.wait(300);
  const budgetUnder = await panel.budget();
  check(
    'budget: under the limit the chip says how much of it is used',
    JSON.stringify(budgetUnder.stored) === '{"session":0.5,"turn":null}' &&
      budgetUnder.chip === 'budget 62%' &&
      budgetUnder.totalOver === 'false' &&
      // The old limit leaves the title with the save, not with the next poll.
      !/session budget/.test(budgetUnder.totalTitle),
    JSON.stringify(budgetUnder),
  );
  await panel.set(costAt(0.6));
  await panel.set(costAt(0.7));
  const budgetCrossed = await panel.budget();
  check(
    'budget: crossing the limit while watching toasts once',
    budgetCrossed.toasts.length === 1 &&
      budgetCrossed.toasts[0] === 'Token Meter: this session reached your $0.5000 budget ($0.6000)' &&
      budgetCrossed.totalOver === 'true',
    JSON.stringify(budgetCrossed.toasts),
  );
  await panel.switchSession(costAt(0.9), 'ses_budget');
  await panel.wait(1200);
  const budgetOpened = await panel.budget();
  check(
    'budget: opening a session that is already over colours it without a toast',
    budgetOpened.toasts.length === 1 && budgetOpened.totalOver === 'true',
    `${budgetOpened.toasts.length} toasts, over ${budgetOpened.totalOver}`,
  );
  await panel.click('.budget-chip');
  await panel.wait(200);
  await panel.click(CLEAR);
  await panel.wait(300);
  const budgetCleared = await panel.budget();
  check(
    'budget: clearing removes the stored limits',
    budgetCleared.stored === null &&
      budgetCleared.chip === 'set budget' &&
      budgetCleared.totalOver === 'false' &&
      budgetCleared.chipOver === 'false' &&
      !/session budget/.test(budgetCleared.totalTitle),
    JSON.stringify(budgetCleared),
  );

  // --- robustness -----------------------------------------------------------
  // An exception inside a frame must not stop the frame loop: the headline,
  // the zoom and the reset clocks all live there. A step list with a hole in it
  // makes the bar easing throw on every frame; the next good answer must still
  // move the headline.
  const holeSteps = Array.from({ length: 30 }, (_, index) => ({
    aborted: false,
    at: Date.now() - (30 - index) * 10_000,
    cost: 0.001,
    ms: 2_000,
    tokens: 200,
    tps: 100,
  }));
  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 120 }, stepsSeq: 900, stepsKnown: 30, steps: holeSteps }));
  const beforeHole = await settle(panel, 'tps', '120');
  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 120 }, stepsSeq: 901, stepsKnown: 31, steps: [null, ...holeSteps] }));
  await panel.wheel('[data-chart="steps"]', -100);
  await panel.wait(400);
  await panel.set(state({ status: 'streaming', live: { ...state().live, tps: 40 }, stepsSeq: 902, stepsKnown: 30, steps: holeSteps }));
  const afterHole = await settle(panel, 'tps', '40');
  check(
    'panel keeps its frame loop through an exception in a frame',
    beforeHole.tps === '120' && afterHole.tps === '40',
    `${beforeHole.tps} -> ${afterHole.tps}`,
  );
  await panel.leave('[data-chart="steps"]');

  // The wheel eases the live window over a few frames; a reader who asked for
  // less motion gets the new window on the next frame.
  const easedPage = await run('panel');
  const easedAxis = await easedPage.wheelFrames('[data-chart="live"]', 100, 2);
  check('panel eases the live zoom by default', easedAxis !== '71 s ago' && /^6\d s ago$/.test(easedAxis ?? ''), String(easedAxis));
  await browser(['set', 'media', 'dark', 'reduced-motion']);
  const calm = await run('panel');
  const calmAxis = await calm.wheelFrames('[data-chart="live"]', 100, 2);
  const calmTransition = JSON.parse(
    await browser(['eval', `getComputedStyle(document.getElementById('f').contentDocument.querySelector('.subs-detail')).transitionDuration`]),
  );
  check(
    'panel snaps the zoom and the roster for a reader who asked for less motion',
    calmAxis === '71 s ago' && /^0s(, 0s)*$/.test(calmTransition),
    `${calmAxis} · transition ${calmTransition}`,
  );
  const calmCadence = await calm.chartCadence();
  check('panel respects reduced motion instead of continuously scrolling history', calmCadence.frames >= 10 && calmCadence.changed <= 2, JSON.stringify(calmCadence));
  const calmSlide = await calm.slideRate(500);
  check('panel does not slide the curve for a reader who asked for less motion', calmSlide.moves === 0, JSON.stringify(calmSlide));
  await browser(['set', 'media', 'dark']);

  // A short frame plus a busy roster used to squeeze the Steps block below its
  // content, so the axis and legend overflowed under the footer.
  const crowded = state({
    status: 'streaming',
    subagents: { active: [1, 2, 3, 4].map((i) => ({ id: `ses_over_${i}`, title: `child ${i}`, status: 'streaming', tps: 40 })), count: 4, loading: 4, partial: 0, running: 4, streaming: 4, tool: 0, members: [] },
    stepsSeq: 906,
    stepsKnown: 60,
    steps: Array.from({ length: 60 }, (_, i) => ({ aborted: false, at: Date.now() - (60 - i) * 2000, cost: 0.001, ms: 1500, tokens: 200, tps: 120 })),
  });
  await panel.set(crowded);
  await browser(['eval', `document.getElementById('f').style.height = '420px'`]);
  await panel.wait(500);
  const shortFrame = await panel.read();
  check(
    'the steps block never overflows onto the footer in a short frame',
    shortFrame.legendBottom !== null && shortFrame.footTop !== null && shortFrame.legendBottom <= shortFrame.footTop + 0.5,
    `legend ${shortFrame.legendBottom} vs foot ${shortFrame.footTop}`,
  );
  await browser(['eval', `document.getElementById('f').style.height = '900px'`]);

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
    'UI-20 the status frame keeps its own drawing',
    /IN/.test(sIdle.text) && !/API/.test(sIdle.text) && !/\$/.test(sIdle.text),
    sIdle.text.slice(0, 60),
  );
  // The service sends this section only the fields it draws. A reduced answer
  // must paint the same cells and spark: a field this frame still reads would
  // show up as a missing cell or an exception.
  const statusFull = state();
  await status.set(statusFull);
  const fullAnswerUi = await status.read();
  const reducedAnswer = { ...statusFull };
  for (const key of ['steps', 'seriesLong', 'seriesWide', 'subagents', 'cost', 'models', 'turn', 'rates', 'recording']) {
    delete reducedAnswer[key];
  }
  await status.set(reducedAnswer);
  const reducedUi = await status.read();
  const reducedErrors = await status.errors();
  check(
    'status paints the same from the reduced answer the service sends',
    reducedErrors.length === 0 &&
      reducedUi.cells.join(',') === fullAnswerUi.cells.join(',') &&
      reducedUi.values.join('|') === fullAnswerUi.values.join('|') &&
      Boolean(reducedUi.sparkD),
    `${reducedErrors.length} errors, ${reducedUi.values.join('|')} vs ${fullAnswerUi.values.join('|')}`,
  );
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

  // A finished recording's spark keeps the live clock too: it scrolls away
  // with time rather than freezing on an old end.
  const sparkEnd = Date.now() - 2 * 3_600_000;
  await status.set(
    state({
      generatedAt: Date.now(),
      recording: { state: 'saved', startedAt: sparkEnd - 600_000, endedAt: sparkEnd, lastSampleAt: sparkEnd - 250, error: null },
      series: { t0: sparkEnd - 59_750, step: 250, v: Array.from({ length: 240 }, () => 30) },
    }),
  );
  const oldSpark = await status.read();
  check('status treats an old recording as history, not a frozen graph', oldSpark.sparkD === null, String(oldSpark.sparkD).slice(0, 40));
  await status.set(state());

  // The dot as well: a generating session's breathing dot is not the next one's.
  await status.set(state({ status: 'streaming' }));
  const statusHot = await status.read();
  await status.delay(1500);
  await new Promise((resolve) => setTimeout(resolve, 620));
  await status.switchSession(state({ status: 'idle' }), 'ses_dot');
  const statusDot = await status.read();
  check(
    'status rests the dot the moment the session switches',
    statusHot.dotState === 'streaming' && statusDot.dotState === 'idle',
    `${statusHot.dotState} -> ${statusDot.dotState}`,
  );
  await status.delay(0);
  await new Promise((resolve) => setTimeout(resolve, 1800));

  const statusRise = await measureCurveRise(status);
  check('Work Status curve rises through intermediate heights alongside the eased number', statusRise.frames >= 6 && statusRise.heights >= 6, JSON.stringify(statusRise));
  const statusCadence = await status.chartCadence();
  check('Work Status curve follows display frames without pointer input', statusCadence.frames >= 10 && statusCadence.changed >= statusCadence.frames * 0.8, JSON.stringify(statusCadence));
  const statusHighRefresh = await status.fastFrames();
  check('Work Status curve draws on every 120 Hz callback', statusHighRefresh === 40, `${statusHighRefresh} draws / 40 frames`);
  // The spark is the same free-running loop: idle still scrolls it, at 5 fps.
  await status.set(state({ status: 'idle' }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const idleSparkDraws = await status.drawRate(1_000, '[data-chart="spark"] path[data-role="spark-line"]');
  check(
    'Work Status spark redraws about 5 times a second at idle, not on every frame',
    idleSparkDraws >= 4 && idleSparkDraws <= 10,
    `${idleSparkDraws} path writes in 1 s`,
  );

  await status.set({ ...state(), ok: false, error: 'OpenCode access is not available.' });
  await status.wait(400);
  const bannerUi = await status.read();
  const heights = await status.heights();
  check(
    'status grows its frame for an error banner instead of clipping the grid',
    heights.length > 0 && heights.at(-1) >= bannerUi.neededHeight - 1,
    `heights ${heights.join(',')} needed ${bannerUi.neededHeight}`,
  );
  await status.set(state());

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
