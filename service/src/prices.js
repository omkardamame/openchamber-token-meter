// Manual price overrides.
//
// An optional file in the service's data directory lets the owner correct a
// card without waiting for a release:
//
//   $OPENCHAMBER_SERVICE_DATA_DIR/price-overrides.json
//   { "anthropic/claude-opus-5-5": { "input": 3.5, "output": 18,
//                                    "cacheRead": 0.18, "cacheWrite": 4.5 } }
//
// Keys are `<price-provider>/<model-id>` after provider alias resolution. All
// four rates are required and must be finite and non-negative; a bad entry is
// logged and skipped rather than half-applied. Read once at start: a change
// needs a service restart, which is the same cost as a rebuild.
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPriceBook, isValidPriceBook, PRICE_SOURCE } from '../../shared/price-book-build.js';

const RATES = ['cacheRead', 'cacheWrite', 'input', 'output'];
const MAX_BOOK_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_COOLDOWN_MS = 60_000;

/** The override file for a data directory, or null when none is configured. */
export function priceOverrideFile(dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? null) {
  return dataDir ? path.join(dataDir, 'price-overrides.json') : null;
}

/** The cached price-book file for a data directory, or null when none is configured. */
export function priceBookFile(dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? null) {
  return dataDir ? path.join(dataDir, 'price-book.json') : null;
}

/**
 * Read and validate the override map. Never throws: a missing file is normal,
 * and a broken one must not stop the meter from showing published prices.
 */
export function loadPriceOverrides({ file = priceOverrideFile(), log = () => {} } = {}) {
  if (!file) return {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`token-meter: could not read ${file}: ${error?.message ?? error}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log(`token-meter: ${file} is not JSON: ${error.message}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log(`token-meter: ${file} must be an object of "provider/model" to rates`);
    return {};
  }
  const overrides = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[\w.-]+\/.+$/.test(key)) {
      log(`token-meter: override "${key}" is not "provider/model"; ignored`);
      continue;
    }
    const bad = RATES.filter((name) => !Number.isFinite(value?.[name]) || value[name] < 0);
    if (bad.length) {
      log(`token-meter: override "${key}" needs finite non-negative ${bad.join(', ')}; ignored`);
      continue;
    }
    overrides[key] = {
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      input: value.input,
      output: value.output,
    };
  }
  const count = Object.keys(overrides).length;
  if (count) log(`token-meter: ${count} price override${count === 1 ? '' : 's'} from ${file}`);
  return overrides;
}

/**
 * Load a cached price-book.json if present, valid, and at least as recent as
 * the bundled fallback. Never throws.
 */
export function loadCachedPriceBook({ file = priceBookFile(), fallback = null, log = () => {} } = {}) {
  if (!file) return fallback;
  try {
    const stat = statSync(file);
    if (stat.size > MAX_BOOK_BYTES) {
      log(`token-meter: ${file} exceeds ${MAX_BOOK_BYTES} bytes; using bundled price book`);
      return fallback;
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isValidPriceBook(parsed)) {
      log(`token-meter: ${file} failed schema check; using bundled price book`);
      return fallback;
    }
    if (fallback?.checkedAt && parsed.checkedAt < fallback.checkedAt) return fallback;
    return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`token-meter: could not read ${file}: ${error?.message ?? error}`);
    return fallback;
  }
}

function writeAtomicJson(file, value, log = () => {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        log(`token-meter: could not remove temp file ${temp}: ${cleanupError?.message ?? cleanupError}`);
      }
    }
    throw error;
  }
}

/**
 * Background price-book refresher with single-flight coalescing, reconnect
 * cooldown, strict validation, and atomic cache persistence. Never throws.
 */
export function createPriceRefresher({
  initialBook = null,
  file = priceBookFile(),
  fetchImpl = fetch,
  source = PRICE_SOURCE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = () => Date.now(),
  log = () => {},
  onBook = () => {},
} = {}) {
  let current = initialBook;
  let inFlight = null;
  let lastAttemptAt = -Infinity;

  async function run() {
    lastAttemptAt = now();
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      const answer = await fetchImpl(source, signal ? { signal } : undefined);
      if (!answer?.ok) throw new Error(`HTTP ${answer?.status ?? 'error'}`);
      const api = await answer.json();
      const today = new Date(now()).toISOString().slice(0, 10);
      const next = buildPriceBook(api, today);
      if (file) {
        try {
          writeAtomicJson(file, next, log);
        } catch (writeError) {
          log(`token-meter: could not cache ${file}: ${writeError?.message ?? writeError}`);
        }
      }
      current = next;
      onBook(next);
      return next;
    } catch (error) {
      log(`token-meter: price refresh failed (keeping ${current?.checkedAt ?? 'bundled'}): ${error?.message ?? error}`);
      return current;
    } finally {
      inFlight = null;
    }
  }

  return {
    refresh({ force = false } = {}) {
      if (inFlight) return inFlight;
      if (!force && now() - lastAttemptAt < cooldownMs) return Promise.resolve(current);
      inFlight = run();
      return inFlight;
    },
  };
}
