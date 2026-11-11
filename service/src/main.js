// Local service for the Token Meter extension.
// Reads the open session's usage from the OpenCode server the host is using,
// through the loopback proxy the host provides for `provides: ["opencode"]`.
// The panel never sees the URL or the token; it only asks this process.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  LIVE_TYPES,
  applyEvent,
  applyRecord,
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
// Watched sessions; each carries its own subagent tree.
const MAX_COLLECTORS = 6;
// `?parentID=` answers the children of one session in a few KB, so the tree can
// be kept fresh without scanning every session on the machine.
const LINEAGE_MS = 30_000;
const LINEAGE_RETRY_MS = 60_000;
const LINEAGE_DEPTH = 4;
const MAX_SUBAGENTS = 40;
const SUBAGENT_HISTORY_RETRY_MS = 15_000;
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
    }
    collector.touchedAt = Date.now();
    collector.watched = true;
    collector.watchedAt = collector.touchedAt;
    // Only watched sessions count against the limit; a subagent exists because
    // its parent is watched and leaves with it.
    const watched = [...collectors.values()].filter((item) => item.watched);
    if (watched.length > MAX_COLLECTORS) {
      // Never drop a session that is streaming, or one whose subagent is: it is
      // the tree the user is watching.
      const idle = watched
        .filter(
          (item) =>
            item !== collector &&
            !item.turnActive &&
            !treeOf(item).some((member) => member.status === 'streaming'),
        )
        .sort((a, b) => a.watchedAt - b.watchedAt)[0];
      if (idle) dropTree(idle);
    }
    void refreshLineage(collector);
    void readTurnStart(collector);
    return collector;
  };

  /**
   * The watched session followed by every collector below it. A subagent's own
   * session names its parent, so the tree is walked from the parent ids the
   * service already holds; no extra read happens per poll.
   */
  const treeOf = (root) => {
    const tree = [root];
    const seen = new Set([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const collector of collectors.values()) {
        if (!collector.parentId || seen.has(collector.id) || !seen.has(collector.parentId)) continue;
        seen.add(collector.id);
        tree.push(collector);
        grew = true;
      }
    }
    return tree;
  };

  /** Drop a watched session and the subagents that only existed for it. */
  const dropTree = (root) => {
    for (const member of treeOf(root)) {
      // A subagent the user also has open keeps its own collector; it simply
      // becomes a root of its own.
      if (member !== root && member.watched) {
        member.parentId = null;
        continue;
      }
      collectors.delete(member.id);
    }
  };

  const watchedRoots = () => [...collectors.values()].filter((collector) => collector.watched);

  const ensureSubagent = (id, record, parentId) => {
    let collector = collectors.get(id);
    if (!collector) {
      collector = createCollector(id);
      collector.parentId = parentId ?? record?.parentID ?? null;
      collectors.set(id, collector);
    } else if (!collector.parentId) {
      collector.parentId = parentId ?? record?.parentID ?? null;
    }
    if (record) applyRecord(collector, record);
    collector.touchedAt = Date.now();
    return collector;
  };

  /**
   * Ask OpenCode for the children of a session, then of each child: subagents
   * can spawn subagents. A read costs a few KB and is throttled, so the tree is
   * correct for sessions that finished before the meter was opened too.
   */
  const refreshLineage = async (root) => {
    if (!base || !upstreamIsLoopback || root.lineageLoading) return;
    const now = Date.now();
    if (root.lineageAt && now - root.lineageAt < LINEAGE_MS) return;
    if (root.lineageTriedAt && now - root.lineageTriedAt < LINEAGE_RETRY_MS) return;
    root.lineageLoading = true;
    root.lineageTriedAt = now;
    try {
      const queue = [{ id: root.id, depth: 0 }];
      const seen = new Set();
      let found = 0;
      while (queue.length && found < MAX_SUBAGENTS) {
        const { id, depth } = queue.shift();
        if (depth > LINEAGE_DEPTH) continue;
        const answer = await apiGet(`/api/session?parentID=${encodeURIComponent(id)}&limit=200`);
        // The panel may have moved on and dropped this tree while the read was
        // in flight; its subagents must not outlive it.
        if (!collectors.has(root.id)) return;
        for (const record of Array.isArray(answer?.data) ? answer.data : []) {
          if (!record?.id || record.id === root.id || seen.has(record.id)) continue;
          seen.add(record.id);
          found += 1;
          ensureSubagent(record.id, record, id);
          queue.push({ id: record.id, depth: depth + 1 });
          if (found >= MAX_SUBAGENTS) break;
        }
      }
      root.lineageAt = Date.now();
      root.lineageTriedAt = 0;
    } catch (error) {
      log(`token-meter: could not read the subagents of ${root.id}: ${error?.message ?? error}`);
    } finally {
      root.lineageLoading = false;
    }
  };

  /**
   * A session that is not in any watched tree yet sent an event. Place it by
   * its parent chain, so a subagent created after the last lineage read shows
   * up on its own instead of waiting for the next one. Unknown sessions that
   * belong to nobody watched are remembered and not read again for a minute.
   */
  const learning = new Set();
  const missedAt = new Map();
  const learnSession = async (id) => {
    if (!base || !upstreamIsLoopback || learning.has(id) || watchedRoots().length === 0) return;
    const now = Date.now();
    if (missedAt.has(id) && now - missedAt.get(id) < LINEAGE_RETRY_MS) return;
    learning.add(id);
    try {
      const chain = [];
      let cursor = id;
      let attached = false;
      for (let depth = 0; depth <= LINEAGE_DEPTH; depth += 1) {
        const record = (await apiGet(`/api/session/${encodeURIComponent(cursor)}`))?.data;
        if (!record?.id) break;
        chain.push(record);
        const parentId = record.parentID;
        if (!parentId) break;
        if (collectors.has(parentId)) {
          attached = true;
          break;
        }
        cursor = parentId;
      }
      if (!attached) {
        if (missedAt.size > 500) missedAt.clear();
        missedAt.set(id, Date.now());
        return;
      }
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        ensureSubagent(chain[index].id, chain[index], chain[index].parentID);
      }
      missedAt.delete(id);
    } catch (error) {
      if (missedAt.size > 500) missedAt.clear();
      missedAt.set(id, Date.now());
      log(`token-meter: could not place ${id}: ${error?.message ?? error}`);
    } finally {
      learning.delete(id);
    }
  };

  /**
   * The last user message starts the current (or last) turn. A collector opened
   * mid-turn never saw `session.execution.started`, so its last-turn cost has no
   * boundary; the message's own time gives one. A live turn start is later and
   * is kept. Failure is logged, not fatal: the cost cell shows a dash.
   */
  const readTurnStart = async (collector, force = false) => {
    if (!base || !upstreamIsLoopback || collector.turnStartLoading) return;
    const now = Date.now();
    if (!force && collector.turnStartedAt) return;
    if (now - collector.turnStartTriedAt < LINEAGE_RETRY_MS) return;
    collector.turnStartLoading = true;
    collector.turnStartTriedAt = now;
    try {
      const answer = await apiGet(`/api/session/${encodeURIComponent(collector.id)}/message?type=user&limit=1&order=desc`);
      const created = answer?.data?.[0]?.time?.created;
      if (typeof created === 'number' && created > collector.turnStartedAt) collector.turnStartedAt = created;
    } catch (error) {
      log(`token-meter: could not read the turn start of ${collector.id}: ${error?.message ?? error}`);
    } finally {
      collector.turnStartLoading = false;
    }
  };

  const dispatch = (event) => {
    if (!wantsEvent(event?.type)) return;
    const sessionId = event?.data?.sessionID;
    if (sessionId) {
      const collector = collectors.get(sessionId);
      if (collector) applyEvent(collector, event);
      else void learnSession(sessionId);
      return;
    }
    // A form may name its session only inside the form itself.
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
    for (const collector of watchedRoots()) {
      if (now - collector.watchedAt > COLLECTOR_TTL_MS) {
        dropTree(collector);
        continue;
      }
      const tree = treeOf(collector);
      // Keep sampling while the panel asks for answers, and while any subagent
      // is still streaming: the curve must not freeze the moment the parent
      // goes quiet and hands its turn to a child.
      if (now - collector.watchedAt > HOT_MS && !tree.some((member) => member.status === 'streaming')) continue;
      tick(collector, now, tree);
      void refreshLineage(collector);
      for (const member of tree) {
        // A subagent's history is read for the step chart; its totals come from
        // OpenCode's usage record, which is exact and cheaper. Never load a
        // half-finished step: wait for the child to go quiet.
        const mayLoad =
          member !== collector &&
          member.historyAt === 0 &&
          !member.loading &&
          !member.turnActive &&
          member.status !== 'streaming' &&
          now - member.historyTriedAt >= SUBAGENT_HISTORY_RETRY_MS;
        if (mayLoad) void loadHistory(member, apiGet, 0, { stepsOnly: true });
      }
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
      // A turn start missed while the stream was down is corrected with the
      // same slow cadence as the history.
      if (stale) void readTurnStart(collector, true);
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
      const tree = treeOf(collector);
      tick(collector, now, tree);
      const answer = snapshot(collector, now, tree);
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
