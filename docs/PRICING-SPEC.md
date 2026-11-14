# API Value Pricing — Spec and Plan

Status: **approved 2026-11-14; Phase 1 built** — committed book, resolver,
compute, 55 pure checks. Phase 2 (snapshot wiring) not started.
Owner: Omkar.
Scope: the rail panel's `Cost` block (OpenChamber extension `token-meter`).
Providers in scope: **Anthropic** (`anthropic`, `claude-agent`), **OpenAI**
(`openai`), **OpenCode Go** (`opencode-go`), **Command Code** (`commandcode`),
**OpenCode Zen** (`opencode`), **DeepSeek** (`deepseek`).
Dropped: **OpenRouter** (`openrouter`, `omniroute`).
Out of scope: plan usage bars (provider OAuth), 30-day dashboard, plan-price
multiplier, per-step API value in the chart hover.

The implementation must follow `AGENTS.md`; this document adds detail, it does
not override the agent rules. Read `AGENTS.md` and `docs/STATE.md` first.

---

## 1. Problem

The Cost block currently shows **OpenCode's recorded cost** as `Total`. That is
correct for a metered API, but subscription and plan providers record
`cost: 0`, so Claude, ChatGPT and Command Code sessions show `$0.0000` and their
`rates / 1M` line shows `—`. The meter's least-squares fit cannot run because it
requires `cost > 0`.

The owner wants the block to show **API value** instead: what the session's
tokens would cost at the model's published API rates. The rates line must show
that model's own rates from its own provider, never another provider's card.

The screenshots from Vorssaint are the reference: `$1,180` for a Claude
subscription and `$31.43` for ChatGPT Plus. Those are list-price values, not
money billed. The multipliers (`59×`, `1.6×`) are API value divided by the plan
price.

## 2. Definitions

| Term | Meaning |
|---|---|
| **API value** | `sum(tokens × published list rates)` for the session and its subagents. The new `Total`. |
| **Billed** | OpenCode's recorded `message.cost` / session `cost`. The actual charge, or `$0` for a plan. |
| **Effective** | API value ÷ consumed tokens. The value-weighted average rate. Not an average of model rates. |
| **Coverage** | Share of consumed tokens whose model has a published rate. `1` is complete; `<1` makes the total a lower bound. |
| **Lower bound** | `coverage < 1`; the UI prefixes the total with `≥`. |
| **Price book** | The committed, curated rate snapshot (section 4). |
| **Card** | One model's rates in the price book. |
| **Match** | How a session model resolved to a card: `exact`, `alias`, `bare`, `family`, `lab`, `override`, `recovered`. |
| **Source** | Human label for the card: `Anthropic list`, `OpenAI list`, `OpenCode Go card`, `Command Code list`, `OpenCode Zen list`, `DeepSeek list`, `Command Code via Anthropic list`, `manual override`, `billed rates`. |
| **Drift** | Difference between API value and billed cost for a metered model, above 1%. |

**Formula, per step:**

```
freshInput  = max(0, step.total - step.tokens)   // step.tokens = output + reasoning
generated   = step.tokens                        // output + reasoning
prompt      = freshInput + step.cacheRead + step.cacheWrite
consumed    = prompt + generated
apiCost     = freshInput  * rate.input
            + generated   * rate.output
            + cacheRead   * rate.cacheRead
            + cacheWrite  * rate.cacheWrite
```

`step.total` is `tokens.input + output`; `step.tokens` is `output + reasoning`.
Therefore `step.total - step.tokens = tokens.input` (fresh input). Cache read and
cache write are separate. Reasoning is charged at the output rate; all six
providers price it that way. Only `deepseek` publishes a `reasoning` rate, and it
equals its `output` rate, so the generator drops the field and keeps `output`.
If a provider ever needs a separate reasoning rate,
the step must store the split; not needed now.

`consumed = freshInput + generated + cacheRead + cacheWrite`.

**Display law:** API value is a counterfactual. It is never called "spend" or
"cost". The billed number stays available and is labeled `billed`.

## 3. Decisions

| # | Decision |
|---|---|
| D1 | `Total` becomes API value. `billed` is a secondary number in the tooltip and in `cost.billed`. |
| D2 | The rates line shows the current model's own published rates, including cache write, with a source label. |
| D3 | Scope is the six providers above. OpenRouter is not a source and is not priced. |
| D4 | Prices come from a committed, curated snapshot generated from models.dev; no runtime network. |
| D5 | Unknown models show `no published rate`; no neighbour, no average, no guess. |
| D6 | For metered models, API value is reconciled against billed cost; drift above 1% is flagged. |
| D7 | Session-level first. 30-day dashboard and plan usage bars are later, separate work. |
| D8 | No plan-price multiplier in v1. The `59×` is a later option that needs a plan price. |
| D9 | Keep the block title `Cost`; label the total value with an `API` badge. |
| D10 | Snapshot updates on release, not daily. `checkedAt` is shown in the tooltip. |
| D11 | Resolution order: exact → provider alias → model alias → bare ID → family latest → lab fallback → manual override → none. |
| D12 | Cache write is included; context tiers are applied per step; time tiers are applied per step's timestamp. |
| D13 | `Effective` is API value ÷ consumed tokens. If coverage `<1`, it is computed over priced tokens and marked `~`. |
| D14 | The existing speed, token, TTFT and step-chart behavior is unchanged. |
| D15 | The existing DeepSeek official time card remains, now backed by the book's `deepseek` cards (they match the `shared/pricing.js` tariff to the cent); it must not regress. |

