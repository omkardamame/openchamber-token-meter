// Pure checks for the price book, the resolver and the API-value computation.
// No OpenCode, no browser, no network: runs anywhere, deterministic.
import { computeApiValue, resolvePrice } from '../shared/price-resolve.js';
import { FIXTURE_BOOK as book, FIXTURE_OVERRIDES, step, SATURDAY_NOON, MONDAY_PEAK, CN_HOLIDAY } from './fixtures/price-book.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ detail, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const resolve = (provider, model, extra = {}) => resolvePrice(book, { model, provider, ...extra });
const rates = (price) => (price ? [price.rates.input, price.rates.output, price.rates.cacheRead, price.rates.cacheWrite] : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= eps;

// --- 11.2 Price resolver -----------------------------------------------------

check('PR-01 exact anthropic card', same(rates(resolve('anthropic', 'claude-opus-5-5')), [4, 20, 0.2, 5]) && resolve('anthropic', 'claude-opus-5-5').match === 'exact');

const opusAlias = resolve('claude-agent', 'opus');
check('PR-02 claude-agent/opus is an alias', opusAlias?.provider === 'anthropic' && opusAlias.model === 'claude-opus-5-5' && opusAlias.match === 'alias');

const fableExact = resolve('claude-agent', 'claude-fable-5-2');
check('PR-03 claude-agent full id resolves exactly', fableExact?.model === 'claude-fable-5-2' && fableExact.match === 'exact');

check('PR-04 claude-agent/sonnet resolves', resolve('claude-agent', 'sonnet')?.model === 'claude-sonnet-5-5');

const family = resolve('anthropic', 'opus');
check('PR-05 family falls to the latest release', family?.model === 'claude-opus-5-5' && family.match === 'family');

check('PR-06 commandcode bare path id', resolve('commandcode', 'deepseek/deepseek-v4.1-flash')?.match === 'exact');
check('PR-07 commandcode short id resolves bare', resolve('commandcode', 'deepseek-v4.1-flash')?.model === 'deepseek/deepseek-v4.1-flash');

const labAnthropic = resolve('commandcode', 'claude-fable-5-2');
check('PR-08 lab fallback to Anthropic', labAnthropic?.provider === 'anthropic' && labAnthropic.match === 'lab' && labAnthropic.source === 'Command Code via Anthropic list', labAnthropic?.source);

const labOpenai = resolve('commandcode', 'gpt-6.1-terra');
check('PR-09 lab fallback to OpenAI', labOpenai?.provider === 'openai' && labOpenai.match === 'lab' && labOpenai.source === 'Command Code via OpenAI list', labOpenai?.source);

check('PR-10 commandcode unknown model', resolve('commandcode', 'unknown') === null);
check('PR-11 two cards share a bare id', resolve('anthropic', 'shared') === null);

const mixedCase = resolve('commandcode', 'zai-org/glm-5.3');
check('PR-12 case-insensitive model id', mixedCase?.model === 'zai-org/GLM-5.3', mixedCase?.model);

check('PR-13 unknown provider and model', resolve('nope', 'nope') === null);

const flat = resolve('opencode-go', 'glm-5.3-flash');
check('PR-14 flat card has no time tier', same(rates(flat), [0.15, 0.5, 0.03, 0]) && flat.timeTier === null);

const peak = resolve('opencode-go', 'deepseek-v4.1-flash', { at: MONDAY_PEAK });
check('PR-15 peak side applied', peak?.timeTier === 'peak' && same(rates(peak), [0.3, 1.2, 0.006, 0]), peak?.timeTier);

const offPeak = resolve('opencode-go', 'deepseek-v4.1-flash', { at: SATURDAY_NOON });
check('PR-16 off-peak side applied', offPeak?.timeTier === 'off-peak' && same(rates(offPeak), [0.15, 0.6, 0.003, 0]), offPeak?.timeTier);

const holiday = resolve('deepseek', 'deepseek-flash', { at: CN_HOLIDAY });
check('PR-17 Chinese holiday is off-peak', holiday?.timeTier === 'off-peak', holiday?.timeTier);

const base = resolve('openai', 'gpt-6.1-terra', { promptTokens: 100000 });
check('PR-18 base rates under the tier', same(rates(base), [1, 5, 0.05, 1.25]) && base.tier === null);

const atTier = resolve('openai', 'gpt-6.1-terra', { promptTokens: 272000 });
check('PR-19 tier applies at its threshold', same(rates(atTier), [2, 7.5, 0.1, 2.5]) && atTier.tier?.minContext === 272000);

check('PR-20 tier stays above the threshold', same(rates(resolve('openai', 'gpt-6.1-terra', { promptTokens: 400000 })), [2, 7.5, 0.1, 2.5]));

check('PR-21 cache write carried', resolve('anthropic', 'claude-opus-5-5').rates.cacheWrite === 5);
check('PR-22 cache write absent is zero', resolve('opencode-go', 'deepseek-v4.1-flash').rates.cacheWrite === 0);

const free = resolve('commandcode', 'free-model');
check('PR-23 free card is all zeros', same(rates(free), [0, 0, 0, 0]));

const overridden = resolve('anthropic', 'claude-opus-5-5', { overrides: FIXTURE_OVERRIDES });
check('PR-24 override wins', overridden?.match === 'override' && same(rates(overridden), [3.5, 18, 0.18, 4.5]) && overridden.source === 'manual override');

const badOverride = resolve('anthropic', 'claude-opus-5-5', { overrides: { 'anthropic/claude-opus-5-5': { cacheRead: 0.1, cacheWrite: 1, input: Number.NaN, output: 9 } } });
check('PR-25 invalid override is ignored', badOverride?.match === 'exact' && same(rates(badOverride), [4, 20, 0.2, 5]));

check('PR-26 no book', resolvePrice(null, { model: 'opus', provider: 'anthropic' }) === null);
check('PR-27 OpenRouter is not priced', resolve('openrouter', 'z-ai/glm-5.2:free') === null);
check('PR-28 provider with no model', resolve('claude-agent', '') === null);

const labels = [
  resolve('anthropic', 'claude-opus-5-5').source,
  resolve('openai', 'gpt-6.1-terra').source,
  resolve('opencode-go', 'glm-5.3-flash').source,
  resolve('opencode', 'muse-spark-1.3-contributor-free').source,
  resolve('deepseek', 'deepseek-flash').source,
  resolve('commandcode', 'free-model').source,
];
check('PR-29 source labels', same(labels, ['Anthropic list', 'OpenAI list', 'OpenCode Go card', 'OpenCode Zen list', 'DeepSeek list', 'Command Code list']), labels.join(' | '));

check('PR-30 checkedAt carried', resolve('anthropic', 'claude-opus-5-5').checkedAt === '2026-11-14');

const zen = resolve('opencode', 'muse-spark-1.3-contributor-free');
check('PR-31 Zen free card resolves exactly', zen?.match === 'exact' && same(rates(zen), [0, 0, 0, 0]));

const deepseekPeak = resolve('deepseek', 'deepseek-flash', { at: MONDAY_PEAK });
check('PR-32 DeepSeek peak side', deepseekPeak?.timeTier === 'peak' && same(rates(deepseekPeak), [0.3, 1.2, 0.006, 0]), deepseekPeak?.timeTier);

check('PR-33 DeepSeek holiday stays off-peak', same(rates(holiday), [0.15, 0.6, 0.003, 0]));

const labOverride = resolve('commandcode', 'claude-fable-5-2', { overrides: { 'anthropic/claude-fable-5-2': { cacheRead: 0.2, cacheWrite: 9, input: 7, output: 35 } } });
check('PR-34 override beats the lab fallback', labOverride?.provider === 'anthropic' && labOverride.match === 'override' && labOverride.rates.input === 7);

check('PR-35 override without a card is null', resolve('anthropic', 'no-such-model', { overrides: { 'anthropic/no-such-model': { cacheRead: 0, cacheWrite: 0, input: 1, output: 2 } } }) === null);

// The committed book and the time tariffs must agree: the panel draws the
// tariff's two sides while labeling them with the card's source, so a drift
// between the two would print one provider's numbers under another's name.
const { PRICE_BOOK } = await import('../shared/price-book.js');
const { timeTariff } = await import('../shared/pricing.js');
const tariffMismatch = [];
for (const [provider, entry] of Object.entries(PRICE_BOOK.providers)) {
  for (const [modelId, card] of Object.entries(entry.models)) {
    const tariff = timeTariff(provider, modelId);
    if (!tariff) continue;
    const same = ['input', 'output', 'cacheRead'].every(
      (key) => Math.abs((card.cost[key] ?? 0) - (tariff.offPeak[key] ?? 0)) <= Math.max(1e-9, Math.abs(tariff.offPeak[key]) * 1e-6),
    );
    if (!same) tariffMismatch.push(`${provider}/${modelId}: book ${JSON.stringify(card.cost)} vs off-peak ${JSON.stringify(tariff.offPeak)}`);
  }
}
check('PR-36 every tariffed card matches its off-peak side', tariffMismatch.length === 0, tariffMismatch.slice(0, 2).join(' · '));

// --- 11.3 Computation --------------------------------------------------------

const value = (steps, extra = {}) => computeApiValue(book, steps, extra);

check('CV-01 fresh input at the input rate', near(value([step({ input: 1e6 })]).total, 4), String(value([step({ input: 1e6 })]).total));
check('CV-02 output at the output rate', near(value([step({ generated: 1e5 })]).total, 2));
check('CV-03 cache read at the read rate', near(value([step({ cacheRead: 5e6 })]).total, 1));
check('CV-04 cache write at the write rate', near(value([step({ cacheWrite: 1e6 })]).total, 5));
check('CV-05 all four on one step', near(value([step({ cacheRead: 5e6, cacheWrite: 1e6, generated: 1e5, input: 1e6 })]).total, 12));
check('CV-06 reasoning rides the output rate', near(value([step({ generated: 100000 })]).total, 2));

const twoSteps = value([step({ input: 1e6 }), step({ generated: 1e5 })]);
check('CV-07 two steps sum', near(twoSteps.total, 6) && twoSteps.pricedSteps === 2, String(twoSteps.total));

const turned = value([step({ at: 1000, input: 1e6 }), step({ at: 2000, input: 1e6 })], { turnStartedAt: 1500 });
check('CV-08 last turn boundary', near(turned.lastTurn, 4) && near(turned.total, 8));

const switched = value([step({ input: 1e6 }), step({ generated: 1e6, model: 'gpt-6.1-terra', provider: 'openai' })]);
check('CV-09 model switch groups', switched.models.length === 2 && switched.models[0].model === 'gpt-6.1-terra' && near(switched.total, 9), `${switched.models.length} groups, $${switched.total}`);

const tree = value([step({ input: 1e6, provider: 'claude-agent' }), step({ input: 1e6, provider: 'anthropic' })]);
check('CV-10 parent and subagent sum', near(tree.total, 8) && tree.models.length === 1);

const partial = value([step({ input: 1e6 }), step({ input: 1e6, model: 'unknown/model', provider: 'nowhere' })]);
check('CV-11 partial coverage is a lower bound', partial.lowerBound === true && partial.coverage < 1 && near(partial.total, 4) && partial.priceNote === 'partial', `coverage ${partial.coverage}`);

const unknown = value([step({ model: 'unknown/model', provider: 'nowhere', input: 1e6 })]);
check('CV-12 unknown model only', unknown.total === null && unknown.priceNote === 'noPrice');

const zenValue = value([step({ input: 1e6, model: 'muse-spark-1.3-contributor-free', provider: 'opencode' })]);
check('CV-13 free model', zenValue.total === 0 && zenValue.coverage === 1 && zenValue.priceNote === 'free');

const billed = value([step({ cost: 1.5, input: 1e6 }), step({ cost: 2.5, input: 1e6 })]);
check('CV-14 billed sum', near(billed.billed.total, 4) && near(billed.billed.lastTurn >= 0 ? 0 : 1, 0));

const drifted = value([step({ cacheRead: 5e6, cacheWrite: 1e6, cost: 12.24, generated: 1e5, input: 1e6 })]);
check('CV-15 drift over 1% flags', Boolean(drifted.drift) && drifted.priceNote === 'drift' && near(drifted.total, 12), drifted.drift ? `${(drifted.drift.relative * 100).toFixed(2)}%` : 'none');

const steady = value([step({ cacheRead: 5e6, cacheWrite: 1e6, cost: 12.06, generated: 1e5, input: 1e6 })]);
check('CV-16 drift under 1% stays quiet', steady.drift === null && steady.priceNote === null);

const tiered = value([step({ input: 100000, model: 'gpt-6.1-terra', provider: 'openai' }), step({ input: 300000, model: 'gpt-6.1-terra', provider: 'openai' })]);
check('CV-17 context tier per step', near(tiered.total, 0.1 + 0.6), String(tiered.total));

const timed = value([step({ at: MONDAY_PEAK, input: 1e6, model: 'deepseek-v4.1-flash', provider: 'opencode-go' }), step({ at: SATURDAY_NOON, input: 1e6, model: 'deepseek-v4.1-flash', provider: 'opencode-go' })]);
check('CV-18 time tier per step', near(timed.total, 0.45), String(timed.total));

const empty = value([step({})]);
check('CV-19 zero tokens do not divide by zero', empty.total === 0 && Number.isFinite(empty.perMillion ?? 0) && empty.priceNote === null, `total ${empty.total}, perMillion ${empty.perMillion}`);

const many = Array.from({ length: 1000 }, (_, i) => step({ at: i * 1000, input: 1000 + i, generated: 100 }));
const started = performance.now();
const manyValue = value(many, { turnStartedAt: 500 * 1000 });
const elapsed = performance.now() - started;
check('CV-20 1,000 steps under 50 ms', elapsed < 50 && near(manyValue.total, manyValue.models.reduce((sum, m) => sum + m.apiValue, 0)), `${elapsed.toFixed(1)} ms`);

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} price checks passed`);
process.exit(process.exitCode ?? 0);
