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
var HISTORY_PAGES = 20;
var HISTORY_PAGE_SIZE = 100;
var MAX_STEPS = 1000;
var SERIES_POINTS = 240;
var SERIES_INTERVAL_MS = 250;
var LIVE_WINDOW_MS = 3000;
var DEFAULT_CHARS_PER_TOKEN = 0.28;
var TOOL_CHARS_MAX = 200;
var SUBAGENT_RANK = { streaming: 0, tool: 1, "waiting-permission": 2, "waiting-question": 2 };
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
    parentId: null,
    title: null,
    watched: false,
    watchedAt: 0,
    lineageAt: 0,
    lineageTriedAt: 0,
    lineageLoading: false,
    model: null,
    status: "idle",
    pendingTools: 0,
    error: null,
    totals: emptyTotals(),
    totalsFrom: "history",
    steps: [],
    stepsSeq: 0,
    knownSteps: 0,
    series: [],
    chars: [],
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    stream: null,
    turnActive: false,
    turnStartedAt: 0,
    turnStartTriedAt: 0,
    turnStartLoading: false,
    ttftMs: null,
    lastTtftMs: null,
    lastStep: null,
    historyAt: 0,
    historyPartial: false,
    historyCut: false,
    historyTriedAt: 0,
    loading: null,
    derived: null,
    touchedAt: Date.now()
  };
}
function wantsEvent(type) {
  return LIVE_TYPES.has(type);
}
function partKey(type, data) {
  const kind = type.includes("reasoning") ? "reasoning" : type.includes("tool.input") ? "tool" : "text";
  return `${kind}:${data.assistantMessageID ?? ""}:${data.ordinal ?? data.id ?? ""}`;
}
function addChars(collector, type, data, at) {
  const delta = type.endsWith(".delta");
  const n = delta ? typeof data.delta === "string" ? data.delta.length : 0 : typeof data.text === "string" ? data.text.length : 0;
  if (!n)
    return;
  if (collector.stream) {
    collector.stream.deltaParts ??= new Set;
    const key = partKey(type, data);
    if (!delta && collector.stream.deltaParts.has(key))
      return;
    if (delta)
      collector.stream.deltaParts.add(key);
  }
  const isTool = type === "session.tool.input.delta" || type === "session.tool.input.ended";
  if (isTool) {
    if (!collector.stream)
      return;
    const key = typeof data.id === "string" ? data.id : "tool";
    const used = collector.stream.toolChars.get(key) ?? 0;
    const capped = Math.min(n, Math.max(0, TOOL_CHARS_MAX - used));
    if (!capped)
      return;
    collector.stream.toolChars.set(key, used + capped);
    addWindowChars(collector, data, capped, at);
    return;
  }
  addWindowChars(collector, data, n, at);
}
function addWindowChars(collector, data, n, at) {
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
function raisedTotals(current, shape, cost = null, steps = null) {
  return {
    input: Math.max(current.input, shape.input),
    output: Math.max(current.output, shape.output),
    reasoning: Math.max(current.reasoning, shape.reasoning),
    cacheRead: Math.max(current.cacheRead, shape.cacheRead),
    cacheWrite: Math.max(current.cacheWrite, shape.cacheWrite),
    cost: Math.max(current.cost, typeof cost === "number" ? cost : current.cost),
    steps: typeof steps === "number" ? Math.max(current.steps, steps) : current.steps
  };
}
function applyRecord(collector, record) {
  if (!record)
    return;
  if (typeof record.title === "string" && record.title)
    collector.title = record.title;
  if (typeof record.model?.id === "string")
    collector.model = record.model.id;
  const busy = record.time?.busy;
  const idle = record.time?.idle;
  const working = Boolean(busy && (!idle || busy > idle));
  if (working) {
    if (collector.status === "idle")
      collector.status = "streaming";
    collector.turnActive = true;
  } else if (collector.status !== "failed") {
    const staleStream = Boolean(collector.stream && idle && collector.stream.startedAt && idle > collector.stream.startedAt);
    if (!collector.stream || staleStream) {
      collector.status = "idle";
      collector.turnActive = false;
      collector.stream = null;
      collector.pendingTools = 0;
    }
  }
  const tokens = record.tokens;
  if (!tokens)
    return;
  collector.totals = raisedTotals(collector.totals, sameShape(tokens), record.cost);
  collector.totalsFrom = "usage";
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
  let tool = false;
  for (const part of parts) {
    const time = part?.time ?? {};
    if (part?.type === "text" || part?.type === "reasoning") {
      if (typeof time.created === "number" && (!start || time.created < start))
        start = time.created;
      if (typeof time.completed === "number" && time.completed > end)
        end = time.completed;
    } else if (part?.type === "tool") {
      tool = true;
      if (typeof time.created === "number" && (!start || time.created < start))
        start = time.created;
    }
  }
  if (tool && !end && typeof message?.time?.streamed === "number")
    end = message.time.streamed;
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
    model: typeof message.model?.id === "string" ? message.model.id : null,
    tokens: output,
    total: (tokens.input ?? 0) + output,
    cost: typeof message.cost === "number" ? message.cost : 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    ms,
    tps: ms > 150 ? Math.round(output / ms * 1000 * 10) / 10 : null,
    ttftMs: span ? Math.max(0, span.start - created) : null,
    aborted: Boolean(message.error),
    measured: true
  };
}
async function loadHistory(collector, apiGet, deadline = 0, { stepsOnly = false } = {}) {
  if (collector.loading)
    return collector.loading;
  collector.historyTriedAt = Date.now();
  const run = (async () => {
    const messages = [];
    let cursor = null;
    let complete = true;
    let cutByDeadline = false;
    for (let page = 0;page < HISTORY_PAGES; page += 1) {
      if (deadline && Date.now() > deadline) {
        complete = false;
        cutByDeadline = true;
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
    if (cursor)
      complete = false;
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
    collector.knownSteps = Math.max(collector.knownSteps, totals.steps);
    if (!stepsOnly) {
      const cumulative = collector.totalsFrom === "usage";
      collector.totals = raisedTotals(collector.totals, totals, totals.cost, totals.steps);
      if (!cumulative)
        collector.totalsFrom = "history";
    }
    const seen = new Set(steps.map((step) => step.id));
    for (const step of collector.steps) {
      if (step.id && !seen.has(step.id))
        steps.push(step);
    }
    steps.sort((a, b) => a.at - b.at);
    collector.steps = steps.slice(-MAX_STEPS);
    collector.model = steps.at(-1)?.model ?? collector.model;
    collector.stepsSeq += 1;
    collector.lastStep = [...collector.steps].reverse().find((step) => step.tps) ?? null;
    collector.lastTtftMs = [...collector.steps].reverse().find((step) => step.ttftMs > 0)?.ttftMs ?? null;
    if (tokens > 0 && chars > 0)
      calibrate(collector, chars, tokens);
    collector.historyPartial = !complete;
    collector.historyCut = cutByDeadline;
    collector.historyAt = Date.now();
    collector.error = null;
    return complete;
  })().catch((error) => {
    collector.error = error?.message ?? String(error);
    collector.historyPartial = true;
    collector.historyCut = false;
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
      collector.turnStartedAt = typeof data.started === "number" ? data.started : at;
      return;
    case "session.tool.called":
      collector.pendingTools += 1;
      collector.status = "tool";
      return;
    case "session.tool.success":
    case "session.tool.failed":
      collector.pendingTools = Math.max(0, collector.pendingTools - 1);
      if (collector.pendingTools === 0 && collector.status === "tool") {
        collector.status = collector.stream || collector.turnActive ? "streaming" : "idle";
      }
      return;
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      collector.turnActive = false;
      collector.status = "idle";
      collector.stream = null;
      collector.pendingTools = 0;
      return;
    case "session.execution.failed":
      collector.turnActive = false;
      collector.status = "failed";
      collector.stream = null;
      collector.pendingTools = 0;
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
        collector.status = collector.turnActive ? "streaming" : "idle";
      return;
    case "session.step.started":
      collector.pendingTools = 0;
      if (typeof data.model?.id === "string")
        collector.model = data.model.id;
      collector.stream = {
        started: typeof data.started === "number" ? data.started : at,
        startedAt: at,
        streamedAt: null,
        model: collector.model,
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
          model: stream?.model ?? collector.model,
          tokens: output,
          total: tokens.input + output,
          cost: typeof data.cost === "number" ? data.cost : 0,
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
          if (collector.totalsFrom !== "usage") {
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
          } else {
            collector.totals = { ...collector.totals, steps: collector.totals.steps + 1 };
          }
        }
        if (stream?.chars)
          calibrate(collector, stream.chars, output);
        collector.lastStep = step;
        if (step.ttftMs > 0)
          collector.lastTtftMs = step.ttftMs;
      }
      collector.stream = null;
      collector.status = collector.pendingTools > 0 ? "tool" : "idle";
      return;
    }
    case "session.usage.updated":
    case "session.usage.recorded": {
      if (!data.tokens)
        return;
      collector.totals = raisedTotals(collector.totals, sameShape(data.tokens), data.cost, collector.steps.length);
      collector.totalsFrom = "usage";
      return;
    }
    default:
      noteFirstOutput(collector, type, at);
      addChars(collector, type, data, at);
  }
}
function memberRate(collector, now) {
  if (collector.status !== "streaming")
    return 0;
  return charsInWindow(collector, now) / (LIVE_WINDOW_MS / 1000) * collector.charsPerToken;
}
function tick(collector, now = Date.now(), tree = [collector]) {
  const streaming = tree.some((member) => member.status === "streaming");
  const rate = streaming ? tree.reduce((sum, member) => sum + memberRate(member, now), 0) : 0;
  const last = collector.series[collector.series.length - 1];
  if (!last || now - last.t >= SERIES_INTERVAL_MS) {
    collector.series.push({ t: now, v: Math.round(rate * 10) / 10 });
    if (collector.series.length > SERIES_POINTS)
      collector.series.splice(0, collector.series.length - SERIES_POINTS);
  }
  return rate;
}
function treeStatus(collector, tree) {
  const streaming = tree.some((member) => member.status === "streaming");
  if (streaming && collector.status !== "streaming")
    return { status: "streaming", subagent: true };
  if (collector.status !== "idle")
    return { status: collector.status, subagent: false };
  const waiting = tree.find((member) => member.status === "waiting-permission" || member.status === "waiting-question");
  if (waiting)
    return { status: waiting.status, subagent: true };
  if (tree.some((member) => member.status === "tool"))
    return { status: "tool", subagent: true };
  return { status: collector.status, subagent: false };
}
function modelRates(steps, model) {
  if (!model)
    return null;
  const rows = [];
  for (const step of steps) {
    if (step.model !== model || !(step.cost > 0))
      continue;
    const input = step.total - step.tokens;
    if (!(input >= 0) || !(step.cacheRead >= 0))
      continue;
    rows.push([input, step.tokens, step.cacheRead, step.cost * 1e6]);
  }
  if (rows.length < 8 || !rows.some((row) => row[2] > 0))
    return null;
  const n = 3;
  const scale = Array.from({ length: n }, (_, column) => Math.sqrt(rows.reduce((sum, row) => sum + row[column] * row[column], 0) / rows.length));
  if (scale.some((value) => !(value > 0)))
    return null;
  const a = Array.from({ length: n }, () => Array(n).fill(0));
  const b = Array(n).fill(0);
  for (const row of rows) {
    for (let i = 0;i < n; i += 1) {
      const left = row[i] / scale[i];
      b[i] += left * row[3];
      for (let j = 0;j < n; j += 1)
        a[i][j] += left * (row[j] / scale[j]);
    }
  }
  const maxPivot = Math.max(...a.map((row, i) => Math.abs(row[i])));
  for (let column = 0;column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1;row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column]))
        pivot = row;
    }
    if (Math.abs(a[pivot][column]) < maxPivot * 0.0000000001)
      return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    [b[column], b[pivot]] = [b[pivot], b[column]];
    for (let row = 0;row < n; row += 1) {
      if (row === column)
        continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column;k < n; k += 1)
        a[row][k] -= factor * a[column][k];
      b[row] -= factor * b[column];
    }
  }
  const x = b.map((value, i) => value / a[i][i] / scale[i]);
  if (x.some((value) => !Number.isFinite(value) || value < -0.000001))
    return null;
  let error = 0;
  let scaleY = 0;
  for (const row of rows) {
    const predicted = row[0] * x[0] + row[1] * x[1] + row[2] * x[2];
    error += (row[3] - predicted) ** 2;
    scaleY += row[3] ** 2;
  }
  if (scaleY <= 0)
    return null;
  const relative = Math.sqrt(error / rows.length) / Math.sqrt(scaleY / rows.length);
  if (relative > 0.0001)
    return null;
  const round = (value) => Math.round(value * 1e6) / 1e6;
  return { model, input: round(x[0]), output: round(x[1]), cacheRead: round(x[2]) };
}
function snapshot(collector, now = Date.now(), tree = [collector]) {
  const members = tree.length ? tree : [collector];
  const totals = emptyTotals();
  for (const member of members) {
    totals.input += member.totals.input;
    totals.output += member.totals.output;
    totals.reasoning += member.totals.reasoning;
    totals.cacheRead += member.totals.cacheRead;
    totals.cacheWrite += member.totals.cacheWrite;
    totals.cost += member.totals.cost;
    totals.steps += member.totals.steps;
  }
  const stepsKey = members.map((member) => `${member.id}:${member.stepsSeq}:${member.steps.length}`).join("|");
  let derived = collector.derived;
  if (derived?.key !== stepsKey) {
    const steps2 = [];
    const subSteps2 = new Set;
    for (const member of members) {
      for (const step of member.steps) {
        steps2.push(step);
        if (member !== collector)
          subSteps2.add(step);
      }
    }
    steps2.sort((a, b) => a.at - b.at);
    const shownSteps2 = steps2.slice(-MAX_STEPS);
    derived = {
      key: stepsKey,
      steps: steps2,
      subSteps: subSteps2,
      shownSteps: shownSteps2,
      rates: ratesOf(steps2),
      wire: shownSteps2.map((step) => ({
        tokens: step.tokens,
        ms: step.ms,
        tps: step.tps,
        aborted: step.aborted,
        at: step.at,
        cost: Math.round((step.cost ?? 0) * 1e6) / 1e6,
        ...subSteps2.has(step) ? { sub: true } : {}
      })),
      ratesByModel: new Map
    };
    collector.derived = derived;
  }
  const { steps, subSteps, shownSteps, rates, wire } = derived;
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const generated = totals.output + totals.reasoning;
  const consumed = prompt + generated;
  const totalCost = Math.round(totals.cost * 1e6) / 1e6;
  const stepsKnown = members.reduce((sum, member) => sum + Math.max(member.totals.steps, member.steps.length, member.knownSteps), 0);
  let lastTurnCost = 0;
  let turnTokens = 0;
  let turnSteps = 0;
  if (collector.turnStartedAt) {
    for (const step of steps) {
      if (step.at >= collector.turnStartedAt) {
        lastTurnCost += step.cost ?? 0;
        turnTokens += step.tokens ?? 0;
        turnSteps += 1;
      }
    }
  }
  lastTurnCost = Math.round(lastTurnCost * 1e6) / 1e6;
  const live = collector.series[collector.series.length - 1]?.v ?? 0;
  const streamer = members.find((member) => member.status === "streaming" && member.ttftMs != null);
  const lastStepRaw = members.reduce((best, member) => member.lastStep && (!best || member.lastStep.at > best.at) ? member.lastStep : best, null);
  const model = collector.model ?? lastStepRaw?.model ?? null;
  const modelKey = model ?? "";
  let modelCostRates;
  if (derived.ratesByModel.has(modelKey)) {
    modelCostRates = derived.ratesByModel.get(modelKey);
  } else {
    modelCostRates = modelRates(steps, model);
    derived.ratesByModel.set(modelKey, modelCostRates);
  }
  const status = treeStatus(collector, members);
  const active = [];
  for (const member of members) {
    if (member === collector)
      continue;
    const rank = SUBAGENT_RANK[member.status];
    if (rank === undefined)
      continue;
    active.push({
      rank,
      item: {
        id: member.id,
        title: member.title ?? null,
        status: member.status,
        tps: Math.round(memberRate(member, now) * 10) / 10
      }
    });
  }
  active.sort((a, b) => a.rank - b.rank || b.item.tps - a.item.tps);
  const subagents = {
    count: members.length - 1,
    running: active.length,
    loading: members.filter((member) => member !== collector && member.historyAt === 0).length,
    partial: members.filter((member) => member !== collector && member.historyPartial).length,
    streaming: members.filter((member) => member !== collector && member.status === "streaming").length,
    tool: members.filter((member) => member !== collector && member.status === "tool").length,
    active: active.slice(0, 8).map((entry) => entry.item)
  };
  return {
    ok: true,
    session: collector.id,
    status: status.status,
    error: collector.error,
    historyPartial: Boolean(collector.historyPartial),
    totals: {
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      cost: totalCost,
      steps: totals.steps,
      prompt,
      generated,
      consumed,
      cacheHitRate: prompt > 0 ? totals.cacheRead / prompt : 0,
      source: collector.totalsFrom
    },
    cost: {
      total: totalCost,
      lastTurn: lastTurnCost,
      perMillion: consumed > 0 ? Math.round(totalCost / consumed * 1e6 * 1e4) / 1e4 : null,
      rates: modelCostRates
    },
    turn: {
      active: Boolean(collector.turnActive),
      startedAt: collector.turnStartedAt || null,
      tokens: turnTokens,
      steps: turnSteps
    },
    live: {
      tps: live,
      charsPerSecond: Math.round(members.reduce((sum, member) => sum + (member.status === "streaming" ? charsInWindow(member, now) : 0), 0) / (LIVE_WINDOW_MS / 1000)),
      charsPerToken: Math.round(collector.charsPerToken * 1000) / 1000,
      ttftMs: streamer?.ttftMs ?? collector.ttftMs ?? collector.lastTtftMs ?? lastStepRaw?.ttftMs ?? null,
      lastStep: lastStepRaw ? { ...lastStepRaw, sub: subSteps.has(lastStepRaw) || undefined } : null,
      subagent: status.subagent,
      estimated: true
    },
    subagents,
    series: {
      t0: collector.series.length ? collector.series[0].t : now,
      step: SERIES_INTERVAL_MS,
      v: collector.series.slice(-SERIES_POINTS).map((point) => point.v)
    },
    stepsSeq: members.reduce((sum, member) => sum + member.stepsSeq, 0),
    steps: wire,
    stepsFrom: shownSteps[0]?.at ?? null,
    stepsKnown,
    rates: { avg: Math.round(rates.avg * 10) / 10, peak: Math.round(rates.peak * 10) / 10 },
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
var LINEAGE_MS = 30000;
var LINEAGE_RETRY_MS = 60000;
var LINEAGE_DEPTH = 4;
var MAX_SUBAGENTS = 40;
var SUBAGENT_HISTORY_RETRY_MS = 15000;
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
    }
    collector.touchedAt = Date.now();
    collector.watched = true;
    collector.watchedAt = collector.touchedAt;
    const watched = [...collectors.values()].filter((item) => item.watched);
    if (watched.length > MAX_COLLECTORS) {
      const idle = watched.filter((item) => item !== collector && !item.turnActive && !treeOf(item).some((member) => member.status === "streaming")).sort((a, b) => a.watchedAt - b.watchedAt)[0];
      if (idle)
        dropTree(idle);
    }
    refreshLineage(collector);
    readTurnStart(collector);
    return collector;
  };
  const treeOf = (root) => {
    const tree = [root];
    const seen = new Set([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const collector of collectors.values()) {
        if (!collector.parentId || seen.has(collector.id) || !seen.has(collector.parentId))
          continue;
        seen.add(collector.id);
        tree.push(collector);
        grew = true;
      }
    }
    return tree;
  };
  const dropTree = (root) => {
    for (const member of treeOf(root)) {
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
    if (record)
      applyRecord(collector, record);
    collector.touchedAt = Date.now();
    return collector;
  };
  const refreshLineage = async (root) => {
    if (!base || !upstreamIsLoopback || root.lineageLoading)
      return;
    const now = Date.now();
    if (root.lineageAt && now - root.lineageAt < LINEAGE_MS)
      return;
    if (root.lineageTriedAt && now - root.lineageTriedAt < LINEAGE_RETRY_MS)
      return;
    root.lineageLoading = true;
    root.lineageTriedAt = now;
    try {
      const own = apiGet(`/api/session/${encodeURIComponent(root.id)}`).catch((error) => {
        log(`token-meter: could not read ${root.id}: ${error?.message ?? error}`);
        return null;
      });
      const queue = [{ id: root.id, depth: 0 }];
      const seen = new Set;
      let found = 0;
      while (queue.length && found < MAX_SUBAGENTS) {
        const { id, depth } = queue.shift();
        if (depth > LINEAGE_DEPTH)
          continue;
        const answer = await apiGet(`/api/session?parentID=${encodeURIComponent(id)}&limit=200`);
        if (!collectors.has(root.id))
          return;
        for (const record of Array.isArray(answer?.data) ? answer.data : []) {
          if (!record?.id || record.id === root.id || seen.has(record.id))
            continue;
          seen.add(record.id);
          found += 1;
          ensureSubagent(record.id, record, id);
          queue.push({ id: record.id, depth: depth + 1 });
          if (found >= MAX_SUBAGENTS)
            break;
        }
      }
      const ownAnswer = await own;
      if (ownAnswer?.data)
        applyRecord(root, ownAnswer.data);
      root.lineageAt = Date.now();
      root.lineageTriedAt = 0;
    } catch (error) {
      log(`token-meter: could not read the subagents of ${root.id}: ${error?.message ?? error}`);
    } finally {
      root.lineageLoading = false;
    }
  };
  const learning = new Set;
  const missedAt = new Map;
  const learnSession = async (id) => {
    if (!base || !upstreamIsLoopback || learning.has(id) || watchedRoots().length === 0)
      return;
    const now = Date.now();
    if (missedAt.has(id) && now - missedAt.get(id) < LINEAGE_RETRY_MS)
      return;
    learning.add(id);
    try {
      const chain = [];
      let cursor = id;
      let attached = false;
      for (let depth = 0;depth <= LINEAGE_DEPTH; depth += 1) {
        const record = (await apiGet(`/api/session/${encodeURIComponent(cursor)}`))?.data;
        if (!record?.id)
          break;
        chain.push(record);
        const parentId = record.parentID;
        if (!parentId)
          break;
        if (collectors.has(parentId)) {
          attached = true;
          break;
        }
        cursor = parentId;
      }
      if (!attached) {
        if (missedAt.size > 500)
          missedAt.clear();
        missedAt.set(id, Date.now());
        return;
      }
      for (let index = chain.length - 1;index >= 0; index -= 1) {
        ensureSubagent(chain[index].id, chain[index], chain[index].parentID);
      }
      missedAt.delete(id);
    } catch (error) {
      if (missedAt.size > 500)
        missedAt.clear();
      missedAt.set(id, Date.now());
      log(`token-meter: could not place ${id}: ${error?.message ?? error}`);
    } finally {
      learning.delete(id);
    }
  };
  const readTurnStart = async (collector, force = false) => {
    if (!base || !upstreamIsLoopback || collector.turnStartLoading)
      return;
    const now = Date.now();
    if (!force && collector.turnStartedAt)
      return;
    if (now - collector.turnStartTriedAt < LINEAGE_RETRY_MS)
      return;
    collector.turnStartLoading = true;
    collector.turnStartTriedAt = now;
    try {
      const answer = await apiGet(`/api/session/${encodeURIComponent(collector.id)}/message?type=user&limit=1&order=desc`);
      const created = answer?.data?.[0]?.time?.created;
      if (typeof created === "number" && created > collector.turnStartedAt)
        collector.turnStartedAt = created;
    } catch (error) {
      log(`token-meter: could not read the turn start of ${collector.id}: ${error?.message ?? error}`);
    } finally {
      collector.turnStartLoading = false;
    }
  };
  const dispatch = (event) => {
    if (!wantsEvent(event?.type))
      return;
    const sessionId = event?.data?.sessionID;
    if (sessionId) {
      const collector = collectors.get(sessionId);
      if (collector)
        applyEvent(collector, event);
      else
        learnSession(sessionId);
      return;
    }
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
    let recycled = false;
    while (!state.stopping) {
      if (!base || !upstreamIsLoopback) {
        state.stream = "off";
        state.streamError = "OpenCode access is not available";
        await sleep(5000);
        continue;
      }
      const controller = new AbortController;
      state.controller = controller;
      if (!recycled)
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
      recycled = cutByOurTimer;
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
    for (const collector of watchedRoots()) {
      if (now - collector.watchedAt > COLLECTOR_TTL_MS) {
        dropTree(collector);
        continue;
      }
      const tree = treeOf(collector);
      if (now - collector.watchedAt > HOT_MS && !tree.some((member) => member.status === "streaming"))
        continue;
      tick(collector, now, tree);
      refreshLineage(collector);
      for (const member of tree) {
        const mayLoad = member !== collector && member.historyAt === 0 && !member.loading && !member.turnActive && member.status !== "streaming" && now - member.historyTriedAt >= SUBAGENT_HISTORY_RETRY_MS;
        if (mayLoad)
          loadHistory(member, apiGet, 0, { stepsOnly: true });
      }
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
      const cutRetry = collector.historyCut && !collector.turnActive && now - collector.historyAt > 15000;
      if (stale)
        readTurnStart(collector, true);
      const mayLoad = !collector.loading && now - collector.historyTriedAt >= (collector.error ? 15000 : 0) && (first || stale || cutRetry);
      if (mayLoad) {
        const run = loadHistory(collector, apiGet, first ? now + FIRST_LOAD_BUDGET_MS : 0);
        if (first)
          await run;
      } else if (first && collector.loading) {
        await collector.loading;
      }
      const tree = treeOf(collector);
      tick(collector, now, tree);
      const answer = snapshot(collector, now, tree);
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
