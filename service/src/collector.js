// Aggregates token usage for one session from OpenCode's own API and event stream.
// No DOM, no host: the server in ./main.js hands it an `apiGet` function.
import { ratesOf } from '../../shared/chart.js';

const HISTORY_PAGES = 8;
const HISTORY_PAGE_SIZE = 100;
const MAX_STEPS = 400;
const SERIES_POINTS = 240;
const SERIES_INTERVAL_MS = 250;
const LIVE_WINDOW_MS = 3_000;
const DEFAULT_CHARS_PER_TOKEN = 0.28;
// A tool's argument JSON follows a schema, not a thought: past this many
// characters per call it stops saying anything about generation speed.
const TOOL_CHARS_MAX = 200;

export const LIVE_TYPES = new Set([
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.step.started',
  'session.step.streamed',
  'session.step.ended',
  'session.step.failed',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.usage.updated',
  'session.usage.recorded',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
]);

const emptyTotals = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  steps: 0,
});

export function createCollector(id) {
  return {
    id,
    // A subagent's session names its parent; the service fills this in when it
    // learns the lineage. A watched parent's numbers are the sum of its tree.
    parentId: null,
    watched: false,
    watchedAt: 0,
    lineageAt: 0,
    lineageTriedAt: 0,
    lineageLoading: false,
    status: 'idle',
    error: null,
    totals: emptyTotals(),
    totalsFrom: 'history',
    steps: [],
    stepsSeq: 0,
    series: [],
    chars: [],
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    stream: null, // { started, streamed, messageID, chars, firstOutputAt, startedAt, toolChars }
    turnActive: false,
    ttftMs: null,
    lastTtftMs: null,
    lastStep: null,
    historyAt: 0,
    historyTriedAt: 0,
    loading: null,
    touchedAt: Date.now(),
  };
}

export function wantsEvent(type) {
  return LIVE_TYPES.has(type);
}

/** The part a text, reasoning or tool-input event belongs to. */
function partKey(type, data) {
  const kind = type.includes('reasoning') ? 'reasoning' : type.includes('tool.input') ? 'tool' : 'text';
  return `${kind}:${data.assistantMessageID ?? ''}:${data.ordinal ?? data.id ?? ''}`;
}

function addChars(collector, type, data, at) {
  const delta = type.endsWith('.delta');
  const n = delta
    ? typeof data.delta === 'string'
      ? data.delta.length
      : 0
    : typeof data.text === 'string'
      ? data.text.length
      : 0;
  if (!n) return;
  // A part that streamed its deltas already counted them; its ended event then
  // repeats the whole text (measured: 215 delta chars, 215 ended chars). Add
  // only parts that arrive whole, as some providers send them.
  if (collector.stream) {
    collector.stream.deltaParts ??= new Set();
    const key = partKey(type, data);
    if (!delta && collector.stream.deltaParts.has(key)) return;
    if (delta) collector.stream.deltaParts.add(key);
  }
  const isTool = type === 'session.tool.input.delta' || type === 'session.tool.input.ended';
  if (isTool) {
    if (!collector.stream) return;
    const key = typeof data.id === 'string' ? data.id : 'tool';
    const used = collector.stream.toolChars.get(key) ?? 0;
    const capped = Math.min(n, Math.max(0, TOOL_CHARS_MAX - used));
    if (!capped) return;
    collector.stream.toolChars.set(key, used + capped);
    addWindowChars(collector, data, capped, at);
    return;
  }
  addWindowChars(collector, data, n, at);
}

function addWindowChars(collector, data, n, at) {
  if (collector.stream && typeof data.assistantMessageID === 'string') {
    if (!collector.stream.messageID) collector.stream.messageID = data.assistantMessageID;
    if (collector.stream.messageID === data.assistantMessageID) {
      collector.stream.chars += n;
    }
  }
  // The window scan breaks at the first old bucket, so the array has to stay
  // sorted even if a re-delivered event carries an earlier timestamp.
  const previous = collector.chars[collector.chars.length - 1];
  const t = previous && previous.t > at ? previous.t : at;
  collector.chars.push({ t, n });
  const floor = t - LIVE_WINDOW_MS * 2;
  while (collector.chars.length && collector.chars[0].t < floor) collector.chars.shift();
}

