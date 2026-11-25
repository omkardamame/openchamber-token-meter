// API value: what a session's tokens would cost at list rates.
//
// Pure: no fs, no network, no OpenCode client. The book and any overrides are
// passed in, which is what lets every rule be tested without a browser or a
// server. See docs/PRICING-SPEC.md sections 5 and 6.
import { isPeakAt, timeTariff } from './pricing.js';

export const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const LAB_PREFIX = { 'claude-': 'anthropic', 'gpt-': 'openai' };
const EIGHT = 1e-9;

function tierRate(cost, minContext) {
  return { cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0, input: cost.input, minContext, output: cost.output };
}

/** An override is usable only when all four rates are real and non-negative. */
function usableOverride(entry) {
  if (!entry) return null;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const value = entry[key];
    if (!Number.isFinite(value) || value < 0) return null;
  }
  return entry;
}

/** The highest context tier whose threshold the prompt reaches, or null. */
function activeTier(card, promptTokens) {
  if (!card?.tiers?.length) return null;
  let active = null;
  for (const tier of card.tiers) {
    if (tier.minContext <= promptTokens) active = tier;
  }
  return active;
}

/** A model id without its first path segment, if it has one. */
function bareId(model) {
  const cut = model.indexOf('/');
  return cut === -1 ? model : model.slice(cut + 1);
}

const cardIndexCache = new WeakMap();
const AMBIGUOUS = Symbol('ambiguous');

function indexCards(cards) {
  let cached = cardIndexCache.get(cards);
  if (cached) return cached;
  const byLower = new Map();
  const byBare = new Map();
  for (const id of Object.keys(cards)) {
    const lower = id.toLowerCase();
    byLower.set(lower, byLower.has(lower) ? AMBIGUOUS : id);
    const bare = bareId(id);
    byBare.set(bare, byBare.has(bare) ? AMBIGUOUS : id);
  }
  cached = { byLower, byBare };
  cardIndexCache.set(cards, cached);
  return cached;
}

/**
 * Resolve an OpenCode provider/model pair to a card.
 *
 * Order: exact → provider alias → model alias → bare id → family latest →
 * lab fallback. An override replaces the resolved card's rates. Never guesses:
 * an unknown model, an ambiguous bare id, or a missing book answers null.
 */
export function resolvePrice(book, { provider, model, promptTokens = 0, at = Date.now(), overrides = null } = {}) {
  if (!book?.providers || !provider || !model) return null;
  const aliases = book.aliases ?? {};
  const priceProvider = aliases.providers?.[provider] ?? provider;
  const cards = book.providers[priceProvider]?.models;
  if (cards && cards[model]) return finish(book, priceProvider, model, cards[model], 'exact', promptTokens, at, overrides);

  // A case-only difference is the same model: vendors write `zai-org/GLM-5.3`
  // while a session records `zai-org/glm-5.3`.
  if (cards) {
    const idx = indexCards(cards);
    const sameId = idx.byLower.get(model.toLowerCase());
    if (sameId && sameId !== AMBIGUOUS) {
      return finish(book, priceProvider, sameId, cards[sameId], 'exact', promptTokens, at, overrides);
    }
  }

  // Model alias: an OpenCode-versus-vendor short name (`opus`, `haiku`).
  const aliasId = aliases.models?.[provider]?.[model];
  if (aliasId && cards?.[aliasId]) {
    return finish(book, priceProvider, aliasId, cards[aliasId], 'alias', promptTokens, at, overrides);
  }

  if (cards) {
    // Bare id: `deepseek/deepseek-v4.1-flash` is a Command Code model id.
    const idx = indexCards(cards);
    const bare = bareId(model);
    const bareMatch = idx.byBare.get(bare);
    if (bareMatch === AMBIGUOUS) return null;
    if (bareMatch) {
      return finish(book, priceProvider, bareMatch, cards[bareMatch], 'bare', promptTokens, at, overrides);
    }
    // Family latest, only for a known Claude short name.
    if (FAMILIES.includes(model)) {
      const family = Object.keys(cards)
        .filter((id) => id.startsWith(`claude-${model}-`))
        .sort((a, b) => (cards[a].release ?? '').localeCompare(cards[b].release ?? '') || a.localeCompare(b));
      const latest = family[family.length - 1];
      if (latest) return finish(book, priceProvider, latest, cards[latest], 'family', promptTokens, at, overrides);
    }
  }

  // Lab fallback: only Command Code, priced from the lab that makes the model.
  if (priceProvider === 'commandcode') {
    for (const [prefix, lab] of Object.entries(LAB_PREFIX)) {
      if (!model.startsWith(prefix)) continue;
      const labCards = book.providers[lab]?.models;
      const target = labCards && (labCards[model] ? model : bareId(model));
      if (labCards?.[target]) {
        const resolved = finish(book, lab, target, labCards[target], 'lab', promptTokens, at, overrides);
        // Say where the number really came from: the lab's list, not Command Code's.
        resolved.source = `Command Code via ${book.providers[lab].source}`;
        return resolved;
      }
    }
  }
  return null;
}