## 4. Price book

### 4.1 File

`shared/price-book.js` — generated, committed, deterministic:

```js
// GENERATED by scripts/sync-prices.mjs — do not edit.
// Source: https://models.dev/api.json, filtered to six providers.
export const PRICE_BOOK = {
  version: 1,
  checkedAt: '2026-11-14',
  currency: 'USD',
  providers: {
    anthropic: {
      name: 'Anthropic',
      source: 'Anthropic list',
      models: {
        'claude-opus-5-5': {
          name: 'Claude Opus 5.5',
          release: '2026-09-22',
          cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
          tiers: [],
        },
      },
    },
    openai: { name: 'OpenAI', source: 'OpenAI list', models: { /* ... */ } },
    'opencode-go': { name: 'OpenCode Go', source: 'OpenCode Go card', models: { /* ... */ } },
    commandcode: { name: 'Command Code', source: 'Command Code list', models: { /* ... */ } },
    opencode: { name: 'OpenCode Zen', source: 'OpenCode Zen list', models: { /* ... */ } },
    deepseek: { name: 'DeepSeek', source: 'DeepSeek list', models: { /* ... */ } },
  },
  aliases: {
    providers: {
      'claude-agent': 'anthropic',
      'command-code': 'commandcode',
      commandcode: 'commandcode',
      openai: 'openai',
      'opencode-go': 'opencode-go',
      opencode: 'opencode',
      deepseek: 'deepseek',
    },
    models: {
      'claude-agent': {
        opus: 'claude-opus-5-5',
        sonnet: 'claude-sonnet-5-5',
        haiku: 'claude-haiku-5-5',
        fable: 'claude-fable-5-2',
      },
    },
    labs: {
      commandcode: { 'claude-': 'anthropic', 'gpt-': 'openai' },
    },
  },
};
```

Field rules:

- `cost` values are **USD per 1,000,000 tokens**.
- `tiers` is an array of `{ minContext, cost }`, sorted ascending by
  `minContext`. The highest tier whose `minContext <= prompt` replaces the base
  `cost`. `[]` means flat.
- `release` is `YYYY-MM-DD`, used only for family fallback.
- `name` is models.dev's `name` verbatim. The UI draws it on one line with an
  ellipsis and puts the full name in the title.
- Models with no published `cost` are omitted, not stored with `null`.
- A published cost of **`0` is kept**: it is a known price, not a missing one.
  Most of `opencode`'s free models are this case, and they must resolve to
  `free` (`total: 0`, `coverage: 1`), never to `noPrice`.
- `cacheWrite` is `0` when the provider publishes no cache-write rate
  (`opencode-go`, `opencode` and `deepseek` never do).
- `checkedAt` is the date the snapshot was generated, not the date of the last
  request.
- No provider credentials, no conversation data, no runtime URLs in this file.

### 4.2 Generation

`scripts/sync-prices.mjs`:

1. Fetch `https://models.dev/api.json` with a 15 s timeout.
2. Keep providers `anthropic`, `openai`, `opencode-go`, `commandcode`,
   `opencode`, `deepseek`.
3. For each model with a non-null `cost`, normalize:
   - `input`, `output`, `cache_read` → `input`, `output`, `cacheRead`.
   - `cache_write` → `cacheWrite` (missing → `0`).
   - `tiers[]` → `{ minContext: tier.size, cost: {...} }`, sorted.
   - `name`, `release_date`.
4. Drop models whose `cost` has no finite `input` or `output`.
5. Sort providers and model keys alphabetically; sort tiers by `minContext`.
6. Write `shared/price-book.js` with the header above.
7. `--check` mode regenerates into a temp buffer and exits `1` when the
   committed file differs. Never writes in `--check` mode.

The script is run manually when a release updates prices. It is **not** part of
`npm run verify` (no network in the gate).

`scripts/check-prices.mjs` (optional, manual) fetches models.dev and reports
drift against the committed book; it is not a gate.

### 4.3 Overrides

`$OPENCHAMBER_SERVICE_DATA_DIR/price-overrides.json`, optional:

```json
{
  "anthropic/claude-opus-5-5": {
    "input": 3.5,
    "output": 18,
    "cacheRead": 0.18,
    "cacheWrite": 4.5
  }
}
```

- Key is `<price-provider>/<model-id>` after provider alias resolution.
- All four rates are required; finite and `>= 0`; otherwise the entry is ignored
  with a log line.
- Overrides win over the book; source is `manual override`; `match` is
  `override`.
- Loaded once at service start. No file watcher.

## 5. Resolution

`shared/price-resolve.js` — pure, no fs, no network, no OpenCode client.

```js
resolvePrice(book, { provider, model, promptTokens, at, overrides })
// -> null | {
//   provider, model, name, rates, source, match, release, checkedAt,
//   tier: null | { minContext, rates },
//   timeTier: null | 'peak' | 'off-peak',
//   timeHours: null | string,        // the tariff's window, for the title
// }
```

