// End-to-end check against this machine's real OpenCode server.
// Runs the built aggregation logic plus the service HTTP surface, and compares
// its totals with an independent sum read straight from OpenCode.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollector, applyRecord, loadHistory, applyEvent, tick, snapshot } from '../service/src/collector.js';
import { compress, easeToward, ratesOf } from '../shared/chart.js';
import { dotState } from '../shared/cells.js';

const MANAGED = path.join(os.homedir(), '.config', 'openchamber', 'managed-opencode');

function discover() {
  const files = readdirSync(MANAGED)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(MANAGED, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const managed = JSON.parse(readFileSync(files[0], 'utf8'));
  const env = execFileSync('ps', ['eww', '-p', String(managed.pid)], { encoding: 'utf8' });
  const match = env.match(/OPENCODE_PASSWORD=(\S+)/);
  if (!match) throw new Error('no OPENCODE_PASSWORD for the managed OpenCode process');
  return { base: `http://127.0.0.1:${managed.port}`, password: match[1] };
}

const { base, password } = discover();
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const realFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: basic } });

async function pickSession() {
  const answer = await (await realFetch(`${base}/api/session`)).json();
  const sessions = Array.isArray(answer?.data) ? answer.data : [];
  const candidates = [];
  for (const session of sessions.slice(0, 40)) {
    const messages = await (
      await realFetch(`${base}/api/session/${session.id}/message?type=assistant&limit=40`)
    ).json();
    const rows = (messages?.data ?? []).filter((message) => message.tokens);
    if (rows.length) candidates.push({ session, rows });
  }
  candidates.sort((a, b) => b.rows.length - a.rows.length);
  // A parent's totals are its tree's; keep this check to one session so it can
  // compare against that session's own messages. Trees have their own test.
  for (const candidate of candidates.slice(0, 12)) {
    const children = await (
      await realFetch(`${base}/api/session?parentID=${encodeURIComponent(candidate.session.id)}&limit=1`)
    ).json();
    if (!Array.isArray(children?.data) || children.data.length === 0) return candidate;
  }
  if (!candidates.length) throw new Error('no session with assistant token usage found');
  return candidates[0];
}

async function independentTotals(sessionId) {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, steps: 0, tps: [] };
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ type: 'assistant', limit: '100' });
    if (cursor) query.set('cursor', cursor);
    else query.set('order', 'desc');
    const answer = await (await realFetch(`${base}/api/session/${sessionId}/message?${query}`)).json();
    for (const message of answer?.data ?? []) {
      if (!message.tokens) continue;
      totals.input += message.tokens.input ?? 0;
      totals.output += message.tokens.output ?? 0;
      totals.reasoning += message.tokens.reasoning ?? 0;
      totals.cacheRead += message.tokens.cache?.read ?? 0;
      totals.cacheWrite += message.tokens.cache?.write ?? 0;
      totals.steps += 1;
      const ms = (message.time?.streamed ?? 0) - (message.time?.created ?? 0);
      if (ms > 150) totals.tps.push(((message.tokens.output + message.tokens.reasoning) / ms) * 1000);
    }
    cursor = answer?.cursor?.next ?? null;
    if (!cursor) break;
  }
  return totals;
}

// ---------------------------------------------------------------- collector
const { session, rows } = await pickSession();
const expected = await independentTotals(session.id);

const collector = createCollector(session.id);
await loadHistory(collector, async (pathname) => (await realFetch(`${base}${pathname}`)).json());
const snap = snapshot(collector);

check('session picked has usage', rows.length > 0, `${session.id} · ${session.title?.slice(0, 40) ?? ''}`);
check('history returns 100% of page', true, `${rows.length} newest steps read`);
check('input total matches OpenCode', snap.totals.input === expected.input, `${snap.totals.input} vs ${expected.input}`);
check('output total matches OpenCode', snap.totals.output === expected.output, `${snap.totals.output} vs ${expected.output}`);
check('reasoning total matches OpenCode', snap.totals.reasoning === expected.reasoning, `${snap.totals.reasoning} vs ${expected.reasoning}`);
check('cache hit total matches OpenCode', snap.totals.cacheRead === expected.cacheRead, `${snap.totals.cacheRead} vs ${expected.cacheRead}`);
check('cache write total matches OpenCode', snap.totals.cacheWrite === expected.cacheWrite, `${snap.totals.cacheWrite} vs ${expected.cacheWrite}`);
check('step count matches', snap.totals.steps === expected.steps, `${snap.totals.steps} vs ${expected.steps}`);
check('cache hit rate is a share', snap.totals.cacheHitRate >= 0 && snap.totals.cacheHitRate <= 1, `${(snap.totals.cacheHitRate * 100).toFixed(2)}%`);
check(
  'consumed counts prompt and generated, cache included',
  snap.totals.consumed === snap.totals.prompt + snap.totals.generated &&
    snap.totals.prompt === snap.totals.input + snap.totals.cacheRead + snap.totals.cacheWrite,
  `${snap.totals.consumed} tokens`,
);
check(
  'the wire carries only the fields the frame reads',
  snap.steps.length <= 400 &&
    snap.steps.every((step) => {
      const keys = Object.keys(step).sort().join(',');
      return keys === 'aborted,ms,tokens,tps' || keys === 'aborted,ms,tokens,tps,sub';
    }),
  `${snap.steps.length} steps, ${Object.keys(snap.steps[0] ?? {}).length} fields`,
);
check(
  'the wire carries every step the chart draws',
  snap.steps.length === Math.min(collector.steps.length, 400),
  `${snap.steps.length} of ${collector.steps.length} kept steps`,
);
check(
  'the drawn rates cover every step, not just the ones on the wire',
  snap.rates.peak === ratesOf(collector.steps).peak && Math.abs(snap.rates.avg - ratesOf(collector.steps).avg) <= 0.05,
  `avg ${snap.rates.avg.toFixed(1)}, peak ${snap.rates.peak}`,
);
check('per-step tps is plausible', snap.steps.every((step) => !step.tps || (step.tps > 1 && step.tps < 5000)), `${snap.steps.filter((s) => s.tps).length} timed steps`);
check('chars per token seeded from history', collector.charsPerToken > 0.02 && collector.charsPerToken <= 6, `${collector.charsPerToken.toFixed(2)} tokens per char`);

