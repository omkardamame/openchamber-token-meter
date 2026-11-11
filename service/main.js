// service/src/main.js
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

// shared/chart.js
function ratesOf(steps) {
  let tokens = 0;
  let ms = 0;
  let peak = 0;
  for (const step of steps ?? []) {
    if (!step?.tps || step.tps <= 0 || step.aborted)
      continue;
    tokens += step.tokens;
    ms += step.ms;
    if (step.tps > peak)
      peak = step.tps;
  }
  return { avg: ms > 0 ? tokens / ms * 1000 : 0, peak };
}

// service/src/collector.js
var HISTORY_PAGES = 8;
var HISTORY_PAGE_SIZE = 100;
var MAX_STEPS = 400;
var SERIES_POINTS = 240;
var SERIES_INTERVAL_MS = 250;
var LIVE_WINDOW_MS = 3000;
var DEFAULT_CHARS_PER_TOKEN = 0.28;
var TOOL_CHARS_MAX = 200;
var LIVE_TYPES = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.usage.updated",
  "session.usage.recorded",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled"
]);
var emptyTotals = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  steps: 0
});
function createCollector(id) {
  return {
    id,
    status: "idle",
    error: null,
    totals: emptyTotals(),
    totalsFrom: "history",
    steps: [],
    stepsSeq: 0,
    series: [],
    chars: [],
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    stream: null,
    turnActive: false,
    ttftMs: null,
    lastTtftMs: null,
    lastStep: null,
    historyAt: 0,
    historyTriedAt: 0,
    loading: null,
    touchedAt: Date.now()
  };
}
function wantsEvent(type) {
  return LIVE_TYPES.has(type);
}
function addChars(collector, type, data, at) {
  let n = 0;
  if (type === "session.text.delta" || type === "session.reasoning.delta" || type === "session.tool.input.delta") {
    n = typeof data.delta === "string" ? data.delta.length : 0;
  } else if (type === "session.text.ended" || type === "session.reasoning.ended" || type === "session.tool.input.ended") {
    n = typeof data.text === "string" ? data.text.length : 0;
  }
  if (!n)
    return;
  const isTool = type === "session.tool.input.delta" || type === "session.tool.input.ended";
  if (isTool) {
    if (!collector.stream)
      return;
    const key = typeof data.id === "string" ? data.id : "tool";
    const used = collector.stream.toolChars.get(key) ?? 0;
    n = Math.min(n, Math.max(0, TOOL_CHARS_MAX - used));
    if (!n)
      return;
    collector.stream.toolChars.set(key, used + n);
  }
  if (collector.stream && typeof data.assistantMessageID === "string") {
    if (!collector.stream.messageID)
      collector.stream.messageID = data.assistantMessageID;
    if (collector.stream.messageID === data.assistantMessageID) {
      collector.stream.chars += n;
    }
  }
  const previous = collector.chars[collector.chars.length - 1];
  const t = previous && previous.t > at ? previous.t : at;
  collector.chars.push({ t, n });
  const floor = t - LIVE_WINDOW_MS * 2;
  while (collector.chars.length && collector.chars[0].t < floor)
    collector.chars.shift();
}
function noteFirstOutput(collector, type, at) {
  if (!collector.stream)
    return;
  const isOutput = type === "session.text.started" || type === "session.text.delta" || type === "session.reasoning.started" || type === "session.reasoning.delta" || type === "session.tool.input.started" || type === "session.tool.input.delta";
  if (!isOutput)
    return;
  if (collector.stream.firstOutputAt)
    return;
  collector.stream.firstOutputAt = at;
  const startedAt = collector.stream.started;
  collector.ttftMs = startedAt ? Math.max(0, at - startedAt) : null;
}
function charsInWindow(collector, now) {
  let sum = 0;
  for (let i = collector.chars.length - 1;i >= 0; i -= 1) {
    const bucket = collector.chars[i];
    if (now - bucket.t > LIVE_WINDOW_MS)
      break;
    sum += bucket.n;
  }
  return sum;
}
function sameShape(tokens) {
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0
  };
}
function calibrate(collector, chars, tokens) {
  if (!chars || !tokens)
    return;
  const ratio = tokens / chars;
  if (!Number.isFinite(ratio) || ratio <= 0)
    return;
  const clamped = Math.min(6, Math.max(0.02, ratio));
  collector.charsPerToken = collector.charsPerToken * 0.7 + clamped * 0.3;
}
function pushStep(collector, step) {
  if (!step.tokens)
    return;
  collector.stepsSeq += 1;
  collector.steps.push(step);
  if (collector.steps.length > MAX_STEPS)
    collector.steps.splice(0, collector.steps.length - MAX_STEPS);
}
function partSpan(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  let start = 0;
  let end = 0;
  for (const part of parts) {
    if (part?.type !== "text" && part?.type !== "reasoning")
      continue;
    const time = part.time ?? {};
    if (typeof time.created === "number" && (!start || time.created < start))
      start = time.created;
    if (typeof time.completed === "number" && time.completed > end)
      end = time.completed;
  }
  return start && end && end > start ? { start, end } : null;
}
function stepFromMessage(message) {
  const tokens = message?.tokens;
  const created = message?.time?.created;
  const streamed = message?.time?.streamed;
  if (!tokens || typeof created !== "number")
    return null;
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  const span = partSpan(message);
  const ms = span ? span.end - span.start : typeof streamed === "number" ? Math.max(0, streamed - created) : 0;
  return {
    id: message.id,
    at: typeof streamed === "number" ? streamed : created,
    tokens: output,
    total: (tokens.input ?? 0) + output,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    ms,
    tps: ms > 150 ? Math.round(output / ms * 1000 * 10) / 10 : null,
    ttftMs: span ? Math.max(0, span.start - created) : null,
    aborted: Boolean(message.error),
    measured: true
  };
}
async function loadHistory(collector, apiGet, deadline = 0) {
  if (collector.loading)
    return collector.loading;
  collector.historyTriedAt = Date.now();
  const run = (async () => {
    const messages = [];
    let cursor = null;
    let complete = true;
    for (let page = 0;page < HISTORY_PAGES; page += 1) {
      if (deadline && Date.now() > deadline) {
        complete = false;
        break;
      }
      const query = new URLSearchParams({ type: "assistant", limit: String(HISTORY_PAGE_SIZE) });
      if (cursor)
        query.set("cursor", cursor);
      else
        query.set("order", "desc");
      const answer = await apiGet(`/api/session/${encodeURIComponent(collector.id)}/message?${query.toString()}`);
      const data = Array.isArray(answer?.data) ? answer.data : [];
      messages.push(...data);
      cursor = answer?.cursor?.next ?? null;
      if (!cursor || data.length === 0)
        break;
    }
    messages.sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0));
    const totals = emptyTotals();
    const steps = [];
    let chars = 0;
    let tokens = 0;
    for (const message of messages) {
      if (message?.type !== "assistant" || !message.tokens)
        continue;
      const shape = sameShape(message.tokens);
      totals.input += shape.input;
      totals.output += shape.output;
      totals.reasoning += shape.reasoning;
      totals.cacheRead += shape.cacheRead;
      totals.cacheWrite += shape.cacheWrite;
      totals.cost += typeof message.cost === "number" ? message.cost : 0;
      totals.steps += 1;
      const step = stepFromMessage(message);
      if (step)
        steps.push(step);
      chars += textChars(message);
      tokens += shape.output + shape.reasoning;
    }
    collector.totals = { ...collector.totals, ...totals };
    collector.totalsFrom = "history";
    collector.steps = steps.slice(-MAX_STEPS);
    collector.stepsSeq += 1;
    collector.lastStep = [...collector.steps].reverse().find((step) => step.tps) ?? null;
    collector.lastTtftMs = [...collector.steps].reverse().find((step) => step.ttftMs > 0)?.ttftMs ?? null;
    if (tokens > 0 && chars > 0)
      calibrate(collector, chars, tokens);
    collector.historyAt = Date.now();
    collector.error = null;
    return complete;
  })().catch((error) => {
    collector.error = error?.message ?? String(error);
    return false;
  }).finally(() => {
    collector.loading = null;
  });
  collector.loading = run;
  return run;
}
function textChars(message) {
  if (!Array.isArray(message.content))
    return 0;
  let sum = 0;
  for (const part of message.content) {
    if (typeof part?.text === "string")
      sum += part.text.length;
    else if (typeof part?.content === "string")
      sum += part.content.length;
    else if (part?.state?.input !== undefined)
      sum += JSON.stringify(part.state.input).length;
  }
  return sum;
}
function applyEvent(collector, event) {
  const type = event?.type;
  if (!wantsEvent(type))
    return;
  const data = event.data ?? {};
  if (data.sessionID && data.sessionID !== collector.id)
    return;
  if (!data.sessionID && type === "form.created" && data.form?.sessionID !== collector.id)
    return;
  const at = typeof event.created === "number" ? event.created : Date.now();
  switch (type) {
    case "session.execution.started":
      collector.turnActive = true;
      collector.status = "streaming";
      collector.error = null;
      return;
    case "session.tool.called":
      collector.status = "tool";
      return;
    case "session.tool.success":
    case "session.tool.failed":
      if (collector.status === "tool")
        collector.status = "idle";
      return;
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      collector.turnActive = false;
      collector.status = "idle";
      collector.stream = null;
      return;
    case "session.execution.failed":
      collector.turnActive = false;
      collector.status = "failed";
      collector.stream = null;
      return;
    case "permission.asked":
      collector.status = "waiting-permission";
      return;
    case "permission.replied":
      if (collector.status === "waiting-permission")
        collector.status = collector.turnActive ? "streaming" : "idle";
      return;
    case "form.created":
      collector.status = "waiting-question";
      return;
    case "form.replied":
    case "form.cancelled":
      if (collector.status === "waiting-question")
        collector.status = "idle";
      return;
    case "session.step.started":
      collector.stream = {
        started: typeof data.started === "number" ? data.started : at,
        startedAt: at,
        streamedAt: null,
        messageID: data.assistantMessageID ?? null,
        chars: 0,
        firstOutputAt: null,
        toolChars: new Map
      };
      collector.ttftMs = null;
      collector.status = "streaming";
      return;
    case "session.step.streamed":
      if (collector.stream && (!data.assistantMessageID || collector.stream.messageID === data.assistantMessageID)) {
        collector.stream.streamedAt = at;
      }
      return;
    case "session.step.ended":
    case "session.step.failed": {
      const tokens = data.tokens ? sameShape(data.tokens) : null;
      const stream = collector.stream;
      if (tokens) {
        const output = tokens.output + tokens.reasoning;
        const startedAt = stream?.firstOutputAt ?? stream?.started ?? at;
        const endAt = stream?.streamedAt ?? at;
        const ms = Math.max(0, endAt - startedAt);
        const step = {
          id: data.assistantMessageID ?? null,
          at: endAt,
          tokens: output,
          total: tokens.input + output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          ms,
          tps: ms > 150 ? Math.round(output / ms * 1000 * 10) / 10 : null,
          ttftMs: stream?.firstOutputAt && stream?.started ? Math.max(0, stream.firstOutputAt - stream.started) : null,
          aborted: data.error?.type === "aborted",
          measured: true
        };
        const known = step.id && collector.steps.some((item) => item.id === step.id);
        if (!known) {
          pushStep(collector, step);
          collector.totals = {
            input: collector.totals.input + tokens.input,
            output: collector.totals.output + tokens.output,
            reasoning: collector.totals.reasoning + tokens.reasoning,
            cacheRead: collector.totals.cacheRead + tokens.cacheRead,
            cacheWrite: collector.totals.cacheWrite + tokens.cacheWrite,
            cost: collector.totals.cost + (typeof data.cost === "number" ? data.cost : 0),
            steps: collector.totals.steps + 1
          };
          collector.totalsFrom = "events";
        }
        if (stream?.chars)
          calibrate(collector, stream.chars, output);
        collector.lastStep = step;
        if (step.ttftMs > 0)
          collector.lastTtftMs = step.ttftMs;
      }
      collector.stream = null;
      collector.status = "idle";
      return;
    }
    case "session.usage.updated":
    case "session.usage.recorded": {
      if (!data.tokens)
        return;
      const shape = sameShape(data.tokens);
      const totals = collector.totals;
      collector.totals = {
        input: Math.max(totals.input, shape.input),
        output: Math.max(totals.output, shape.output),
        reasoning: Math.max(totals.reasoning, shape.reasoning),
        cacheRead: Math.max(totals.cacheRead, shape.cacheRead),
        cacheWrite: Math.max(totals.cacheWrite, shape.cacheWrite),
        cost: Math.max(totals.cost, typeof data.cost === "number" ? data.cost : totals.cost),
        steps: Math.max(totals.steps, collector.steps.length)
      };
      collector.totalsFrom = "usage";
      return;
    }
    default:
      noteFirstOutput(collector, type, at);
      addChars(collector, type, data, at);
  }
}
function tick(collector, now = Date.now()) {
  const streaming = collector.status === "streaming";
  const charsPerSecond = charsInWindow(collector, now) / (LIVE_WINDOW_MS / 1000);
  const rate = streaming ? charsPerSecond * collector.charsPerToken : 0;
  const last = collector.series[collector.series.length - 1];
  if (!last || now - last.t >= SERIES_INTERVAL_MS) {
    collector.series.push({ t: now, v: Math.round(rate * 10) / 10 });
    if (collector.series.length > SERIES_POINTS)
      collector.series.splice(0, collector.series.length - SERIES_POINTS);
  }
  return rate;
}
function snapshot(collector, now = Date.now()) {
  const totals = collector.totals;
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const generated = totals.output + totals.reasoning;
  const live = collector.series[collector.series.length - 1]?.v ?? 0;
  return {
    ok: true,
    session: collector.id,
    status: collector.status,
    error: collector.error,
    totals: {
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      cost: Math.round(totals.cost * 1e6) / 1e6,
      steps: totals.steps,
      prompt,
      generated,
      consumed: prompt + generated,
      cacheHitRate: prompt > 0 ? totals.cacheRead / prompt : 0,
      source: collector.totalsFrom
    },
    live: {
      tps: live,
      charsPerSecond: Math.round(charsInWindow(collector, now) / (LIVE_WINDOW_MS / 1000)),
      charsPerToken: Math.round(collector.charsPerToken * 1000) / 1000,
      ttftMs: collector.ttftMs ?? collector.lastTtftMs ?? null,
      lastStep: collector.lastStep,
      estimated: true
    },
    series: {
      t0: collector.series.length ? collector.series[0].t : now,
      step: SERIES_INTERVAL_MS,
      v: collector.series.slice(-SERIES_POINTS).map((point) => point.v)
    },
    stepsSeq: collector.stepsSeq,
    steps: collector.steps.slice(-40).map((step) => ({
      tokens: step.tokens,
      ms: step.ms,
      tps: step.tps,
      aborted: step.aborted
    })),
    rates: {
      avg: Math.round(ratesOf(collector.steps).avg * 10) / 10,
      peak: Math.round(ratesOf(collector.steps).peak * 10) / 10
    },
    generatedAt: now
  };
}

