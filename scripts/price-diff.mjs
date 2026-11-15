// What moved between two price books, one line per model, in words a reader
// can act on: `node scripts/sync-prices.mjs --check` prints these when the
// committed snapshot no longer matches models.dev. Pure: no fs, no network.
//
//   + provider/model   in 1 · out 2 · read 0.1 · write 0   a model to price
//   - provider/model                                       a model gone
//   ~ provider/model   input 4 → 3.5, context >200k added  a model that moved
const RATES = ['input', 'output', 'cacheRead', 'cacheWrite'];

const sortedKeys = (...objects) => [...new Set(objects.flatMap((object) => Object.keys(object ?? {})))].sort();

const rate = (cost, key) => cost?.[key] ?? 0;

function rateChanges(before, after, prefix = '') {
  const changes = [];
  for (const key of RATES) {
    if (rate(before, key) !== rate(after, key)) changes.push(`${prefix}${key} ${rate(before, key)} → ${rate(after, key)}`);
  }
  return changes;
}

const ratesLine = (cost) => `in ${rate(cost, 'input')} · out ${rate(cost, 'output')} · read ${rate(cost, 'cacheRead')} · write ${rate(cost, 'cacheWrite')}`;

/** Every context tier that appeared, went or moved, by its threshold. */
function tierChanges(before = [], after = []) {
  const byContext = (tiers) => new Map(tiers.map((tier) => [tier.minContext, tier.cost]));
  const was = byContext(before);
  const now = byContext(after);
  const changes = [];
  for (const minContext of [...new Set([...was.keys(), ...now.keys()])].sort((a, b) => a - b)) {
    const label = `context >${minContext}`;
    if (!was.has(minContext)) changes.push(`${label} added (${ratesLine(now.get(minContext))})`);
    else if (!now.has(minContext)) changes.push(`${label} removed`);
    else changes.push(...rateChanges(was.get(minContext), now.get(minContext), `${label} `));
  }
  return changes;
}

export function diffBooks(before, after) {
  const lines = [];
  const was = before?.providers ?? {};
  const now = after?.providers ?? {};
  for (const provider of sortedKeys(was, now)) {
    if (!was[provider]) {
      lines.push(`+ ${provider} (new provider, ${Object.keys(now[provider].models ?? {}).length} models)`);
      continue;
    }
    if (!now[provider]) {
      lines.push(`- ${provider} (provider gone)`);
      continue;
    }
    const oldModels = was[provider].models ?? {};
    const newModels = now[provider].models ?? {};
    for (const model of sortedKeys(oldModels, newModels)) {
      const id = `${provider}/${model}`;
      const old = oldModels[model];
      const next = newModels[model];
      if (!old) {
        lines.push(`+ ${id}  ${ratesLine(next.cost)}`);
        continue;
      }
      if (!next) {
        lines.push(`- ${id}`);
        continue;
      }
      const changes = [...rateChanges(old.cost, next.cost), ...tierChanges(old.tiers, next.tiers)];
      if ((old.name ?? null) !== (next.name ?? null)) changes.push(`name "${old.name}" → "${next.name}"`);
      if ((old.release ?? null) !== (next.release ?? null)) changes.push(`release ${old.release ?? '—'} → ${next.release ?? '—'}`);
      if (changes.length) lines.push(`~ ${id}  ${changes.join(', ')}`);
    }
  }
  return lines;
}