function finish(book, priceProvider, model, card, match, promptTokens, at, overrides) {
  const base = card.cost ?? {};
  const tier = activeTier(card, promptTokens);
  let rates = {
    cacheRead: base.cacheRead ?? 0,
    cacheWrite: base.cacheWrite ?? 0,
    input: base.input,
    output: base.output,
    ...(tier ? tier.cost : {}),
  };
  let timeTier = null;
  let timeHours = null;

  // An override is a deliberate statement about this model: it wins over the
  // card and over a time tariff, and it is not tiered. A malformed entry is
  // ignored here as well as at load time, so a hand-edited file cannot make the
  // meter print NaN.
  const override = usableOverride(overrides?.[`${priceProvider}/${model}`]);
  let finalMatch = match;
  let finalSource = book.providers[priceProvider]?.source ?? null;
  let finalTier = tier ? { minContext: tier.minContext, rates: tierRate(tier.cost, tier.minContext) } : null;
  if (override) {
    rates = { cacheRead: override.cacheRead, cacheWrite: override.cacheWrite, input: override.input, output: override.output };
    finalMatch = 'override';
    finalSource = 'manual override';
    finalTier = null;
  } else {
    const tariff = timeTariff(priceProvider, model);
    if (tariff) {
      const onPeak = isPeakAt(at, tariff.schedule);
      timeTier = onPeak ? 'peak' : 'off-peak';
      timeHours = tariff.schedule.label;
      const side = onPeak ? tariff.peak : tariff.offPeak;
      rates = { cacheRead: side.cacheRead ?? 0, cacheWrite: 0, input: side.input, output: side.output };
      // A tariff's two sides replace a base cost; a tier cannot also apply.
      finalTier = null;
    }
  }

  return {
    checkedAt: book.checkedAt ?? null,
    match: finalMatch,
    model,
    name: card.name ?? model,
    provider: priceProvider,
    rates: { ...rates },
    release: card.release ?? null,
    source: finalSource,
    tier: finalTier,
    timeHours,
    timeTier,
  };
}

/** True when every rate in a resolved card is zero. */
export function isFree(price) {
  return Boolean(price) && ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => price.rates[key] === 0);
}

/**
 * Cost of one step at its own card, tier and timestamp.
 *
 *   freshInput = total - tokens   (tokens = output + reasoning)
 *   generated  = tokens
 *   consumed   = freshInput + generated + cacheRead + cacheWrite
 */
export function priceStep(book, step, { provider = null, model = null, overrides = null, recovered = null } = {}) {
  const stepProvider = step.provider ?? provider;
  const stepModel = step.model ?? model;
  const generated = step.tokens ?? 0;
  const freshInput = Math.max(0, (step.total ?? 0) - generated);
  const cacheRead = step.cacheRead ?? 0;
  const cacheWrite = step.cacheWrite ?? 0;
  const prompt = freshInput + cacheRead + cacheWrite;
  const consumed = prompt + generated;
  let price = resolvePrice(book, { at: step.at, model: stepModel, overrides, promptTokens: prompt, provider: stepProvider });

  // No card: fall back to rates recovered from this provider's own recorded
  // costs. Only for the provider the caller fitted, so two providers that share
  // a model id cannot borrow each other's prices.
  if (!price && recovered && recovered.model === stepModel && (!recovered.provider || recovered.provider === stepProvider)) {
    price = {
      match: 'recovered',
      model: stepModel,
      name: null,
      provider: stepProvider,
      rates: { cacheRead: recovered.rates.cacheRead ?? 0, cacheWrite: recovered.rates.cacheWrite ?? 0, input: recovered.rates.input, output: recovered.rates.output },
      release: null,
      source: 'billed rates',
      tier: null,
      timeHours: null,
      timeTier: null,
    };
  }

  const apiCost = price
    ? (freshInput * price.rates.input +
        generated * price.rates.output +
        cacheRead * price.rates.cacheRead +
        cacheWrite * price.rates.cacheWrite) /
      1e6
    : null;

  return {
    apiCost,
    at: step.at ?? null,
    billed: step.cost ?? 0,
    cacheRead,
    cacheWrite,
    consumed,
    freshInput,
    generated,
    group: price ? `${price.provider}/${price.model}` : `${stepProvider ?? '?'}/${stepModel ?? '?'}`,
    model: stepModel,
    price,
    provider: stepProvider,
    unpriced: price === null,
  };
}