function noteFirstOutput(collector, type, at) {
  if (!collector.stream) return;
  const isOutput =
    type === 'session.text.started' ||
    type === 'session.text.delta' ||
    type === 'session.reasoning.started' ||
    type === 'session.reasoning.delta' ||
    type === 'session.tool.input.started' ||
    type === 'session.tool.input.delta';
  if (!isOutput) return;
  if (collector.stream.firstOutputAt) return;
  collector.stream.firstOutputAt = at;
  const startedAt = collector.stream.started;
  collector.ttftMs = startedAt ? Math.max(0, at - startedAt) : null;
}

function charsInWindow(collector, now) {
  let sum = 0;
  for (let i = collector.chars.length - 1; i >= 0; i -= 1) {
    const bucket = collector.chars[i];
    if (now - bucket.t > LIVE_WINDOW_MS) break;
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
    cacheWrite: tokens?.cache?.write ?? 0,
  };
}

function calibrate(collector, chars, tokens) {
  if (!chars || !tokens) return;
  // tokens per character, so chars/s × this = tokens/s.
  // Above 1 is real: a provider can encrypt reasoning, so its stream carries
  // many tokens for each visible character.
  const ratio = tokens / chars;
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  const clamped = Math.min(6, Math.max(0.02, ratio));
  collector.charsPerToken = collector.charsPerToken * 0.7 + clamped * 0.3;
}

/**
 * A cumulative reading raises a counter and never lowers it: OpenCode's usage
 * record and the live event stream differ by a rounding step, and a running
 * meter may not fall back on that. `cost` and `steps` join when given.
 */
function raisedTotals(current, shape, cost = null, steps = null) {
  return {
    input: Math.max(current.input, shape.input),
    output: Math.max(current.output, shape.output),
    reasoning: Math.max(current.reasoning, shape.reasoning),
    cacheRead: Math.max(current.cacheRead, shape.cacheRead),
    cacheWrite: Math.max(current.cacheWrite, shape.cacheWrite),
    cost: Math.max(current.cost, typeof cost === 'number' ? cost : current.cost),
    steps: typeof steps === 'number' ? Math.max(current.steps, steps) : current.steps,
  };
}

/**
 * Seed a session from OpenCode's own record (the shape `/api/session` and
 * `/api/session/{id}` answer): its `tokens` and `cost` are cumulative and hold
 * that session's own work only. A child's record therefore carries everything
 * a subagent did before the meter was pointed at its parent, and summing the
 * records of a tree does not count a step twice.
 */
export function applyRecord(collector, record) {
  if (!record) return;
  const busy = record.time?.busy;
  const idle = record.time?.idle;
  // A session is working when it went busy after it last went idle. It may be
  // streaming or running a tool; the next event says which, and until then a
  // live rate of zero with a breathing dot is the honest reading.
  if (busy && (!idle || busy > idle) && collector.status === 'idle') collector.status = 'streaming';
  const tokens = record.tokens;
  if (!tokens) return;
  collector.totals = raisedTotals(collector.totals, sameShape(tokens), record.cost);
  collector.totalsFrom = 'usage';
}

function pushStep(collector, step) {
  if (!step.tokens) return;
  collector.stepsSeq += 1;
  collector.steps.push(step);
  if (collector.steps.length > MAX_STEPS) collector.steps.splice(0, collector.steps.length - MAX_STEPS);
}

/**
 * The span a step actually generated in: its text and reasoning parts, from the
 * first one's start to the last one's end.
 *
 * `time.streamed - time.created` looks like the same thing and is not: created
 * is when the request went out, so the difference swallows the wait for the
 * first token (17 s in one measured step here) and, on a tool call, the tool's
 * own run. Using it reported 25 tok/s for a turn the app measured at 155.
 */