`overrides` is the validated map from `price-overrides.json`; passing it keeps
the resolver pure and leaves the file read to the service.

Order:

1. **Exact**: `book.providers[provider]?.models[model]`. A case-only difference
   is the same model and resolves here too: vendors write `zai-org/GLM-5.3`
   while a session records `zai-org/glm-5.3`.
2. **Provider alias**: map `claude-agent` → `anthropic`, `command-code` →
   `commandcode`; try exact again.
3. **Model alias**: `book.aliases.models[originalProvider]?.[model]`; resolve in
   the price provider.
4. **Bare ID**: strip the first path segment (`deepseek/deepseek-v4.1-flash` →
   `deepseek-v4.1-flash`) and try exact. Build a bare index **per price
   provider**, once. Two cards sharing a bare ID **inside the same provider**
   return `null` (ambiguous; do not guess). Across providers it is not
   ambiguous: `deepseek-v4-flash` exists in both `deepseek` and `commandcode`,
   and each provider's own index answers for itself.
5. **Family latest**: only for a known family alias (`opus`, `sonnet`, `haiku`,
   `fable`). Find cards whose model ID starts with `claude-<family>-` in the
   provider, choose the highest `release`. `match: 'family'`.
6. **Lab fallback**: only for `commandcode` when the model is missing. Map
   `claude-` → `anthropic`, `gpt-` → `openai`, then try exact/bare there.
   `match: 'lab'`; source says `Command Code via Anthropic list` (or OpenAI).
7. **Override**: after steps 1–6 produced a card, if
   `price-overrides.json` has a key for the **resolved** `provider/model-id`,
   those four rates replace the card's and `match` becomes `override`. This
   applies to a lab fallback too (an override on `anthropic/claude-fable-5-2`
   wins for `commandcode` traffic priced through the Anthropic card). An
   override never creates a match on its own: a key with no resolvable card
   stays `null`. Rates are applied before tiers. An override also clears the
   context tier and the time tariff: one deliberate set of four rates is the
   whole answer, so `tier` and `timeTier` come back `null` and `source` reads
   `manual override`.
8. **None**: return `null`.

Tiers:

- Context: choose the highest `tier.minContext <= promptTokens`; merge its
  `cost` over the base `cost`. Return the active tier for the UI.
- Time: if `timeTariff(priceProvider, model)` exists, choose `peak` or
  `offPeak` by `isPeakAt(at, schedule)`. The UI still shows both sides from the
  tariff. For `opencode-go` DeepSeek, the book's base is the off-peak card; the
  tariff supplies both sides.

Never use OpenCode Go's card for another provider. A missing card is `null`;
the caller decides whether to fall back to recovered billed rates.

## 6. Computation

`computeApiValue(book, steps, { turnStartedAt, provider, model, overrides, recovered })` — pure:

```js
// Returns:
{
  total, lastTurn, effective, perMillion, coverage, lowerBound,
  pricedTokens, totalTokens, pricedSteps,
  models: [ { provider, model, name, source, match, apiValue, billed,
              tokens: { input, generated, cacheRead, cacheWrite },
              consumed, coverage, rates, tier, timeTier, drift, steps } ],
  billed: { total, lastTurn, perMillion, effective },
  drift: null | { model, relative },
  priceNote: null | 'noPrice' | 'partial' | 'drift' | 'free' | 'noBilledCost',
  unpriced: [ { provider, model, consumed } ],   // the models behind `≥`
}
```

`provider` and `model` are the collector's, for a step that carries neither.
`recovered` is `null | { provider, model, rates }` — the fit recovered from
recorded costs, used only for the exact provider and model it was fitted on.

Rules:

- Iterate `steps` in time order; use `step.provider` and `step.model`; if either
  is missing, use the collector's provider/model.
- Resolve the card with `prompt = freshInput + cacheRead + cacheWrite` and
  `at = step.at`.
- If no card, try the recovered rates (from `modelRates`); if present, use them
  as the value source `recovered` (these are actual billed rates). If neither,
  the step is unpriced.
- Known limitation: today `modelRates()` and `derived.ratesByModel` are keyed by
  model only. For the recovered fallback, use a fit only when every step in it
  shares the step's provider; Phase 2 must key both by `provider/model`.
- Sum `apiCost`; sum `consumed` for priced steps; sum all consumed.
- `coverage = pricedConsumed / totalConsumed`; when nothing was consumed at all
  it is `1` if some step had a card and `0` otherwise, so a zero-token step is
  never reported as a lower bound.
- `lowerBound = coverage < 1 - 1e-9`.
- `lastTurn` sums steps with `at >= turnStartedAt` (0 if no turn).
- Group by `provider/model` for `models`; keep insertion order by first step,
  then sort by `apiValue` descending. Each group carries its own rates,
  coverage, billed and drift.
- `billed.total` is the sum of `step.cost`; `billed.lastTurn` filters the same
  way.
- `billed.effective = billed.total / totalConsumed`.
- `effective = total / (coverage === 1 ? totalConsumed : pricedConsumed)`.
- Drift per model: if `billed > 0` and `apiValue > 0`, compare
  `(apiValue - billed) / billed`; flag `abs > 0.01`. The top-level `drift` is
  the largest absolute relative drift.
