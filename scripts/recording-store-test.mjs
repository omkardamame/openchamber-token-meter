// Standalone checks for the saved live-graph recordings.
// No OpenCode, no browser, no network: every file lives under one temp root
// created here and removed again on the way out.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecordingStore } from '../service/src/recordings.js';

const BASE = 1_760_000_000_000;
const HOUR = 3_600_000;
const roots = [];
const checks = [];
const test = (name, run) => checks.push({ name, run });
const tempDir = (label) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `token-meter-${label}-`));
  roots.push(dir);
  return dir;
};
const fileOf = (dataDir) => path.join(dataDir, 'graphs.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const recordKeys = ['endedAt', 'id', 'series', 'seriesLong', 'seriesWide', 'startedAt', 'updatedAt'];

function cleanup() {
  for (const dir of roots) {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`cleanup failed for ${dir}: ${error?.message ?? error}`);
    }
  }
}

test('RS-01 capture stores exactly the whitelisted recording fields', () => {
  const dataDir = tempDir('fields');
  const store = createRecordingStore({ dataDir });
  const startedAt = BASE - 120_000;
  const endedAt = BASE - 2_000;
  const collector = {
    id: 'ses-abc_1',
    series: [
      { t: endedAt - 2_000, v: 10.5 },
      { t: startedAt, v: 0 },
      { t: endedAt, v: 2.25 },
    ],
    seriesLong: [{ t: endedAt - 10_000, sum: 12, n: 2 }],
    seriesWide: [{ t: endedAt - 600_000, sum: 30.5, n: 5 }],
    captureStartedAt: startedAt,
    captureEndedAt: endedAt,
    title: 'PRIVATE-TITLE-fields',
    messages: [{ text: 'PRIVATE-MESSAGE-fields' }],
    credentials: { token: 'PRIVATE-TOKEN-fields' },
    totals: { input: 12345, output: 678 },
    model: 'private/model',
  };
  const expected = {
    id: 'ses-abc_1',
    startedAt,
    endedAt,
    updatedAt: BASE,
    series: [
      { t: startedAt, v: 0 },
      { t: endedAt - 2_000, v: 10.5 },
      { t: endedAt, v: 2.25 },
    ],
    seriesLong: [{ t: endedAt - 10_000, sum: 12, n: 2 }],
    seriesWide: [{ t: endedAt - 600_000, sum: 30.5, n: 5 }],
  };
  assert.deepEqual(store.capture(collector, BASE), expected);
  const saved = store.get('ses-abc_1');
  assert.deepEqual(saved, expected);
  assert.deepEqual(Object.keys(saved).sort(), recordKeys);
});