function partSpan(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  let start = 0;
  let end = 0;
  for (const part of parts) {
    if (part?.type !== 'text' && part?.type !== 'reasoning') continue;
    const time = part.time ?? {};
    if (typeof time.created === 'number' && (!start || time.created < start)) start = time.created;
    if (typeof time.completed === 'number' && time.completed > end) end = time.completed;
  }
  return start && end && end > start ? { start, end } : null;
}

function stepFromMessage(message) {
  const tokens = message?.tokens;
  const created = message?.time?.created;
  const streamed = message?.time?.streamed;
  if (!tokens || typeof created !== 'number') return null;
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  const span = partSpan(message);
  const ms = span ? span.end - span.start : typeof streamed === 'number' ? Math.max(0, streamed - created) : 0;
  return {
    id: message.id,
    at: typeof streamed === 'number' ? streamed : created,
    tokens: output,
    total: (tokens.input ?? 0) + output,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    ms,
    tps: ms > 150 ? Math.round((output / ms) * 1000 * 10) / 10 : null,
    ttftMs: span ? Math.max(0, span.start - created) : null,
    // A step the user stopped keeps its tokens in the totals, but its span
    // includes the time after the stop, so it cannot say anything about speed.
    aborted: Boolean(message.error),
    measured: true,
  };
}

/**
 * Rebuild a collector from its history.
 *
 * `stepsOnly` is for a subagent collector: its totals come from OpenCode's
 * cumulative usage record, which is exact, while its history is read for the
 * per-step chart. The pages carry at most `HISTORY_PAGES × HISTORY_PAGE_SIZE`
 * steps, so a very long subagent's history must not replace the exact record
 * with a partial sum.
 */
export async function loadHistory(collector, apiGet, deadline = 0, { stepsOnly = false } = {}) {
  if (collector.loading) return collector.loading;
  collector.historyTriedAt = Date.now();
  const run = (async () => {
    const messages = [];
    let cursor = null;
    let complete = true;
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      // The first request must answer before the host's 20 s timeout, so a long
      // session loads what fits and reconciles the rest on a later poll.
      if (deadline && Date.now() > deadline) {
        complete = false;
        break;
      }
      // A cursor already carries the order: OpenCode answers 400 when both are sent.
      const query = new URLSearchParams({ type: 'assistant', limit: String(HISTORY_PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      else query.set('order', 'desc');
      const answer = await apiGet(`/api/session/${encodeURIComponent(collector.id)}/message?${query.toString()}`);
      const data = Array.isArray(answer?.data) ? answer.data : [];
      messages.push(...data);
      cursor = answer?.cursor?.next ?? null;
      if (!cursor || data.length === 0) break;
    }
    messages.sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0));

    const totals = emptyTotals();
    const steps = [];
    let chars = 0;
    let tokens = 0;
    for (const message of messages) {
      if (message?.type !== 'assistant' || !message.tokens) continue;
      const shape = sameShape(message.tokens);
      totals.input += shape.input;
      totals.output += shape.output;
      totals.reasoning += shape.reasoning;
      totals.cacheRead += shape.cacheRead;
      totals.cacheWrite += shape.cacheWrite;
      totals.cost += typeof message.cost === 'number' ? message.cost : 0;
      totals.steps += 1;
      const step = stepFromMessage(message);
      if (step) steps.push(step);
      chars += textChars(message);
      tokens += shape.output + shape.reasoning;
    }
    if (!stepsOnly) {
      // History fills what the live events missed. It covers at most 800 steps,
      // so it must not pull a counter back from a record or an event.
      const cumulative = collector.totalsFrom === 'usage';
      collector.totals = raisedTotals(collector.totals, totals, totals.cost, totals.steps);
      // A cumulative reading stays cumulative: the next step may not be added on
      // top of it, or it would be counted twice.
      if (!cumulative) collector.totalsFrom = 'history';
    } else {
      // A step that ended a moment ago may not be in the history yet. Keep the
      // live steps the collector already has, matched by message id, so a read
      // done between two tool calls cannot erase the bar it just drew.
      const seen = new Set(steps.map((step) => step.id));
      for (const step of collector.steps) {
        if (step.id && !seen.has(step.id)) steps.push(step);
      }
      steps.sort((a, b) => a.at - b.at);
    }
    collector.steps = steps.slice(-MAX_STEPS);
    collector.stepsSeq += 1;
    collector.lastStep = [...collector.steps].reverse().find((step) => step.tps) ?? null;
    collector.lastTtftMs = [...collector.steps].reverse().find((step) => step.ttftMs > 0)?.ttftMs ?? null;
    if (tokens > 0 && chars > 0) calibrate(collector, chars, tokens);
    collector.historyAt = Date.now();
    collector.error = null;
    return complete;
  })()
    .catch((error) => {
      collector.error = error?.message ?? String(error);
      return false;
    })
    .finally(() => {
      collector.loading = null;
    });
  collector.loading = run;
  return run;
}