- Round to 6 decimals only at the wire boundary; sum in full precision.
- `priceNote` precedence: `noPrice` (coverage 0) → `partial` (`<1`) → `drift`
  (any drift) → `free` (all cards 0) → `noBilledCost` (`billed.total === 0` and
  `total > 0`).
- A step's `tokens` is `output + reasoning`, so a group reports
  `{ input, generated, cacheRead, cacheWrite }`; the output/reasoning split is
  not on the step and is not invented here.
- Empty steps: `total = null`, `coverage = 0`, `priceNote = 'noPrice'`; the UI
  shows `—` (section 8.2).

Budget: at most 1,000 steps per snapshot. Compute once per `stepsKey` and cache
on `collector.derived.api`; `lastTurn` is a filter over the cached per-step
costs. No new timers, no async work.

## 7. Wire contract

`snapshot()` gets a fourth argument: `priceBook = null`.

- `null` keeps the old behavior (`cost.total` is billed) for existing tests and
  any old caller.
- The service always passes the loaded book. `createService({ priceBook })`
  defaults to `PRICE_BOOK`; tests inject a fixture.

New/updated `cost` object:

```js
cost: {
  // which number the headline is; the panel must never paint a billed total
  // as API value. `billed` keeps the old shape for an older caller.
  mode: 'api',                   // 'api' with a book, 'billed' without
  // headline: API value
  total: 1180.0,                 // null when no step is priced
  lastTurn: 0.42,                // null when no step is priced
  perMillion: 0.29,              // API value / consumed (or priced tokens)
  // secondary: actual billed
  billed: {
    total: 0,
    lastTurn: 0,
    perMillion: 0,
  },
  // the current model's card for the rates line
  rates: {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5,
    source: 'Anthropic list',
    match: 'alias',
    checkedAt: '2026-11-14',
    tier: null,                  // or { minContext, rates }
    timeTier: null,              // or 'peak' / 'off-peak'
  },
  ratesNote: null,               // legacy fit note: fewSteps | nonLinear | noCache | noCost
  priceNote: null,               // noPrice | partial | drift | free | noBilledCost
  drift: null,                   // { model, relative } when > 1%
  coverage: 1,
  lowerBound: false,
  // only when the tree used more than one model
  models: [
    { provider, model, name, source, match, apiValue, billed,
      tokens: { input, generated, cacheRead, cacheWrite },
      consumed, coverage, rates, tier, timeTier, drift, steps },
  ],
  tariff: { /* existing shape; time tiers for the current model */ },
}
```

- `total` is `null` only when no step has a price. A free model priced at `$0`
  has `total: 0`, `coverage: 1`, `priceNote: 'free'`.
- `models` is omitted when there is one model; the panel uses `rates` and the
  `Cost` total.
- Keep `tariff` exactly as today for OpenCode Go/DeepSeek. The panel still
  draws both sides.
- `ratesNote` keeps the old recovery reasons for the tooltip; new code should
  prefer `priceNote`.
- Wire size: `models` adds at most ~1 KB for a four-model tree; no per-step
  `apiCost` in v1.
- The step wire rows are unchanged.

## 8. UI

### 8.1 Layout

```
Cost
┌─────────────────────┬─────────────────────┐
│ Total   [API]       │ Last turn           │
│ $1,180.00           │ $0.42               │
├─────────────────────┼─────────────────────┤
│ Model               │ Effective           │
│ Claude Opus 5.5     │ $0.29 / 1M          │
└─────────────────────┴─────────────────────┘
rates / 1M                    in     out    read   write
list ...................  $4.00  $20.00  $0.20   $5.00
Anthropic list · 2026-11-14
```

- `Total` value = API value; `API` badge next to the label.
- `Last turn` = API value for the turn.
- `Model` = card display name; title carries provider and model ID.
- `Effective` = API value / tokens; title carries the billed effective.
- Rates table always has four numeric columns: **in, out, read, write**.
- Row label:
  - `list` for a flat card.
  - `peak now` / `off-peak` for a time tariff, active row first.
  - `billed` for recovered rates with no card.
  - `manual` for an override.
  - `context >272k` for an active context tier.
- Source line below: `<source> · <checkedAt>`. For a lab fallback:
  `Command Code via Anthropic list · 2026-11-14`.
- If `models.length > 1`: append `+N models` to the source line; title lists
  each model's name, value and rates.
- If `lowerBound`: prefix the total and last turn with `≥ `; title lists
  unpriced models.
- **Prefix precedence:** `≥` is the only prefix. A total that is both partial
  and drifting keeps the `≥` and carries `price drift` as a flag; drift never
  becomes `≈` on the headline. Two markers on one number read as one wrong
  claim, and the floor is the stronger statement.

### 8.2 States

