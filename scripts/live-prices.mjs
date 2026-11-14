// Live reconciliation: what the meter says about real sessions, one per provider.
//
// Reads this machine's OpenCode server the way the service does, asks a service
// built with the real book for /state, and prints the API value against the
// recorded cost. INT-01..05 and INT-11..12 of docs/PRICING-SPEC.md; a provider
// with no session is printed as SKIP, never as a pass.
//
//   node scripts/live-prices.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGED = path.join(os.homedir(), '.config', 'openchamber', 'managed-opencode');
const DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const PORT = 47831;
const TOKEN = 'live-prices';

function discover() {
  const files = readdirSync(MANAGED)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(MANAGED, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error('no managed OpenCode process; open OpenChamber first');
  const managed = JSON.parse(readFileSync(files[0], 'utf8'));
  const env = execFileSync('ps', ['eww', '-p', String(managed.pid)], { encoding: 'utf8' });
  const match = env.match(/OPENCODE_PASSWORD=(\S+)/);
  if (!match) throw new Error('no OPENCODE_PASSWORD for the managed OpenCode process');
  return { base: `http://127.0.0.1:${managed.port}`, password: match[1] };
}

/** Candidate sessions that used `provider`, newest first, as the API names them. */
function sessionsFor(provider) {
  try {
    const answer = execFileSync(
      'sqlite3',
      [
        DB,
        `select session_id from message
           where json_extract(data,'$.providerID')='${provider}'
           group by session_id order by max(time_created) desc limit 8`,
      ],
      { encoding: 'utf8' },
    ).trim();
    const ids = answer
      .split('\n')
      .map((line) => line.trim().replace(/^vsh_/, ''))
      .filter((line) => /^ses[\w-]+$/.test(line));
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

const { base, password } = discover();
process.env.OPENCHAMBER_SERVICE_PORT = String(PORT);
process.env.OPENCHAMBER_SERVICE_TOKEN = TOKEN;
process.env.OPENCHAMBER_OPENCODE_URL = base;

const { createService } = await import('../service/src/main.js');
// The host hands the service a bearer for its own loopback proxy; on this
// machine the proxy is OpenCode itself, which wants Basic. Same rewrite the
// collector test uses.
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
const realFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: basic } });
const service = createService({
  base,
  fetchImpl: realFetch,
  log: (message) => console.error(message),
  port: PORT,
  token: TOKEN,
});
// `priceBook` is left to its default, which is the committed book.
service.start();
await new Promise((resolve) => setTimeout(resolve, 300));

const rows = [];
const wanted = [
  ['INT-01', 'opencode-go'],
  ['INT-02', 'claude-agent'],
  ['INT-03', 'openai'],
  ['INT-04', 'commandcode'],
  ['INT-11', 'opencode'],
  ['INT-12', 'deepseek'],
];

for (const [id, provider] of wanted) {
  const candidates = sessionsFor(provider);
  if (!candidates.length) {
    rows.push({ id, provider, state: 'SKIP', detail: 'no session on this machine' });
    continue;
  }
  // A session recorded under a worktree is not addressable here (`vsh_…`), so
  // walk the newest few until one the server will answer for.
  let body = null;
  let session = null;
  for (const candidate of candidates) {
    const answer = await fetch(`http://127.0.0.1:${PORT}/state?session=${candidate}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!answer.ok) continue;
    const parsed = await answer.json();
    if ((parsed.stepsKnown ?? 0) > 0) {
      body = parsed;
      session = candidate;
      break;
    }
  }
  if (!body) {
    rows.push({ id, provider, state: 'SKIP', detail: `${candidates.length} known sessions, none readable here` });
    continue;
  }
  const cost = body.cost ?? {};
  const drift = cost.drift ? `${(cost.drift.relative * 100).toFixed(2)}%` : '—';
  const state =
    cost.mode !== 'api'
      ? 'FAIL'
      : cost.total === null
        ? cost.priceNote === 'free'
          ? 'OK'
          : 'FAIL'
        : cost.lowerBound
          ? 'OK (≥)'
          : 'OK';
  rows.push({
    api: cost.total,
    billed: cost.billed?.total,
    coverage: cost.coverage,
    detail: `${cost.rates?.provider ?? '?'}/${cost.rates?.model ?? '?'} · ${cost.rates?.source ?? '—'} · ${cost.priceNote ?? '—'}`,
    drift,
    flagged: Boolean(cost.drift),
    id,
    models: cost.models?.length ?? 1,
    provider,
    session,
    state,
    steps: body.stepsKnown ?? 0,
  });
}

service.stop();

const money = (value) => (value === null || value === undefined ? '—' : `$${Number(value).toFixed(4)}`);
console.log('\nID      provider      state    API value   billed      drift    coverage  model');
for (const row of rows) {
  if (row.state === 'SKIP') {
    console.log(`${row.id.padEnd(7)} ${row.provider.padEnd(13)} SKIP     ${row.detail}`);
    continue;
  }
  console.log(
    `${row.id.padEnd(7)} ${row.provider.padEnd(13)} ${row.state.padEnd(8)} ${money(row.api).padEnd(11)} ${money(row.billed).padEnd(11)} ${String(row.drift).padEnd(8)} ${String(row.coverage?.toFixed(3) ?? '—').padEnd(9)} ${row.detail}`,
  );
}

// INT-01: the drift flag must agree with the numbers. The machine-wide group
// for this card was −0.56% / −0.85% across 1,805 messages (spec section 9.2);
// one live session moves while it streams, so this prints it and fails only
// when a >1% disagreement goes unflagged.
const goRow = rows.find((row) => row.id === 'INT-01');
if (goRow && goRow.state !== 'SKIP' && goRow.drift && goRow.drift !== '—') {
  const outside = Math.abs(Number(goRow.drift.replace('%', ''))) > 1;
  const flagged = goRow.flagged === true;
  console.log(`\nINT-01 session drift ${goRow.drift} → ${outside ? (flagged ? 'flagged, as it should be' : 'UNFLAGGED') : 'inside 1%'}`);
  if (outside && !flagged) process.exitCode = 1;
}
const failed = rows.filter((row) => row.state === 'FAIL' || row.state === 'ERROR');
if (failed.length) {
  console.log(`\n${failed.map((row) => row.id).join(', ')} failed`);
  process.exitCode = 1;
}
console.log('\nlive prices: done');