function textChars(message) {
  if (!Array.isArray(message.content)) return 0;
  let sum = 0;
  for (const part of message.content) {
    if (typeof part?.text === 'string') sum += part.text.length;
    else if (typeof part?.content === 'string') sum += part.content.length;
    else if (part?.state?.input !== undefined) sum += JSON.stringify(part.state.input).length;
  }
  return sum;
}

export function applyEvent(collector, event) {
  const type = event?.type;
  if (!wantsEvent(type)) return;
  const data = event.data ?? {};
  if (data.sessionID && data.sessionID !== collector.id) return;
  if (!data.sessionID && type === 'form.created' && data.form?.sessionID !== collector.id) return;
  const at = typeof event.created === 'number' ? event.created : Date.now();

  switch (type) {
    case 'session.execution.started':
      collector.turnActive = true;
      collector.status = 'streaming';
      collector.error = null;
      return;
    case 'session.tool.called':
      collector.status = 'tool';
      return;
    case 'session.tool.success':
    case 'session.tool.failed':
      if (collector.status === 'tool') collector.status = 'idle';
      return;
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      collector.turnActive = false;
      collector.status = 'idle';
      collector.stream = null;
      return;
    case 'session.execution.failed':
      collector.turnActive = false;
      collector.status = 'failed';
      collector.stream = null;
      return;
    case 'permission.asked':
      collector.status = 'waiting-permission';
      return;
    case 'permission.replied':
      if (collector.status === 'waiting-permission') collector.status = collector.turnActive ? 'streaming' : 'idle';
      return;
    case 'form.created':
      collector.status = 'waiting-question';
      return;
    case 'form.replied':
    case 'form.cancelled':
      if (collector.status === 'waiting-question') collector.status = 'idle';
      return;
    case 'session.step.started':
      collector.stream = {
        started: typeof data.started === 'number' ? data.started : at,
        startedAt: at,
        streamedAt: null,
        messageID: data.assistantMessageID ?? null,
        chars: 0,
        firstOutputAt: null,
        toolChars: new Map(),
      };
      collector.ttftMs = null;
      collector.status = 'streaming';
      return;
    case 'session.step.streamed':
      if (collector.stream && (!data.assistantMessageID || collector.stream.messageID === data.assistantMessageID)) {
        collector.stream.streamedAt = at;
      }
      return;
    case 'session.step.ended':
    case 'session.step.failed': {
      const tokens = data.tokens ? sameShape(data.tokens) : null;
      const stream = collector.stream;
      if (tokens) {
        const output = tokens.output + tokens.reasoning;
        // From the first streamed token to the end of the stream: the wait for
        // the first token and any tool run stay out of the rate.
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
          tps: ms > 150 ? Math.round((output / ms) * 1000 * 10) / 10 : null,
          ttftMs: stream?.firstOutputAt && stream?.started ? Math.max(0, stream.firstOutputAt - stream.started) : null,
          aborted: data.error?.type === 'aborted',
          measured: true,
        };
        const known = step.id && collector.steps.some((item) => item.id === step.id);
        if (!known) {
          pushStep(collector, step);
          // A cumulative source (a usage event or a session record) already
          // counts every finished step. Adding this one would count it twice;
          // its own usage event lands right behind it and keeps the total moving.
          if (collector.totalsFrom !== 'usage') {
            collector.totals = {
              input: collector.totals.input + tokens.input,
              output: collector.totals.output + tokens.output,
              reasoning: collector.totals.reasoning + tokens.reasoning,
              cacheRead: collector.totals.cacheRead + tokens.cacheRead,
              cacheWrite: collector.totals.cacheWrite + tokens.cacheWrite,
              cost: collector.totals.cost + (typeof data.cost === 'number' ? data.cost : 0),
              steps: collector.totals.steps + 1,
            };
            collector.totalsFrom = 'events';
          } else {
            collector.totals = { ...collector.totals, steps: collector.totals.steps + 1 };
          }
        }
        if (stream?.chars) calibrate(collector, stream.chars, output);
        collector.lastStep = step;
        if (step.ttftMs > 0) collector.lastTtftMs = step.ttftMs;
      }
      collector.stream = null;
      collector.status = 'idle';
      return;
    }
    case 'session.usage.updated':
    case 'session.usage.recorded': {
      if (!data.tokens) return;
      // OpenCode's per-session usage and the sum of its own per-message tokens
      // differ by a rounding step (measured: 0.02% of input, 0.5% of cost). A
      // running meter may not fall back on a rounding difference, so each
      // counter keeps the larger of the two readings.
      collector.totals = raisedTotals(collector.totals, sameShape(data.tokens), data.cost, collector.steps.length);
      collector.totalsFrom = 'usage';
      return;
    }
    default:
      noteFirstOutput(collector, type, at);
      addChars(collector, type, data, at);
  }
}