| State | Total | Rates line |
|---|---|---|
| Priced, complete | `$1,180.00` | table + source |
| Priced, partial | `≥ $12.00` | table + source; title names unpriced models |
| Free | `$0.0000` | `free · in $0 · out $0 · read $0 · write $0` |
| No price, billed > 0 | `—` (title shows billed) | `no published rate` |
| No price, billed = 0 | `—` | `no published rate` |
| Waiting for first step | `—` | `waiting for the first step` |
| Drift | `$12.00` (title shows both) | table + `price drift` flag |
| Model switch | new model's card | no stale card; title says the total includes prior models |

### 8.3 Formatting

- `moneyValue(n)`:
  - `null` → `—`
  - `>= 1000` → `$1,180.00`
  - `>= 10` → `$31.43`
  - else → 4 decimals (`$0.0842`)
- `listRate(n)`: `<0.001` → 4 decimals, `<0.01` → 3, else 2
  (`$20.00`, not `$20.0`; `$0.003`, `$0.0005`).
- `rateMoney(n)`: keep the current per-million formatting.
- `≥ ` is a text prefix, never a color alone. There is no `≈ ` prefix.

### 8.4 CSS

- `.cost-rates .rate-row`: five columns
  `minmax(52px, 1fr) 42px 42px 44px 46px`; gap `6px`.
- `.cost-rates .rate-source`: `font-size: 10.5px`, muted, wraps.
- `.cost-rates .rate-flag`: warning color, 10.5px.
- `.cost-total .api-badge`: 9.5px, muted, uppercase, margin-left 4px.
- The `Model` value cell is one line: `overflow: hidden`, `text-overflow:
  ellipsis`, `white-space: nowrap`. A wrapped model name would grow the block,
  and the full name is in the title.
- No color-only meaning; titles carry the full text.
- The block must not change the panel's height rules or the Work Status frame.

## 9. Reliability

### 9.1 Sources

| Source | Role | Runtime |
|---|---|---|
| models.dev `api.json` | primary rate snapshot | no (build-time only) |
| Anthropic / OpenAI / Command Code / OpenCode Go pages | verify + override | no |
| OpenCode `GET /api/model` | exact resolved prices, config overrides | optional, only if allowlisted |
| LiteLLM `model_prices_and_context_window.json` | cross-check | no |
| OpenRouter | dropped | no |

- Attribute models.dev in `README.md` and the snapshot header.
- Do not scrape provider pages at runtime. A price change is a release.
- If OpenCode later allowlists `/api/model`, prefer it over the book for
  metered providers and keep the book for subscriptions (their `cost` is empty).

### 9.2 Reconciliation

- For every model with `billed > 0`, compare API value and billed **for the
  whole model group**, never per step.
- `abs((apiValue - billed) / billed) > 0.01` → `drift`.
- The panel shows a `price drift` flag; the tooltip names both numbers. It does
  not change the headline number or add a prefix (section 8.1).
- The total remains API value. Billed remains the actual number.
- OpenCode Go is the strongest check: its card and its recorded cost should
  agree; a mismatch means the card or snapshot is stale.

**Measured on this machine, 2026-11-14** — `~/.local/share/opencode/opencode.db`,
every costed assistant message, card from models.dev, group totals:

| Group | Messages | API value | Billed | Drift |
|---|---|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | 1,520 | $27.4284 | $27.5837 | −0.56% |
| `opencode-go/glm-5.3-flash` | 190 | $6.2759 | $6.3296 | −0.85% |
| `opencode-go/muse-spark-1.3-contributor` | 95 | $0.7958 | $0.8265 | −3.72% (flags) |
| `deepseek/deepseek-flash` | 82 | $0.4466 | $0.4372 | +2.15% (flags; ignores the CN holiday rule) |

The design holds at group level: 97.6% of the Go spend reconciles inside 1%.
**Per message it does not:** the ratio spreads from 0.5× to 2× because the Go
`cost` is written at a time the peak window does not describe (20 messages carry
cost with almost no tokens), so a per-step drift flag would sit permanently on.
That is why drift is a group comparison only.

A `cost` written by local tooling rather than the provider (a backfill from a
local catalog) proves nothing about the card; INT-01 must compare against
messages the provider costed itself.

### 9.3 Staleness

- `checkedAt` is shown in the source tooltip.
- Older than 30 days: append `· snapshot is N days old` in the tooltip.
- An unknown model never falls back to a nearby model or an average.

## 10. Tooling and gates

New scripts:

- `scripts/sync-prices.mjs` — generate/check the book (network, manual).
- `scripts/check-prices.mjs` — optional drift report (network, manual).
- `scripts/price-test.mjs` — pure unit tests, no OpenChamber, no browser.

`package.json`:

```json
"test:prices": "node scripts/price-test.mjs",
"sync-prices": "node scripts/sync-prices.mjs",
"verify": "bun run build && bun run check && bash scripts/secret-scan.sh && bash scripts/check-changelog.sh && node scripts/price-test.mjs && node scripts/collector-test.mjs && node scripts/page-test.mjs"
```

Gates:

1. `node scripts/price-test.mjs` — pure, deterministic.
2. `node scripts/collector-test.mjs` — needs the local OpenCode server.
3. `node scripts/page-test.mjs` — needs `agent-browser`.
4. `bun run verify` — full gate.
5. Browser proof: screenshot of the six provider fixtures; console clean.
6. `bash scripts/secret-scan.sh` — clean.

## 11. Test plan

