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
    series: { t0: Date.now() - 5000, step: 250, v: [30, 34, 36] },
    stepsSeq: 3,
    steps: [
      { tokens: 1100, ms: 7800, tps: 141, aborted: false },
      { tokens: 900, ms: 5000, tps: 180, aborted: false },
    ],
    rates: { avg: 79, peak: 334 },
    stream: { state: 'open' },
    loading: false,
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
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    posts.push(message.type);
    const reply = (payload) => frame.contentWindow.postMessage({ channel: CHANNEL, v: V, type: 'result', id: message.id, ok: true, payload }, '*');
    if (message.type === 'hello') {
      frame.contentWindow.postMessage({
        channel: CHANNEL, v: V, type: 'ready',
        payload: {
          session: { id: 'ses_page', title: 'page test', busy: false },
          surface: 'status',
          connection: { connected: true, account: null },
          settings: {},
          locale: 'en',
          theme: { mode: 'dark', tokens: {} },
          features: {},
        },
      }, '*');
      return;
    }
    if (message.type === 'service-request') {
      const answer = window.__answer ? window.__answer(message.payload) : { status: 200, body: JSON.stringify(window.__state) };
      reply(answer);
      return;
    }
    if (message.type === 'set-height') return;
  });
  window.__setState = (next) => { window.__state = next; };
  window.__state = __STATE__;
  window.__read = () => {
    const doc = frame.contentDocument;
    const text = doc.body.innerText.replace(/\\s+/g, ' ').trim();
    const dot = doc.querySelector('.dot');
    return {
      text,
      dotState: dot ? dot.getAttribute('data-state') : null,
      cells: [...doc.querySelectorAll('.cell-label')].map((n) => n.textContent),
      values: [...doc.querySelectorAll('.cell-value')].map((n) => n.textContent.trim()),
      tps: (doc.querySelector('.tps-value') || doc.querySelector('.tps') || {}).textContent,
      bars: doc.querySelectorAll('[data-chart="steps"] rect').length,
      stepSvg: (doc.querySelector('[data-chart="steps"]') || {}).innerHTML ?? '',
      labels: [...doc.querySelectorAll('svg text')].map((n) => n.textContent),
    };
  };
</script>`;

const scenario = (page, answer) =>
  harness.replace('/__page', `/package/${page}`).replace('__STATE__', JSON.stringify(answer));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/panel' || url.pathname === '/status') {
    const page = url.pathname === '/panel' ? 'panel/index.html' : 'status/index.html';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(scenario(page, state()));
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
  };
};

try {
  // --- the panel -----------------------------------------------------------
  const panel = await run('panel');
  const idle = await panel.read();
  check('panel draws all eight cells', idle.cells.join(',') === 'In,Out,Think,Total out,Cache,Cache hit,TTFT,Consumed', idle.cells.join(','));
  check('panel draws the consumed total', idle.values.some((v) => v.startsWith('49.2M')), idle.values.join(' | '));
  check('panel draws the measured ttft', idle.values.some((v) => v.includes('6.5 s')), idle.values.join(' | '));
  check('panel labels the average and the peak', idle.labels.some((l) => l.startsWith('avg 79')) && idle.labels.some((l) => l.startsWith('peak 334')), idle.labels.join(' | '));
  check('panel shows the last measured step', /last 33 t\/s/.test(idle.text), idle.text.slice(0, 60));
  check('panel sits on a dim dot when idle', idle.dotState === 'idle', String(idle.dotState));

  await panel.set(state({ status: 'streaming' }));
  const streaming = await panel.read();
  check('panel draws the live rate while generating', streaming.tps === '36', String(streaming.tps));
  check('panel breathes the dot while generating', streaming.dotState === 'streaming', String(streaming.dotState));

  // an answer that leaves the step list off must keep the bars already drawn
  const cached = state({ status: 'streaming' });
  delete cached.steps;
  await panel.set(cached);
  const reused = await panel.read();
  check('panel keeps its bars when the list is omitted', reused.bars > 0, `${reused.bars} bars`);

  await panel.set(state({ status: 'tool' }));
  const tool = await panel.read();
  check('panel says a tool is running', /a tool is running/.test(tool.text), tool.text.slice(0, 60));
  check('panel glows orange for a tool', tool.dotState === 'tool', String(tool.dotState));

  // a parent whose subagent is generating: the headline is the tree's
  const subState = (over = {}) => {
    const base = state();
    return {
      ...base,
      status: 'streaming',
      live: { ...base.live, tps: 41, subagent: true, lastStep: { ...base.live.lastStep, sub: true } },
      subagents: { count: 2, streaming: 1, tool: 0 },
      steps: [{ tokens: 500, ms: 2000, tps: 250, aborted: false, sub: true }],
      ...over,
    };
  };
  await panel.set(subState());
  const subagent = await panel.read();
  check('panel names the subagent behind the rate', /a subagent is generating/.test(subagent.text), subagent.text.slice(0, 90));
  check('panel says how many subagents are in the totals', /2 subagents/.test(subagent.text), subagent.text.slice(0, 90));
  check('panel marks the last step as a subagent’s', /last 33 t\/s .*subagent/.test(subagent.text), subagent.text.slice(-90));
  check('panel draws a subagent step differently', /subagent ·/.test(subagent.stepSvg) && subagent.bars === 1, `${subagent.bars} bars`);
  check('panel breathes the dot while a subagent generates', subagent.dotState === 'streaming', String(subagent.dotState));
  await panel.set(subState({ status: 'tool' }));
  const subTool = await panel.read();
  check('panel says the subagent is running a tool', /a subagent is running a tool/.test(subTool.text), subTool.text.slice(0, 90));

  await panel.set({ ok: false, error: 'OpenCode access is not available.', totals: null });
  const broken = await panel.read();
  check('panel explains a refused answer', /cannot read this session/.test(broken.text), broken.text.slice(0, 70));
  check('panel runs without an exception', (await panel.errors()).length === 0, (await panel.errors()).join(' | '));

  // --- the Work Status section --------------------------------------------
  const status = await run('status');
  const sIdle = await status.read();
  check('status draws all eight cells', sIdle.cells.join(',') === 'In,Out,Think,Total out,Cache,Cache hit,TTFT,Consumed', sIdle.cells.join(','));
  check('status draws the consumed total', sIdle.values.some((v) => v.startsWith('49.2M')), sIdle.values.join(' | '));
  check('status shows the last measured step', /last 33 t\/s/.test(sIdle.text), sIdle.text.slice(0, 60));

  await status.set(state({ status: 'streaming' }));
  const sStreaming = await status.read();
  check('status draws the live rate while generating', sStreaming.tps === '36', String(sStreaming.tps));
  check('status breathes the dot while generating', sStreaming.dotState === 'streaming', String(sStreaming.dotState));

  const statusBase = state();
  await status.set({
    ...statusBase,
    status: 'streaming',
    live: { ...statusBase.live, tps: 41, subagent: true, lastStep: { ...statusBase.live.lastStep, sub: true } },
    subagents: { count: 2, streaming: 1, tool: 0 },
  });
  const sSub = await status.read();
  check('status says how many subagents are included', /2 subagents/.test(sSub.text), sSub.text.slice(0, 80));
  check('status marks a subagent step', /last 33 t\/s · sub/.test(sSub.text), sSub.text.slice(0, 80));
  check('status keeps the first-token wait beside the subagents', /2 subagents · first token 6\.5 s/.test(sSub.text), sSub.text.slice(0, 80));
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