/**
 * One session's share of the live rate: the characters it streamed in the last
 * three seconds, times its own learned ratio. Each collector keeps its own
 * line, because a subagent may run a different model from its parent.
 */
function memberRate(collector, now) {
  if (collector.status !== 'streaming') return 0;
  return (charsInWindow(collector, now) / (LIVE_WINDOW_MS / 1000)) * collector.charsPerToken;
}

/**
 * `tree` is the session itself followed by every known descendant. A parent's
 * headline follows what its subagents stream, so a turn spent delegating does
 * not read as zero; hold it to one session by passing nothing.
 */
export function tick(collector, now = Date.now(), tree = [collector]) {
  const streaming = tree.some((member) => member.status === 'streaming');
  const rate = streaming ? tree.reduce((sum, member) => sum + memberRate(member, now), 0) : 0;
  const last = collector.series[collector.series.length - 1];
  if (!last || now - last.t >= SERIES_INTERVAL_MS) {
    collector.series.push({ t: now, v: Math.round(rate * 10) / 10 });
    if (collector.series.length > SERIES_POINTS) collector.series.splice(0, collector.series.length - SERIES_POINTS);
  }
  return rate;
}

/**
 * What the whole tree did, and where the headline came from. A parent whose
 * subagent is generating is generating: the dot breathes, and the panel says
 * so instead of claiming the turn is idle.
 */
function treeStatus(collector, tree) {
  const streaming = tree.some((member) => member.status === 'streaming');
  if (streaming && collector.status !== 'streaming') return { status: 'streaming', subagent: true };
  if (collector.status !== 'idle') return { status: collector.status, subagent: false };
  // A subagent must not leave its parent reading "idle" while it waits on the
  // user: the section can say that the turn is paused on a permission or a
  // question, wherever in the tree it waits.
  const waiting = tree.find((member) => member.status === 'waiting-permission' || member.status === 'waiting-question');
  if (waiting) return { status: waiting.status, subagent: true };
  if (tree.some((member) => member.status === 'tool')) return { status: 'tool', subagent: true };
  return { status: collector.status, subagent: false };
}

