// Automatic recording is a service responsibility, not a side effect of /state.
// Real HTTP + fake OpenCode event stream; no live credentials or browser needed.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCHAMBER_SERVICE_PORT = '1';
process.env.OPENCHAMBER_SERVICE_TOKEN = 'test-token';
process.env.TOKEN_METER_NO_LISTEN = '1';
process.env.TOKEN_METER_SCAN_MS = '150';
process.env.TOKEN_METER_RECORD_FRESH_MS = '300';
const { createService } = await import('../service/src/main.js');
const { createRecordingStore } = await import('../service/src/recordings.js');
let dir = await mkdtemp(path.join(os.tmpdir(), 'token-recordings-'));
const records = new Map();
const started = Date.now();
const record = (id, parentID = null, busy = true) => ({
  id, parentID, title: 'NEVER_STORE_TITLE',
  model: { id: 'test-model', providerID: 'test-provider' },
  time: { created: started - 60_000, updated: Date.now(), busy: busy ? Date.now() : started - 60_000, idle: busy ? null : started - 50_000 },
});
let service = null;
let controller = null;
let port = null;
let historyReads = 0;
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`PASS  ${name}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('recording fixture did not become ready');
    await delay(10);
  }
}
async function start() {
  controller = null;
  service = createService({
    port: 0, token: 'test-token', base: 'http://127.0.0.1:9', dataDir: dir, priceBook: null,
    fetchImpl: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
      if (u.pathname === '/api/session') {
        const parent = u.searchParams.get('parentID');
        return Response.json({ data: [...records.values()].filter((item) => parent === null || item.parentID === parent) });
      }
      if (u.pathname.endsWith('/message')) {
        historyReads += 1;
        return Response.json({ data: [] });
      }
      const id = decodeURIComponent(u.pathname.split('/').at(-1));
      // A record read that is slow must not stop the idle graph reaching now.
      if (id === 'ses_pending_zero') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return new Response('{"message":"slow"}', { status: 503 });
      }
      const one = records.get(id);
      return one ? Response.json({ data: one }) : new Response('{"message":"not found"}', { status: 404 });
    },
  });
  const server = service.start();
  await once(server, 'listening');
  port = server.address().port;
  await until(() => controller !== null);
}
async function stop() {
  if (!service) return;
  controller?.close();
  await service.stop();
  service = null;
}
function event(id, type, extra = {}) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, created: Date.now(), data: { sessionID: id, ...extra } })}\n\n`));
}
async function burst(id, { startTurn = true } = {}) {
  if (startTurn) {
    event(id, 'session.execution.started', { started: Date.now() });
    event(id, 'session.step.started', { assistantMessageID: `msg_${id}` });
  }
  for (let i = 0; i < 6; i += 1) {
    event(id, 'session.text.delta', { assistantMessageID: `msg_${id}`, delta: 'NEVER_STORE_BODY'.repeat(10) });
    await delay(260);
  }
}
async function state(id) {
  const response = await fetch(`http://127.0.0.1:${port}/state?session=${id}`, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  check('host starts the recorder without a panel request', () => assert.equal(manifest.openchamber.contributes.service.keepRunning, true));
  await start();
  records.set('ses_unopened', record('ses_unopened'));
  await burst('ses_unopened');
  check('automatic capture does not read message histories in the background', () => assert.equal(historyReads, 0));
  const live = await state('ses_unopened');
  check('a never-opened generating session already has a real live curve', () => {
    assert.ok(live.series.v.length >= 4);
    assert.ok(live.series.v.some((v) => v > 0));
    assert.equal(live.recording.state, 'live');
    assert.ok(live.recording.startedAt < Date.now() - 1000);
  });
  records.set('ses_unopened', { ...records.get('ses_unopened'), time: { ...records.get('ses_unopened').time, idle: Date.now() } });
  event('ses_unopened', 'session.execution.succeeded');
  await delay(280);
  const ended = await state('ses_unopened');
  await delay(280);
  const quiet = await state('ses_unopened');
  check('completion freezes the recording instead of replacing it with idle zeros', () => {
    assert.equal(ended.recording.state, 'saved');
    assert.ok(ended.recording.endedAt > 0);
    assert.equal(quiet.recording.endedAt, ended.recording.endedAt);
    // A finished turn keeps sampling zeros while the panel asks for answers,
    // so the frame can hold a flat line at `now`.
    assert.ok(quiet.recording.lastSampleAt > ended.recording.lastSampleAt);
    assert.equal(quiet.series.v.at(-1), 0);
    // The curve must settle at zero, not freeze at the rate it ended on.
    assert.equal(ended.series.v.at(-1), 0);
    const lastAt = ended.series.t0 + ended.series.d.at(-1);
    assert.ok(lastAt <= ended.recording.endedAt && ended.recording.endedAt - lastAt <= 1000);
    assert.ok(ended.series.v.slice(0, -1).some((v) => v > 0));
  });
  await stop();
  const disk = await readFile(path.join(dir, 'graphs.json'), 'utf8');
  check('saved graphs never contain conversation text or session titles', () => {
    assert.ok(!disk.includes('NEVER_STORE_BODY'));
    assert.ok(!disk.includes('NEVER_STORE_TITLE'));
    assert.ok(!disk.includes('test-token'));
  });
  await start();
  const restored = await state('ses_unopened');
  check('recorded samples, offsets and end time survive a service restart', () => {
    assert.ok(restored.series.v.length > 0);
    assert.equal(restored.series.v.at(-1), 0);
    assert.equal(restored.recording.state, 'saved');
    assert.equal(restored.recording.endedAt, ended.recording.endedAt);
  });
  records.set('ses_unopened', record('ses_unopened'));
  await burst('ses_unopened');
  const resumed = await state('ses_unopened');
  check('a new turn resumes live recording rather than staying frozen', () => {
    assert.equal(resumed.recording.state, 'live');
    assert.equal(resumed.recording.endedAt, null);
    assert.ok(resumed.recording.lastSampleAt > restored.recording.lastSampleAt);
  });
  await stop();
  // A recording that was active when the service stopped must not trust the
  // record's retained busy flag after a restart: that turn ended meanwhile.
  records.set('ses_crashed', record('ses_crashed'));
  await start();
  await burst('ses_crashed');
  const beforeCrash = await state('ses_crashed');
  check('a recording is active before an abrupt stop', () => assert.equal(beforeCrash.recording.state, 'live'));
  await stop();
  records.set('ses_crashed', { ...record('ses_crashed'), time: { created: started - 60_000, updated: started - 50_000, busy: started - 50_000 } });
  await start();
  await delay(400);
  const revived = await state('ses_crashed');
  check('a restored recording settles instead of trusting a stale busy flag', () => {
    assert.equal(revived.recording.state, 'saved');
  });
  records.set('ses_stale_busy', { ...record('ses_stale_busy'), time: { created: started - 3_600_000, updated: started - 1_800_000, busy: started - 1_800_000, idle: null } });
  await delay(400);
  const stale = await state('ses_stale_busy');
  check('an old busy record does not start a phantom live graph', () => {
    assert.equal(stale.recording.state, 'unrecorded');
    assert.equal(stale.series.v.length, 0);
  });
  await stop();
  records.clear();
  records.set('ses_boot_busy', record('ses_boot_busy'));
  await start();
  await delay(300);
  await burst('ses_boot_busy', { startTurn: false });
  const boot = await state('ses_boot_busy');
  check('startup discovers sessions already generating before the recorder launched', () => {
    assert.equal(boot.recording.state, 'live');
    assert.ok(boot.series.v.length >= 4);
    assert.ok(boot.series.v.some((v) => v > 0));
  });
  records.set('ses_unopened_parent', record('ses_unopened_parent', null, false));
  records.set('ses_unopened_child', record('ses_unopened_child', 'ses_unopened_parent'));
  await burst('ses_unopened_child');
  const parent = await state('ses_unopened_parent');
  const child = await state('ses_unopened_child');
  check('an unopened parent captures the rate generated by its unopened subagent', () => {
    assert.ok(parent.series.v.some((v) => v > 0));
    assert.ok(child.series.v.some((v) => v > 0));
    assert.ok(parent.subagents.count >= 1);
  });
  await stop();
  // A missed success event leaves the collector working; a discovery read of an
  // idle record must settle it, even though that record is older than 15 s.
  records.set('ses_stale_idle', record('ses_stale_idle'));
  await start();
  await burst('ses_stale_idle');
  // The record is written after the last event, then goes stale: the exact
  // shape that used to pin the graph live forever.
  records.set('ses_stale_idle', { ...record('ses_stale_idle'), time: { created: started - 60_000, updated: Date.now(), busy: Date.now() - 5_000, idle: Date.now() - 1_000 } });
  await delay(900);
  const staleIdle = await state('ses_stale_idle');
  check('a stale idle record still ends a missed turn', () => {
    assert.equal(staleIdle.recording.state, 'saved');
    assert.equal(staleIdle.series.v.at(-1), 0);
  });
  await stop();

  // A recording saved as active before an abrupt stop must settle beside its
  // last sample, not at the moment it is reopened (an empty 60 s window).
  const seedDir = await mkdtemp(path.join(os.tmpdir(), 'token-seed-'));
  const seedStore = (await import('../service/src/recordings.js')).createRecordingStore({ dataDir: seedDir });
  const lastSample = Date.now() - 20 * 60_000;
  seedStore.capture({
    id: 'ses_seeded_old', captureStartedAt: lastSample - 5000, captureEndedAt: null,
    series: [{ t: lastSample - 1000, v: 40 }, { t: lastSample, v: 12 }],
    seriesLong: [], seriesWide: [],
  }, Date.now());
  await seedStore.flush();
  const keptDir = dir;
  dir = seedDir; // start() reads this directory from now on
  records.clear();
  records.set('ses_seeded_old', { ...record('ses_seeded_old'), time: { created: lastSample - 60_000, updated: lastSample, busy: lastSample, idle: null } });
  await start();
  const seeded = await state('ses_seeded_old');
  check('a restored recording ends beside its last sample, so its curve is visible', () => {
    const lastAt = seeded.series.t0 + seeded.series.d.at(-1);
    assert.equal(seeded.recording.state, 'saved');
    assert.ok(seeded.recording.endedAt - lastAt < 1000);
    assert.ok(seeded.series.v.length >= 2);
    // The pre-fix record ended high; a finished graph must settle to zero.
    assert.equal(seeded.series.v.at(-1), 0);
  });
  await stop();
  await rm(seedDir, { recursive: true, force: true });
  dir = keptDir;

  // A deleted session settles instead of holding a live graph forever. One
  // service: the burst runs, then the session disappears from OpenCode.
  records.clear();
  records.set('ses_deleted', record('ses_deleted'));
  await start();
  await burst('ses_deleted');
  records.clear();
  await delay(800);
  const deleted = await state('ses_deleted');
  check('a deleted session settles its graph instead of keeping it live', () => {
    assert.equal(deleted.recording.state, 'saved');
    assert.equal(deleted.series.v.at(-1), 0);
  });
  await stop();

  // A permission wait is not generation: no flat "recorded graph" and no slot.
  records.set('ses_perm', record('ses_perm'));
  await start();
  event('ses_perm', 'permission.asked', { permissionID: 'p1' });
  await delay(80);
  event('ses_perm', 'permission.replied', { permissionID: 'p1' });
  records.set('ses_perm', { ...record('ses_perm'), time: { created: started - 60_000, updated: Date.now(), busy: started - 50_000, idle: Date.now() } });
  event('ses_perm', 'session.execution.succeeded');
  await delay(600);
  const perm = await state('ses_perm');
  check('a permission wait with no generation is not saved as a recording', () => {
    assert.equal(perm.recording.state, 'unrecorded');
    assert.equal(perm.series.v.length, 0);
  });
  await stop();

  // While a restored recording waits for its record read, an idle graph must
  // still emit zero samples, or its last rate is held as a long line.
  await stop();
  const pendingSeed = createRecordingStore({ dataDir: dir });
  pendingSeed.capture({
    id: 'ses_pending_zero', captureStartedAt: Date.now() - 30_000, captureEndedAt: null,
    series: [{ t: Date.now() - 30_000, v: 90 }], seriesLong: [], seriesWide: [],
  }, Date.now());
  await pendingSeed.flush();
  await start();
  await delay(600);
  const pending = await state('ses_pending_zero');
  check('an idle pending graph reaches now at zero', () => {
    assert.equal(pending.recording.state, 'live');
    assert.equal(pending.series.v.at(-1), 0);
  });
  await stop();

  await start();
  records.set('ses_never_recorded', record('ses_never_recorded', null, false));
  const old = await state('ses_never_recorded');
  check('a finished session with no recording is not given a fabricated live curve', () => {
    assert.equal(old.recording.state, 'unrecorded');
    assert.equal(old.recording.endedAt, null);
    assert.equal(old.series.v.length, 0);
  });
  console.log(`\n${checks}/${checks} recording integration checks passed`);
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