// ---------------------------------------------------------------- live math
const live = createCollector('ses_live_test');
const at = Date.now();
const emit = (type, data, offset = 0) => applyEvent(live, { type, created: at + offset, data: { sessionID: 'ses_live_test', ...data } });

emit('session.execution.started', {});
const started = tick(live, at);
check('idle rate is zero before output', started === 0, `${started}`);
emit('session.step.started', { assistantMessageID: 'msg_1', started: at });
emit('session.text.started', { assistantMessageID: 'msg_1', ordinal: 0 }, 120);
check('time to first token recorded', live.ttftMs === 120, `${live.ttftMs} ms`);
for (let i = 0; i < 20; i += 1) emit('session.text.delta', { assistantMessageID: 'msg_1', ordinal: 0, delta: 'x'.repeat(50) }, 200 + i * 100);
const rate = tick(live, at + 2200);
check('live rate follows the deltas', rate > 0, `${rate.toFixed(0)} tok/s from ${live.charsPerToken.toFixed(2)} chars/token`);
const seriesSnap = snapshot(live, at + 2200).series;
check('live series grows on tick', seriesSnap.v.length > 0, `${seriesSnap.v.length} points, step ${seriesSnap.step}`);
check(
  'the series travels as values against a fixed cadence',
  seriesSnap.v.length === live.series.length && seriesSnap.t0 === live.series[0].t && seriesSnap.step === 250,
  `t0 + ${seriesSnap.v.length}·${seriesSnap.step}`,
);
emit('session.step.streamed', { assistantMessageID: 'msg_1' }, 2300);
emit(
  'session.step.ended',
  { assistantMessageID: 'msg_1', finish: 'stop', cost: 0.12, tokens: { input: 900, output: 300, reasoning: 100, cache: { read: 12_000, write: 40 } } },
  2400,
);
const afterStep = snapshot(live, at + 2600);
check('settled step adds measured tokens', afterStep.totals.output === 300 && afterStep.totals.reasoning === 100, `${afterStep.totals.output}/${afterStep.totals.reasoning}`);
check('settled step is a chart point', afterStep.steps.length === 1 && afterStep.steps[0].tps === 183.5, `${afterStep.steps[0]?.tps} tok/s over ${afterStep.steps[0]?.ms} ms`);
check('calibration follows the real step', live.charsPerToken > 0.3 && live.charsPerToken < 0.45, live.charsPerToken.toFixed(3));
emit('session.usage.updated', { cost: 0.12, tokens: { input: 900, output: 400, reasoning: 100, cache: { read: 12_000, write: 40 } } }, 2500);
const afterUsage = snapshot(live, at + 2700);
check('usage event overrides totals', afterUsage.totals.output === 400 && afterUsage.totals.source === 'usage', `${afterUsage.totals.output}`);
emit('session.execution.succeeded', {}, 3000);
check('turn end clears the live rate', snapshot(live, at + 3200).status === 'idle');

// ---------------------------------------------------------------- subagents
// A watched session's numbers are its own plus its subagents'. OpenCode keeps
// each session's record to its own messages, so summing a tree cannot count a
// step twice — and a child that finished before the meter opened still counts
// from its record.
const treeParent = createCollector('ses_tree_parent');
const treeChild = createCollector('ses_tree_child');
applyRecord(treeParent, {
  id: 'ses_tree_parent',
  cost: 0.01,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } },
  time: {},
});
applyRecord(treeChild, {
  id: 'ses_tree_child',
  parentID: 'ses_tree_parent',
  title: 'SA-2 store+route',
  cost: 0.02,
  tokens: { input: 50, output: 10, reasoning: 2, cache: { read: 70, write: 0 } },
  time: { busy: 100, idle: 90 },
});
const treeSnap = snapshot(treeParent, Date.now(), [treeParent, treeChild]);
check(
  'a parent totals its subagents',
  treeSnap.totals.input === 150 && treeSnap.totals.output === 30 && treeSnap.totals.reasoning === 7,
  JSON.stringify({ in: treeSnap.totals.input, out: treeSnap.totals.output, think: treeSnap.totals.reasoning }),
);
check('a parent totals its subagents cost', Math.abs(treeSnap.totals.cost - 0.03) < 1e-9, `$${treeSnap.totals.cost}`);
check(
  'a parent names how many subagents it has',
  treeSnap.subagents.count === 1 && treeSnap.subagents.streaming === 1,
  JSON.stringify(treeSnap.subagents),
);
check(
  'a streaming subagent keeps the parent generating',
  treeSnap.status === 'streaming' && treeSnap.live.subagent === true,
  `${treeSnap.status} (${treeSnap.live.subagent})`,
);
check(
  'a running subagent is listed with its title',
  treeSnap.subagents.running === 1 &&
    treeSnap.subagents.active.length === 1 &&
    treeSnap.subagents.active[0].title === 'SA-2 store+route' &&
    treeSnap.subagents.active[0].status === 'streaming',
  JSON.stringify(treeSnap.subagents.active[0]),
);
// regression: a missed turn-end event is corrected by the session record
const stale = createCollector('ses_stale');
stale.status = 'streaming';
stale.turnActive = true;
applyRecord(stale, { time: { busy: 10, idle: 20 } });
check('an idle record clears a stuck generating state', stale.status === 'idle' && stale.turnActive === false, stale.status);
check('a busy record marks the session active', treeChild.turnActive === true, String(treeChild.turnActive));
const liveStream = createCollector('ses_live_stream');
liveStream.status = 'streaming';
liveStream.stream = {};
applyRecord(liveStream, { time: { busy: 10, idle: 20 } });
check('an idle record never interrupts an in-flight step', liveStream.status === 'streaming', liveStream.status);
const staleStream = createCollector('ses_stale_stream');
staleStream.status = 'streaming';
staleStream.turnActive = true;
staleStream.stream = { startedAt: 5 };
applyRecord(staleStream, { time: { busy: 10, idle: 20 } });
check(
  'an idle record drops a step missed at the stream cut',
  staleStream.status === 'idle' && staleStream.stream === null,
  staleStream.status,
);
const failedTurn = createCollector('ses_failed_turn');
failedTurn.status = 'failed';
applyRecord(failedTurn, { time: { busy: 10, idle: 20 } });
check('an idle record does not erase a failed turn', failedTurn.status === 'failed', failedTurn.status);

const treeAt = Date.now();
const emitTree = (collector, id, type, data, offset = 0) =>
  applyEvent(collector, { type, created: treeAt + offset, data: { sessionID: id, ...data } });
