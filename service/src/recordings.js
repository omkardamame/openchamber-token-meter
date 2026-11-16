// Saved per-session live graph recordings.
//
// The service samples the live graph every tick; this store keeps the newest
// hour of those samples for the sessions that matter, so a restart or a session
// switch can draw the same curves again. A record holds measurements only: no
// messages, titles, credentials or usage counters ever enter one.
//
// A null dataDir keeps everything in memory (the normal mode in tests). With a
// dataDir, creation loads graphs.json synchronously and flush() writes it
// atomically. The file is checked against a byte cap before it is read; a
// broken or oversized file is reported and skipped instead of taking the
// service down.
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const FILE_NAME = 'graphs.json';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const WINDOW_MS = 60 * 60_000;
const MAX_SESSIONS = 200;
const CAPS = { series: 240, seriesLong: 300, seriesWide: 360 };
const SESSION_ID = /^ses[\w-]{1,120}$/;

const isTime = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

function clampMaxSessions(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_SESSIONS;
  return Math.min(MAX_SESSIONS, Math.max(1, Math.trunc(value)));
}

function copySeries(points) {
  return points.map((point) => ({ t: point.t, v: point.v }));
}

function copyBuckets(points) {
  return points.map((point) => ({ t: point.t, sum: point.sum, n: point.n }));
}

function copyRecord(record) {
  return {
    id: record.id,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    updatedAt: record.updatedAt,
    series: copySeries(record.series),
    seriesLong: copyBuckets(record.seriesLong),
    seriesWide: copyBuckets(record.seriesWide),
  };
}

/**
 * Keep the valid, ordered, deduplicated tail of one series.
 *
 * `windowEnd` is the record's endedAt (or now while it is active): points in the
 * last hour are kept, so a saved recording never grows past its own window.
 * A null windowEnd keeps every point (load time). Points outside the window
 * are routine and silent; malformed points are counted so the caller can
 * report them without logging every sample.
 */
function normalizeSeries(input, kind, cap, windowEnd) {
  if (!Array.isArray(input)) return { points: [], invalid: 0 };
  const byTime = new Map();
  let invalid = 0;
  for (const point of input) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      invalid += 1;
      continue;
    }
    const t = point.t;
    if (!isTime(t)) {
      invalid += 1;
      continue;
    }
    if (windowEnd !== null && (t < windowEnd - WINDOW_MS || t > windowEnd)) continue;
    if (kind === 'v') {
      const v = point.v;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        invalid += 1;
        continue;
      }
      // A duplicate timestamp keeps the later sample: sorting alone would make
      // two points with one x break the curve's tangents.
      byTime.set(t, { t, v });
    } else {
      const sum = point.sum;
      const n = point.n;
      if (
        typeof sum !== 'number' ||
        !Number.isFinite(sum) ||
        sum < 0 ||
        !Number.isInteger(n) ||
        n <= 0
      ) {
        invalid += 1;
        continue;
      }
      byTime.set(t, { t, sum, n });
    }
  }
  const points = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { points: points.slice(Math.max(0, points.length - cap)), invalid };
}

/**
 * Create the recording store. Loading is synchronous so the first request for
 * a recording sees the file's contents; only flush() touches the disk again.
 */