export function snapshot(collector, now = Date.now(), tree = [collector]) {
  const members = tree.length ? tree : [collector];
  const totals = emptyTotals();
  const steps = [];
  const subSteps = new Set();
  for (const member of members) {
    totals.input += member.totals.input;
    totals.output += member.totals.output;
    totals.reasoning += member.totals.reasoning;
    totals.cacheRead += member.totals.cacheRead;
    totals.cacheWrite += member.totals.cacheWrite;
    totals.cost += member.totals.cost;
    totals.steps += member.totals.steps;
    for (const step of member.steps) {
      steps.push(step);
      if (member !== collector) subSteps.add(step);
    }
  }
  steps.sort((a, b) => a.at - b.at);
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const generated = totals.output + totals.reasoning;
  const live = collector.series[collector.series.length - 1]?.v ?? 0;
  const streamer = members.find((member) => member.status === 'streaming' && member.ttftMs != null);
  const lastStepRaw = members.reduce(
    (best, member) => (member.lastStep && (!best || member.lastStep.at > best.at) ? member.lastStep : best),
    null,
  );
  const status = treeStatus(collector, members);
  const subagents = {
    count: members.length - 1,
    streaming: members.filter((member) => member !== collector && member.status === 'streaming').length,
    tool: members.filter((member) => member !== collector && member.status === 'tool').length,
  };
  return {
    ok: true,
    session: collector.id,
    status: status.status,
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
      source: collector.totalsFrom,
    },
    live: {
      tps: live,
      // What each member that is still generating streamed in the last three
      // seconds: an idle parent's final burst must not colour its subagent's
      // rate.
      charsPerSecond: Math.round(
        members.reduce(
          (sum, member) => sum + (member.status === 'streaming' ? charsInWindow(member, now) : 0),
          0,
        ) / (LIVE_WINDOW_MS / 1000),
      ),
      charsPerToken: Math.round(collector.charsPerToken * 1000) / 1000,
      // A streaming member's own wait wins, wherever in the tree it streams;
      // between steps the cell holds the last measured first-token wait instead
      // of blinking to a dash.
      ttftMs: streamer?.ttftMs ?? collector.ttftMs ?? collector.lastTtftMs ?? lastStepRaw?.ttftMs ?? null,
      lastStep: lastStepRaw ? { ...lastStepRaw, sub: subSteps.has(lastStepRaw) || undefined } : null,
      subagent: status.subagent,
      estimated: true,
    },
    subagents,
    series: {
      t0: collector.series.length ? collector.series[0].t : now,
      step: SERIES_INTERVAL_MS,
      v: collector.series.slice(-SERIES_POINTS).map((point) => point.v),
    },
    // Every member's counter only grows, so their sum changes as soon as a
    // step arrives anywhere in the tree and the client knows to fetch the list.
    stepsSeq: members.reduce((sum, member) => sum + member.stepsSeq, 0),
    // The chart draws the last 32 bars; forty is enough to draw and to hover.
    // Nothing else travels: the wire carried eleven fields for four the frame
    // reads, which was two thirds of a 34 KB answer.
    steps: steps.slice(-40).map((step) => ({
      tokens: step.tokens,
      ms: step.ms,
      tps: step.tps,
      aborted: step.aborted,
      ...(subSteps.has(step) ? { sub: true } : {}),
    })),
    // Worked out over every step, so the drawn average stays the session's.
    rates: {
      avg: Math.round(ratesOf(steps).avg * 10) / 10,
      peak: Math.round(ratesOf(steps).peak * 10) / 10,
    },
    generatedAt: now,
  };
}
