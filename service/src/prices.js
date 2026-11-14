// Manual price overrides.
//
// An optional file in the service's data directory lets the owner correct a
// card without waiting for a release:
//
//   ~/.local/share/openchamber-tokens/price-overrides.json
//   { "anthropic/claude-opus-5-5": { "input": 3.5, "output": 18,
//                                    "cacheRead": 0.18, "cacheWrite": 4.5 } }
//
// Keys are `<price-provider>/<model-id>` after provider alias resolution. All
// four rates are required and must be finite and non-negative; a bad entry is
// logged and skipped rather than half-applied. Read once at start: a change
// needs a service restart, which is the same cost as a rebuild.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RATES = ['cacheRead', 'cacheWrite', 'input', 'output'];

/** The override file for a data directory, or null when none is configured. */
export function priceOverrideFile(dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? null) {
  return dataDir ? path.join(dataDir, 'price-overrides.json') : null;
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