export function createRecordingStore({ dataDir = null, log = () => {}, maxSessions = MAX_SESSIONS } = {}) {
  const dir = typeof dataDir === 'string' && dataDir.length > 0 ? dataDir : null;
  const report = typeof log === 'function' ? log : () => {};
  const limit = clampMaxSessions(maxSessions);
  const records = new Map();
  const file = dir ? path.join(dir, FILE_NAME) : null;
  let dirty = false;
  let loadError = null;
  let writeError = null;
  let flushQueue = Promise.resolve();
  let tmpCounter = 0;

  function loadFailure(message) {
    loadError = message;
    report(`token-meter: ${message}`);
  }

  function evictOldest() {
    let oldest = null;
    for (const record of records.values()) {
      if (!oldest || record.updatedAt < oldest.updatedAt) oldest = record;
    }
    if (!oldest) return null;
    records.delete(oldest.id);
    return oldest;
  }

  function trimToLimit() {
    let dropped = 0;
    while (records.size > limit) {
      if (!evictOldest()) break;
      dropped += 1;
    }
    if (dropped > 0) {
      report(`token-meter: recording store: dropped ${dropped} least-recent recording${dropped === 1 ? '' : 's'} (max ${limit})`);
    }
  }

  /** Validate one persisted record. Bad points are filtered; a bad record is skipped. */
  function readRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not an object' };
    if (typeof raw.id !== 'string' || !SESSION_ID.test(raw.id)) return { reason: 'invalid session id' };
    if (!isTime(raw.startedAt)) return { reason: 'startedAt is not a finite positive timestamp' };
    if (raw.endedAt !== null && !isTime(raw.endedAt)) {
      return { reason: 'endedAt is neither null nor a finite positive timestamp' };
    }
    if (!isTime(raw.updatedAt)) return { reason: 'updatedAt is not a finite positive timestamp' };
    if (!Array.isArray(raw.series) || !Array.isArray(raw.seriesLong) || !Array.isArray(raw.seriesWide)) {
      return { reason: 'series fields are not arrays' };
    }
    const series = normalizeSeries(raw.series, 'v', CAPS.series, null);
    const seriesLong = normalizeSeries(raw.seriesLong, 'long', CAPS.seriesLong, null);
    const seriesWide = normalizeSeries(raw.seriesWide, 'wide', CAPS.seriesWide, null);
    const invalid = series.invalid + seriesLong.invalid + seriesWide.invalid;
    if (invalid > 0) {
      report(`token-meter: recording store: ${raw.id}: ignored ${invalid} invalid sample${invalid === 1 ? '' : 's'} from ${file}`);
    }
    if (series.points.length + seriesLong.points.length + seriesWide.points.length === 0) {
      return { reason: 'no valid samples' };
    }
    return {
      record: {
        id: raw.id,
        startedAt: raw.startedAt,
        endedAt: raw.endedAt,
        updatedAt: raw.updatedAt,
        series: series.points,
        seriesLong: seriesLong.points,
        seriesWide: seriesWide.points,
      },
    };
  }

  function load() {
    if (!dir) return;
    let info;
    try {
      info = statSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      loadFailure(`recording store: could not stat ${file}: ${error?.message ?? error}`);
      return;
    }
    if (!info.isFile()) {
      loadFailure(`recording store: ${file} is not a regular file; starting empty`);
      return;
    }
    if (info.size > MAX_FILE_BYTES) {
      loadFailure(
        `recording store: ${file} is ${info.size} bytes, over the ${MAX_FILE_BYTES}-byte cap; not read`,
      );
      return;
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      loadFailure(`recording store: could not read ${file}: ${error?.message ?? error}`);
      return;
    }
    // The stat and the read can disagree when the file is rewritten between
    // them; the read must still not grow past the cap that was just checked.
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      loadFailure(`recording store: ${file} grew past the ${MAX_FILE_BYTES}-byte cap; not loaded`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parser's message can quote the file, so it is deliberately dropped.
      loadFailure(`recording store: ${file} is not valid JSON; starting empty`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      loadFailure(`recording store: ${file} is not a recording file; starting empty`);
      return;
    }
    if (parsed.version !== VERSION) {
      const found = typeof parsed.version === 'number' ? `version ${parsed.version}` : 'a non-numeric version';
      loadFailure(`recording store: ${file} has ${found}; expected version ${VERSION}; starting empty`);
      return;
    }
    if (!Array.isArray(parsed.recordings)) {
      loadFailure(`recording store: ${file} has no recordings array; starting empty`);
      return;
    }
    parsed.recordings.forEach((raw, index) => {
      const result = readRecord(raw);
      if (!result.record) {
        report(`token-meter: recording store: ${file}: recording #${index + 1} ignored (${result.reason})`);
        return;
      }
      const record = result.record;
      const previous = records.get(record.id);
      if (previous) {
        if (previous.updatedAt >= record.updatedAt) {
          report(`token-meter: recording store: ${file}: duplicate ${record.id} ignored (older copy)`);
          return;
        }
        report(`token-meter: recording store: ${file}: duplicate ${record.id} replaced by newer copy`);
      }
      records.set(record.id, record);
    });
    trimToLimit();
  }

  function capture(collector, now) {
    if (!collector || typeof collector !== 'object' || Array.isArray(collector)) {
      report('token-meter: recording store: capture needs a collector object');
      return null;
    }
    const id = collector.id;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) {
      report('token-meter: recording store: capture ignored (session id is not "ses…")');
      return null;
    }
    let at = now;
    if (!isTime(at)) {
      at = Date.now();
      report(`token-meter: recording ${id}: capture time is not a finite positive number; using the clock`);
    }
    const existing = records.get(id);

    let startedAt = null;
    if (isTime(collector.captureStartedAt)) {
      startedAt = collector.captureStartedAt;
    } else if (collector.captureStartedAt != null) {
      report(`token-meter: recording ${id}: captureStartedAt is not a finite positive number`);
    }
    if (startedAt === null) startedAt = existing ? existing.startedAt : at;

    let endedAt = null;
    if (isTime(collector.captureEndedAt)) {
      endedAt = collector.captureEndedAt;
    } else if (collector.captureEndedAt != null) {
      report(`token-meter: recording ${id}: captureEndedAt is not a finite positive number; recording stays active`);
    }

    const windowEnd = endedAt ?? at;
    const series = normalizeSeries(collector.series, 'v', CAPS.series, windowEnd);
    const seriesLong = normalizeSeries(collector.seriesLong, 'long', CAPS.seriesLong, windowEnd);
    const seriesWide = normalizeSeries(collector.seriesWide, 'wide', CAPS.seriesWide, windowEnd);
    const invalid = series.invalid + seriesLong.invalid + seriesWide.invalid;
    if (invalid > 0) {
      report(`token-meter: recording ${id}: ignored ${invalid} invalid sample${invalid === 1 ? '' : 's'}`);
    }

    if (series.points.length + seriesLong.points.length + seriesWide.points.length === 0) {
      // An empty capture is the quiet start of a session, not a recording.
      return existing ? copyRecord(existing) : null;
    }

    const record = {
      id,
      startedAt,
      endedAt,
      updatedAt: at,
      series: series.points,
      seriesLong: seriesLong.points,
      seriesWide: seriesWide.points,
    };
    records.set(id, record);
    trimToLimit();
    dirty = true;
    const kept = records.get(id);
    return kept ? copyRecord(kept) : null;
  }

  function get(id) {
    if (typeof id !== 'string') return null;
    const record = records.get(id);
    return record ? copyRecord(record) : null;
  }

  function recordsById() {
    return [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * The file's text, trimmed to the byte cap. The per-record caps keep a normal
   * 200-session file well under 16 MiB; if a pathological value ever pushes it
   * over, the least-recent recordings are dropped from memory as well, so what
   * is written never exceeds what a later load is willing to read.
   */
  function encode() {
    const list = recordsById();
    const full = JSON.stringify({ version: VERSION, recordings: list });
    if (Buffer.byteLength(full, 'utf8') <= MAX_FILE_BYTES) return full;

    const prefix = `{"version":${VERSION},"recordings":[`;
    const suffix = ']}';
    const newestFirst = [...list].sort(
      (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const encoded = newestFirst.map((record) => ({ record, text: JSON.stringify(record) }));
    let bytes =
      Buffer.byteLength(prefix + suffix, 'utf8') +
      encoded.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0) +
      Math.max(0, encoded.length - 1);
    let kept = encoded;
    let dropped = 0;
    while (kept.length > 1 && bytes > MAX_FILE_BYTES) {
      const removed = kept.pop();
      bytes -= Buffer.byteLength(removed.text, 'utf8') + (kept.length > 0 ? 1 : 0);
      records.delete(removed.record.id);
      dropped += 1;
    }
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`one recording is larger than the ${MAX_FILE_BYTES}-byte file cap`);
    }
    if (dropped > 0) {
      report(
        `token-meter: recording store: dropped ${dropped} least-recent recording${dropped === 1 ? '' : 's'} to stay under the ${MAX_FILE_BYTES}-byte file cap`,
      );
    }
    return prefix + kept.map((entry) => entry.text).join(',') + suffix;
  }

  async function flushOnce() {
    if (!dirty) return true;
    let text;
    try {
      text = encode();
    } catch (error) {
      return writeFailure(error, false);
    }
    // Cleared before the write: a capture that lands while the disk is busy
    // marks the store dirty again, so that newer state gets its own flush. A
    // failed write restores the flag below.
    dirty = false;
    const tmp = path.join(dir, `${FILE_NAME}.tmp-${process.pid}-${++tmpCounter}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // writeFile's mode is filtered through the process umask; a private
      // file must stay 0600 whatever that umask happens to be.
      await chmod(tmp, 0o600);
      await rename(tmp, file);
      writeError = null;
      return true;
    } catch (error) {
      await unlink(tmp).catch(() => {});
      return writeFailure(error, true);
    }
  }

  function writeFailure(error, markDirty) {
    if (markDirty) dirty = true;
    writeError = `recording store: could not write ${file}: ${error?.message ?? error}`;
    report(`token-meter: ${writeError}`);
    return false;
  }

  function flush() {
    if (!dir) return Promise.resolve(true);
    // Flushes run one at a time: a slow older write can never land after a
    // newer one. The queue itself never rejects; each caller gets its own
    // true/false result.
    const run = flushQueue.then(() => flushOnce());
    flushQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  load();

  return {
    capture,
    flush,
    get,
    get error() {
      return writeError ?? loadError;
    },
  };
}