test('RS-02 empty captures never insert or disturb a record', async () => {
  const dataDir = tempDir('empty');
  const store = createRecordingStore({ dataDir });
  assert.equal(store.capture({ id: 'sesempty', series: [], seriesLong: [], seriesWide: [] }, BASE), null);
  assert.equal(store.capture({ id: 'sesempty' }, BASE), null);
  assert.equal(
    store.capture({ id: 'sesempty', series: [{ t: BASE, v: -1 }], seriesLong: [], seriesWide: [] }, BASE),
    null,
  );
  assert.equal(store.get('sesempty'), null);
  assert.equal(await store.flush(), true);
  assert.equal(existsSync(fileOf(dataDir)), false);

  const first = store.capture(
    {
      id: 'seskeep',
      series: [{ t: BASE - 1_000, v: 4 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 5_000,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.ok(first);
  const quiet = store.capture(
    { id: 'seskeep', series: [], seriesLong: [], seriesWide: [], captureEndedAt: null },
    BASE + 5_000,
  );
  assert.deepEqual(quiet, first, 'an empty capture must not refresh updatedAt or the window');
  assert.deepEqual(store.get('seskeep'), first);
  assert.equal(await store.flush(), true);
  assert.equal(existsSync(fileOf(dataDir)), true);
});

test('RS-03 get returns a deep copy, so neither side can mutate the other', () => {
  const store = createRecordingStore();
  const series = [{ t: BASE - 3_000, v: 1.5 }];
  const seriesLong = [{ t: BASE - 10_000, sum: 3, n: 1 }];
  const seriesWide = [{ t: BASE - 20_000, sum: 4, n: 2 }];
  const collector = {
    id: 'sescopy',
    series,
    seriesLong,
    seriesWide,
    captureStartedAt: BASE - 100_000,
    captureEndedAt: null,
  };
  store.capture(collector, BASE);

  series[0].v = 99;
  series.push({ t: BASE, v: 7 });
  seriesLong[0].n = 9;
  seriesWide.push({ t: BASE - 1, sum: 0, n: 1 });
  collector.id = 'sesother';
  collector.title = 'later mutation';

  let saved = store.get('sescopy');
  assert.deepEqual(saved.series, [{ t: BASE - 3_000, v: 1.5 }]);
  assert.deepEqual(saved.seriesLong, [{ t: BASE - 10_000, sum: 3, n: 1 }]);
  assert.deepEqual(saved.seriesWide, [{ t: BASE - 20_000, sum: 4, n: 2 }]);

  saved.series[0].v = -5;
  saved.series.push({ t: BASE, v: 8 });
  saved.seriesLong[0].n = 77;
  saved.id = 'seschanged';
  saved.endedAt = 123;
  saved.extra = true;

  saved = store.get('sescopy');
  assert.deepEqual(saved.series, [{ t: BASE - 3_000, v: 1.5 }]);
  assert.deepEqual(saved.seriesLong, [{ t: BASE - 10_000, sum: 3, n: 1 }]);
  assert.equal(saved.id, 'sescopy');
  assert.equal(saved.endedAt, null);
  assert.equal('extra' in saved, false);
  assert.equal(store.get('missing'), null);
  assert.equal(store.get(7), null);
  assert.equal(store.get(undefined), null);
});

test('RS-04 caps keep the newest 240 / 300 / 360 samples', () => {
  const store = createRecordingStore();
  const live = Array.from({ length: 500 }, (_, i) => ({ t: BASE - 500 + i, v: i }));
  const long = Array.from({ length: 500 }, (_, i) => ({ t: BASE - 500_000 + i * 100, sum: i, n: i + 1 }));
  const wide = Array.from({ length: 500 }, (_, i) => ({ t: BASE - 2_000_000 + i * 1_000, sum: i * 2, n: 3 }));
  store.capture(
    {
      id: 'sescaps',
      series: live,
      seriesLong: long,
      seriesWide: wide,
      captureStartedAt: BASE - HOUR,
      captureEndedAt: null,
    },
    BASE,
  );
  const saved = store.get('sescaps');
  assert.equal(saved.series.length, 240);
  assert.deepEqual(saved.series[0], { t: BASE - 500 + 260, v: 260 });
  assert.deepEqual(saved.series[239], { t: BASE - 1, v: 499 });
  assert.equal(saved.seriesLong.length, 300);
  assert.deepEqual(saved.seriesLong[0], { t: BASE - 500_000 + 200 * 100, sum: 200, n: 201 });
  assert.deepEqual(saved.seriesLong[299], { t: BASE - 500_000 + 499 * 100, sum: 499, n: 500 });
  assert.equal(saved.seriesWide.length, 360);
  assert.deepEqual(saved.seriesWide[0], { t: BASE - 2_000_000 + 140 * 1_000, sum: 280, n: 3 });
  assert.deepEqual(saved.seriesWide[359], { t: BASE - 2_000_000 + 499 * 1_000, sum: 998, n: 3 });
  assert.deepEqual(Object.keys(saved.series[0]).sort(), ['t', 'v']);
  assert.deepEqual(Object.keys(saved.seriesLong[0]).sort(), ['n', 'sum', 't']);
  for (let i = 1; i < saved.seriesWide.length; i += 1) {
    assert.ok(saved.seriesWide[i - 1].t < saved.seriesWide[i].t);
  }
});

test('RS-05 every series is pruned to the last hour of endedAt or now', () => {
  const store = createRecordingStore();
  const endedAt = BASE - 1_000;
  store.capture(
    {
      id: 'seswindow',
      series: [
        { t: endedAt - HOUR, v: 1 },
        { t: endedAt - HOUR - 1, v: 2 },
        { t: endedAt, v: 3 },
        { t: endedAt + 1, v: 4 },
        { t: 0, v: 5 },
        { t: -1, v: 6 },
        { t: Number.NaN, v: 7 },
        { t: '1', v: 8 },
      ],
      seriesLong: [
        { t: endedAt - HOUR, sum: 1, n: 1 },
        { t: endedAt - HOUR - 1, sum: 2, n: 1 },
        { t: endedAt, sum: 3, n: 1 },
      ],
      seriesWide: [
        { t: endedAt - HOUR, sum: 1, n: 1 },
        { t: endedAt - HOUR - 1, sum: 2, n: 1 },
      ],
      captureStartedAt: endedAt - HOUR,
      captureEndedAt: endedAt,
    },
    BASE,
  );
  const saved = store.get('seswindow');
  assert.deepEqual(saved.series, [
    { t: endedAt - HOUR, v: 1 },
    { t: endedAt, v: 3 },
  ]);
  assert.deepEqual(saved.seriesLong, [
    { t: endedAt - HOUR, sum: 1, n: 1 },
    { t: endedAt, sum: 3, n: 1 },
  ]);
  assert.deepEqual(saved.seriesWide, [{ t: endedAt - HOUR, sum: 1, n: 1 }]);

  store.capture(
    {
      id: 'sesactive',
      series: [
        { t: BASE - HOUR, v: 1 },
        { t: BASE - HOUR - 1, v: 2 },
        { t: BASE, v: 3 },
      ],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - HOUR,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.deepEqual(store.get('sesactive').series, [
    { t: BASE - HOUR, v: 1 },
    { t: BASE, v: 3 },
  ]);
  assert.equal(
    store.capture({ id: 'sesold', series: [{ t: BASE - HOUR - 1, v: 1 }], seriesLong: [], seriesWide: [] }, BASE),
    null,
  );
});

test('RS-06 samples sort by time, dedupe by last value and reject bad numbers', () => {
  const store = createRecordingStore();
  store.capture(
    {
      id: 'sessort',
      series: [
        { t: BASE - 2_000, v: 10 },
        { t: BASE - 1_000, v: 20 },
        { t: BASE - 2_000, v: 11 },
        { t: BASE - 3_000, v: 12 },
        { t: BASE, v: -0.5 },
        { t: BASE, v: Number.POSITIVE_INFINITY },
        { t: BASE, v: '5' },
        { t: BASE - 5, v: Number.NaN },
      ],
      seriesLong: [
        { t: BASE - 2_000, sum: 1, n: 1 },
        { t: BASE - 1_000, sum: 2, n: 2 },
        { t: BASE - 2_000, sum: 9, n: 9 },
        { t: BASE - 3_000, sum: -1, n: 1 },
        { t: BASE - 3_000, sum: 1, n: 0 },
        { t: BASE - 3_000, sum: 1, n: 1.5 },
        { t: BASE - 3_000, sum: Number.NaN, n: 1 },
      ],
      seriesWide: [
        { t: BASE - 1_000, sum: 0, n: 1 },
        { t: BASE - 500, sum: 2, n: 3 },
      ],
      captureStartedAt: BASE - 10_000,
      captureEndedAt: null,
    },
    BASE,
  );
  const saved = store.get('sessort');
  assert.deepEqual(saved.series, [
    { t: BASE - 3_000, v: 12 },
    { t: BASE - 2_000, v: 11 },
    { t: BASE - 1_000, v: 20 },
  ]);
  assert.deepEqual(saved.seriesLong, [
    { t: BASE - 2_000, sum: 9, n: 9 },
    { t: BASE - 1_000, sum: 2, n: 2 },
  ]);
  assert.deepEqual(saved.seriesWide, [
    { t: BASE - 1_000, sum: 0, n: 1 },
    { t: BASE - 500, sum: 2, n: 3 },
  ]);
});

test('RS-07 maxSessions clamps to 1..200 and evicts the least recently updated', () => {
  const put = (store, id, now) =>
    store.capture(
      {
        id,
        series: [{ t: now - 10, v: 1 }],
        seriesLong: [],
        seriesWide: [],
        captureStartedAt: now - 1_000,
        captureEndedAt: null,
      },
      now,
    );

  const store = createRecordingStore({ maxSessions: 3 });
  put(store, 'sesa', BASE);
  put(store, 'sesb', BASE + 1_000);
  put(store, 'sesc', BASE + 2_000);
  put(store, 'sesa', BASE + 3_000);
  put(store, 'sesd', BASE + 4_000);
  assert.ok(store.get('sesa'));
  assert.equal(store.get('sesb'), null);
  assert.ok(store.get('sesc'));
  assert.ok(store.get('sesd'));

  const one = createRecordingStore({ maxSessions: 0 });
  put(one, 'sesone', BASE);
  put(one, 'sestwo', BASE + 1_000);
  assert.equal(one.get('sesone'), null);
  assert.ok(one.get('sestwo'));

  const many = createRecordingStore({ maxSessions: 10_000 });
  const idOf = (index) => `ses${String(index).padStart(3, '0')}`;
  for (let index = 0; index < 201; index += 1) {
    put(many, idOf(index), BASE + index * 1_000);
  }
  assert.equal(many.get(idOf(0)), null);
  assert.ok(many.get(idOf(200)));
  let kept = 0;
  for (let index = 0; index < 201; index += 1) {
    if (many.get(idOf(index))) kept += 1;
  }
  assert.equal(kept, 200);
});

test('RS-08 flush persists exact records and a reload matches them', async () => {
  const root = tempDir('persist');
  const dataDir = path.join(root, 'data');
  const store = createRecordingStore({ dataDir });
  const startedAt = BASE - 200_000;
  const endedAt = BASE - 5_000;
  store.capture(
    {
      id: 'sespersist-a',
      series: [
        { t: endedAt - 1_000, v: 1 },
        { t: endedAt, v: 2 },
      ],
      seriesLong: [{ t: endedAt - 30_000, sum: 9, n: 3 }],
      seriesWide: [{ t: endedAt - 600_000, sum: 20, n: 4 }],
      captureStartedAt: startedAt,
      captureEndedAt: endedAt,
      title: 'PRIVATE-TITLE-persist',
      messages: [{ text: 'PRIVATE-MESSAGE-persist' }],
      credentials: { token: 'PRIVATE-TOKEN-persist' },
    },
    BASE,
  );
  store.capture(
    {
      id: 'sespersist-b',
      series: [{ t: BASE + 900, v: 0.25 }],
      seriesLong: [],
      seriesWide: [{ t: BASE - 10_000, sum: 1, n: 1 }],
      captureStartedAt: BASE - 2_000,
      captureEndedAt: null,
    },
    BASE + 1_000,
  );
  const beforeA = store.get('sespersist-a');
  const beforeB = store.get('sespersist-b');
  assert.equal(await store.flush(), true);
  assert.equal(store.error, null);

  const file = fileOf(dataDir);
  assert.equal(existsSync(file), true);
  const raw = readJson(file);
  assert.equal(raw.version, 1);
  assert.equal(raw.recordings.length, 2);
  for (const record of raw.recordings) {
    assert.deepEqual(Object.keys(record).sort(), recordKeys);
  }
  assert.deepEqual(raw.recordings.find((record) => record.id === 'sespersist-a'), beforeA);
  assert.deepEqual(raw.recordings.find((record) => record.id === 'sespersist-b'), beforeB);

  assert.equal(statSync(dataDir).mode & 0o077, 0);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(statSync(file).mode & 0o600, 0o600);
  const text = readFileSync(file, 'utf8');
  for (const secret of ['PRIVATE-TITLE-persist', 'PRIVATE-MESSAGE-persist', 'PRIVATE-TOKEN-persist']) {
    assert.equal(text.includes(secret), false);
  }

  const reloaded = createRecordingStore({ dataDir });
  assert.equal(reloaded.error, null);
  assert.deepEqual(reloaded.get('sespersist-a'), beforeA);
  assert.deepEqual(reloaded.get('sespersist-b'), beforeB);

  rmSync(file);
  assert.equal(await reloaded.flush(), true);
  assert.equal(existsSync(file), false, 'a clean store must not rewrite the file');
});

test('RS-09 overlapping flushes run in order and the newest state wins', async () => {
  const root = tempDir('flushes');
  const dataDir = path.join(root, 'data');
  const store = createRecordingStore({ dataDir });
  const pending = [];
  for (let index = 0; index < 6; index += 1) {
    const at = BASE + index * 1_000;
    store.capture(
      {
        id: 'sesrace',
        series: [{ t: at - 10, v: index }],
        seriesLong: [],
        seriesWide: [],
        captureStartedAt: BASE - 1_000,
        captureEndedAt: null,
      },
      at,
    );
    pending.push(store.flush());
  }
  const results = await Promise.all(pending);
  assert.deepEqual(results, [true, true, true, true, true, true]);
  assert.equal(store.error, null);
  const raw = readJson(fileOf(dataDir));
  assert.equal(raw.recordings.length, 1);
  assert.equal(raw.recordings[0].updatedAt, BASE + 5_000);
  assert.deepEqual(raw.recordings[0].series, [{ t: BASE + 5_000 - 10, v: 5 }]);
  assert.deepEqual(readdirSync(dataDir), ['graphs.json']);
});

test('RS-10 a capture during a flush stays dirty for the next flush', async () => {
  const root = tempDir('midflush');
  const dataDir = path.join(root, 'data');
  const store = createRecordingStore({ dataDir });
  store.capture(
    {
      id: 'sesmid',
      series: [{ t: BASE - 10, v: 1 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 1_000,
      captureEndedAt: null,
    },
    BASE,
  );
  const pending = store.flush();
  await new Promise((resolve) => setImmediate(resolve));
  store.capture(
    {
      id: 'sesmid',
      series: [{ t: BASE + 990, v: 7 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 1_000,
      captureEndedAt: null,
    },
    BASE + 1_000,
  );
  assert.deepEqual(store.get('sesmid').series, [{ t: BASE + 990, v: 7 }]);
  assert.equal(await pending, true);
  assert.equal(await store.flush(), true);
  const raw = readJson(fileOf(dataDir));
  assert.deepEqual(raw.recordings[0].series, [{ t: BASE + 990, v: 7 }]);
  assert.deepEqual(readdirSync(dataDir), ['graphs.json']);
});

test('RS-11 a failed write keeps the old file, reports it and retries', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('SKIP  RS-11 write permissions cannot be restricted as root');
    return;
  }
  const root = tempDir('failure');
  const dataDir = path.join(root, 'data');
  const store = createRecordingStore({ dataDir });
  store.capture(
    {
      id: 'sesfail',
      series: [{ t: BASE - 10, v: 1 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 1_000,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.equal(await store.flush(), true);
  const file = fileOf(dataDir);
  const before = readFileSync(file, 'utf8');

  store.capture(
    {
      id: 'sesfail',
      series: [{ t: BASE + 990, v: 2 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 1_000,
      captureEndedAt: null,
    },
    BASE + 1_000,
  );
  chmodSync(dataDir, 0o500);
  try {
    assert.equal(await store.flush(), false);
    assert.equal(typeof store.error, 'string');
    assert.match(store.error, /could not write/);
    assert.equal(store.error.includes('"series"'), false);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(store.get('sesfail').series, [{ t: BASE + 990, v: 2 }]);
    assert.equal(await store.flush(), false, 'a failed write stays dirty and retries');
  } finally {
    chmodSync(dataDir, 0o700);
  }

  assert.equal(await store.flush(), true);
  assert.equal(store.error, null);
  assert.deepEqual(readJson(file).recordings[0].series, [{ t: BASE + 990, v: 2 }]);
  assert.deepEqual(readdirSync(dataDir), ['graphs.json']);
});

test('RS-12 malformed captures are rejected or filtered without throwing', () => {
  const lines = [];
  const store = createRecordingStore({ log: (line) => lines.push(line) });
  const rejected = [
    undefined,
    null,
    'sesx',
    [],
    {},
    { id: 42 },
    { id: 'bad' },
    { id: 'ses' },
    { id: 'sesA!' },
    { id: `ses${'a'.repeat(121)}` },
    { id: ' sesx' },
  ];
  for (const collector of rejected) assert.equal(store.capture(collector, BASE), null);
  assert.ok(lines.length > 0);
  const longest = `ses${'a'.repeat(120)}`;
  const accepted = store.capture(
    {
      id: longest,
      series: [{ t: BASE - 10, v: 1 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 100,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.equal(accepted.id, longest);

  assert.equal(
    store.capture(
      { id: 'sescontainers', series: {}, seriesLong: 'x', seriesWide: null, captureStartedAt: BASE - 100, captureEndedAt: null },
      BASE,
    ),
    null,
  );

  const clocked = store.capture(
    {
      id: 'sesclock',
      series: [{ t: Date.now() - 100, v: 1 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: 0,
      captureEndedAt: 'later',
    },
    Number.NaN,
  );
  assert.ok(clocked);
  assert.ok(Number.isFinite(clocked.updatedAt) && clocked.updatedAt > 0);
  assert.ok(Number.isFinite(clocked.startedAt) && clocked.startedAt > 0);
  assert.equal(clocked.endedAt, null);

  const filtered = store.capture(
    {
      id: 'sesfiltered',
      series: [
        { t: BASE - 10, v: 1 },
        { t: BASE - 5, v: -1 },
        { t: 'x', v: 2 },
        { t: BASE + 1_000_000, v: 3 },
        null,
        [],
      ],
      seriesLong: [{ t: BASE - 10, sum: 1, n: 1 }],
      seriesWide: [],
      captureStartedAt: BASE - 100,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.deepEqual(filtered.series, [{ t: BASE - 10, v: 1 }]);
  assert.deepEqual(filtered.seriesLong, [{ t: BASE - 10, sum: 1, n: 1 }]);
  assert.ok(lines.some((line) => line.includes('invalid sample')));
});

test('RS-13 load keeps good records and skips bad entries with diagnostics', () => {
  const root = tempDir('entries');
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const good = {
    id: 'sesgood',
    startedAt: 1_000,
    endedAt: 2_000,
    updatedAt: 3_000,
    series: [{ t: 1_000, v: 1 }],
    seriesLong: [{ t: 1_500, sum: 2, n: 2 }],
    seriesWide: [],
  };
  const capped = {
    id: 'sescapsload',
    startedAt: 1_000,
    endedAt: null,
    updatedAt: 4_000,
    series: Array.from({ length: 300 }, (_, i) => ({ t: 1_000 + i, v: i })),
    seriesLong: Array.from({ length: 400 }, (_, i) => ({ t: 1_000 + i, sum: i, n: 1 })),
    seriesWide: Array.from({ length: 500 }, (_, i) => ({ t: 1_000 + i, sum: i, n: 1 })),
  };
  const entries = [
    good,
    capped,
    { id: 'bad', startedAt: 1_000, endedAt: null, updatedAt: 2_000, series: [], seriesLong: [], seriesWide: [] },
    { id: 'sesbadstart', startedAt: 0, endedAt: null, updatedAt: 2_000, series: [{ t: 1_000, v: 1 }], seriesLong: [], seriesWide: [] },
    { id: 'sesbadend', startedAt: 1_000, endedAt: 'x', updatedAt: 2_000, series: [{ t: 1_000, v: 1 }], seriesLong: [], seriesWide: [] },
    { id: 'sesbadupdate', startedAt: 1_000, endedAt: null, updatedAt: Number.NaN, series: [{ t: 1_000, v: 1 }], seriesLong: [], seriesWide: [] },
    { id: 'sesmissingarrays', startedAt: 1_000, endedAt: null, updatedAt: 2_000 },
    { id: 'sesnegative', startedAt: 1_000, endedAt: null, updatedAt: 2_000, series: [{ t: 1_000, v: -1 }], seriesLong: [], seriesWide: [] },
    { id: 'sesemptyentry', startedAt: 1_000, endedAt: null, updatedAt: 2_000, series: [], seriesLong: [], seriesWide: [] },
    { id: 'sesdupe', startedAt: 1_000, endedAt: null, updatedAt: 5_000, series: [{ t: 1_000, v: 5 }], seriesLong: [], seriesWide: [] },
    { id: 'sesdupe', startedAt: 1_000, endedAt: null, updatedAt: 4_000, series: [{ t: 1_000, v: 4 }], seriesLong: [], seriesWide: [] },
    'nope',
    null,
  ];
  writeFileSync(fileOf(dataDir), JSON.stringify({ version: 1, recordings: entries }));
  const lines = [];
  const store = createRecordingStore({ dataDir, log: (line) => lines.push(line) });
  assert.equal(store.error, null);
  assert.deepEqual(store.get('sesgood'), good);
  for (const id of [
    'bad',
    'sesbadstart',
    'sesbadend',
    'sesbadupdate',
    'sesmissingarrays',
    'sesnegative',
    'sesemptyentry',
  ]) {
    assert.equal(store.get(id), null, `${id} should be ignored`);
  }
  const loadedCaps = store.get('sescapsload');
  assert.equal(loadedCaps.series.length, 240);
  assert.equal(loadedCaps.seriesLong.length, 300);
  assert.equal(loadedCaps.seriesWide.length, 360);
  assert.equal(loadedCaps.series[0].t, 1_060);
  assert.equal(loadedCaps.seriesLong[0].sum, 100);
  assert.equal(loadedCaps.seriesWide[0].sum, 140);
  assert.equal(store.get('sesdupe').updatedAt, 5_000);
  assert.equal(store.get('sesdupe').series[0].v, 5);
  assert.ok(lines.some((line) => line.includes('ignored')));
  assert.ok(lines.some((line) => line.includes('duplicate')));

  const trimRoot = tempDir('loadtrim');
  const trimDir = path.join(trimRoot, 'data');
  mkdirSync(trimDir, { recursive: true });
  const tiny = (id, updatedAt) => ({
    id,
    startedAt: 1,
    endedAt: null,
    updatedAt,
    series: [{ t: 1, v: 1 }],
    seriesLong: [],
    seriesWide: [],
  });
  writeFileSync(
    fileOf(trimDir),
    JSON.stringify({
      version: 1,
      recordings: [tiny('sesloada', 1), tiny('sesloadb', 2), tiny('sesloadc', 3)],
    }),
  );
  const trimmed = createRecordingStore({ dataDir: trimDir, maxSessions: 2, log: () => {} });
  assert.equal(trimmed.get('sesloada'), null);
  assert.ok(trimmed.get('sesloadb'));
  assert.ok(trimmed.get('sesloadc'));
});

test('RS-14 broken files set an error, keep the store usable and never print contents', async () => {
  const secret = 'PRIVATE-FILE-BODY-7c1d';
  const root = tempDir('broken');
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(fileOf(dataDir), `{"secret":"${secret}",`);
  const lines = [];
  const store = createRecordingStore({ dataDir, log: (line) => lines.push(line) });
  assert.ok(store.error);
  assert.match(store.error, /not valid JSON/);
  assert.equal(String(store.error).includes(secret), false);
  assert.equal(lines.join('\n').includes(secret), false);
  assert.equal(store.get('anything'), null);
  store.capture(
    {
      id: 'sesafter',
      series: [{ t: BASE - 10, v: 1 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 100,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.equal(await store.flush(), true);
  assert.ok(readJson(fileOf(dataDir)).recordings.some((record) => record.id === 'sesafter'));

  const versionRoot = tempDir('version');
  const versionDir = path.join(versionRoot, 'data');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(fileOf(versionDir), JSON.stringify({ version: 2, recordings: [] }));
  const versioned = createRecordingStore({ dataDir: versionDir });
  assert.ok(versioned.error);
  assert.match(versioned.error, /version/);
  assert.equal(versioned.get('sesx'), null);

  const shapeRoot = tempDir('shape');
  const shapeDir = path.join(shapeRoot, 'data');
  mkdirSync(shapeDir, { recursive: true });
  writeFileSync(fileOf(shapeDir), JSON.stringify({ version: 1, recordings: {} }));
  assert.match(createRecordingStore({ dataDir: shapeDir }).error, /recordings/);

  const arrayRoot = tempDir('array');
  const arrayDir = path.join(arrayRoot, 'data');
  mkdirSync(arrayDir, { recursive: true });
  writeFileSync(fileOf(arrayDir), JSON.stringify([]));
  assert.ok(createRecordingStore({ dataDir: arrayDir }).error);

  const dirRoot = tempDir('isfile');
  const dirData = path.join(dirRoot, 'data');
  mkdirSync(path.join(dirData, 'graphs.json'), { recursive: true });
  const asDirectory = createRecordingStore({ dataDir: dirData });
  assert.ok(asDirectory.error);
  assert.match(asDirectory.error, /not a regular file/);

  const missingRoot = tempDir('missing');
  assert.equal(createRecordingStore({ dataDir: path.join(missingRoot, 'data') }).error, null);
});

test('RS-15 a file over 16 MiB is measured and skipped before it is read', async () => {
  const root = tempDir('toobig');
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = fileOf(dataDir);
  writeFileSync(file, '');
  truncateSync(file, 16 * 1024 * 1024 + 1);
  const lines = [];
  const store = createRecordingStore({ dataDir, log: (line) => lines.push(line) });
  assert.ok(store.error);
  assert.match(store.error, /cap/);
  assert.match(store.error, /not read/);
  assert.ok(lines.some((line) => line.includes('not read')));
  assert.equal(store.get('sesx'), null);
  store.capture(
    {
      id: 'sesafterbig',
      series: [{ t: BASE - 10, v: 1 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 100,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.equal(await store.flush(), true);
  assert.ok(statSync(file).size < 16 * 1024 * 1024);
  assert.equal(readJson(file).recordings[0].id, 'sesafterbig');
});

test('RS-16 a null dataDir is memory-only', async () => {
  const store = createRecordingStore();
  const saved = store.capture(
    {
      id: 'sesmemory',
      series: [{ t: BASE - 10, v: 1.25 }],
      seriesLong: [],
      seriesWide: [],
      captureStartedAt: BASE - 100,
      captureEndedAt: null,
    },
    BASE,
  );
  assert.ok(saved);
  assert.deepEqual(store.get('sesmemory'), saved);
  assert.equal(store.error, null);
  assert.equal(await store.flush(), true);
  assert.equal(store.error, null);
});

test('RS-17 200 full recordings stay under the 16 MiB write cap', async () => {
  const root = tempDir('bound');
  const dataDir = path.join(root, 'data');
  const store = createRecordingStore({ dataDir });
  const big = Number.MAX_VALUE;
  for (let session = 0; session < 200; session += 1) {
    const id = `sesfull${String(session).padStart(3, '0')}`;
    const series = Array.from({ length: 240 }, (_, i) => ({ t: BASE - 239_000 + i * 1_000, v: big }));
    const seriesLong = Array.from({ length: 300 }, (_, i) => ({
      t: BASE - 2_990_000 + i * 10_000,
      sum: big,
      n: 9007199254740991,
    }));
    const seriesWide = Array.from({ length: 360 }, (_, i) => ({
      t: BASE - 3_590_000 + i * 10_000,
      sum: big,
      n: 9007199254740991,
    }));
    store.capture(
      { id, series, seriesLong, seriesWide, captureStartedAt: BASE - 3_590_000, captureEndedAt: null },
      BASE,
    );
  }
  assert.equal(await store.flush(), true);
  const file = fileOf(dataDir);
  const size = statSync(file).size;
  assert.ok(size <= 16 * 1024 * 1024, `serialized file is ${size} bytes`);
  const raw = readJson(file);
  assert.equal(raw.recordings.length, 200);
  const reloaded = createRecordingStore({ dataDir });
  assert.equal(reloaded.error, null);
  assert.equal(reloaded.get('sesfull000').series.length, 240);
  assert.equal(reloaded.get('sesfull199').seriesWide.length, 360);
});

let failed = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    const detail = String(error?.stack ?? error)
      .split('\n')
      .slice(0, 5)
      .join('\n      ');
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}
cleanup();
console.log(`\nrecording store: ${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