// service/src/main.js
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var BASE = process.env.OPENCHAMBER_OPENCODE_URL ?? "";
var STREAM_MAX_MS = 55000;
var STREAM_RETRY_MS = 2000;
var STREAM_REOPEN_MS = 300;
var API_TIMEOUT_MS = 8000;
var HISTORY_RECONCILE_MS = 300000;
var FIRST_LOAD_BUDGET_MS = 6000;
var HOT_MS = 30000;
var COLLECTOR_TTL_MS = 10 * 60000;
var MAX_COLLECTORS = 6;
var TICK_MS = 250;
if (!PORT || !TOKEN) {
  console.error("token-meter: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
function createService({ fetchImpl = fetch, log = () => {}, base = BASE, token = TOKEN, port = PORT } = {}) {
  const collectors = new Map;
  const state = { stream: "idle", streamError: null, stopping: false, controller: null, since: Date.now() };
  const upstreamIsLoopback = (() => {
    try {
      const host = new URL(base).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    } catch {
      return false;
    }
  })();
  const subscribeTypes = [...LIVE_TYPES].filter((type) => type !== "session.usage.recorded");
  let filterStream = true;
  const apiGet = async (path) => {
    if (!base)
      throw new Error("OpenCode access is not available");
    if (!upstreamIsLoopback)
      throw new Error("OpenCode access is not on loopback; refusing to send the token");
    const answer = await fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      ...typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(API_TIMEOUT_MS) } : {}
    });
    if (!answer.ok)
      throw new Error(`OpenCode answered ${answer.status}`);
    return answer.json();
  };
  const authorized = (header) => {
    if (!token)
      return true;
    const given = Buffer.from(String(header ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const getCollector = (id) => {
    let collector = collectors.get(id);
    if (!collector) {
      collector = createCollector(id);
      collectors.set(id, collector);
      if (collectors.size > MAX_COLLECTORS) {
        const idle = [...collectors.entries()].filter(([, item]) => !item.turnActive).sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
        if (idle)
          collectors.delete(idle[0]);
      }
    }
    collector.touchedAt = Date.now();
    return collector;
  };
  const dispatch = (event) => {
    if (!wantsEvent(event?.type))
      return;
    for (const collector of collectors.values())
      applyEvent(collector, event);
  };
  async function consume(body) {
    const decoder = new TextDecoder;
    let buffer = "";
    let warnedBadPayload = false;
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf(`
`);
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf(`
`);
        if (!line.startsWith("data:"))
          continue;
        const payload = line.slice(5).trim();
        if (!payload)
          continue;
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
      if (buffer.length > 4000000)
        buffer = "";
    }
  }
  async function streamLoop() {
    while (!state.stopping) {
      if (!base || !upstreamIsLoopback) {
        state.stream = "off";
        state.streamError = "OpenCode access is not available";
        await sleep(5000);
        continue;
      }
      const controller = new AbortController;
      state.controller = controller;
      state.stream = "connecting";
      let cutByOurTimer = false;
      const timer = setTimeout(() => {
        cutByOurTimer = true;
        controller.abort();
      }, STREAM_MAX_MS);
      try {
        const streamUrl = new URL(`${base}/api/event`);
        if (filterStream)
          for (const type of subscribeTypes)
            streamUrl.searchParams.append("types", type);
        const answer = await fetchImpl(streamUrl.toString(), {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          signal: controller.signal
        });
        if (!answer.ok) {
          if (answer.status === 400 && filterStream) {
            filterStream = false;
            log("token-meter: the server refused the event filter; reading the unfiltered stream");
          }
          throw new Error(`event stream answered ${answer.status}`);
        }
        if (!answer.body)
          throw new Error("event stream answered without a body");
        state.stream = "open";
        state.streamError = null;
        await consume(answer.body);
      } catch (error) {
        if (!state.stopping && !cutByOurTimer) {
          state.stream = "retrying";
          state.streamError = error?.message ? String(error.message) : String(error);
          log("token-meter: event stream", state.streamError);
        }
      } finally {
        clearTimeout(timer);
        state.controller = null;
      }
      if (state.stopping)
        break;
      if (!cutByOurTimer && state.stream === "retrying")
        await sleep(STREAM_RETRY_MS);
      else
        await sleep(STREAM_REOPEN_MS);
    }
  }
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const [id, collector] of collectors) {
      if (now - collector.touchedAt > COLLECTOR_TTL_MS) {
        collectors.delete(id);
        continue;
      }
      if (now - collector.touchedAt <= HOT_MS || collector.status === "streaming")
        tick(collector, now);
    }
  }, TICK_MS);
  ticker.unref?.();
  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    res.end(payload);
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`token-meter: ${req.method} ${req.url} failed: ${error?.message ?? error}`);
      if (res.destroyed || res.writableEnded)
        return;
      if (!res.headersSent)
        json(res, 500, { ok: false, error: "internal error" });
      else
        res.destroy();
    });
  });
  async function handle(req, res) {
    if (!authorized(req.headers.authorization)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "only GET is served" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      json(res, 200, { ok: true, pid: process.pid, upstream: Boolean(base), stream: state.stream });
      return;
    }
    if (url.pathname === "/state") {
      const session = url.searchParams.get("session") ?? "";
      if (!/^ses[\w-]{1,120}$/.test(session)) {
        json(res, 400, { ok: false, error: "session is required" });
        return;
      }
      const collector = getCollector(session);
      const first = collector.historyAt === 0;
      if (!base || !upstreamIsLoopback) {
        json(res, 200, {
          ...snapshot(collector),
          ok: false,
          error: !base ? "OpenCode access is not available. Approve the extension in Settings → Extensions." : "OpenCode access is not on loopback; refusing to send the token.",
          stream: { state: "off", error: state.streamError },
          loading: false
        });
        return;
      }
      const now = Date.now();
      const stale = now - collector.historyAt > HISTORY_RECONCILE_MS && !collector.turnActive;
      const mayLoad = !collector.loading && now - collector.historyTriedAt >= (collector.error ? 15000 : 0) && (first || stale);
      if (mayLoad) {
        const run = loadHistory(collector, apiGet, first ? now + FIRST_LOAD_BUDGET_MS : 0);
        if (first)
          await run;
      } else if (first && collector.loading) {
        await collector.loading;
      }
      tick(collector);
      const answer = snapshot(collector);
      if (url.searchParams.get("steps") === String(answer.stepsSeq))
        delete answer.steps;
      json(res, 200, {
        ...answer,
        stream: { state: state.stream, error: state.streamError, since: state.since },
        loading: Boolean(collector.loading)
      });
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  }
  return {
    server,
    start() {
      server.listen(port, "127.0.0.1");
      streamLoop();
      return server;
    },
    stop() {
      state.stopping = true;
      clearInterval(ticker);
      state.controller?.abort();
      server.close();
    }
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var isMain = process.argv[1] && process.argv[1].endsWith("main.js") && !process.env.TOKEN_METER_NO_LISTEN;
if (isMain) {
  const service = createService({ log: (message) => console.error(message) });
  service.start().on("listening", () => console.error(`token-meter: service on 127.0.0.1:${PORT}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      service.stop();
      process.exit(0);
    });
  }
}
export {
  createService
};