for (const [collector, id] of [
  [treeParent, treeParent.id],
  [treeChild, treeChild.id],
]) {
  emitTree(collector, id, 'session.execution.started', {});
  emitTree(collector, id, 'session.step.started', { assistantMessageID: `msg_${id}`, started: treeAt });
  emitTree(collector, id, 'session.text.started', { assistantMessageID: `msg_${id}`, ordinal: 0 }, 120);
  for (let i = 0; i < 10; i += 1) {
    emitTree(collector, id, 'session.text.delta', { assistantMessageID: `msg_${id}`, ordinal: 0, delta: 'q'.repeat(40) }, 200 + i * 100);
  }
}
const ownRate = tick(treeParent, treeAt + 2200, [treeParent]);
const childRate = tick(treeChild, treeAt + 2200, [treeChild]);
const bothRate = tick(treeParent, treeAt + 2200, [treeParent, treeChild]);
check(
  'a parent headline adds its subagents live rate',
  Math.abs(bothRate - (ownRate + childRate)) < 0.5 && bothRate > ownRate,
  `${ownRate.toFixed(1)} + ${childRate.toFixed(1)} = ${bothRate.toFixed(1)} t/s`,
);
const liveTreeSnap = snapshot(treeParent, treeAt + 2200, [treeParent, treeChild]);
check(
  'a subagent row carries its own live rate',
  Math.round(liveTreeSnap.subagents.active[0]?.tps) === Math.round(childRate),
  `${liveTreeSnap.subagents.active[0]?.tps} vs ${childRate.toFixed(1)}`,
);