### 11.1 Fixtures

`scripts/fixtures/price-book.js` (test-only, not the real book):

- `anthropic/claude-opus-5-5`: 4 / 20 / 0.2 / 5.
- `anthropic/claude-sonnet-5-5`: 2 / 10 / 0.1 / 2.5.
- `anthropic/claude-fable-5-2`: 8 / 40 / 0.2 / 10.
- `openai/gpt-6.1-terra`: 1 / 5 / 0.05 / 1.25; context tier at 272k:
  2 / 7.5 / 0.1 / 2.5.
- `opencode-go/deepseek-v4.1-flash`: 0.15 / 0.6 / 0.003 / 0; time tariff 2×.
- `commandcode/deepseek/deepseek-v4.1-flash`: 0.15 / 0.6 / 0.003 / 0.
- `commandcode/free-model`: 0 / 0 / 0 / 0.
- `opencode/muse-spark-1.3-contributor-free`: 0 / 0 / 0 / 0 — the Zen free
  case that dominates real traffic; must resolve to `free`, not `noPrice`.
- `deepseek/deepseek-flash`: 0.15 / 0.6 / 0.003 / 0; time tariff 2× with the
  2026 Chinese holiday set, matching `shared/pricing.js` to the cent.
- Unknown: `unknown/model`.
- Aliases as in section 4.
- Override: `anthropic/claude-opus-5-5` at 3.5 / 18 / 0.18 / 4.5.

`scripts/fixtures/messages.js`: step arrays built from the formula, with known
expected values (section 11.4).

### 11.2 Price resolver

| ID | Case | Expected |
|---|---|---|
| PR-01 | exact `anthropic/claude-opus-5-5` | rates 4/20/0.2/5, `match: exact` |
| PR-02 | `claude-agent/opus` | resolves to `anthropic`, `match: alias` |
| PR-03 | `claude-agent/claude-fable-5-2` | exact under `anthropic` |
| PR-04 | `claude-agent/sonnet` | `claude-sonnet-5-5` |
| PR-05 | family `opus` with no alias | latest release in the family |
| PR-06 | `commandcode/deepseek/deepseek-v4.1-flash` | exact |
| PR-07 | `commandcode/deepseek-v4.1-flash` | bare ID resolves |
| PR-08 | `commandcode/claude-fable-5-2` | lab fallback to `anthropic` |
| PR-09 | `commandcode/gpt-6.1-terra` | lab fallback to `openai` |
| PR-10 | `commandcode/unknown` | `null` |
| PR-11 | two cards share a bare ID | `null` (ambiguous) |
| PR-12 | case-insensitive model ID | resolves |
| PR-13 | unknown provider/model | `null`, no guess |
| PR-14 | `opencode-go/glm-5.3-flash` | exact flat card |
| PR-15 | `opencode-go/deepseek-v4.1-flash` at peak | peak rates |
| PR-16 | same at off-peak / weekend | off-peak rates |
| PR-17 | DeepSeek official holiday | off-peak (existing tariff) |
| PR-18 | GPT-6.1 Terra prompt 100k | base rates |
| PR-19 | same prompt 272k | tier rates |
| PR-20 | same prompt 400k | tier rates |
| PR-21 | cache write present | included |
| PR-22 | cache write absent | 0 |
| PR-23 | free model | rates all 0 |
| PR-24 | override | override wins, `match: override` |
| PR-25 | invalid override (NaN/negative) | ignored, card used |
| PR-26 | no book | `null` |
| PR-27 | OpenRouter provider | `null` (dropped) |
| PR-28 | `claude-agent` with no model | `null` |
| PR-29 | source labels | exact strings |
| PR-30 | `checkedAt` carried | matches fixture |
| PR-31 | `opencode/muse-spark-1.3-contributor-free` | zero card, `match: exact` |
| PR-32 | `deepseek/deepseek-flash` at peak | 2× off-peak rates |
| PR-33 | same during a 2026 Chinese holiday | off-peak |
| PR-34 | lab fallback + override | override wins over the fallback card |
| PR-35 | override key with no resolvable card | `null`, not an override match |

### 11.3 Computation

| ID | Case | Expected |
|---|---|---|
| CV-01 | one Claude step 1M fresh input | `$4.00` |
| CV-02 | one Claude step 100k output | `$2.00` |
| CV-03 | one Claude step 5M cache read | `$1.00` |
| CV-04 | one Claude step 1M cache write | `$5.00` |
| CV-05 | all four on one step | `$12.00` |
| CV-06 | reasoning included in output | output rate applied |
| CV-07 | two steps sum | exact sum |
| CV-08 | last turn boundary | only steps at/after start |
| CV-09 | model switch | groups by model, total sum |
| CV-10 | parent + subagent | tree sum |
| CV-11 | partial coverage | `lowerBound`, `coverage <1` |
| CV-12 | unknown model only | `total: null`, `noPrice` |
| CV-13 | free model | `total: 0`, `coverage: 1`, `free` |
| CV-14 | billed sum | equals recorded costs |
| CV-15 | drift 2% | `drift`, `priceNote: drift` |
| CV-16 | drift 0.5% | no drift |
| CV-17 | context tier per step | higher rate on the large step |
| CV-18 | time tier per step | peak step 2× off-peak step |
| CV-19 | 0 tokens | 0 value, no divide by zero |
| CV-20 | 1,000 steps | under 50 ms, cached object reused |