/**
 * API value for a session and its subagents.
 *
 * Groups by the card that priced each step, so a model switch or a peak/off-peak
 * pair shows as two rows instead of an average. Drift is compared per group:
 * per step the recorded cost carries a timestamp the tariff window does not
 * always describe, and a per-step flag sits permanently on.
 */
export function computeApiValue(book, steps, { turnStartedAt = null, provider = null, model = null, overrides = null, recovered = null } = {}) {
  // The turn is a sum over the steps that ran after a boundary. Keeping one
  // price object per step just for that sum retained ~450 B per step in the
  // whole tree (90 MB at the 201k-step cap), so only the timeline is kept: its
  // timestamps and cumulative sums, or the raw numbers when order is unknown.
  const timelineAt = [];
  const timelineApi = [];
  const timelineBilled = [];
  const groups = new Map();
  let total = 0;
  let lastTurn = 0;
  let billedTotal = 0;
  let billedLastTurn = 0;
  let pricedConsumed = 0;
  let totalConsumed = 0;
  let pricedSteps = 0;
  let freeSteps = 0;

  for (const step of steps) {
    const row = priceStep(book, step, { model, overrides, provider, recovered });
    timelineAt.push(step.at ?? 0);
    timelineApi.push(row.apiCost ?? 0);
    timelineBilled.push(row.billed);
    totalConsumed += row.consumed;
    billedTotal += row.billed;
    if (!row.unpriced) {
      pricedSteps += 1;
      total += row.apiCost;
      pricedConsumed += row.consumed;
      if (isFree(row.price)) freeSteps += 1;
    }
    if (turnStartedAt != null && (step.at ?? 0) >= turnStartedAt) {
      billedLastTurn += row.billed;
      if (!row.unpriced) lastTurn += row.apiCost;
    }
    let group = groups.get(row.group);
    if (!group) {
      group = {
        apiValue: 0,
        // Drift must compare the same steps: the API value and the recorded
        // bill of the steps that have both, never the token value of usage the
        // provider did not bill.
        apiValueBilled: 0,
        billed: 0,
        billedPriced: 0,
        cacheRead: 0,
        cacheWrite: 0,
        consumed: 0,
        freshInput: 0,
        generated: 0,
        match: row.price?.match ?? null,
        model: row.price?.model ?? row.model,
        name: row.price?.name ?? null,
        price: row.price,
        priced: 0,
        pricedConsumed: 0,
        provider: row.price?.provider ?? row.provider,
        source: row.price?.source ?? null,
        steps: 0,
      };
      groups.set(row.group, group);
    }
    group.steps += 1;
    group.billed += row.billed;
    group.consumed += row.consumed;
    group.freshInput += row.freshInput;
    group.generated += row.generated;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    if (!row.unpriced) {
      group.priced += 1;
      group.pricedConsumed += row.consumed;
      group.apiValue += row.apiCost;
      // Only steps the provider actually billed can say anything about drift.
      if (row.billed > 0) {
        group.apiValueBilled += row.apiCost;
        group.billedPriced += row.billed;
      }
      // The active side and its rates come from the last step that had a card.
      group.match = row.price.match;
      group.price = row.price;
      group.name = row.price.name ?? row.price.model;
      group.source = row.price.source;
    }
  }

  // Cumulative sums make the turn filter a binary search. The wire rounds to
  // six decimals, so summing in a different order is invisible; an unsorted
  // list (not expected from the collector) falls back to the old linear scan.
  let ordered = true;
  for (let index = 1; index < timelineAt.length; index += 1) {
    if (timelineAt[index] < timelineAt[index - 1]) {
      ordered = false;
      break;
    }
  }
  let turnTotals;
  if (ordered) {
    const count = timelineAt.length;
    const at = Float64Array.from(timelineAt);
    const apiCum = new Float64Array(count);
    const billedCum = new Float64Array(count);
    let apiSum = 0;
    let billedSum = 0;
    for (let index = 0; index < count; index += 1) {
      apiSum += timelineApi[index];
      billedSum += timelineBilled[index];
      apiCum[index] = apiSum;
      billedCum[index] = billedSum;
    }
    turnTotals = (from) => {
      if (from == null || count === 0) return { api: 0, billed: 0 };
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (at[mid] < from) low = mid + 1;
        else high = mid;
      }
      if (low === count) return { api: 0, billed: 0 };
      return {
        api: apiCum[count - 1] - (low > 0 ? apiCum[low - 1] : 0),
        billed: billedCum[count - 1] - (low > 0 ? billedCum[low - 1] : 0),
      };
    };
  } else {
    turnTotals = (from) => {
      let api = 0;
      let billed = 0;
      if (from == null) return { api, billed };
      for (let index = 0; index < timelineAt.length; index += 1) {
        if (timelineAt[index] < from) continue;
        api += timelineApi[index];
        billed += timelineBilled[index];
      }
      return { api, billed };
    };
  }

  const coverage = totalConsumed > 0 ? pricedConsumed / totalConsumed : pricedSteps > 0 ? 1 : 0;
  const lowerBound = coverage < 1 - EIGHT;
  const drifted = [];
  for (const group of groups.values()) {
    if (group.priced === 0) continue;
    group.coverage = group.consumed > 0 ? group.pricedConsumed / group.consumed : 0;
    group.rates = group.price?.rates ?? null;
    group.timeTier = group.price?.timeTier ?? null;
    group.tier = group.price?.tier ?? null;
    group.drift = null;
    if (group.billedPriced > 0 && group.apiValueBilled > 0) {
      const relative = (group.apiValueBilled - group.billedPriced) / group.billedPriced;
      if (Math.abs(relative) > 0.01) {
        group.drift = relative;
        drifted.push({ model: group.model, relative });
      }
    }
  }

  const models = [...groups.values()]
    .filter((group) => group.priced > 0)
    .map((group) => ({
      apiValue: group.apiValue,
      billed: group.billed,
      consumed: group.consumed,
      coverage: group.coverage,
      drift: group.drift,
      match: group.match,
      model: group.model,
      name: group.name,
      provider: group.provider,
      rates: group.rates,
      source: group.source,
      steps: group.steps,
      tier: group.tier,
      timeTier: group.timeTier,
      tokens: { cacheRead: group.cacheRead, cacheWrite: group.cacheWrite, generated: group.generated, input: group.freshInput },
    }))
    .sort((a, b) => b.apiValue - a.apiValue || a.model.localeCompare(b.model));

  const unpriced = [...groups.values()]
    .filter((group) => group.priced === 0)
    .map((group) => ({ consumed: group.consumed, model: group.model, provider: group.provider }));

  drifted.sort((a, b) => Math.abs(b.relative) - Math.abs(a.relative));
  const billedTouched = billedTotal > 0;
  const allFree = pricedSteps > 0 && freeSteps === pricedSteps;

  let priceNote = null;
  if (pricedSteps === 0) priceNote = 'noPrice';
  else if (lowerBound) priceNote = 'partial';
  else if (drifted.length) priceNote = 'drift';
  else if (allFree) priceNote = 'free';
  else if (!billedTouched && total > 0) priceNote = 'noBilledCost';

  return {
    billed: {
      effective: totalConsumed > 0 ? billedTotal / totalConsumed : null,
      lastTurn: billedLastTurn,
      perMillion: totalConsumed > 0 ? (billedTotal / totalConsumed) * 1e6 : null,
      total: billedTotal,
    },
    coverage,
    drift: drifted[0] ?? null,
    effective: total > 0 && (coverage === 1 ? totalConsumed : pricedConsumed) > 0 ? total / (coverage === 1 ? totalConsumed : pricedConsumed) : null,
    lastTurn: pricedSteps === 0 ? null : lastTurn,
    lowerBound,
    models,
    perMillion:
      total > 0 && (coverage === 1 ? totalConsumed : pricedConsumed) > 0
        ? (total / (coverage === 1 ? totalConsumed : pricedConsumed)) * 1e6
        : null,
    priceNote,
    pricedSteps,
    pricedTokens: pricedConsumed,
    turnTotals,
    total: pricedSteps === 0 ? null : total,
    totalTokens: totalConsumed,
    unpriced,
  };
}
