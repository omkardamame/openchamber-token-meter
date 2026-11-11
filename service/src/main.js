// Local service for the Token Meter extension.
// Reads the open session's usage from the OpenCode server the host is using,
// through the loopback proxy the host provides for `provides: ["opencode"]`.
// The panel never sees the URL or the token; it only asks this process.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  LIVE_TYPES,
  applyEvent,
  createCollector,
  loadHistory,
  snapshot,
  tick,
  wantsEvent,
} from './collector.js';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const BASE = process.env.OPENCHAMBER_OPENCODE_URL ?? '';

const STREAM_MAX_MS = 55_000;
const STREAM_RETRY_MS = 2_000;
// A clean close (server restart, idle eviction) must not turn into a busy loop.
const STREAM_REOPEN_MS = 300;
const API_TIMEOUT_MS = 8_000;
// Re-reading a session's history every 20 s cost up to 800 messages a turn and
// could drag the totals back while a step was still in flight.
const HISTORY_RECONCILE_MS = 300_000;
const FIRST_LOAD_BUDGET_MS = 6_000;
const HOT_MS = 30_000;
const COLLECTOR_TTL_MS = 10 * 60_000;
const MAX_COLLECTORS = 6;
const TICK_MS = 250;

if (!PORT || !TOKEN) {
  console.error('token-meter: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

export function createService({ fetchImpl = fetch, log = () => {}, base = BASE, token = TOKEN, port = PORT } = {}) {
  const collectors = new Map();
  const state = { stream: 'idle', streamError: null, stopping: false, controller: null, since: Date.now() };

  const upstreamIsLoopback = (() => {
    try {
      const host = new URL(base).hostname;
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    } catch {
      return false;
    }
  })();

  // `types` narrows the subscription so the machine's other sessions and its
  // tool chatter never reach this process. One event type the service handles
  // is not subscribable, and any unknown value makes the whole request a 400,
  // so the list is explicit and the stream falls back to unfiltered on a 400.
  const subscribeTypes = [...LIVE_TYPES].filter((type) => type !== 'session.usage.recorded');
  let filterStream = true;

  const apiGet = async (path) => {
    if (!base) throw new Error('OpenCode access is not available');
    if (!upstreamIsLoopback) throw new Error('OpenCode access is not on loopback; refusing to send the token');
    const answer = await fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(API_TIMEOUT_MS) } : {}),
    });
    if (!answer.ok) throw new Error(`OpenCode answered ${answer.status}`);
    return answer.json();
  };

  const authorized = (header) => {
    if (!token) return true;
    const given = Buffer.from(String(header ?? ''));
    const expected = Buffer.from(`Bearer ${token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const getCollector = (id) => {
    let collector = collectors.get(id);
    if (!collector) {
      collector = createCollector(id);
      collectors.set(id, collector);
      if (collectors.size > MAX_COLLECTORS) {
        // Never drop a session that is streaming: it is the one being watched.
        const idle = [...collectors.entries()]
          .filter(([, item]) => !item.turnActive)
          .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
        if (idle) collectors.delete(idle[0]);
      }
    }
    collector.touchedAt = Date.now();
    return collector;
  };

  const dispatch = (event) => {
    if (!wantsEvent(event?.type)) return;
    for (const collector of collectors.values()) applyEvent(collector, event);
  };

  async function consume(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    let warnedBadPayload = false;
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch (error) {
          if (!warnedBadPayload) {
            warnedBadPayload = true;
            log(`token-meter: an event payload was not JSON: ${error.message}`);
          }
          continue;
        }
        dispatch(event);
      }
      if (buffer.length > 4_000_000) buffer = '';
    }
  }

  async function streamLoop() {
    while (!state.stopping) {
      if (!base || !upstreamIsLoopback) {
        state.stream = 'off';
        state.streamError = 'OpenCode access is not available';
        await sleep(5_000);
        continue;
      }
      const controller = new AbortController();
      state.controller = controller;
      state.stream = 'connecting';
      let cutByOurTimer = false;
      const timer = setTimeout(() => {
        cutByOurTimer = true;
        controller.abort();
      }, STREAM_MAX_MS);
      try {
        // Ask only for the events this service reads: the stream carries tool
        // progress and shell chatter for every session on the machine.
        const streamUrl = new URL(`${base}/api/event`);
        if (filterStream) for (const type of subscribeTypes) streamUrl.searchParams.append('types', type);
        const answer = await fetchImpl(streamUrl.toString(), {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!answer.ok) {
          if (answer.status === 400 && filterStream) {
            filterStream = false;
            log('token-meter: the server refused the event filter; reading the unfiltered stream');
          }
          throw new Error(`event stream answered ${answer.status}`);
        }
        if (!answer.body) throw new Error('event stream answered without a body');
        state.stream = 'open';
        state.streamError = null;
        await consume(answer.body);
      } catch (error) {
        if (!state.stopping && !cutByOurTimer) {
          state.stream = 'retrying';
          state.streamError = error?.message ? String(error.message) : String(error);
          log('token-meter: event stream', state.streamError);
        }
      } finally {
        clearTimeout(timer);
        state.controller = null;
      }
      if (state.stopping) break;
      if (!cutByOurTimer && state.stream === 'retrying') await sleep(STREAM_RETRY_MS);
      else await sleep(STREAM_REOPEN_MS);
    }
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const [id, collector] of collectors) {
      if (now - collector.touchedAt > COLLECTOR_TTL_MS) {
        collectors.delete(id);
        continue;
      }
      if (now - collector.touchedAt <= HOT_MS || collector.status === 'streaming') tick(collector, now);
    }
  }, TICK_MS);
  ticker.unref?.();

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      // A failed route is a bug in this process, not a quiet 200.
      log(`token-meter: ${req.method} ${req.url} failed: ${error?.message ?? error}`);
      // The caller may be gone by now: a write on a closed socket is the one
      // failure that would take the whole service down.
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      else res.destroy();
    });
  });

  async function handle(req, res) {
    if (!authorized(req.headers.authorization)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'only GET is served' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      json(res, 200, { ok: true, pid: process.pid, upstream: Boolean(base), stream: state.stream });
      return;
    }
    if (url.pathname === '/state') {
      const session = url.searchParams.get('session') ?? '';
      if (!/^ses[\w-]{1,120}$/.test(session)) {
        json(res, 400, { ok: false, error: 'session is required' });
        return;
      }
      const collector = getCollector(session);
      const first = collector.historyAt === 0;
      if (!base || !upstreamIsLoopback) {
        json(res, 200, {
          ...snapshot(collector),
          ok: false,
          error: !base
            ? 'OpenCode access is not available. Approve the extension in Settings → Extensions.'
            : 'OpenCode access is not on loopback; refusing to send the token.',
          stream: { state: 'off', error: state.streamError },
          loading: false,
        });
        return;
      }
      const now = Date.now();
      // Only reconcile while the session is quiet: a rebuild during a turn would
      // count a half-finished step and make the totals dip. A failed read waits
      // 15 s, so a broken upstream is not hammered once per poll.
      const stale = now - collector.historyAt > HISTORY_RECONCILE_MS && !collector.turnActive;
      const mayLoad =
        !collector.loading &&
        now - collector.historyTriedAt >= (collector.error ? 15_000 : 0) &&
        (first || stale);
      if (mayLoad) {
        const run = loadHistory(collector, apiGet, first ? now + FIRST_LOAD_BUDGET_MS : 0);
        if (first) await run;
      } else if (first && collector.loading) {
        await collector.loading;
      }
      tick(collector);
      const answer = snapshot(collector);
      // The step list changes once per step; a client that already has this
      // sequence keeps its copy instead of receiving the same rows again.
      if (url.searchParams.get('steps') === String(answer.stepsSeq)) delete answer.steps;
      json(res, 200, {
        ...answer,
        stream: { state: state.stream, error: state.streamError, since: state.since },
        loading: Boolean(collector.loading),
      });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  return {
    server,
    start() {
      server.listen(port, '127.0.0.1');
      void streamLoop();
      return server;
    },
    stop() {
      state.stopping = true;
      clearInterval(ticker);
      state.controller?.abort();
      server.close();
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isMain = process.argv[1] && process.argv[1].endsWith('main.js') && !process.env.TOKEN_METER_NO_LISTEN;
if (isMain) {
  const service = createService({ log: (message) => console.error(message) });
  service.start().on('listening', () => console.error(`token-meter: service on 127.0.0.1:${PORT}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      service.stop();
      process.exit(0);
    });
  }
}
