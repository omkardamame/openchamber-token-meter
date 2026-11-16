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
  tickFinal,
  wantsEvent,
} from './collector.js';
import { PRICE_BOOK } from '../../shared/price-book.js';
import { loadPriceOverrides, priceOverrideFile } from './prices.js';
import { createRecordingStore } from './recordings.js';

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
// Every subagent costs one read per lineage pass, so this is a ceiling on
// requests, not on the tree: 200 covers any real tree and still bounds a run
// away tree. "Unlimited" would let one session hold the service open.
const MAX_SUBAGENTS = 200;
// The same hour the roster uses: past it, a child is not walked or listed.
const MAX_SUBAGENT_AGE_MS = 60 * 60_000;
const SUBAGENT_HISTORY_RETRY_MS = 15_000;
const TICK_MS = 250;
const MAX_RECORDINGS = 200;
const RECORDING_SAVE_MS = 5_000;
// Test seam only: the suites shorten the scan instead of waiting 30 s.
const RECORDING_SCAN_MS = Math.max(100, Number(process.env.TOKEN_METER_SCAN_MS) || 30_000);
// A record nobody has touched for this long is history, not a running turn.
// Discovery uses it to avoid resurrecting a graph from a stale busy flag.
const DISCOVERY_FRESH_MS = 10 * 60_000;
// A record older than this cannot prove a turn is still running: OpenCode keeps
// `busy` after a turn when the idle event was missed or the service restarted.
const RECORD_FRESH_MS = Math.max(50, Number(process.env.TOKEN_METER_RECORD_FRESH_MS) || 15_000);
// An unopened session only feeds the live curve; opening it loads the full
// thousand-step history. Keeping that history for every remembered session
// would cost far more memory than the graph it draws.
const AUTO_STEPS = 120;