### 11.4 Expected values

With the fixture book:

- Claude 1M fresh input + 100k output + 5M read + 1M write = **$12.00**.
- GPT-6.1 Terra same shape = **$3.00**.
- GPT-6.1 Terra above 272k context = **$5.75**.
- OpenCode Go DeepSeek off-peak same shape = **$0.225**; peak = **$0.45**.
- Command Code DeepSeek same shape = **$0.225**.
- DeepSeek official same shape = **$0.225** off-peak, **$0.45** at peak.
- Zen free model, any shape = **$0.0000**, `coverage: 1`, `priceNote: 'free'`.
- Partial: Claude $12.00 + unknown 1M = **$12.00**, `coverage <1`.
- Drift: card $12.00 vs billed $12.24 = **2%**, flagged.

### 11.5 Snapshot / collector

| ID | Case | Expected |
|---|---|---|
| SN-01 | `snapshot(..., fixtureBook)` | `cost.total` = API value; `cost.billed.total` = recorded |
| SN-02 | `snapshot(..., null)` | `cost.total` = billed (legacy) |
| SN-03 | subscription: cost 0 + card | `total >0`, `billed 0`, `priceNote: noBilledCost` |
| SN-04 | no card, no recovered | `total: null`, `priceNote: noPrice` |
| SN-05 | partial | `lowerBound: true` |
| SN-06 | OpenCode Go tariff | active side per step; `tariff` still drawn |
| SN-07 | main rates | `rates` is the card for the current model |
| SN-08 | multi-model | `models` present, sorted, each with rates |
| SN-09 | same steps twice | `derived.api` reused |
| SN-10 | new step | `derived.api` rebuilt |
| SN-11 | model switch | rates change, no stale card |
| SN-12 | turn | `lastTurn` API value |
| SN-13 | drift | `drift` set, total stays API value |
| SN-14 | free | `total: 0`, `priceNote: free` |
| SN-15 | unknown | no fake number |
| SN-16 | route | `createService({ priceBook })` passes the book to `/state` |

### 11.6 Page

| ID | Case | Expected |
|---|---|---|
| UI-01 | Claude fixture | `Total $1,180.00`, `API` badge |
| UI-02 | Claude rates | 4 numeric cells, `Anthropic list` source |
| UI-03 | ChatGPT fixture | `$31.43`, OpenAI source |
| UI-04 | Command Code fixture | `$12.40`, Command Code source |
| UI-05 | OpenCode Go peak | 2 rows, active peak first, 4 cells |
| UI-06 | OpenCode Go off-peak | active off-peak first |
| UI-07 | flat model | one `list` row, 4 cells |
| UI-08 | metered/recovered | `billed` row, no API badge claim |
| UI-09 | no price | `no published rate`, title |
| UI-10 | partial | `≥` prefix, title names unpriced |
| UI-11 | multi-model | `+N models` in source line |
| UI-12 | drift | `price drift` flag, no `≈`, title has both |
| UI-13 | model switch | no stale card |
| UI-14 | formatting | `$1,180.00`, `$31.43`, `$0.0842` |
| UI-15 | tooltip | source, checkedAt, match |
| UI-16 | empty | `—`, waiting text |
| UI-17 | free | `$0.0000`, free label |
| UI-18 | CSS | no overflow at 300 px |
| UI-19 | legacy shape | old cost fields do not crash |
| UI-20 | status frame | unchanged |

### 11.7 Live / integration

| ID | Case | Expected |
|---|---|---|
| INT-01 | OpenCode Go session | API value vs billed within 1% for the group (baseline 2026-11-14: −0.56% / −0.85%, section 9.2) |
| INT-02 | Claude session (`claude-agent`) | API value shown; billed 0 |
| INT-03 | ChatGPT session (`openai`) | API value shown; billed 0 |
| INT-04 | Command Code session | API value shown; billed 0 |
| INT-05 | unknown model | `no published rate` |
| INT-06 | totals/speed/TTFT | unchanged from v1.9.0 |
| INT-07 | service route | book passed, no 500 |
| INT-08 | no network | service makes no outbound request |
| INT-09 | secret scan | clean |
| INT-10 | full verify | green |
| INT-11 | OpenCode Zen session (`opencode`) | `$0.0000`, `free` label, `coverage: 1` — not `—` |
| INT-12 | DeepSeek official session | card matches the existing tariff side for side |

Skip `INT-02..04` with a clear `SKIP` line when the local OpenCode server has no
such session; never report a green that did not run. As of 2026-11-14 this
machine has `claude-agent` (16 messages) and `openai` (213) history but **no
`commandcode` message**, so INT-04 is a `SKIP` until one exists.

## 12. Rollout