emitTree(treeChild, treeChild.id, 'session.step.streamed', { assistantMessageID: `msg_${treeChild.id}` }, 2300);
emitTree(
  treeChild,
  treeChild.id,
  'session.step.ended',
  {
    assistantMessageID: `msg_${treeChild.id}`,
    finish: 'stop',
    cost: 0,
    tokens: { input: 1, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  2400,
);
const afterChildStep = snapshot(treeParent, treeAt + 2600, [treeParent, treeChild]);
check(
  'a subagent step reaches the parent chart, marked as one',
  afterChildStep.steps.some((step) => step.sub === true && step.tps > 0) && afterChildStep.live.lastStep?.sub === true,
  JSON.stringify(afterChildStep.steps.at(-1)),
);
check(
  'the step sequence sums the tree so the client refetches the list',
  afterChildStep.stepsSeq === treeParent.stepsSeq + treeChild.stepsSeq,
  `${afterChildStep.stepsSeq} = ${treeParent.stepsSeq} + ${treeChild.stepsSeq}`,
);
check(
  'a step does not double count on top of a cumulative usage record',
  afterChildStep.totals.output === 30,
  `${afterChildStep.totals.output} tokens out`,
);
applyEvent(treeChild, {
  type: 'session.usage.updated',
  created: treeAt + 2700,
  data: {
    sessionID: treeChild.id,
    cost: 0.02,
    tokens: { input: 50, output: 50, reasoning: 2, cache: { read: 70, write: 0 } },
  },
});
const afterUsageTree = snapshot(treeParent, treeAt + 2800, [treeParent, treeChild]);
check(
  'a usage event raises a subagent total once',
  afterUsageTree.totals.output === 70,
  `${afterUsageTree.totals.output} tokens out`,
);
applyEvent(treeChild, { type: 'permission.asked', created: treeAt + 2900, data: { sessionID: treeChild.id } });
emitTree(treeParent, treeParent.id, 'session.execution.succeeded', {}, 2850);
const waitingTree = snapshot(treeParent, treeAt + 3000, [treeParent, treeChild]);
check(
  'a subagent waiting on the user keeps the parent waiting',
  waitingTree.status === 'waiting-permission' && waitingTree.live.subagent === true,
  waitingTree.status,
);

// regression: a part that streamed its deltas is not counted again when its
// full text arrives, while a part sent only at its end still counts
const endedRun = createCollector('ses_ended_test');
const endedAt = Date.now();
const emitEnded = (type, data, offset = 0) =>
  applyEvent(endedRun, { type, created: endedAt + offset, data: { sessionID: 'ses_ended_test', ...data } });
emitEnded('session.execution.started', {});
emitEnded('session.step.started', { assistantMessageID: 'msg_ended', started: endedAt });
emitEnded('session.text.started', { assistantMessageID: 'msg_ended', ordinal: 0 }, 50);
for (let i = 0; i < 4; i += 1) {
  emitEnded('session.text.delta', { assistantMessageID: 'msg_ended', ordinal: 0, delta: 'x'.repeat(50) }, 100 + i * 50);
}
emitEnded('session.text.ended', { assistantMessageID: 'msg_ended', ordinal: 0, text: 'x'.repeat(200) }, 400);
const streamedChars = endedRun.chars.reduce((sum, bucket) => sum + bucket.n, 0);
check('a streamed part is counted once, not again at its end', streamedChars === 200, `${streamedChars} chars`);
emitEnded('session.text.started', { assistantMessageID: 'msg_whole', ordinal: 1 }, 500);
emitEnded('session.text.ended', { assistantMessageID: 'msg_whole', ordinal: 1, text: 'y'.repeat(120) }, 600);
const wholeChars = endedRun.chars.reduce((sum, bucket) => sum + bucket.n, 0);
check('a part sent whole at its end still counts', wholeChars === 320, `${wholeChars} chars`);

// regression: a streaming subagent supplies the first-token wait, not the
// parent's older step
const ttftParent = createCollector('ses_ttft_parent');
const ttftChild = createCollector('ses_ttft_child');
ttftParent.lastTtftMs = 9_000;
ttftChild.status = 'streaming';
ttftChild.ttftMs = 250;
check(
  'a streaming subagent supplies the first-token wait',
  snapshot(ttftParent, Date.now(), [ttftParent, ttftChild]).live.ttftMs === 250,
  `${snapshot(ttftParent, Date.now(), [ttftParent, ttftChild]).live.ttftMs}`,
);
check('an idle parent keeps its own last first-token wait', snapshot(ttftParent).live.ttftMs === 9_000, `${snapshot(ttftParent).live.ttftMs}`);

// ---------------------------------------------------------------- cost
const costRun = createCollector('ses_cost_test');
const costAt = 1_794_000_000_000;
const emitCost = (type, data = {}, offset = 0) =>
  applyEvent(costRun, { type, created: costAt + offset, data: { sessionID: 'ses_cost_test', ...data } });
const costStep = (id, cost) => ({
  assistantMessageID: id,
  finish: 'stop',
  cost,
  tokens: { input: 10, output: 90, reasoning: 0, cache: { read: 0, write: 0 } },
});
emitCost('session.execution.started', { started: costAt });
emitCost('session.step.started', { assistantMessageID: 'msg_cost_1', started: costAt }, 100);
emitCost('session.step.ended', costStep('msg_cost_1', 0.02), 1_000);
emitCost('session.step.started', { assistantMessageID: 'msg_cost_2', started: costAt + 1_100 }, 1_100);
emitCost('session.step.ended', costStep('msg_cost_2', 0.03), 2_000);
const costSnap = snapshot(costRun, costAt + 2_100);
check('the last-turn cost is the sum of its steps', costSnap.cost.lastTurn === 0.05, `$${costSnap.cost.lastTurn}`);
check(
  'the effective rate is the cost per million tokens processed',
  costSnap.cost.perMillion === 250,
  `$${costSnap.cost.perMillion} per 1M`,
);
emitCost('session.execution.started', { started: costAt + 3_000 }, 3_000);
emitCost('session.step.started', { assistantMessageID: 'msg_cost_3', started: costAt + 3_100 }, 3_100);
emitCost('session.step.ended', costStep('msg_cost_3', 0.01), 4_000);
const nextTurn = snapshot(costRun, costAt + 4_100);
check('a new turn resets the last-turn cost', nextTurn.cost.lastTurn === 0.01, `$${nextTurn.cost.lastTurn}`);

// ---------------------------------------------------------------- model rates
// OpenCode's step costs are linear in input, generated and cache-read tokens.
// A fit recovers the model's own $/1M rates without a price table or a blocked
// API read.
const rateRun = createCollector('ses_rate_test');
rateRun.model = 'rate-model';
const rateAt = 1_794_000_000_000;
for (let i = 0; i < 12; i += 1) {
  const input = 1000 + i * 137;
  const output = 100 + (i % 5) * 17;
  const cacheRead = 5000 + i * 311;
  rateRun.steps.push({
    id: `msg_rate_${i}`,
    at: rateAt + i * 1000,
    model: 'rate-model',
    tokens: output,
    total: input + output,
    cost: (input * 0.15 + output * 0.6 + cacheRead * 0.003) / 1e6,
    cacheRead,
    cacheWrite: 0,
    ms: 1000,
    tps: output,
    aborted: false,
  });
}
rateRun.stepsSeq = rateRun.steps.length;
rateRun.lastStep = rateRun.steps.at(-1);
const rateSnap = snapshot(rateRun);
check(
  'the model rates are recovered from its step costs',
  rateSnap.cost.rates?.input === 0.15 &&
    rateSnap.cost.rates?.output === 0.6 &&
    rateSnap.cost.rates?.cacheRead === 0.003,
  JSON.stringify(rateSnap.cost.rates),
);
const tieredRun = createCollector('ses_rate_tiered');
tieredRun.model = 'tiered-model';
for (let i = 0; i < 12; i += 1) {
  const input = 1000 + i * 137;
  const output = 100 + (i % 5) * 17;
  const cacheRead = 5000 + i * 311;
  tieredRun.steps.push({
    id: `msg_tier_${i}`,
    at: rateAt + i * 1000,
    model: 'tiered-model',
    tokens: output,
    total: input + output,
    cost: ((input * 0.15 + output * 0.6 + cacheRead * 0.003) / 1e6) * (i % 2 ? 1.2 : 1),
    cacheRead,
    cacheWrite: 0,
    ms: 1000,
    tps: output,
    aborted: false,
  });
}
check('a non-linear cost yields no rate instead of a guess', snapshot(tieredRun).cost.rates === null, JSON.stringify(snapshot(tieredRun).cost.rates));

// A subagent whose history is longer than the kept list still counts in full.
const knownRun = createCollector('ses_known_test');
knownRun.knownSteps = 450;
knownRun.steps = [
  { id: 'msg_known', at: 1, model: null, tokens: 1, total: 1, cost: 0, cacheRead: 0, cacheWrite: 0, ms: 0, tps: null, aborted: false },
];
check('the step count includes steps older than the kept list', snapshot(knownRun).stepsKnown === 450, `${snapshot(knownRun).stepsKnown}`);

// OpenCode's own two readings differ by a rounding step; a running meter keeps the larger
emit('session.usage.updated', { cost: 0.01, tokens: { input: 900, output: 399, reasoning: 100, cache: { read: 12_000, write: 40 } } }, 3300);
const merged = snapshot(live, at + 3400);
check('a lower usage reading never shrinks a counter', merged.totals.output === 400 && merged.totals.input === 900, `out ${merged.totals.output}`);

// regression: a cursor must never travel with order (OpenCode answers 400)
const paging = createCollector('ses_paging_test');
const queries = [];
const pageOf = (index) => ({
  data: [
    {
      id: `msg_page_${index}`,
      type: 'assistant',
      time: { created: index * 10_000, streamed: index * 10_000 + 2_000 },
      tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [],
    },
  ],
  cursor: { previous: null, next: index < 2 ? `CUR${index}` : null },
});
let pageIndex = 0;
await loadHistory(paging, async (pathname) => {
  queries.push(pathname);
  return pageOf(pageIndex++);
});
const searchOf = (pathname) => new URL(pathname, 'http://local').search;
check(
  'history pages with a cursor and no order',
  queries.length === 3 && queries.every((q, i) => (i === 0 ? q.includes('order=desc') && !q.includes('cursor=') : q.includes('cursor=') && !q.includes('order='))),
  queries.map(searchOf).join(' | '),
);
check('history keeps more than one page of steps', paging.totals.steps === 3, `${paging.totals.steps} steps`);

// regression: a provider can spend many tokens for each visible character
const hotTokens = createCollector('ses_hot_test');
const hotAt = Date.now();
const emitHot = (type, data, offset = 0) =>
  applyEvent(hotTokens, { type, created: hotAt + offset, data: { sessionID: 'ses_hot_test', ...data } });
emitHot('session.execution.started', {});
emitHot('session.step.started', { assistantMessageID: 'msg_hot', started: hotAt });
for (let i = 0; i < 4; i += 1) {
  emitHot('session.reasoning.delta', { assistantMessageID: 'msg_hot', ordinal: 0, delta: 'z'.repeat(50) }, 100 + i * 100);
}
emitHot('session.step.streamed', { assistantMessageID: 'msg_hot' }, 900);
emitHot(
  'session.step.ended',
  { assistantMessageID: 'msg_hot', finish: 'stop', cost: 0, tokens: { input: 0, output: 800, reasoning: 200, cache: { read: 0, write: 0 } } },
  1_000,
);
check('calibration allows many tokens per visible character', hotTokens.charsPerToken > 1, `${hotTokens.charsPerToken.toFixed(2)} tokens per char`);

// a tool call is its own state, and its argument JSON stops counting past 200 chars
const toolRun = createCollector('ses_tool_test');
const toolAt = Date.now();
const emitTool = (type, data, offset = 0) =>
  applyEvent(toolRun, { type, created: toolAt + offset, data: { sessionID: 'ses_tool_test', ...data } });
emitTool('session.execution.started', {});
emitTool('session.step.started', { assistantMessageID: 'msg_tool', started: toolAt });
emitTool('session.tool.input.started', { assistantMessageID: 'msg_tool', id: 'call_1' }, 100);
emitTool('session.tool.called', { assistantMessageID: 'msg_tool', id: 'call_1' }, 200);
check('a tool call is its own status', toolRun.status === 'tool', toolRun.status);
for (let i = 0; i < 4; i += 1) {
  emitTool('session.tool.input.delta', { assistantMessageID: 'msg_tool', id: 'call_1', delta: 'a'.repeat(300) }, 300 + i * 50);
}
const toolChars = toolRun.chars.reduce((sum, bucket) => sum + bucket.n, 0);
check('tool argument JSON stops counting past 200 chars', toolChars === 200, `${toolChars} chars counted`);
emitTool('session.tool.success', { assistantMessageID: 'msg_tool', id: 'call_1' }, 600);
check('a finished tool returns the status to idle', toolRun.status === 'idle', toolRun.status);

// a step's rate is measured over its text parts, not over the whole step
const spanRun = createCollector('ses_span_test');
const spanAt = 1_794_000_000_000;
const spanPages = [
  {
    data: [
      {
        id: 'msg_span_1',
        type: 'assistant',
        time: { created: spanAt, streamed: spanAt + 42_643, completed: spanAt + 43_037 },
        tokens: { input: 11, output: 660, reasoning: 2_730, cache: { read: 448_296, write: 0 } },
        cost: 0,
        content: [
          { type: 'reasoning', text: 'x', time: { created: spanAt + 16_983, completed: spanAt + 42_635 } },
          { type: 'tool', time: { created: spanAt + 39_434, ran: spanAt + 42_639, completed: spanAt + 43_034 } },
        ],
      },
    ],
    cursor: { next: null },
  },
];
await loadHistory(spanRun, async () => spanPages[0]);
const spanStep = spanRun.steps[0];
check(
  'a step rate uses the text parts, not the whole step',
  spanStep.ms === 25_652 && spanStep.tps === 132.2,
  `${spanStep.tps} tok/s over ${spanStep.ms} ms`,
);
check('time to first token is measured from the request', spanStep.ttftMs === 16_983, `${spanStep.ttftMs} ms`);
check('the last step carries its own ttft', snapshot(spanRun).live.ttftMs === 16_983, `${snapshot(spanRun).live.ttftMs}`);
applyEvent(spanRun, { type: 'session.step.started', created: spanAt + 60_000, data: { sessionID: 'ses_span_test', assistantMessageID: 'msg_span_2', started: spanAt + 60_000 } });
check(
  'a step that just started keeps the last measured ttft',
  snapshot(spanRun).live.ttftMs === 16_983,
  `${snapshot(spanRun).live.ttftMs}`,
);

// the live path measures the same span
const liveSpan = createCollector('ses_live_span');
const liveAt = Date.now();
const emitSpan = (type, data, offset = 0) =>
  applyEvent(liveSpan, { type, created: liveAt + offset, data: { sessionID: 'ses_live_span', ...data } });
emitSpan('session.execution.started', {});
emitSpan('session.step.started', { assistantMessageID: 'm_span', started: liveAt }, 0);
emitSpan('session.reasoning.started', { assistantMessageID: 'm_span', ordinal: 0 }, 16_983);
emitSpan('session.reasoning.ended', { assistantMessageID: 'm_span', ordinal: 0, text: 'y'.repeat(100) }, 42_635);
emitSpan('session.step.streamed', { assistantMessageID: 'm_span' }, 42_643);
emitSpan('session.step.ended', { assistantMessageID: 'm_span', finish: 'stop', cost: 0, tokens: { input: 11, output: 660, reasoning: 2_730, cache: { read: 0, write: 0 } } }, 43_037);
const liveSpanStep = liveSpan.lastStep;
check(
  'the live step measures the same span as history',
  Math.abs(liveSpanStep.ms - 25_652) <= 50 && Math.round(liveSpanStep.tps) === 132,
  `${liveSpanStep.tps} tok/s over ${liveSpanStep.ms} ms`,
);
check('the live step reports its real time to first token', liveSpanStep.ttftMs === 16_983, `${liveSpanStep.ttftMs} ms`);

// ---------------------------------------------------------------- easing
const frame = 16;
let up = 0;
const upPath = [];
for (let i = 0; i < 120; i += 1) {
  up = easeToward(up, 100, frame);
  upPath.push(up);
}
check(
  'the headline eases up without overshooting',
  upPath.every((value, i) => value <= 100 && (i === 0 || value >= upPath[i - 1])) && up > 99,
  `settled at ${up.toFixed(1)} after ${(upPath.length * frame) / 1000}s`,
);
let down = 100;
const downPath = [];
for (let i = 0; i < 120; i += 1) {
  down = easeToward(down, 0, frame);
  downPath.push(down);
}
check(
  'the headline eases down the same way',
  downPath.every((value, i) => value >= 0 && (i === 0 || value <= downPath[i - 1])) && down < 1,
  `settled at ${down.toFixed(2)}`,
);
const halfLife = (() => {
  let v = 0;
  let steps = 0;
  while (v < 50 && steps < 1000) {
    v = easeToward(v, 100, frame);
    steps += 1;
  }
  return steps * frame;
})();
check('the headline covers half the gap in about 110 ms', halfLife >= 90 && halfLife <= 140, `${halfLife} ms`);

// the rates drawn on the live chart, checked against the session that raised it
const sessionSteps = [
  { tokens: 1155, ms: 10_000, tps: 115.5 },
  { tokens: 1200, ms: 8_791, tps: 136.5 },
  { tokens: 1580, ms: 10_519, tps: 150.2 },
  { tokens: 1117, ms: 7_872, tps: 141.9 },
  { tokens: 1117, ms: 15_407, tps: 72.5 },
  { tokens: 300, ms: 0, tps: null },
];
const rates = ratesOf(sessionSteps);
check('the drawn average is tokens over stream time', Math.round(rates.avg) === 117, `${rates.avg.toFixed(1)} t/s`);
check('the drawn peak is the best measured step', rates.peak === 150.2, `${rates.peak} t/s`);
check('a step without a span counts for neither', Math.round(ratesOf([{ tokens: 9, ms: 0, tps: null }]).avg) === 0, 'no span, no rate');
const withAbort = ratesOf([...sessionSteps, { tokens: 400, ms: 231_067, tps: 1.7, aborted: true }]);
check(
  'a stopped step does not drag the average or set the peak',
  Math.round(withAbort.avg) === 117 && withAbort.peak === 150.2,
  `avg ${withAbort.avg.toFixed(1)}, peak ${withAbort.peak}`,
);

// a spike must stay on the chart, not be cut off at the top
const ceiling = 100;
const atCeiling = compress(ceiling, ceiling);
const tenTimes = compress(ceiling * 10, ceiling);
const hundredTimes = compress(ceiling * 100, ceiling);
check('zero sits on the baseline', compress(0, ceiling) === 0, String(compress(0, ceiling)));
check('the ceiling sits at the end of the linear band', Math.abs(atCeiling - 0.76) < 1e-9, atCeiling.toFixed(3));
check('a spike above the ceiling stays inside the plot', tenTimes > 0.95 && tenTimes < 1, tenTimes.toFixed(3));
check('a hundredfold spike still stays inside', hundredTimes < 1 && hundredTimes > tenTimes, hundredTimes.toFixed(3));
check(
  'the mapping never goes down as the value rises',
  [0, 10, 50, 100, 200, 1_000, 10_000].every((v, i, all) => i === 0 || compress(v, ceiling) >= compress(all[i - 1], ceiling)),
  'monotonic',
);

// the dot says what the session is doing, in one word per state
check(
  'every session state maps to a dot state',
  dotState('streaming') === 'streaming' &&
    dotState('tool') === 'tool' &&
    dotState('waiting-permission') === 'waiting' &&
    dotState('waiting-question') === 'waiting' &&
    dotState('failed') === 'error' &&
    dotState('idle') === 'idle' &&
    dotState('something-new') === 'idle',
  'streaming, tool, waiting, error, idle',
);

// ---------------------------------------------------------------- layout guards
// The status page reports its own height, so nothing in it may be sized by the
// frame. A 100%-tall root made scrollHeight grow with every setHeight and the
// section crept down the panel, 2 px per render.
const statusHtml = readFileSync(new URL('../status/index.html', import.meta.url), 'utf8');
const statusSource = readFileSync(new URL('../status/src/main.js', import.meta.url), 'utf8');
check('the self-sizing section is never sized by its frame', !/height:\s*100%/.test(statusHtml));
check(
  'the self-sizing section measures its content, not the root that stretches',
  /ui\?\.app \? ui\.app\.scrollHeight/.test(statusSource) && !/Math\.ceil\(root\.scrollHeight\)/.test(statusSource),
);
check('the rail panel still fills its dock', /height:\s*100%/.test(readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')));

// a form that is answered clears the waiting state
const formRun = createCollector('ses_form_test');
const formAt = Date.now();
applyEvent(formRun, { type: 'form.created', created: formAt, data: { sessionID: 'ses_form_test', form: { sessionID: 'ses_form_test' } } });
check('a question puts the session in waiting', formRun.status === 'waiting-question', formRun.status);
applyEvent(formRun, { type: 'form.replied', created: formAt + 100, data: { sessionID: 'ses_form_test', form: { sessionID: 'ses_form_test' } } });
check('an answered question clears the waiting state', formRun.status === 'idle', formRun.status);

// a late event must not break the ordered character window
const orderRun = createCollector('ses_order_test');
const orderAt = Date.now();
applyEvent(orderRun, { type: 'session.execution.started', created: orderAt, data: { sessionID: 'ses_order_test' } });
applyEvent(orderRun, { type: 'session.step.started', created: orderAt, data: { sessionID: 'ses_order_test', assistantMessageID: 'm1', started: orderAt } });
applyEvent(orderRun, { type: 'session.text.delta', created: orderAt + 500, data: { sessionID: 'ses_order_test', assistantMessageID: 'm1', delta: 'later' } });
applyEvent(orderRun, { type: 'session.text.delta', created: orderAt + 100, data: { sessionID: 'ses_order_test', assistantMessageID: 'm1', delta: 'earlier' } });
check(
  'a late event keeps the character window ordered',
  orderRun.chars.every((bucket, index) => index === 0 || bucket.t >= orderRun.chars[index - 1].t),
  JSON.stringify(orderRun.chars.map((bucket) => bucket.t - orderAt)),
);

// ---------------------------------------------------------------- http service
const port = 47821;
const token = 'test-token';
process.env.OPENCHAMBER_SERVICE_PORT = String(port);
process.env.OPENCHAMBER_SERVICE_TOKEN = token;
process.env.OPENCHAMBER_OPENCODE_URL = 'http://127.0.0.1:9'; // loopback on purpose: the guard refuses anything else

const stream = { controller: null, chunks: [] };
const service = (await import('../service/src/main.js')).createService({
  fetchImpl: async (url, init = {}) => {
    const target = new URL(url);
    if (target.pathname === '/api/event') {
      const body = new ReadableStream({
        start(controller) {
          stream.controller = controller;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(`${base}${target.pathname}${target.search}`, init);
  },
});
service.start();
await new Promise((resolve) => setTimeout(resolve, 250));

const get = async (query) => {
  const answer = await fetch(`http://127.0.0.1:${port}/state?${query}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: answer.status, body: await answer.json() };
};

const unauthorised = await fetch(`http://127.0.0.1:${port}/state?session=${session.id}`);
check('service refuses a request without the bearer', unauthorised.status === 401);
const missing = await get('');
check('service asks for a session id', missing.status === 400);
const traversal = await get('session=../../etc/passwd');
check('a session id that is not one is refused', traversal.status === 400, String(traversal.body.error));
const posted = await fetch(`http://127.0.0.1:${port}/state?session=${session.id}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
});
check('service serves GET only', posted.status === 405, String(posted.status));
const wrongToken = await fetch(`http://127.0.0.1:${port}/state?session=${session.id}`, {
  headers: { authorization: 'Bearer not-the-token' },
});
check('service refuses a wrong bearer', wrongToken.status === 401, String(wrongToken.status));
const served = await get(`session=${session.id}`);
check('service answers with the same totals', served.status === 200 && served.body.totals.input === expected.input, `${served.body.totals?.input}`);

const push = (event) => stream.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
await new Promise((resolve) => setTimeout(resolve, 100));
push({ id: 'evt_1', created: Date.now(), type: 'session.execution.started', data: { sessionID: session.id } });
push({ id: 'evt_2', created: Date.now() + 50, type: 'session.step.started', data: { sessionID: session.id, assistantMessageID: 'msg_live', agent: 'build', model: {}, started: Date.now() } });
for (let i = 0; i < 12; i += 1) {
  push({
    id: `evt_d${i}`,
    created: Date.now() + 100 + i * 80,
    type: 'session.text.delta',
    data: { sessionID: session.id, assistantMessageID: 'msg_live', ordinal: 0, delta: 'y'.repeat(90) },
  });
}
await new Promise((resolve) => setTimeout(resolve, 500));
const streaming = await get(`session=${session.id}`);
check('streamed events turn the status to generating', streaming.body.status === 'streaming', streaming.body.status);
check('streamed events build a live graph', streaming.body.series.v.some((value) => value > 0), `peak ${Math.max(...streaming.body.series.v)} tok/s`);
check('streamed events report the stream as open', streaming.body.stream.state === 'open', streaming.body.stream.state);

push({
  id: 'evt_end',
  created: Date.now() + 1200,
  type: 'session.step.ended',
  data: { sessionID: session.id, assistantMessageID: 'msg_live', finish: 'stop', cost: 0, tokens: { input: 10, output: 500, reasoning: 0, cache: { read: 0, write: 0 } } },
});
push({ id: 'evt_usage', created: Date.now() + 1250, type: 'session.usage.updated', data: { sessionID: session.id, cost: 0, tokens: { input: expected.input + 10, output: expected.output + 500, reasoning: expected.reasoning, cache: { read: expected.cacheRead, write: expected.cacheWrite } } } });
await new Promise((resolve) => setTimeout(resolve, 400));
const ended = await get(`session=${session.id}`);
check('a finished step adds one chart point', ended.body.steps.length >= snap.steps.length, `${ended.body.steps.length} points`);
check('the new step carries a measured rate', ended.body.live.lastStep?.tokens === 500, JSON.stringify(ended.body.live.lastStep));
check('totals follow the usage event', ended.body.totals.output === expected.output + 500, `${ended.body.totals.output}`);

// the step list is only sent when the client's sequence is stale
const seqNow = (await get(`session=${session.id}`)).body.stepsSeq;
const sibling = await get(`session=${session.id}&steps=${seqNow}`);
check(
  'a current step sequence omits the list',
  sibling.body.stepsSeq !== seqNow || sibling.body.steps === undefined,
  `asked with ${seqNow}, answer has ${sibling.body.stepsSeq}`,
);
const staleSteps = await get(`session=${session.id}&steps=0`);
check('a stale step sequence carries the list', Array.isArray(staleSteps.body.steps) && staleSteps.body.steps.length > 0, `${staleSteps.body.steps?.length}`);
const freshSteps = await get(`session=${session.id}&steps=${staleSteps.body.stepsSeq}`);
check('the sequence the client just read is honoured', freshSteps.body.steps === undefined, `seq ${staleSteps.body.stepsSeq}`);

// a server that refuses the event filter still gets a working stream
const streamUrls = [];
const fallbackPort = port + 2;
const fallback = (await import('../service/src/main.js')).createService({
  base: 'http://127.0.0.1:9',
  token,
  port: fallbackPort,
  fetchImpl: async (url) => {
    const target = new URL(url);
    if (target.pathname === '/api/event') {
      streamUrls.push(target.search);
      if (streamUrls.length === 1) return new Response('nope', { status: 400 });
      return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
fallback.start();
// the retry delay is 2 s by design, so wait past it
await new Promise((resolve) => setTimeout(resolve, 2600));
check(
  'a refused event filter falls back to the unfiltered stream',
  streamUrls.length >= 2 && streamUrls[0].includes('types=') && !streamUrls[1].includes('types='),
  streamUrls.map((search) => (search.includes('types=') ? 'filtered' : 'unfiltered')).join(' → '),
);
check('the filtered subscription names every type the service reads', streamUrls[0].includes('session.step.ended') && !streamUrls[0].includes('session.usage.recorded'), 'no unsubscribable type');
fallback.stop();

// a service pointed away from loopback refuses to send its bearer anywhere
const offLoopbackPort = port + 1;
const offLoopback = (await import('../service/src/main.js')).createService({
  base: 'https://example.com',
  token,
  fetchImpl: async () => {
    throw new Error('must not be called');
  },
});
offLoopback.server.listen(offLoopbackPort, '127.0.0.1');
await new Promise((resolve) => setTimeout(resolve, 150));
const guarded = await fetch(`http://127.0.0.1:${offLoopbackPort}/state?session=${session.id}`, {
  headers: { authorization: `Bearer ${token}` },
});
const guardedBody = await guarded.json();
check('a non-loopback upstream is refused', guardedBody.ok === false && /loopback/.test(guardedBody.error), guardedBody.error);
offLoopback.stop();

// ---------------------------------------------------------------- subagents over HTTP
// A watched parent must show what its subagents do, including children that
// finished before the meter was opened. The tree above is served by a stub, so
// the check does not depend on this machine's sessions.
const treePort = port + 3;
const treeStream = { controller: null };
const records = {
  ses_st_child: {
    id: 'ses_st_child',
    parentID: 'ses_st_parent',
    title: 'SA child',
    cost: 0.02,
    tokens: { input: 50, output: 10, reasoning: 2, cache: { read: 70, write: 0 } },
    time: { busy: 1, idle: 0 },
  },
  ses_st_grand: {
    id: 'ses_st_grand',
    parentID: 'ses_st_child',
    cost: 0.003,
    tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 9, write: 0 } },
    time: {},
  },
};
const answerJson = (data) =>
  new Response(JSON.stringify({ data, cursor: { next: null } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const treeService = (await import('../service/src/main.js')).createService({
  base: 'http://127.0.0.1:9',
  token,
  port: treePort,
  fetchImpl: async (url) => {
    const target = new URL(url);
    if (target.pathname === '/api/event') {
      return new Response(
        new ReadableStream({
          start(controller) {
            treeStream.controller = controller;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (target.pathname === '/api/session') {
      const parentID = target.searchParams.get('parentID');
      return answerJson(Object.values(records).filter((record) => record.parentID === parentID));
    }
    const message = target.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (message) return answerJson([]);
    const one = target.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      return answerJson(records[id] ?? { id, parentID: null });
    }
    return answerJson({});
  },
});
treeService.start();
await new Promise((resolve) => setTimeout(resolve, 200));
const treeGet = async () => {
  const answer = await fetch(`http://127.0.0.1:${treePort}/state?session=ses_st_parent`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return answer.json();
};
const pushTree = (event) =>
  treeStream.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
await treeGet();
await new Promise((resolve) => setTimeout(resolve, 600));
const seeded = await treeGet();
check('a watched parent finds its subagents', seeded.subagents?.count === 2, JSON.stringify(seeded.subagents));
check(
  'a watched parent lists its running subagent by title',
  seeded.subagents?.running === 1 && seeded.subagents?.active?.[0]?.title === 'SA child',
  JSON.stringify(seeded.subagents?.active?.[0]),
);
check(
  'a subagent that finished before the meter opened still counts',
  seeded.totals.input === 57 && seeded.totals.output === 13 && seeded.totals.reasoning === 3,
  `${seeded.totals.input} in, ${seeded.totals.output} out, ${seeded.totals.reasoning} think`,
);
check('a subagent cache read and cost are in the parent', seeded.totals.cacheRead === 79 && Math.abs(seeded.totals.cost - 0.023) < 1e-9, `${seeded.totals.cacheRead} cached, $${seeded.totals.cost}`);

const stAt = Date.now();
pushTree({
  id: 'st_1',
  created: stAt,
  type: 'session.step.started',
  data: { sessionID: 'ses_st_child', assistantMessageID: 'msg_st', started: stAt },
});
for (let i = 0; i < 12; i += 1) {
  pushTree({
    id: `st_d${i}`,
    created: stAt + 100 + i * 80,
    type: 'session.text.delta',
    data: { sessionID: 'ses_st_child', assistantMessageID: 'msg_st', ordinal: 0, delta: 'w'.repeat(60) },
  });
}
await new Promise((resolve) => setTimeout(resolve, 700));
const liveChild = await treeGet();
check(
  'a subagent makes the parent generate instead of reading zero',
  liveChild.status === 'streaming' &&
    liveChild.live.subagent === true &&
    liveChild.subagents.active?.[0]?.tps > 0 &&
    liveChild.series.v.some((value) => value > 0),
  `${liveChild.status}, subagent ${liveChild.live.subagent}, row ${liveChild.subagents.active?.[0]?.tps} t/s, peak ${Math.max(...liveChild.series.v)} t/s`,
);
pushTree({
  id: 'st_end',
  created: stAt + 1500,
  type: 'session.step.ended',
  data: {
    sessionID: 'ses_st_child',
    assistantMessageID: 'msg_st',
    finish: 'stop',
    cost: 0,
    tokens: { input: 5, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
  },
});
await new Promise((resolve) => setTimeout(resolve, 400));
const childStep = await treeGet();
check('a subagent step is not counted twice on a cumulative record', childStep.totals.output === 13, `${childStep.totals.output} out`);
check(
  'a subagent step is drawn as one',
  Array.isArray(childStep.steps) && childStep.steps.some((step) => step.sub === true),
  JSON.stringify(childStep.steps?.at(-1)),
);
pushTree({
  id: 'st_usage',
  created: stAt + 1600,
  type: 'session.usage.updated',
  data: {
    sessionID: 'ses_st_child',
    cost: 0.02,
    tokens: { input: 55, output: 50, reasoning: 2, cache: { read: 70, write: 0 } },
  },
});
await new Promise((resolve) => setTimeout(resolve, 400));
const childUsage = await treeGet();
check('a subagent usage event moves the parent total once', childUsage.totals.output === 53, `${childUsage.totals.output} out`);

// A child created after the last lineage read places itself from its parent
// chain on its first event.
records.ses_st_late = {
  id: 'ses_st_late',
  parentID: 'ses_st_child',
  cost: 0.001,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  time: {},
};
pushTree({
  id: 'st_late',
  created: stAt + 2000,
  type: 'session.step.started',
  data: { sessionID: 'ses_st_late', assistantMessageID: 'msg_late', started: stAt + 2000 },
});
await new Promise((resolve) => setTimeout(resolve, 500));
const late = await treeGet();
check('a subagent created between scans places itself', late.subagents?.count === 3, JSON.stringify(late.subagents));
// A watched tree whose subagent is streaming must survive collector eviction.
pushTree({
  id: 'st_again',
  created: stAt + 3000,
  type: 'session.step.started',
  data: { sessionID: 'ses_st_child', assistantMessageID: 'msg_again', started: stAt + 3000 },
});
for (let i = 0; i < 4; i += 1) {
  pushTree({
    id: `st_again_${i}`,
    created: stAt + 3100 + i * 80,
    type: 'session.text.delta',
    data: { sessionID: 'ses_st_child', assistantMessageID: 'msg_again', ordinal: 0, delta: 'v'.repeat(40) },
  });
}
await new Promise((resolve) => setTimeout(resolve, 500));
for (let i = 1; i <= 6; i += 1) {
  await fetch(`http://127.0.0.1:${treePort}/state?session=ses_fill_${i}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
const survived = await treeGet();
check(
  'a tree with a streaming subagent is not evicted',
  survived.subagents?.count === 3 && survived.status === 'streaming',
  `${survived.subagents?.count} subagents, ${survived.status}`,
);
treeService.stop();

service.stop();
const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(process.exitCode ?? 0);