if (!PORT || !TOKEN) {
  console.error('token-meter: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

export function createService({ fetchImpl = fetch, log = () => {}, base = BASE, token = TOKEN, port = PORT, priceBook = PRICE_BOOK, overrides = null, dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? null } = {}) {
  const collectors = new Map();
  const state = { stream: 'idle', streamError: null, stopping: false, controller: null, since: Date.now() };
  // Prices are a committed snapshot plus an optional hand-written correction.
  // Both are read once, here: no watcher, no per-poll file read.
  const priceOverrides = overrides ?? loadPriceOverrides({ file: priceOverrideFile(dataDir), log });
  const recordings = createRecordingStore({ dataDir, log, maxSessions: MAX_RECORDINGS });
  // A session-lifetime base for `stepsSeq`: a recreated collector must not
  // reproduce a token the frame already holds with different content.
  let seqEpoch = 0;
  const SEQ_STRIDE = 1_000_000;
  let captureError = null;
  let captureWarnAt = 0;
  let discoveryLoading = false;
  const WORKING_STATES = new Set(['streaming', 'tool', 'waiting-permission', 'waiting-question']);
  const working = (member) => Boolean(member.turnActive || WORKING_STATES.has(member.status));
  const makeCollector = (id) => {
    const collector = createCollector(id);
    collector.seqEpoch = (++seqEpoch) * SEQ_STRIDE;
    const saved = recordings.get(id);
    collector.captureStartedAt = saved?.startedAt ?? null;
    collector.captureEndedAt = saved?.endedAt ?? null;
    collector.capturePendingRecord = Boolean(saved && !saved.endedAt);
    if (saved) {
      collector.series = saved.series;
      collector.seriesLong = saved.seriesLong;
      collector.seriesWide = saved.seriesWide;
    }
    return collector;
  };
  const applyCaptureRecord = (collector, record) => {
    // A record read can finish after newer SSE lifecycle events. Its counters
    // are still useful, but its stale busy flag must not resurrect a finished
    // recording or interrupt a new turn.
    // Trust is directional: a record may always settle a turn (it says idle),
    // but only a live event or a fresh record that claims busy may start one.
    // A stale `busy` is OpenCode keeping the flag after the turn, and a stale
    // record must never pin a graph "live" forever either.
    const recordAt = record?.time?.updated ?? record?.time?.created ?? null;
    const saysWorking = Boolean(record?.time?.busy && (!record?.time?.idle || record.time.busy > record.time.idle));
    const newerEvents = recordAt !== null && (collector.captureEventAt ?? 0) > recordAt;
    const preserveLive =
      newerEvents ||
      (saysWorking && (collector.capturePendingRecord || (recordAt !== null && recordAt <= Date.now() - RECORD_FRESH_MS)));
    const liveState = preserveLive ? {
      status: collector.status, turnActive: collector.turnActive, stream: collector.stream,
      pendingTools: collector.pendingTools, model: collector.model, provider: collector.provider,
    } : null;
    applyRecord(collector, record);
    if (liveState) Object.assign(collector, liveState);
    if (record?.parentID && record.parentID !== collector.id && collector.parentId !== record.parentID) {
      collector.parentId = record.parentID;
      reindex();
    }
    collector.capturePendingRecord = false;
    collector.captureRecordKnown = true;
    if (typeof record?.time?.idle === 'number') collector.captureFinishedAt = Math.max(collector.captureFinishedAt ?? 0, record.time.idle);
    if (working(collector)) collector.captureEndedAt = null;
  };

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
    if (!answer.ok) {
      const error = new Error(`OpenCode answered ${answer.status}`);
      error.status = answer.status;
      throw error;
    }
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
      collector = makeCollector(id);
      collectors.set(id, collector);
      reindex();
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
            !treeOf(item).some(working),
        )
        .sort((a, b) => a.watchedAt - b.watchedAt)[0];
      if (idle) dropTree(idle);
    }
    void refreshLineage(collector);
    void readTurnStart(collector);
    // A recording restored as active may have finished while the service was
    // down; its own record settles the status the stream cannot replay.
    if (collector.capturePendingRecord) void learnSession(id);
    return collector;
  };

  /**
   * The watched session followed by every collector below it. A subagent's own
   * session names its parent, so the tree is walked from the parent ids the
   * service already holds; no extra read happens per poll.
   */
  let childIndex = null;
  // Any insert, delete or re-parent invalidates the cached index. Sessions are
  // created and dropped rarely; the tick reads trees four times a second.
  const reindex = () => {
    childIndex = null;
  };
  const treeOf = (root) => {
    if (!childIndex) {
      childIndex = new Map();
      for (const collector of collectors.values()) {
        if (!collector.parentId) continue;
        const siblings = childIndex.get(collector.parentId);
        if (siblings) siblings.push(collector);
        else childIndex.set(collector.parentId, [collector]);
      }
    }
    const tree = [root];
    const seen = new Set([root.id]);
    const queue = [root];
    while (queue.length) {
      for (const child of childIndex.get(queue.pop().id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        tree.push(child);
        queue.push(child);
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
        reindex();
        continue;
      }
      recordings.capture(member, Date.now());
      collectors.delete(member.id);
      reindex();
    }
  };

  const watchedRoots = () => [...collectors.values()].filter((collector) => collector.watched);

  const ensureSubagent = (id, record, parentId) => {
    let collector = collectors.get(id);
    if (!collector) {
      collector = makeCollector(id);
      collector.parentId = parentId ?? record?.parentID ?? null;
      collectors.set(id, collector);
      reindex();
    } else if (!collector.parentId && (parentId ?? record?.parentID ?? null)) {
      collector.parentId = parentId ?? record?.parentID ?? null;
      reindex();
    }
    if (record) applyCaptureRecord(collector, record);
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
      // The root's own record is the only status source after a missed event:
      // the event stream is cut every 55 s and a child's record is re-read every
      // 30 s, but the root's was not. Read it alongside the children so a slow
      // record cannot delay the subagent scan.
      const own = apiGet(`/api/session/${encodeURIComponent(root.id)}`).catch((error) => {
        log(`token-meter: could not read ${root.id}: ${error?.message ?? error}`);
        return null;
      });
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
          // A child that has been quiet for an hour is not part of this tree any
          // more; walking it would cost a read per pass for a tombstone. One we
          // already hold is left alone — it may still be the session on screen.
          const quietSince = record.time?.updated ?? record.time?.created ?? 0;
          if (!collectors.has(record.id) && quietSince && Date.now() - quietSince > MAX_SUBAGENT_AGE_MS) continue;
          seen.add(record.id);
          found += 1;
          ensureSubagent(record.id, record, id);
          queue.push({ id: record.id, depth: depth + 1 });
          if (found >= MAX_SUBAGENTS) break;
        }
      }
      const ownAnswer = await own;
      if (ownAnswer?.data) applyCaptureRecord(root, ownAnswer.data);
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
  // Learn lineage after attaching the event immediately. Waiting for an HTTP
  // record used to discard every early delta of a session with no panel open.
  const automaticCollector = (id) => {
    if (!/^ses[\w-]{1,120}$/.test(id)) return null;
    if (collectors.has(id)) return collectors.get(id);
    if (collectors.size >= MAX_RECORDINGS) {
      const oldest = [...collectors.values()].filter((item) => !item.watched && !treeOf(item).some(working))
        .sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (oldest) dropTree(oldest);
      else {
        captureError = `automatic graph recording reached ${MAX_RECORDINGS} simultaneous sessions`;
        if (Date.now() - captureWarnAt > RECORDING_SCAN_MS) {
          captureWarnAt = Date.now();
          log(`token-meter: ${captureError}`);
        }
        return null;
      }
    }
    captureError = null;
    const collector = makeCollector(id);
    collectors.set(id, collector);
    return collector;
  };
  const learnSession = async (id) => {
    if (state.stopping || !base || !upstreamIsLoopback || learning.has(id)) return;
    const now = Date.now();
    if (missedAt.has(id) && now - missedAt.get(id) < LINEAGE_RETRY_MS) return;
    learning.add(id);
    try {
      let cursor = id;
      const seen = new Set();
      let learned = false;
      for (let depth = 0; depth <= LINEAGE_DEPTH; depth += 1) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const record = (await apiGet(`/api/session/${encodeURIComponent(cursor)}`))?.data;
        if (state.stopping) return;
        if (!record?.id) break;
        learned = true;
        const member = automaticCollector(record.id);
        if (!member) break;
        member.captureLastCheckedAt = Date.now();
        applyCaptureRecord(member, record);
        const parentId = record.parentID;
        if (!parentId) break;
        if (collectors.has(parentId)) break;
        cursor = parentId;
      }
      if (learned) missedAt.delete(id);
      else {
        if (missedAt.size > 500) missedAt.clear();
        missedAt.set(id, Date.now());
      }
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
    if (state.stopping || !wantsEvent(event?.type)) return;
    const sessionId = event?.data?.sessionID ?? event?.data?.form?.sessionID;
    if (sessionId) {
      const existed = collectors.has(sessionId);
      const collector = automaticCollector(sessionId);
      if (!collector) return;
      // A service opened mid-step may first see a delta, not a step-start.
      if (!existed && /^session\.(text|reasoning|tool\.input)\./.test(event.type)) {
        collector.status = 'streaming';
        collector.turnActive = true;
      }
      collector.touchedAt = Date.now();
      collector.captureEventAt = Math.max(collector.captureEventAt ?? 0, typeof event.created === 'number' ? event.created : Date.now());
      if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) collector.captureFinishedAt = collector.captureEventAt;
      collector.capturePendingRecord = false;
      applyEvent(collector, event);
      if (working(collector)) collector.captureEndedAt = null;
      if (!collector.captureStartedAt || !working(collector)) sampleCollector(collector, Date.now(), treeOf(collector));
      if (!collector.captureRecordKnown) void learnSession(sessionId);
      return;
    }
    // A form may name its session only inside the form itself.
    for (const collector of collectors.values()) applyEvent(collector, event);
  };

  // Bootstrap sessions already running when OpenChamber starts. SSE remains
  // the primary source; this bounded scan also recovers after a stream outage.
  const discoverRunning = async () => {
    if (discoveryLoading || state.stopping || !base || !upstreamIsLoopback) return;
    discoveryLoading = true;
    try {
      const answer = await apiGet(`/api/session?limit=${MAX_RECORDINGS}`);
      if (state.stopping) return;
      const rows = Array.isArray(answer?.data) ? answer.data : [];
      const listed = new Set(rows.map((record) => record?.id));
      for (const record of rows) {
        const busy = record?.time?.busy;
        const idle = record?.time?.idle;
        const known = collectors.get(record?.id);
        if (!known && !(busy && (!idle || busy > idle))) continue;
        // Only a freshly updated record can start a graph for a chat we have
        // never seen: OpenCode can retain `busy` after the turn is over.
        if (!known && !(record?.time?.updated > Date.now() - DISCOVERY_FRESH_MS)) continue;
        const collector = known ?? automaticCollector(record.id);
        if (!collector) continue;
        collector.captureLastCheckedAt = Date.now();
        applyCaptureRecord(collector, record);
        if (record.parentID && !collectors.has(record.parentID)) void learnSession(record.id);
      }
      // A busy chat can fall off the recent list or be deleted while the event
      // stream is disconnected. Recheck a bounded batch instead of retaining
      // zombie "active" collectors forever and exhausting the recording cap.
      const unseen = [...collectors.values()].filter((item) => (working(item) || item.capturePendingRecord) && !listed.has(item.id))
        .sort((a, b) => (a.captureLastCheckedAt ?? 0) - (b.captureLastCheckedAt ?? 0)).slice(0, 8);
      await Promise.all(unseen.map(async (collector) => {
        collector.captureLastCheckedAt = Date.now();
        try {
          const record = (await apiGet(`/api/session/${encodeURIComponent(collector.id)}`))?.data;
          if (!state.stopping && record) applyCaptureRecord(collector, record);
        } catch (error) {
          if (state.stopping) return;
          if (error.status === 404) {
            collector.status = 'idle';
            collector.turnActive = false;
            collector.stream = null;
            collector.pendingTools = 0;
            collector.captureFinishedAt = Date.now();
            // The session is gone; a restored pending recording must settle.
            collector.capturePendingRecord = false;
          } else log(`token-meter: could not reconcile graph ${collector.id}: ${error?.message ?? error}`);
        }
      }));
    } catch (error) {
      log(`token-meter: could not discover running graphs: ${error?.message ?? error}`);
    } finally {
      discoveryLoading = false;
    }
  };

  const sampleCollector = (collector, now, tree) => {
    const active = tree.some(working);
    if (active) {
      collector.capturePendingRecord = false;
      collector.captureEndedAt = null;
      collector.captureStartedAt ??= now;
      tick(collector, now, tree);
      collector.captureDirty = true;
    } else if (collector.captureStartedAt && !collector.captureEndedAt && !collector.capturePendingRecord) {
      const last = collector.series.at(-1)?.t ?? null;
      // Settle one cadence after the last tick (not halfway across a long gap
      // detected late), so a finished graph drops to zero instead of ending
      // high and being held at the edge by the frame.
      const settleAt = last === null ? now : last + 250;
      // A turn that never generated (a permission or tool wait) is not a graph:
      // keep the slot for a real one, and do not show a flat recorded line.
      if (!collector.series.some((point) => point.v > 0) && !recordings.get(collector.id)) {
        collector.captureStartedAt = null;
        collector.captureEndedAt = null;
        collector.capturePendingRecord = false;
        collector.captureDirty = false;
        // Nothing was generated, so there is no curve to keep (not even the
        // idle zeros every tick just added).
        collector.series = [];
        collector.seriesLong = [];
        collector.seriesWide = [];
        return;
      }
      // Never invent "now" when nothing observed the end: a recording restored
      // from disk settles next to its last sample, so its window still has the
      // curve instead of being empty.
      const end = Math.max(collector.captureFinishedAt ?? 0, settleAt);
      tickFinal(collector, settleAt, tree);
      collector.captureEndedAt = end;
      recordings.capture(collector, end);
      collector.captureDirty = false;
    }
    // Only the automatic tail is bounded: once a history has been read (a
    // watched session or a subagent of one) its chart keeps every step it loaded.
    if (!collector.watched && collector.historyAt === 0 && collector.steps.length > AUTO_STEPS) {
      collector.steps.splice(0, collector.steps.length - AUTO_STEPS);
    }
  };

  const recordingWire = (collector) => ({
    state: collector.captureStartedAt ? collector.captureEndedAt ? 'saved' : 'live' : 'unrecorded',
    startedAt: collector.captureStartedAt ?? null,
    endedAt: collector.captureEndedAt ?? null,
    lastSampleAt: collector.series.at(-1)?.t ?? null,
    error: recordings.error ?? captureError,
  });

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
    // The stream is cut by our own 55 s timer and reopened at once; saying
    // "connecting" for that reopening made the panel footer flicker every
    // minute. Only a stream that really has to be re-established says so.
    let recycled = false;
    while (!state.stopping) {
      if (!base || !upstreamIsLoopback) {
        state.stream = 'off';
        state.streamError = 'OpenCode access is not available';
        await sleep(5_000);
        continue;
      }
      const controller = new AbortController();
      state.controller = controller;
      if (!recycled) state.stream = 'connecting';
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
      recycled = cutByOurTimer;
      if (state.stopping) break;
      if (!cutByOurTimer && state.stream === 'retrying') await sleep(STREAM_RETRY_MS);
      else await sleep(STREAM_REOPEN_MS);
    }
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const collector of [...collectors.values()]) {
      const tree = treeOf(collector);
      const active = tree.some(working);
      if (!active && now - Math.max(collector.watchedAt, collector.touchedAt) > COLLECTOR_TTL_MS) {
        dropTree(collector);
        continue;
      }
      sampleCollector(collector, now, tree);
      if (!collector.watched || now - collector.watchedAt > HOT_MS) continue;
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
  const saveTimer = setInterval(() => {
    // Copy snapshots once per disk batch, not on every delta or 250 ms tick.
    for (const collector of collectors.values()) {
      if (!collector.captureDirty) continue;
      recordings.capture(collector, Date.now());
      collector.captureDirty = false;
    }
    void recordings.flush();
  }, RECORDING_SAVE_MS);
  const discoveryTimer = setInterval(() => void discoverRunning(), RECORDING_SCAN_MS);
  saveTimer.unref?.();
  discoveryTimer.unref?.();

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
          ...snapshot(collector, Date.now(), [collector], priceBook, priceOverrides),
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
      // A first load the 6 s deadline cut short finished nothing, so waiting for
      // the reconcile would leave it short for five minutes; read it again once
      // the turn is over, in the background.
      const cutRetry = collector.historyCut && !collector.turnActive && now - collector.historyAt > 15_000;
      // A turn start missed while the stream was down is corrected with the
      // same slow cadence as the history.
      if (stale) void readTurnStart(collector, true);
      const mayLoad =
        !collector.loading &&
        now - collector.historyTriedAt >= (collector.error ? 15_000 : 0) &&
        (first || stale || cutRetry);
      if (mayLoad) {
        const run = loadHistory(collector, apiGet, first ? now + FIRST_LOAD_BUDGET_MS : 0);
        if (first) await run;
      } else if (first && collector.loading) {
        await collector.loading;
      }
      const tree = treeOf(collector);
      const snapshotAt = Date.now();
      sampleCollector(collector, snapshotAt, tree);
      const answer = snapshot(collector, snapshotAt, tree, priceBook, priceOverrides);
      // The step list changes once per step; a client that already has this
      // sequence keeps its copy instead of receiving the same rows again.
      if (url.searchParams.get('steps') === String(answer.stepsSeq)) delete answer.steps;
      json(res, 200, {
        ...answer,
        recording: recordingWire(collector),
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
      void discoverRunning();
      return server;
    },
    async stop() {
      state.stopping = true;
      clearInterval(ticker);
      clearInterval(saveTimer);
      clearInterval(discoveryTimer);
      state.controller?.abort();
      server.close();
      for (const collector of collectors.values()) recordings.capture(collector, Date.now());
      await recordings.flush();
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
    process.on(signal, async () => {
      await service.stop();
      process.exit(0);
    });
  }
}