| Phase | Work | Gate |
|---|---|---|
| 0 | This spec, owner review | **approved 2026-11-14** — six providers, `≥` wins |
| 1 | `shared/price-book.js`, resolver, fixtures, `price-test.mjs` | PR-01..35, CV-01..20 |
| 2 | `snapshot` + service wiring + collector tests; key the recovered fit and its cache by `provider/model` | SN-01..16 |
| 3 | Panel rendering + CSS + page tests | UI-01..20 |
| 4 | Reconciliation + live tests + browser proof | INT-01..12 |
| 5 | README, CHANGELOG, release | `bun run verify`, secret scan, screenshot |

No phase starts before the previous gate is green. Two failures on one issue →
set `blocked_on` in `docs/STATE.md` and stop (per `AGENTS.md`).

## 13. Acceptance criteria

1. A Claude, ChatGPT, Command Code, OpenCode Go, OpenCode Zen or DeepSeek
   session with a known model shows a non-blank API value and that model's own
   four rates. A Zen free model shows `$0.0000` with a `free` label.
2. A metered model's API value agrees with OpenCode's recorded cost within 1%,
   or a visible drift flag explains the difference.
3. An unknown model shows `no published rate`; no number is invented.
4. A partial tree shows `≥` and names the unpriced models.
5. `billed` remains visible and is never confused with API value.
6. The rates line never shows another provider's card.
7. Existing speed, token, TTFT and step-chart tests pass unchanged.
8. `bun run verify` is green; secret scan is clean; browser proof exists.
9. The service makes no outbound network request.
10. README and CHANGELOG describe API value, the six providers, and the
    estimate caveats.

## 14. Risks

| Risk | Mitigation |
|---|---|
| models.dev price lags | `checkedAt`, official-page verification, drift flag |
| wrong model match | exact/alias/bare first; `~` for family/lab; show matched key |
| recovered fit mixes two providers with the same model ID | Phase 2 keys the fit by `provider/model`; until then use it only when all steps share the provider |
| cache-write TTL | single standard rate, marked approximate in the title; revisit if exactness is needed |
| context tiers | per-step prompt tier; tests at threshold |
| stale snapshot | release update; `check-prices.mjs`; tooltip age |
| wire growth | `models` only when >1; no per-step API cost |
| performance | compute once per stepsKey; 1,000-step budget |
| misleading "Total" | `API` badge, tooltip, README; billed secondary |
| plan usage confusion | out of scope; no claim to derive plan limits |
| legal/ToS | public price data; no provider credentials |

## 15. Resolved questions

| # | Question | Answer |
|---|---|---|
| 1 | Version: feature/minor or major? | **Open** — the owner decides at the release gate. `Total` changes meaning, so major is defensible; the next `stable` otherwise follows `next-version.sh`. |
| 2 | `Total` + `API` badge, or rename `API value`? | `Total` + `API` badge (D9). |
| 3 | Active context tier only, or both rows? | Active tier only; the title names the threshold. |
| 4 | Plan-price multiplier now? | No (D8). |
| 5 | Commit the book or generate at build? | Commit it (D4). The service has no network. |
| 6 | `Effective` when coverage `<1`: `—` or `~`? | Value over priced tokens, marked `~` (D13). |
| 7 | Provider scope: four or more? | **Six** — owner, 2026-11-14: adds `opencode` (Zen) and `deepseek`. Zen free models then read `free`, not `no published rate`; DeepSeek's card matches its existing tariff. |
| 8 | A total that is both partial and drifting: `≥` or `≈`? | **`≥` wins; drift is a flag, never a prefix** (section 8.1). |

## 16. File change list

| File | Change |
|---|---|
| `docs/PRICING-SPEC.md` | this document |
| `shared/price-book.js` | new, generated snapshot |
| `shared/price-resolve.js` | new, pure resolver + compute |
| `shared/pricing.js` | keep time tariffs; export what the resolver needs |
| `service/src/prices.js` | new, override loader/validation |
| `service/src/collector.js` | `snapshot(..., priceBook)`, new `cost` shape, derive cache |
| `service/src/main.js` | load book/overrides, pass to both snapshot calls |
| `panel/src/main.js` | `paintCost`, `moneyValue`, `listRate`, rates table, source line |
| `panel/index.html` | cost grid CSS, source line, API badge, drift flag |
| `scripts/sync-prices.mjs` | new, generate/check the book |
| `scripts/check-prices.mjs` | new, optional drift report |
| `scripts/price-test.mjs` | new, pure tests |
| `scripts/fixtures/price-book.js` | new, test fixture |
| `scripts/fixtures/messages.js` | new, step fixtures |
| `scripts/collector-test.mjs` | snapshot tests with fixture book |
| `scripts/page-test.mjs` | new cost fixtures/assertions |
| `package.json` | `test:prices`, `sync-prices`, verify gate |
| `README.md` | API value semantics, sources, caveats |
| `CHANGELOG.md` | release entry |
| `docs/STATE.md` | local-only current task / next / log |

## 17. Out of scope

- OpenRouter pricing and any OpenRouter fallback.
- 30-day dashboard, model/project breakdown, activity heatmap.
- Plan usage bars (`Session`, `Week`, `Codex Plus`) — needs provider usage
  API/OAuth, not token math.
- Plan-price multiplier (`59×`, `1.6×`).
- Per-step API value in the chart hover (Phase 2 candidate).
- Live fetching from models.dev in the service.
- Changes to the Work Status section or the speed chart.
