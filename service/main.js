// service/src/main.js
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

// shared/chart.js
function ratesOf(steps) {
  let tokens = 0;
  let ms = 0;
  let peak = 0;
  let peakAt = null;
  for (const step of steps ?? []) {
    if (!step?.tps || step.tps <= 0 || step.aborted)
      continue;
    tokens += step.tokens;
    ms += step.ms;
    if (step.tps > peak) {
      peak = step.tps;
      peakAt = typeof step.at === "number" ? step.at : null;
    }
  }
  return { avg: ms > 0 ? tokens / ms * 1000 : 0, peak, peakAt };
}

// shared/pricing.js
var UTC_WEEKDAY = {
  windows: [
    [1, 4],
    [6, 10]
  ],
  label: "01:00–04:00 and 06:00–10:00 UTC, Mon–Fri",
  holidays: null
};
var CN_HOLIDAY_RANGES = [
  ["2026-01-01", "2026-01-03"],
  ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"],
  ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"],
  ["2026-10-01", "2026-10-07"]
];
function holidaySet(ranges) {
  const days = new Set;
  for (const [start, end] of ranges) {
    const from = Date.parse(`${start}T00:00:00Z`);
    const to = Date.parse(`${end}T00:00:00Z`);
    for (let at = from;at <= to; at += 86400000) {
      days.add(new Date(at).toISOString().slice(0, 10));
    }
  }
  return days;
}
var UTC_WEEKDAY_CN = {
  windows: UTC_WEEKDAY.windows,
  label: "01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays",
  holidays: holidaySet(CN_HOLIDAY_RANGES),
  holidayYear: 2026
};
var flash = (schedule) => ({
  schedule,
  peakMultiplier: 2,
  offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
  peak: { input: 0.3, output: 1.2, cacheRead: 0.006 }
});
var pro = (schedule) => ({
  schedule,
  peakMultiplier: 2,
  offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
  peak: { input: 1.32, output: 3.96, cacheRead: 0.044 }
});
var TIME_TARIFFS = {
  "opencode-go/deepseek-v4.1-flash": flash(UTC_WEEKDAY),
  "opencode-go/deepseek-v4-pro": pro(UTC_WEEKDAY),
  "deepseek/deepseek-flash": flash(UTC_WEEKDAY_CN),
  "deepseek/deepseek-v4-flash": flash(UTC_WEEKDAY_CN),
  "deepseek/deepseek-v4-flash-vision-exp": flash(UTC_WEEKDAY_CN),
  "deepseek/deepseek-v4-pro": pro(UTC_WEEKDAY_CN)
};
function timeTariff(provider, model) {
  if (!provider || !model)
    return null;
  return TIME_TARIFFS[`${provider}/${model}`] ?? null;
}
function isPeakAt(at, schedule = UTC_WEEKDAY) {
  const date = new Date(Number(at));
  if (!Number.isFinite(date.getTime()))
    return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6)
    return false;
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (!schedule.windows.some(([start, end]) => minute >= start * 60 && minute < end * 60))
    return false;
  if (schedule.holidays?.has(date.toISOString().slice(0, 10)))
    return false;
  return true;
}
var pick = (rates) => ({ input: rates.input, output: rates.output, cacheRead: rates.cacheRead });
var scale = (rates, factor) => ({
  input: Math.round(rates.input * factor * 1e6) / 1e6,
  output: Math.round(rates.output * factor * 1e6) / 1e6,
  cacheRead: Math.round(rates.cacheRead * factor * 1e6) / 1e6
});
function tariffTiers(tariff, rates = null) {
  const card = {
    source: "card",
    offPeak: { ...tariff.offPeak },
    peak: { ...tariff.peak }
  };
  if (!rates)
    return card;
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.000001, Math.abs(b) * 0.01);
  const matches = (side) => near(rates.input, side.input) && near(rates.output, side.output) && near(rates.cacheRead, side.cacheRead);
  const atPeak = matches(tariff.peak);
  const atOffPeak = matches(tariff.offPeak);
  if (atPeak && !atOffPeak) {
    return { source: "recovered", offPeak: scale(rates, 1 / tariff.peakMultiplier), peak: pick(rates) };
  }
  if (atOffPeak) {
    return { source: "recovered", offPeak: pick(rates), peak: scale(rates, tariff.peakMultiplier) };
  }
  return card;
}

// shared/price-resolve.js
var FAMILIES = ["opus", "sonnet", "haiku", "fable"];
var LAB_PREFIX = { "claude-": "anthropic", "gpt-": "openai" };
var EIGHT = 0.000000001;
function tierRate(cost, minContext) {
  return { cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0, input: cost.input, minContext, output: cost.output };
}
function usableOverride(entry) {
  if (!entry)
    return null;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const value = entry[key];
    if (!Number.isFinite(value) || value < 0)
      return null;
  }
  return entry;
}
function activeTier(card, promptTokens) {
  if (!card?.tiers?.length)
    return null;
  let active = null;
  for (const tier of card.tiers) {
    if (tier.minContext <= promptTokens)
      active = tier;
  }
  return active;
}
function bareId(model) {
  const cut = model.indexOf("/");
  return cut === -1 ? model : model.slice(cut + 1);
}
function resolvePrice(book, { provider, model, promptTokens = 0, at = Date.now(), overrides = null } = {}) {
  if (!book?.providers || !provider || !model)
    return null;
  const aliases = book.aliases ?? {};
  const priceProvider = aliases.providers?.[provider] ?? provider;
  const cards = book.providers[priceProvider]?.models;
  if (cards && cards[model])
    return finish(book, priceProvider, model, cards[model], "exact", promptTokens, at, overrides);
  if (cards) {
    const lower = model.toLowerCase();
    const sameModel = Object.keys(cards).filter((id) => id.toLowerCase() === lower);
    if (sameModel.length === 1) {
      return finish(book, priceProvider, sameModel[0], cards[sameModel[0]], "exact", promptTokens, at, overrides);
    }
  }
  const aliasId = aliases.models?.[provider]?.[model];
  if (aliasId && cards?.[aliasId]) {
    return finish(book, priceProvider, aliasId, cards[aliasId], "alias", promptTokens, at, overrides);
  }
  if (cards) {
    const bare = bareId(model);
    const matches = Object.keys(cards).filter((id) => id === bare || bareId(id) === bare);
    if (matches.length === 1) {
      return finish(book, priceProvider, matches[0], cards[matches[0]], "bare", promptTokens, at, overrides);
    }
    if (matches.length > 1)
      return null;
    if (FAMILIES.includes(model)) {
      const family = Object.keys(cards).filter((id) => id.startsWith(`claude-${model}-`)).sort((a, b) => (cards[a].release ?? "").localeCompare(cards[b].release ?? "") || a.localeCompare(b));
      const latest = family[family.length - 1];
      if (latest)
        return finish(book, priceProvider, latest, cards[latest], "family", promptTokens, at, overrides);
    }
  }
  if (priceProvider === "commandcode") {
    for (const [prefix, lab] of Object.entries(LAB_PREFIX)) {
      if (!model.startsWith(prefix))
        continue;
      const labCards = book.providers[lab]?.models;
      const target = labCards && (labCards[model] ? model : bareId(model));
      if (labCards?.[target]) {
        const resolved = finish(book, lab, target, labCards[target], "lab", promptTokens, at, overrides);
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
    ...tier ? tier.cost : {}
  };
  let timeTier = null;
  let timeHours = null;
  const override = usableOverride(overrides?.[`${priceProvider}/${model}`]);
  let finalMatch = match;
  let finalSource = book.providers[priceProvider]?.source ?? null;
  let finalTier = tier ? { minContext: tier.minContext, rates: tierRate(tier.cost, tier.minContext) } : null;
  if (override) {
    rates = { cacheRead: override.cacheRead, cacheWrite: override.cacheWrite, input: override.input, output: override.output };
    finalMatch = "override";
    finalSource = "manual override";
    finalTier = null;
  } else {
    const tariff = timeTariff(priceProvider, model);
    if (tariff) {
      const onPeak = isPeakAt(at, tariff.schedule);
      timeTier = onPeak ? "peak" : "off-peak";
      timeHours = tariff.schedule.label;
      const side = onPeak ? tariff.peak : tariff.offPeak;
      rates = { cacheRead: side.cacheRead ?? 0, cacheWrite: 0, input: side.input, output: side.output };
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
    timeTier
  };
}
function isFree(price) {
  return Boolean(price) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => price.rates[key] === 0);
}
function priceStep(book, step, { provider = null, model = null, overrides = null, recovered = null } = {}) {
  const stepProvider = step.provider ?? provider;
  const stepModel = step.model ?? model;
  const generated = step.tokens ?? 0;
  const freshInput = Math.max(0, (step.total ?? 0) - generated);
  const cacheRead = step.cacheRead ?? 0;
  const cacheWrite = step.cacheWrite ?? 0;
  const prompt = freshInput + cacheRead + cacheWrite;
  const consumed = prompt + generated;
  let price = resolvePrice(book, { at: step.at, model: stepModel, overrides, promptTokens: prompt, provider: stepProvider });
  if (!price && recovered && recovered.model === stepModel && (!recovered.provider || recovered.provider === stepProvider)) {
    price = {
      match: "recovered",
      model: stepModel,
      name: null,
      provider: stepProvider,
      rates: { cacheRead: recovered.rates.cacheRead ?? 0, cacheWrite: recovered.rates.cacheWrite ?? 0, input: recovered.rates.input, output: recovered.rates.output },
      release: null,
      source: "billed rates",
      tier: null,
      timeHours: null,
      timeTier: null
    };
  }
  const apiCost = price ? (freshInput * price.rates.input + generated * price.rates.output + cacheRead * price.rates.cacheRead + cacheWrite * price.rates.cacheWrite) / 1e6 : null;
  return {
    apiCost,
    at: step.at ?? null,
    billed: step.cost ?? 0,
    cacheRead,
    cacheWrite,
    consumed,
    freshInput,
    generated,
    group: price ? `${price.provider}/${price.model}` : `${stepProvider ?? "?"}/${stepModel ?? "?"}`,
    model: stepModel,
    price,
    provider: stepProvider,
    unpriced: price === null
  };
}
function computeApiValue(book, steps, { turnStartedAt = null, provider = null, model = null, overrides = null, recovered = null } = {}) {
  const rows = [];
  const groups = new Map;
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
    rows.push(row);
    totalConsumed += row.consumed;
    billedTotal += row.billed;
    if (!row.unpriced) {
      pricedSteps += 1;
      total += row.apiCost;
      pricedConsumed += row.consumed;
      if (isFree(row.price))
        freeSteps += 1;
    }
    if (turnStartedAt != null && (step.at ?? 0) >= turnStartedAt) {
      billedLastTurn += row.billed;
      if (!row.unpriced)
        lastTurn += row.apiCost;
    }
    let group = groups.get(row.group);
    if (!group) {
      group = {
        apiValue: 0,
        billed: 0,
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
        steps: 0
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
      group.match = row.price.match;
      group.price = row.price;
      group.name = row.price.name ?? row.price.model;
      group.source = row.price.source;
    }
  }
  const coverage = totalConsumed > 0 ? pricedConsumed / totalConsumed : pricedSteps > 0 ? 1 : 0;
  const lowerBound = coverage < 1 - EIGHT;
  const drifted = [];
  for (const group of groups.values()) {
    if (group.priced === 0)
      continue;
    group.coverage = group.consumed > 0 ? group.pricedConsumed / group.consumed : 0;
    group.rates = group.price?.rates ?? null;
    group.timeTier = group.price?.timeTier ?? null;
    group.tier = group.price?.tier ?? null;
    group.drift = null;
    if (group.billed > 0 && group.apiValue > 0) {
      const relative = (group.apiValue - group.billed) / group.billed;
      if (Math.abs(relative) > 0.01) {
        group.drift = relative;
        drifted.push({ model: group.model, relative });
      }
    }
  }
  const models = [...groups.values()].filter((group) => group.priced > 0).map((group) => ({
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
    tokens: { cacheRead: group.cacheRead, cacheWrite: group.cacheWrite, generated: group.generated, input: group.freshInput }
  })).sort((a, b) => b.apiValue - a.apiValue || a.model.localeCompare(b.model));
  const unpriced = [...groups.values()].filter((group) => group.priced === 0).map((group) => ({ consumed: group.consumed, model: group.model, provider: group.provider }));
  drifted.sort((a, b) => Math.abs(b.relative) - Math.abs(a.relative));
  const billedTouched = billedTotal > 0;
  const allFree = pricedSteps > 0 && freeSteps === pricedSteps;
  let priceNote = null;
  if (pricedSteps === 0)
    priceNote = "noPrice";
  else if (lowerBound)
    priceNote = "partial";
  else if (drifted.length)
    priceNote = "drift";
  else if (allFree)
    priceNote = "free";
  else if (!billedTouched && total > 0)
    priceNote = "noBilledCost";
  return {
    billed: {
      effective: totalConsumed > 0 ? billedTotal / totalConsumed : null,
      lastTurn: billedLastTurn,
      perMillion: totalConsumed > 0 ? billedTotal / totalConsumed * 1e6 : null,
      total: billedTotal
    },
    coverage,
    drift: drifted[0] ?? null,
    effective: total > 0 && (coverage === 1 ? totalConsumed : pricedConsumed) > 0 ? total / (coverage === 1 ? totalConsumed : pricedConsumed) : null,
    lastTurn: pricedSteps === 0 ? null : lastTurn,
    lowerBound,
    models,
    perMillion: total > 0 && (coverage === 1 ? totalConsumed : pricedConsumed) > 0 ? total / (coverage === 1 ? totalConsumed : pricedConsumed) * 1e6 : null,
    priceNote,
    pricedSteps,
    pricedTokens: pricedConsumed,
    rows,
    total: pricedSteps === 0 ? null : total,
    totalTokens: totalConsumed,
    unpriced
  };
}

// service/src/collector.js
var HISTORY_PAGES = 20;
var HISTORY_PAGE_SIZE = 100;
var MAX_STEPS = 1000;
var SERIES_POINTS = 240;
var LONG_POINTS = 300;
var LONG_MIN_POINTS = 61;
var SERIES_INTERVAL_MS = 250;
var LONG_BUCKET_MS = 1000;
var LIVE_WINDOW_MS = 3000;
var DEFAULT_CHARS_PER_TOKEN = 0.28;
var TOOL_CHARS_MAX = 200;
var SUBAGENT_RANK = { streaming: 0, tool: 1, "waiting-permission": 2, "waiting-question": 2 };
var ROSTER_CAP = 200;
var ROSTER_TTL_MS = 60 * 60000;
var WIDE_POINTS = 360;
var WIDE_BUCKET_MS = 1e4;
var LIVE_TYPES = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.usage.updated",
  "session.usage.recorded",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled"
]);
var emptyTotals = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  steps: 0
});
function createCollector(id) {
  return {
    id,
    parentId: null,
    title: null,
    watched: false,
    watchedAt: 0,
    lineageAt: 0,
    lineageTriedAt: 0,
    lineageLoading: false,
    model: null,
    provider: null,
    status: "idle",
    pendingTools: 0,
    error: null,
    totals: emptyTotals(),
    totalsFrom: "history",
    steps: [],
    stepsSeq: 0,
    knownSteps: 0,
    series: [],
    seriesLong: [],
    seriesWide: [],
    chars: [],
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    stream: null,
    turnActive: false,
    turnStartedAt: 0,
    turnStartTriedAt: 0,
    turnStartLoading: false,
    ttftMs: null,
    lastTtftMs: null,
    lastStep: null,
    historyAt: 0,
    historyPartial: false,
    historyCut: false,
    historyTriedAt: 0,
    loading: null,
    derived: null,
    touchedAt: Date.now()
  };
}
function wantsEvent(type) {
  return LIVE_TYPES.has(type);
}
function partKey(type, data) {
  const kind = type.includes("reasoning") ? "reasoning" : type.includes("tool.input") ? "tool" : "text";
  return `${kind}:${data.assistantMessageID ?? ""}:${data.ordinal ?? data.id ?? ""}`;
}
function addChars(collector, type, data, at) {
  const delta = type.endsWith(".delta");
  const n = delta ? typeof data.delta === "string" ? data.delta.length : 0 : typeof data.text === "string" ? data.text.length : 0;
  if (!n)
    return;
  if (collector.stream) {
    collector.stream.deltaParts ??= new Set;
    const key = partKey(type, data);
    if (!delta && collector.stream.deltaParts.has(key))
      return;
    if (delta)
      collector.stream.deltaParts.add(key);
  }
  const isTool = type === "session.tool.input.delta" || type === "session.tool.input.ended";
  if (isTool) {
    if (!collector.stream)
      return;
    const key = typeof data.id === "string" ? data.id : "tool";
    const used = collector.stream.toolChars.get(key) ?? 0;
    const capped = Math.min(n, Math.max(0, TOOL_CHARS_MAX - used));
    if (!capped)
      return;
    collector.stream.toolChars.set(key, used + capped);
    addWindowChars(collector, data, capped, at);
    return;
  }
  addWindowChars(collector, data, n, at);
}
function addWindowChars(collector, data, n, at) {
  if (collector.stream && typeof data.assistantMessageID === "string") {
    if (!collector.stream.messageID)
      collector.stream.messageID = data.assistantMessageID;
    if (collector.stream.messageID === data.assistantMessageID) {
      collector.stream.chars += n;
    }
  }
  const previous = collector.chars[collector.chars.length - 1];
  const t = previous && previous.t > at ? previous.t : at;
  collector.chars.push({ t, n });
  const floor = t - LIVE_WINDOW_MS * 2;
  while (collector.chars.length && collector.chars[0].t < floor)
    collector.chars.shift();
}
function noteFirstOutput(collector, type, at) {
  if (!collector.stream)
    return;
  const isOutput = type === "session.text.started" || type === "session.text.delta" || type === "session.reasoning.started" || type === "session.reasoning.delta" || type === "session.tool.input.started" || type === "session.tool.input.delta";
  if (!isOutput)
    return;
  if (collector.stream.firstOutputAt)
    return;
  collector.stream.firstOutputAt = at;
  const startedAt = collector.stream.started;
  collector.ttftMs = startedAt ? Math.max(0, at - startedAt) : null;
}
function charsInWindow(collector, now) {
  let sum = 0;
  for (let i = collector.chars.length - 1;i >= 0; i -= 1) {
    const bucket = collector.chars[i];
    if (now - bucket.t > LIVE_WINDOW_MS)
      break;
    sum += bucket.n;
  }
  return sum;
}
function sameShape(tokens) {
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0
  };
}
function calibrate(collector, chars, tokens) {
  if (!chars || !tokens)
    return;
  const ratio = tokens / chars;
  if (!Number.isFinite(ratio) || ratio <= 0)
    return;
  const clamped = Math.min(6, Math.max(0.02, ratio));
  collector.charsPerToken = collector.charsPerToken * 0.7 + clamped * 0.3;
}
function raisedTotals(current, shape, cost = null, steps = null) {
  return {
    input: Math.max(current.input, shape.input),
    output: Math.max(current.output, shape.output),
    reasoning: Math.max(current.reasoning, shape.reasoning),
    cacheRead: Math.max(current.cacheRead, shape.cacheRead),
    cacheWrite: Math.max(current.cacheWrite, shape.cacheWrite),
    cost: Math.max(current.cost, typeof cost === "number" ? cost : current.cost),
    steps: typeof steps === "number" ? Math.max(current.steps, steps) : current.steps
  };
}
function applyRecord(collector, record) {
  if (!record)
    return;
  const updated = record.time?.updated ?? record.time?.created;
  if (typeof updated === "number" && updated > (collector.recordUpdatedAt ?? 0)) {
    collector.recordUpdatedAt = updated;
  }
  if (typeof record.title === "string" && record.title)
    collector.title = record.title;
  if (typeof record.model?.id === "string")
    collector.model = record.model.id;
  if (typeof record.model?.providerID === "string")
    collector.provider = record.model.providerID;
  const busy = record.time?.busy;
  const idle = record.time?.idle;
  const working = Boolean(busy && (!idle || busy > idle));
  if (working) {
    if (collector.status === "idle")
      collector.status = "streaming";
    collector.turnActive = true;
  } else if (collector.status !== "failed") {
    const staleStream = Boolean(collector.stream && idle && collector.stream.startedAt && idle > collector.stream.startedAt);
    if (!collector.stream || staleStream) {
      collector.status = "idle";
      collector.turnActive = false;
      collector.stream = null;
      collector.pendingTools = 0;
    }
  }
  const tokens = record.tokens;
  if (!tokens)
    return;
  collector.totals = raisedTotals(collector.totals, sameShape(tokens), record.cost);
  collector.totalsFrom = "usage";
}
function pushStep(collector, step) {
  if (!step.tokens)
    return;
  collector.stepsSeq += 1;
  collector.steps.push(step);
  if (collector.steps.length > MAX_STEPS)
    collector.steps.splice(0, collector.steps.length - MAX_STEPS);
}
function partSpan(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  let start = 0;
  let end = 0;
  let tool = false;
  for (const part of parts) {
    const time = part?.time ?? {};
    if (part?.type === "text" || part?.type === "reasoning") {
      if (typeof time.created === "number" && (!start || time.created < start))
        start = time.created;
      if (typeof time.completed === "number" && time.completed > end)
        end = time.completed;
    } else if (part?.type === "tool") {
      tool = true;
      if (typeof time.created === "number" && (!start || time.created < start))
        start = time.created;
    }
  }
  if (tool && !end && typeof message?.time?.streamed === "number")
    end = message.time.streamed;
  return start && end && end > start ? { start, end } : null;
}
function stepFromMessage(message) {
  const tokens = message?.tokens;
  const created = message?.time?.created;
  const streamed = message?.time?.streamed;
  if (!tokens || typeof created !== "number")
    return null;
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  const span = partSpan(message);
  const ms = span ? span.end - span.start : typeof streamed === "number" ? Math.max(0, streamed - created) : 0;
  return {
    id: message.id,
    at: typeof streamed === "number" ? streamed : created,
    model: typeof message.model?.id === "string" ? message.model.id : null,
    provider: typeof message.model?.providerID === "string" ? message.model.providerID : null,
    tokens: output,
    total: (tokens.input ?? 0) + output,
    cost: typeof message.cost === "number" ? message.cost : 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    ms,
    tps: ms > 150 ? Math.round(output / ms * 1000 * 10) / 10 : null,
    ttftMs: span ? Math.max(0, span.start - created) : null,
    aborted: Boolean(message.error),
    measured: true
  };
}
async function loadHistory(collector, apiGet, deadline = 0, { stepsOnly = false } = {}) {
  if (collector.loading)
    return collector.loading;
  collector.historyTriedAt = Date.now();
  const run = (async () => {
    const messages = [];
    let cursor = null;
    let complete = true;
    let cutByDeadline = false;
    for (let page = 0;page < HISTORY_PAGES; page += 1) {
      if (deadline && Date.now() > deadline) {
        complete = false;
        cutByDeadline = true;
        break;
      }
      const query = new URLSearchParams({ type: "assistant", limit: String(HISTORY_PAGE_SIZE) });
      if (cursor)
        query.set("cursor", cursor);
      else
        query.set("order", "desc");
      const answer = await apiGet(`/api/session/${encodeURIComponent(collector.id)}/message?${query.toString()}`);
      const data = Array.isArray(answer?.data) ? answer.data : [];
      messages.push(...data);
      cursor = answer?.cursor?.next ?? null;
      if (!cursor || data.length === 0)
        break;
    }
    if (cursor)
      complete = false;
    messages.sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0));
    const totals = emptyTotals();
    const steps = [];
    let chars = 0;
    let tokens = 0;
    for (const message of messages) {
      if (message?.type !== "assistant" || !message.tokens)
        continue;
      const shape = sameShape(message.tokens);
      totals.input += shape.input;
      totals.output += shape.output;
      totals.reasoning += shape.reasoning;
      totals.cacheRead += shape.cacheRead;
      totals.cacheWrite += shape.cacheWrite;
      totals.cost += typeof message.cost === "number" ? message.cost : 0;
      totals.steps += 1;
      const step = stepFromMessage(message);
      if (step)
        steps.push(step);
      chars += textChars(message);
      tokens += shape.output + shape.reasoning;
    }
    collector.knownSteps = Math.max(collector.knownSteps, totals.steps);
    if (!stepsOnly) {
      const cumulative = collector.totalsFrom === "usage";
      collector.totals = raisedTotals(collector.totals, totals, totals.cost, totals.steps);
      if (!cumulative)
        collector.totalsFrom = "history";
    }
    const seen = new Set(steps.map((step) => step.id));
    for (const step of collector.steps) {
      if (step.id && !seen.has(step.id))
        steps.push(step);
    }
    steps.sort((a, b) => a.at - b.at);
    collector.steps = steps.slice(-MAX_STEPS);
    collector.model = steps.at(-1)?.model ?? collector.model;
    collector.provider = steps.at(-1)?.provider ?? collector.provider;
    collector.stepsSeq += 1;
    collector.lastStep = [...collector.steps].reverse().find((step) => step.tps) ?? null;
    collector.lastTtftMs = [...collector.steps].reverse().find((step) => step.ttftMs > 0)?.ttftMs ?? null;
    if (tokens > 0 && chars > 0)
      calibrate(collector, chars, tokens);
    collector.historyPartial = !complete;
    collector.historyCut = cutByDeadline;
    collector.historyAt = Date.now();
    collector.error = null;
    return complete;
  })().catch((error) => {
    collector.error = error?.message ?? String(error);
    collector.historyPartial = true;
    collector.historyCut = false;
    return false;
  }).finally(() => {
    collector.loading = null;
  });
  collector.loading = run;
  return run;
}
function textChars(message) {
  if (!Array.isArray(message.content))
    return 0;
  let sum = 0;
  for (const part of message.content) {
    if (typeof part?.text === "string")
      sum += part.text.length;
    else if (typeof part?.content === "string")
      sum += part.content.length;
    else if (part?.state?.input !== undefined)
      sum += JSON.stringify(part.state.input).length;
  }
  return sum;
}
function applyEvent(collector, event) {
  const type = event?.type;
  if (!wantsEvent(type))
    return;
  const data = event.data ?? {};
  if (data.sessionID && data.sessionID !== collector.id)
    return;
  if (!data.sessionID && type === "form.created" && data.form?.sessionID !== collector.id)
    return;
  const at = typeof event.created === "number" ? event.created : Date.now();
  switch (type) {
    case "session.execution.started":
      collector.turnActive = true;
      collector.status = "streaming";
      collector.error = null;
      collector.turnStartedAt = typeof data.started === "number" ? data.started : at;
      return;
    case "session.tool.called":
      collector.pendingTools += 1;
      collector.status = "tool";
      return;
    case "session.tool.success":
    case "session.tool.failed":
      collector.pendingTools = Math.max(0, collector.pendingTools - 1);
      if (collector.pendingTools === 0 && collector.status === "tool") {
        collector.status = collector.stream || collector.turnActive ? "streaming" : "idle";
      }
      return;
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      collector.turnActive = false;
      collector.status = "idle";
      collector.stream = null;
      collector.pendingTools = 0;
      return;
    case "session.execution.failed":
      collector.turnActive = false;
      collector.status = "failed";
      collector.stream = null;
      collector.pendingTools = 0;
      return;
    case "permission.asked":
      collector.status = "waiting-permission";
      return;
    case "permission.replied":
      if (collector.status === "waiting-permission")
        collector.status = collector.turnActive ? "streaming" : "idle";
      return;
    case "form.created":
      collector.status = "waiting-question";
      return;
    case "form.replied":
    case "form.cancelled":
      if (collector.status === "waiting-question")
        collector.status = collector.turnActive ? "streaming" : "idle";
      return;
    case "session.step.started":
      collector.pendingTools = 0;
      if (typeof data.model?.id === "string")
        collector.model = data.model.id;
      if (typeof data.model?.providerID === "string")
        collector.provider = data.model.providerID;
      collector.stream = {
        started: typeof data.started === "number" ? data.started : at,
        startedAt: at,
        streamedAt: null,
        model: collector.model,
        provider: collector.provider,
        messageID: data.assistantMessageID ?? null,
        chars: 0,
        firstOutputAt: null,
        toolChars: new Map
      };
      collector.ttftMs = null;
      collector.status = "streaming";
      return;
    case "session.step.streamed":
      if (collector.stream && (!data.assistantMessageID || collector.stream.messageID === data.assistantMessageID)) {
        collector.stream.streamedAt = at;
      }
      return;
    case "session.step.ended":
    case "session.step.failed": {
      const tokens = data.tokens ? sameShape(data.tokens) : null;
      const stream = collector.stream;
      if (tokens) {
        const output = tokens.output + tokens.reasoning;
        const startedAt = stream?.firstOutputAt ?? stream?.started ?? at;
        const endAt = stream?.streamedAt ?? at;
        const ms = Math.max(0, endAt - startedAt);
        const step = {
          id: data.assistantMessageID ?? null,
          at: endAt,
          model: stream?.model ?? collector.model,
          provider: stream?.provider ?? collector.provider,
          tokens: output,
          total: tokens.input + output,
          cost: typeof data.cost === "number" ? data.cost : 0,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          ms,
          tps: ms > 150 ? Math.round(output / ms * 1000 * 10) / 10 : null,
          ttftMs: stream?.firstOutputAt && stream?.started ? Math.max(0, stream.firstOutputAt - stream.started) : null,
          aborted: data.error?.type === "aborted",
          measured: true
        };
        const known = step.id && collector.steps.some((item) => item.id === step.id);
        if (!known) {
          pushStep(collector, step);
          if (collector.totalsFrom !== "usage") {
            collector.totals = {
              input: collector.totals.input + tokens.input,
              output: collector.totals.output + tokens.output,
              reasoning: collector.totals.reasoning + tokens.reasoning,
              cacheRead: collector.totals.cacheRead + tokens.cacheRead,
              cacheWrite: collector.totals.cacheWrite + tokens.cacheWrite,
              cost: collector.totals.cost + (typeof data.cost === "number" ? data.cost : 0),
              steps: collector.totals.steps + 1
            };
            collector.totalsFrom = "events";
          } else {
            collector.totals = { ...collector.totals, steps: collector.totals.steps + 1 };
          }
        }
        if (stream?.chars)
          calibrate(collector, stream.chars, output);
        collector.lastStep = step;
        if (step.ttftMs > 0)
          collector.lastTtftMs = step.ttftMs;
      }
      collector.stream = null;
      collector.status = collector.pendingTools > 0 ? "tool" : "idle";
      return;
    }
    case "session.usage.updated":
    case "session.usage.recorded": {
      if (!data.tokens)
        return;
      collector.totals = raisedTotals(collector.totals, sameShape(data.tokens), data.cost, collector.steps.length);
      collector.totalsFrom = "usage";
      return;
    }
    default:
      noteFirstOutput(collector, type, at);
      addChars(collector, type, data, at);
  }
}
function memberRate(collector, now) {
  if (collector.status !== "streaming")
    return 0;
  return charsInWindow(collector, now) / (LIVE_WINDOW_MS / 1000) * collector.charsPerToken;
}
function addWideBucket(collector, now, value) {
  const t = now - now % WIDE_BUCKET_MS;
  const last = collector.seriesWide[collector.seriesWide.length - 1];
  if (last && last.t > t)
    return;
  if (last && last.t === t) {
    last.sum += value;
    last.n += 1;
    return;
  }
  collector.seriesWide.push({ t, sum: value, n: 1 });
  if (collector.seriesWide.length > WIDE_POINTS) {
    collector.seriesWide.splice(0, collector.seriesWide.length - WIDE_POINTS);
  }
}
function addLongBucket(collector, now, value) {
  const t = now - now % LONG_BUCKET_MS;
  const last = collector.seriesLong[collector.seriesLong.length - 1];
  if (last && last.t > t)
    return;
  if (last && last.t === t) {
    last.sum += value;
    last.n += 1;
    return;
  }
  collector.seriesLong.push({ t, sum: value, n: 1 });
  if (collector.seriesLong.length > LONG_POINTS) {
    collector.seriesLong.splice(0, collector.seriesLong.length - LONG_POINTS);
  }
}
function tick(collector, now = Date.now(), tree = [collector]) {
  const streaming = tree.some((member) => member.status === "streaming");
  const rate = streaming ? tree.reduce((sum, member) => sum + memberRate(member, now), 0) : 0;
  const last = collector.series[collector.series.length - 1];
  if (!last || now - last.t >= SERIES_INTERVAL_MS) {
    const value = Math.round(rate * 10) / 10;
    collector.series.push({ t: now, v: value });
    if (collector.series.length > SERIES_POINTS)
      collector.series.splice(0, collector.series.length - SERIES_POINTS);
    addLongBucket(collector, now, value);
    addWideBucket(collector, now, value);
  }
  return rate;
}
function treeStatus(collector, tree) {
  const streaming = tree.some((member) => member.status === "streaming");
  if (streaming && collector.status !== "streaming")
    return { status: "streaming", subagent: true };
  if (collector.status !== "idle")
    return { status: collector.status, subagent: false };
  const waiting = tree.find((member) => member.status === "waiting-permission" || member.status === "waiting-question");
  if (waiting)
    return { status: waiting.status, subagent: true };
  if (tree.some((member) => member.status === "tool"))
    return { status: "tool", subagent: true };
  return { status: collector.status, subagent: false };
}
function modelRates(steps, model, provider = null) {
  if (!model)
    return null;
  const rows = [];
  for (const step of steps) {
    if (step.model !== model || !(step.cost > 0))
      continue;
    if (provider && step.provider && step.provider !== provider)
      continue;
    const input = step.total - step.tokens;
    if (!(input >= 0) || !(step.cacheRead >= 0))
      continue;
    rows.push([input, step.tokens, step.cacheRead, step.cost * 1e6]);
  }
  if (rows.length < 8 || !rows.some((row) => row[2] > 0))
    return null;
  const n = 3;
  const scale2 = Array.from({ length: n }, (_, column) => Math.sqrt(rows.reduce((sum, row) => sum + row[column] * row[column], 0) / rows.length));
  if (scale2.some((value) => !(value > 0)))
    return null;
  const a = Array.from({ length: n }, () => Array(n).fill(0));
  const b = Array(n).fill(0);
  for (const row of rows) {
    for (let i = 0;i < n; i += 1) {
      const left = row[i] / scale2[i];
      b[i] += left * row[3];
      for (let j = 0;j < n; j += 1)
        a[i][j] += left * (row[j] / scale2[j]);
    }
  }
  const maxPivot = Math.max(...a.map((row, i) => Math.abs(row[i])));
  for (let column = 0;column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1;row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column]))
        pivot = row;
    }
    if (Math.abs(a[pivot][column]) < maxPivot * 0.0000000001)
      return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    [b[column], b[pivot]] = [b[pivot], b[column]];
    for (let row = 0;row < n; row += 1) {
      if (row === column)
        continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column;k < n; k += 1)
        a[row][k] -= factor * a[column][k];
      b[row] -= factor * b[column];
    }
  }
  const x = b.map((value, i) => value / a[i][i] / scale2[i]);
  if (x.some((value) => !Number.isFinite(value) || value < -0.000001))
    return null;
  let error = 0;
  let scaleY = 0;
  for (const row of rows) {
    const predicted = row[0] * x[0] + row[1] * x[1] + row[2] * x[2];
    error += (row[3] - predicted) ** 2;
    scaleY += row[3] ** 2;
  }
  if (scaleY <= 0)
    return null;
  const relative = Math.sqrt(error / rows.length) / Math.sqrt(scaleY / rows.length);
  if (relative > 0.0001)
    return null;
  const round = (value) => Math.round(value * 1e6) / 1e6;
  return { model, input: round(x[0]), output: round(x[1]), cacheRead: round(x[2]) };
}
function snapshot(collector, now = Date.now(), tree = [collector], priceBook = null, overrides = null) {
  const members = tree.length ? tree : [collector];
  const totals = emptyTotals();
  for (const member of members) {
    totals.input += member.totals.input;
    totals.output += member.totals.output;
    totals.reasoning += member.totals.reasoning;
    totals.cacheRead += member.totals.cacheRead;
    totals.cacheWrite += member.totals.cacheWrite;
    totals.cost += member.totals.cost;
    totals.steps += member.totals.steps;
  }
  const stepsKey = members.map((member) => `${member.id}:${member.stepsSeq}:${member.steps.length}`).join("|");
  let derived = collector.derived;
  if (derived?.key !== stepsKey) {
    const steps2 = [];
    const subOwner2 = new Map;
    for (const member of members) {
      for (const step of member.steps) {
        steps2.push(step);
        if (member !== collector)
          subOwner2.set(step, member.id);
      }
    }
    steps2.sort((a, b) => a.at - b.at);
    const shownSteps2 = steps2.slice(-MAX_STEPS);
    derived = {
      key: stepsKey,
      steps: steps2,
      subOwner: subOwner2,
      shownSteps: shownSteps2,
      rates: ratesOf(steps2),
      wire: shownSteps2.map((step) => ({
        tokens: step.tokens,
        in: Math.max(0, (step.total ?? step.tokens) - step.tokens),
        ms: step.ms,
        tps: step.tps,
        aborted: step.aborted,
        at: step.at,
        cost: Math.round((step.cost ?? 0) * 1e6) / 1e6,
        ...subOwner2.has(step) ? { sub: subOwner2.get(step) } : {}
      })),
      ratesByModel: new Map
    };
    collector.derived = derived;
  }
  const { steps, subOwner, shownSteps, rates, wire } = derived;
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const generated = totals.output + totals.reasoning;
  const consumed = prompt + generated;
  const totalCost = Math.round(totals.cost * 1e6) / 1e6;
  const stepsKnown = members.reduce((sum, member) => sum + Math.max(member.totals.steps, member.steps.length, member.knownSteps), 0);
  let lastTurnCost = 0;
  let turnTokens = 0;
  let turnSteps = 0;
  let turnConsumed = 0;
  if (collector.turnStartedAt) {
    for (const step of steps) {
      if (step.at >= collector.turnStartedAt) {
        lastTurnCost += step.cost ?? 0;
        turnTokens += step.tokens ?? 0;
        turnConsumed += (step.total ?? 0) + (step.cacheRead ?? 0) + (step.cacheWrite ?? 0);
        turnSteps += 1;
      }
    }
  }
  lastTurnCost = Math.round(lastTurnCost * 1e6) / 1e6;
  const live = collector.series[collector.series.length - 1]?.v ?? 0;
  const streamer = members.find((member) => member.status === "streaming" && member.ttftMs != null);
  const lastStepRaw = members.reduce((best, member) => member.lastStep && (!best || member.lastStep.at > best.at) ? member.lastStep : best, null);
  const model = collector.model ?? lastStepRaw?.model ?? null;
  const modelKey = `${collector.provider ?? ""}|${model ?? ""}`;
  let modelCostRates;
  if (derived.ratesByModel.has(modelKey)) {
    modelCostRates = derived.ratesByModel.get(modelKey);
  } else {
    modelCostRates = modelRates(steps, model, collector.provider ?? null);
    derived.ratesByModel.set(modelKey, modelCostRates);
  }
  const tariff = timeTariff(collector.provider, model);
  const tiers = tariff ? tariffTiers(tariff, modelCostRates) : null;
  const pricedSteps = steps.filter((step) => step.model === model && step.cost > 0);
  const ratesNote = modelCostRates ? null : pricedSteps.length < 8 ? "fewSteps" : pricedSteps.some((step) => step.cacheRead > 0) ? "nonLinear" : "noCache";
  let api = null;
  let ratesCard = null;
  if (priceBook) {
    const apiKey = `${collector.provider ?? ""}|${model ?? ""}|${overrides ? "override" : ""}`;
    if (!derived.api || derived.apiKey !== apiKey || derived.apiBook !== priceBook || derived.apiOverrides !== overrides) {
      const recovered = modelCostRates ? { model, provider: collector.provider ?? null, rates: modelCostRates } : null;
      derived.api = computeApiValue(priceBook, steps, {
        model,
        overrides,
        provider: collector.provider ?? null,
        recovered
      });
      derived.apiBook = priceBook;
      derived.apiKey = apiKey;
      derived.apiOverrides = overrides;
    }
    api = derived.api;
    const lastOfModel = [...steps].reverse().find((item) => item.model === model) ?? null;
    const promptTokens = lastOfModel ? Math.max(0, (lastOfModel.total ?? 0) - (lastOfModel.tokens ?? 0)) + (lastOfModel.cacheRead ?? 0) + (lastOfModel.cacheWrite ?? 0) : 0;
    ratesCard = resolvePrice(priceBook, {
      at: now,
      model,
      overrides,
      promptTokens,
      provider: lastOfModel?.provider ?? collector.provider ?? null
    });
    if (!ratesCard && modelCostRates) {
      ratesCard = {
        checkedAt: null,
        match: "recovered",
        model,
        name: null,
        provider: collector.provider ?? null,
        rates: {
          cacheRead: modelCostRates.cacheRead ?? 0,
          cacheWrite: modelCostRates.cacheWrite ?? 0,
          input: modelCostRates.input,
          output: modelCostRates.output
        },
        source: "billed rates",
        tier: null,
        timeTier: null
      };
    }
  }
  let apiTurn = 0;
  let billedTurn = 0;
  if (api && collector.turnStartedAt) {
    for (const row of api.rows) {
      if (!((row.at ?? 0) >= collector.turnStartedAt))
        continue;
      billedTurn += row.billed;
      if (row.apiCost != null)
        apiTurn += row.apiCost;
    }
  }
  const round6 = (value) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  const tariffWire = tariff ? {
    provider: collector.provider,
    model,
    peak: isPeakAt(now, tariff.schedule),
    multiplier: tariff.peakMultiplier,
    window: tariff.schedule.label,
    holidayYear: tariff.schedule.holidayYear ?? null,
    holidayStale: tariff.schedule.holidayYear ? new Date(now).getUTCFullYear() > tariff.schedule.holidayYear : false,
    source: tiers.source,
    tiers: { offPeak: tiers.offPeak, peak: tiers.peak }
  } : null;
  const status = treeStatus(collector, members);
  const active = [];
  for (const member of members) {
    if (member === collector)
      continue;
    const rank = SUBAGENT_RANK[member.status];
    if (rank === undefined)
      continue;
    active.push({
      rank,
      item: {
        id: member.id,
        title: member.title ?? null,
        status: member.status,
        tps: Math.round(memberRate(member, now) * 10) / 10
      }
    });
  }
  active.sort((a, b) => a.rank - b.rank || b.item.tps - a.item.tps);
  const roster = [];
  for (const member of members) {
    if (member === collector)
      continue;
    let lastAt = null;
    for (const step of member.steps) {
      if (typeof step.at === "number" && (lastAt === null || step.at > lastAt))
        lastAt = step.at;
    }
    const touched = Math.max(lastAt ?? 0, member.recordUpdatedAt ?? 0);
    if (touched > 0 && now - touched > ROSTER_TTL_MS)
      continue;
    const memberRates = ratesOf(member.steps);
    roster.push({
      id: member.id,
      title: member.title ?? null,
      status: member.status,
      tps: Math.round(memberRate(member, now) * 10) / 10,
      cost: round6(member.totals.cost),
      consumed: member.totals.input + member.totals.output + member.totals.reasoning + member.totals.cacheRead + member.totals.cacheWrite,
      avgTps: Math.round(memberRates.avg * 10) / 10,
      peakTps: Math.round(memberRates.peak * 10) / 10,
      lastAt,
      steps: Math.max(member.totals.steps, member.steps.length, member.knownSteps ?? 0)
    });
  }
  roster.sort((a, b) => {
    if (a.lastAt !== b.lastAt) {
      if (a.lastAt === null)
        return 1;
      if (b.lastAt === null)
        return -1;
      return b.lastAt - a.lastAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const subagents = {
    count: members.length - 1,
    running: active.length,
    loading: members.filter((member) => member !== collector && member.historyAt === 0).length,
    partial: members.filter((member) => member !== collector && member.historyPartial).length,
    streaming: members.filter((member) => member !== collector && member.status === "streaming").length,
    tool: members.filter((member) => member !== collector && member.status === "tool").length,
    active: active.slice(0, 8).map((entry) => entry.item),
    members: roster.slice(0, ROSTER_CAP)
  };
  const series = collector.series.slice(-SERIES_POINTS);
  const seriesT0 = series.length ? series[0].t : now;
  const longSeries = collector.seriesLong.length >= LONG_MIN_POINTS ? collector.seriesLong : null;
  const wideSeries = collector.seriesWide.length >= LONG_MIN_POINTS ? collector.seriesWide : null;
  return {
    ok: true,
    session: collector.id,
    status: status.status,
    error: collector.error,
    historyPartial: Boolean(collector.historyPartial),
    totals: {
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      cost: totalCost,
      steps: totals.steps,
      prompt,
      generated,
      consumed,
      cacheHitRate: prompt > 0 ? totals.cacheRead / prompt : 0,
      source: collector.totalsFrom
    },
    cost: priceBook ? {
      mode: "api",
      total: round6(api.total),
      lastTurn: api.total === null ? null : round6(collector.turnStartedAt ? apiTurn : 0),
      perMillion: round6(api.perMillion),
      billed: {
        lastTurn: round6(collector.turnStartedAt ? billedTurn : 0),
        perMillion: round6(api.billed.perMillion),
        total: round6(api.billed.total)
      },
      rates: ratesCard ? {
        provider: ratesCard.provider,
        model: ratesCard.model,
        name: ratesCard.name,
        input: ratesCard.rates.input,
        output: ratesCard.rates.output,
        cacheRead: ratesCard.rates.cacheRead,
        cacheWrite: ratesCard.rates.cacheWrite,
        source: ratesCard.source,
        match: ratesCard.match,
        checkedAt: ratesCard.checkedAt,
        tier: ratesCard.tier,
        timeTier: ratesCard.timeTier
      } : null,
      ratesNote,
      priceNote: api.priceNote,
      drift: api.drift,
      coverage: Math.round(api.coverage * 1e6) / 1e6,
      lowerBound: api.lowerBound,
      ...api.unpriced.length ? {
        unpriced: api.unpriced.map((entry) => ({
          consumed: entry.consumed,
          model: entry.model ?? null,
          provider: entry.provider ?? null
        }))
      } : {},
      ...api.models.length > 1 ? {
        models: api.models.map((entry) => ({
          apiValue: round6(entry.apiValue),
          billed: round6(entry.billed),
          consumed: entry.consumed,
          coverage: Math.round(entry.coverage * 1e6) / 1e6,
          drift: entry.drift,
          match: entry.match,
          model: entry.model,
          name: entry.name,
          provider: entry.provider,
          rates: entry.rates,
          source: entry.source,
          steps: entry.steps,
          tier: entry.tier,
          timeTier: entry.timeTier,
          tokens: entry.tokens
        }))
      } : {},
      tariff: tariffWire
    } : {
      mode: "billed",
      total: totalCost,
      lastTurn: lastTurnCost,
      perMillion: consumed > 0 ? Math.round(totalCost / consumed * 1e6 * 1e4) / 1e4 : null,
      billed: {
        lastTurn: lastTurnCost,
        perMillion: consumed > 0 ? Math.round(totalCost / consumed * 1e6 * 1e4) / 1e4 : null,
        total: totalCost
      },
      rates: modelCostRates,
      ratesNote,
      priceNote: null,
      drift: null,
      coverage: 1,
      lowerBound: false,
      tariff: tariffWire
    },
    turn: {
      active: Boolean(collector.turnActive),
      startedAt: collector.turnStartedAt || null,
      tokens: turnTokens,
      consumed: turnConsumed,
      steps: turnSteps
    },
    live: {
      tps: live,
      charsPerSecond: Math.round(members.reduce((sum, member) => sum + (member.status === "streaming" ? charsInWindow(member, now) : 0), 0) / (LIVE_WINDOW_MS / 1000)),
      charsPerToken: Math.round(collector.charsPerToken * 1000) / 1000,
      ttftMs: streamer?.ttftMs ?? collector.ttftMs ?? collector.lastTtftMs ?? lastStepRaw?.ttftMs ?? null,
      lastStep: lastStepRaw ? { ...lastStepRaw, sub: subOwner.get(lastStepRaw) || undefined } : null,
      subagent: status.subagent,
      estimated: true
    },
    subagents,
    series: {
      t0: seriesT0,
      step: SERIES_INTERVAL_MS,
      d: series.map((point) => point.t - seriesT0),
      v: series.map((point) => point.v)
    },
    ...longSeries ? {
      seriesLong: {
        t0: longSeries[0].t,
        step: LONG_BUCKET_MS,
        d: longSeries.map((bucket) => bucket.t - longSeries[0].t),
        v: longSeries.map((bucket) => Math.round(bucket.sum / bucket.n * 10) / 10)
      }
    } : {},
    ...wideSeries ? {
      seriesWide: {
        t0: wideSeries[0].t,
        step: WIDE_BUCKET_MS,
        d: wideSeries.map((bucket) => bucket.t - wideSeries[0].t),
        v: wideSeries.map((bucket) => Math.round(bucket.sum / bucket.n * 10) / 10)
      }
    } : {},
    stepsSeq: members.reduce((sum, member) => sum + member.stepsSeq, 0),
    steps: wire,
    stepsFrom: shownSteps[0]?.at ?? null,
    stepsKnown,
    rates: {
      avg: Math.round(rates.avg * 10) / 10,
      peak: Math.round(rates.peak * 10) / 10,
      ...rates.peakAt ? { peakAt: rates.peakAt } : {}
    },
    generatedAt: now
  };
}

// shared/price-book.js
var PRICE_BOOK = {
  aliases: {
    providers: {
      "claude-agent": "anthropic",
      "command-code": "commandcode",
      commandcode: "commandcode",
      deepseek: "deepseek",
      openai: "openai",
      opencode: "opencode",
      "opencode-go": "opencode-go"
    },
    models: {
      "claude-agent": {
        fable: "claude-fable-5-2",
        haiku: "claude-haiku-5-5",
        opus: "claude-opus-5-5",
        sonnet: "claude-sonnet-5-5"
      }
    },
    labs: {
      commandcode: {
        "claude-": "anthropic",
        "gpt-": "openai"
      }
    }
  },
  checkedAt: "2026-11-14",
  currency: "USD",
  providers: {
    anthropic: {
      name: "Anthropic",
      source: "Anthropic list",
      models: {
        "claude-fable-5": {
          cost: {
            cacheRead: 1,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "Claude Fable 5",
          tiers: [],
          release: "2026-06-07"
        },
        "claude-fable-5-1": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "Claude Fable 5.1",
          tiers: [],
          release: "2026-09-01"
        },
        "claude-fable-5-2": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 10,
            input: 8,
            output: 40
          },
          name: "Claude Fable 5.2",
          tiers: [],
          release: "2026-11-09"
        },
        "claude-haiku-4-5": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 1.25,
            input: 1,
            output: 5
          },
          name: "Claude Haiku 4.5 (latest)",
          tiers: [],
          release: "2025-10-15"
        },
        "claude-haiku-4-5-20251001": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 1.25,
            input: 1,
            output: 5
          },
          name: "Claude Haiku 4.5",
          tiers: [],
          release: "2025-10-15"
        },
        "claude-haiku-5-5": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "Claude Haiku 5.5",
          tiers: [
            {
              cost: {
                cacheRead: 0.05,
                cacheWrite: 0.625,
                input: 0.5,
                output: 2.5
              },
              minContext: 1e5
            }
          ],
          release: "2026-10-07"
        },
        "claude-opus-4-5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.5 (latest)",
          tiers: [],
          release: "2025-11-24"
        },
        "claude-opus-4-5-20251101": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.5",
          tiers: [],
          release: "2025-11-24"
        },
        "claude-opus-4-6": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.6",
          tiers: [],
          release: "2026-02-04"
        },
        "claude-opus-4-7": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.7",
          tiers: [],
          release: "2026-04-14"
        },
        "claude-opus-4-8": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.8",
          tiers: [],
          release: "2026-05-28"
        },
        "claude-opus-5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 5",
          tiers: [],
          release: "2026-07-24"
        },
        "claude-opus-5-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "Claude Opus 5.5",
          tiers: [],
          release: "2026-09-22"
        },
        "claude-sonnet-4-5": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4.5 (latest)",
          tiers: [],
          release: "2025-09-29"
        },
        "claude-sonnet-4-5-20250929": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4.5",
          tiers: [],
          release: "2025-09-29"
        },
        "claude-sonnet-4-6": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4.6",
          tiers: [],
          release: "2026-02-17"
        },
        "claude-sonnet-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "Claude Sonnet 5",
          tiers: [],
          release: "2026-06-29"
        },
        "claude-sonnet-5-5": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "Claude Sonnet 5.5",
          tiers: [],
          release: "2026-09-28"
        }
      }
    },
    commandcode: {
      name: "Command Code",
      source: "Command Code list",
      models: {
        "MiniMaxAI/MiniMax-M2.5": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M2.5",
          tiers: [],
          release: "2026-02-12"
        },
        "MiniMaxAI/MiniMax-M2.7": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M2.7",
          tiers: [],
          release: "2026-03-18"
        },
        "MiniMaxAI/MiniMax-M3": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M3",
          tiers: [],
          release: "2026-06-01"
        },
        "Qwen/Qwen3.8-27B": {
          cost: {
            cacheRead: 0.04,
            cacheWrite: 0,
            input: 0.4,
            output: 3
          },
          name: "Qwen3.8 27B",
          tiers: [],
          release: "2026-08-14"
        },
        "Qwen/Qwen3.8-Flash": {
          cost: {
            cacheRead: 0.016,
            cacheWrite: 0,
            input: 0.16,
            output: 0.47
          },
          name: "Qwen3.8 Flash",
          tiers: [],
          release: "2026-08-26"
        },
        "Qwen/Qwen3.8-Max": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 2.5,
            input: 2,
            output: 6
          },
          name: "Qwen3.8 Max",
          tiers: [],
          release: "2026-08-03"
        },
        "Qwen/Qwen3.8-Max-0902": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Qwen3.8 Max 0902",
          tiers: [],
          release: "2026-09-02"
        },
        "Qwen/Qwen3.8-Omni-Flash": {
          cost: {
            cacheRead: 0.016,
            cacheWrite: 0,
            input: 0.15,
            output: 0.47
          },
          name: "Qwen3.8 Omni Flash",
          tiers: [],
          release: "2026-09-17"
        },
        "claude-fable-5": {
          cost: {
            cacheRead: 1,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "Claude Fable 5",
          tiers: [],
          release: "2026-06-09"
        },
        "claude-fable-5-1": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "Claude Fable 5.1",
          tiers: [],
          release: "2026-09-01"
        },
        "claude-haiku-4-5-20251001": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 1.25,
            input: 1,
            output: 5
          },
          name: "Claude Haiku 4.5",
          tiers: [],
          release: "2025-10-15"
        },
        "claude-haiku-5-5": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "Claude Haiku 5.5",
          tiers: [
            {
              cost: {
                cacheRead: 0.05,
                cacheWrite: 0.625,
                input: 0.5,
                output: 2.5
              },
              minContext: 1e5
            }
          ],
          release: "2026-10-07"
        },
        "claude-opus-4-7": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.7",
          tiers: [],
          release: "2026-04-16"
        },
        "claude-opus-4-8": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.8",
          tiers: [],
          release: "2026-05-28"
        },
        "claude-opus-5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 5",
          tiers: [],
          release: "2026-07-24"
        },
        "claude-opus-5-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "Claude Opus 5.5",
          tiers: [],
          release: "2026-09-22"
        },
        "claude-sonnet-4-6": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4.6",
          tiers: [],
          release: "2026-02-17"
        },
        "claude-sonnet-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "Claude Sonnet 5",
          tiers: [],
          release: "2026-06-30"
        },
        "claude-sonnet-5-5": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "Claude Sonnet 5.5",
          tiers: [],
          release: "2026-09-28"
        },
        "deepseek/deepseek-v4-flash": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4 Flash",
          tiers: [],
          release: "2026-04-24"
        },
        "deepseek/deepseek-v4-flash-fast": {
          cost: {
            cacheRead: 0.07,
            cacheWrite: 0,
            input: 0.28,
            output: 0.56
          },
          name: "DeepSeek V4 Flash Fast",
          tiers: [],
          release: "2026-04-24"
        },
        "deepseek/deepseek-v4-flash-vision-exp": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4 Flash Vision Exp",
          tiers: [],
          release: "2026-08-21"
        },
        "deepseek/deepseek-v4-pro": {
          cost: {
            cacheRead: 0.022,
            cacheWrite: 0,
            input: 0.66,
            output: 1.98
          },
          name: "DeepSeek V4 Pro",
          tiers: [],
          release: "2026-04-24"
        },
        "deepseek/deepseek-v4.1-flash": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4.1 Flash",
          tiers: [],
          release: "2026-09-10"
        },
        "deepseek/deepseek-v4.1-flash-fast": {
          cost: {
            cacheRead: 0.016,
            cacheWrite: 0,
            input: 0.16,
            output: 0.58
          },
          name: "DeepSeek V4.1 Flash Fast",
          tiers: [],
          release: "2026-09-10"
        },
        "google/gemini-3.1-flash-lite": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.25,
            output: 1.5
          },
          name: "Gemini 3.1 Flash Lite",
          tiers: [],
          release: "2026-05-07"
        },
        "google/gemini-3.5-flash": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.5,
            output: 9
          },
          name: "Gemini 3.5 Flash",
          tiers: [],
          release: "2026-05-19"
        },
        "google/gemini-3.5-flash-lite": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.3,
            output: 2.5
          },
          name: "Gemini 3.5 Flash Lite",
          tiers: [],
          release: "2026-07-21"
        },
        "google/gemini-3.6-flash": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.5,
            output: 7.5
          },
          name: "Gemini 3.6 Flash",
          tiers: [],
          release: "2026-07-21"
        },
        "google/gemini-3.7-flash": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0.08334,
            input: 1.5,
            output: 7.5
          },
          name: "Gemini 3.7 Flash",
          tiers: [],
          release: "2026-08-13"
        },
        "google/gemini-3.8-flash": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.5,
            output: 7.5
          },
          name: "Gemini 3.8 Flash",
          tiers: [],
          release: "2026-09-02"
        },
        "google/gemini-4-argon": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 2,
            output: 10
          },
          name: "Gemini 4 Argon",
          tiers: [],
          release: "2026-10-13"
        },
        "gpt-5.3-codex": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 8
          },
          name: "GPT-5.3 Codex",
          tiers: [],
          release: "2026-02-05"
        },
        "gpt-5.4": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 0,
            input: 2.5,
            output: 15
          },
          name: "GPT-5.4",
          tiers: [],
          release: "2026-03-05"
        },
        "gpt-5.4-mini": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.75,
            output: 4.5
          },
          name: "GPT-5.4 mini",
          tiers: [],
          release: "2026-03-17"
        },
        "gpt-5.5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 5,
            output: 30
          },
          name: "GPT-5.5",
          tiers: [],
          release: "2026-04-23"
        },
        "gpt-5.6-luna": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0.25,
            input: 0.2,
            output: 1.2
          },
          name: "GPT-5.6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.04,
                cacheWrite: 0.5,
                input: 0.4,
                output: 1.8
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-sol": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 30
          },
          name: "GPT-5.6 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 12.5,
                input: 10,
                output: 45
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-terra": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 12
          },
          name: "GPT-5.6 Terra",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 5,
                input: 4,
                output: 18
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-6-astra": {
          cost: {
            cacheRead: 1,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "GPT-6 Astra",
          tiers: [
            {
              cost: {
                cacheRead: 2,
                cacheWrite: 25,
                input: 20,
                output: 75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-04"
        },
        "gpt-6-luna": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "GPT-6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.02,
                cacheWrite: 0.25,
                input: 0.2,
                output: 0.75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "gpt-6-sol": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "GPT-6 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 5,
                input: 4,
                output: 15
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "gpt-6.1-sol": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "GPT-6.1 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.2,
                cacheWrite: 5,
                input: 4,
                output: 15
              },
              minContext: 272000
            }
          ],
          release: "2026-09-29"
        },
        "gpt-6.1-terra": {
          cost: {
            cacheRead: 0.05,
            cacheWrite: 1.25,
            input: 1,
            output: 5
          },
          name: "GPT-6.1 Terra",
          tiers: [
            {
              cost: {
                cacheRead: 0.1,
                cacheWrite: 2.5,
                input: 2,
                output: 7.5
              },
              minContext: 272000
            }
          ],
          release: "2026-10-26"
        },
        "inclusionai/ling-3.1-flash:free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ling 3.1 Flash",
          tiers: [],
          release: "2026-09-29"
        },
        "meta/muse-spark-1.1": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.25,
            output: 4.25
          },
          name: "Muse Spark 1.1",
          tiers: [],
          release: "2026-04-08"
        },
        "meta/muse-spark-1.2": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.25,
            output: 4.25
          },
          name: "Muse Spark 1.2",
          tiers: [],
          release: "2026-08-05"
        },
        "meta/muse-spark-1.2-contributor": {
          cost: {
            cacheRead: 0.002,
            cacheWrite: 0,
            input: 0.1,
            output: 0.2
          },
          name: "Muse Spark 1.2 (Contributor)",
          tiers: [],
          release: "2026-08-05"
        },
        "meta/muse-spark-1.3": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.25,
            output: 4.25
          },
          name: "Muse Spark 1.3",
          tiers: [],
          release: "2026-09-02"
        },
        "meta/muse-spark-1.3-contributor": {
          cost: {
            cacheRead: 0.002,
            cacheWrite: 0,
            input: 0.1,
            output: 0.2
          },
          name: "Muse Spark 1.3 (Contributor)",
          tiers: [],
          release: "2026-09-02"
        },
        "meta/muse-wonder-1.0": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 4,
            output: 20
          },
          name: "Muse Wonder",
          tiers: [],
          release: "2026-10-12"
        },
        "mistral/mistral-large-4": {
          cost: {
            cacheRead: 0.14,
            cacheWrite: 0,
            input: 1.36,
            output: 4.18
          },
          name: "Mistral Large 4",
          tiers: [],
          release: "2026-10-06"
        },
        "moonshotai/Kimi-K2.7-Code": {
          cost: {
            cacheRead: 0.19,
            cacheWrite: 0,
            input: 0.95,
            output: 4
          },
          name: "Kimi K2.7 Code",
          tiers: [],
          release: "2026-06-12"
        },
        "moonshotai/Kimi-K2.7-Code-Highspeed": {
          cost: {
            cacheRead: 0.38,
            cacheWrite: 0,
            input: 1.9,
            output: 8
          },
          name: "Kimi K2.7 Code Highspeed",
          tiers: [],
          release: "2026-06-12"
        },
        "moonshotai/Kimi-K3": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 0,
            input: 3,
            output: 15
          },
          name: "Kimi K3",
          tiers: [],
          release: "2026-07-16"
        },
        "nvidia/nemotron-3-ultra-550b-a55b": {
          cost: {
            cacheRead: 0.12,
            cacheWrite: 0,
            input: 0.6,
            output: 2.4
          },
          name: "Nemotron 3 Ultra 550B A55B",
          tiers: [],
          release: "2026-06-04"
        },
        "sakana/fugu-ultra": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 5,
            output: 30
          },
          name: "Fugu Ultra",
          tiers: [],
          release: "2026-06-15"
        },
        "stepfun/Step-3.5-Flash": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0,
            input: 0.09,
            output: 0.3
          },
          name: "Step 3.5 Flash",
          tiers: [],
          release: "2026-01-29"
        },
        "stepfun/Step-3.7-Flash": {
          cost: {
            cacheRead: 0.04,
            cacheWrite: 0,
            input: 0.2,
            output: 1.15
          },
          name: "Step 3.7 Flash",
          tiers: [],
          release: "2026-05-29"
        },
        "stepfun/Step-5-Preview": {
          cost: {
            cacheRead: 0.05,
            cacheWrite: 0,
            input: 1,
            output: 2.7
          },
          name: "Step 5 Preview",
          tiers: [],
          release: "2026-09-16"
        },
        "tencent/hy3-paid": {
          cost: {
            cacheRead: 0.035,
            cacheWrite: 0,
            input: 0.14,
            output: 0.58
          },
          name: "Hy3",
          tiers: [],
          release: "2026-07-06"
        },
        "tencent/hy4-preview": {
          cost: {
            cacheRead: 0.042,
            cacheWrite: 0,
            input: 0.834,
            output: 2.501
          },
          name: "Hy4 preview",
          tiers: [],
          release: "2026-08-28"
        },
        "thinkingmachines/inkling": {
          cost: {
            cacheRead: 0.17,
            cacheWrite: 0,
            input: 1,
            output: 4.05
          },
          name: "Inkling",
          tiers: [],
          release: "2026-07-15"
        },
        "thinkingmachines/inkling-small": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 0.5,
            output: 1.2
          },
          name: "Inkling Small",
          tiers: [],
          release: "2026-07-30"
        },
        "xai/grok-4.5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.5",
          tiers: [],
          release: "2026-07-08"
        },
        "xai/grok-4.6": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.6",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 4,
                output: 12
              },
              minContext: 200000
            }
          ],
          release: "2026-08-12"
        },
        "xai/grok-4.7": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.7",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 4,
                output: 12
              },
              minContext: 200000
            }
          ],
          release: "2026-09-21"
        },
        "z-ai/glm-5.3-flash": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.15,
            output: 0.5
          },
          name: "GLM-5.3-Flash",
          tiers: [],
          release: "2026-08-26"
        },
        "z-ai/glm-5.3-flashx": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.37,
            output: 1.25
          },
          name: "GLM-5.3-FlashX",
          tiers: [],
          release: "2026-08-26"
        },
        "zai-org/GLM-5.2": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.2",
          tiers: [],
          release: "2026-06-13"
        },
        "zai-org/GLM-5.2-Fast": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 3,
            output: 10.25
          },
          name: "GLM-5.2-Fast",
          tiers: [],
          release: "2026-06-13"
        },
        "zai-org/GLM-5.3": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.3",
          tiers: [],
          release: "2026-08-14"
        }
      }
    },
    deepseek: {
      name: "DeepSeek",
      source: "DeepSeek list",
      models: {
        "deepseek-flash": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4.1 Flash 1017",
          tiers: [],
          release: "2026-10-17"
        },
        "deepseek-v4-flash": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4 Flash",
          tiers: [],
          release: "2026-10-17"
        },
        "deepseek-v4-flash-vision-exp": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4 Flash Vision Exp",
          tiers: [],
          release: "2026-10-17"
        },
        "deepseek-v4-pro": {
          cost: {
            cacheRead: 0.022,
            cacheWrite: 0,
            input: 0.66,
            output: 1.98
          },
          name: "DeepSeek V4 Pro",
          tiers: [],
          release: "2026-08-13"
        }
      }
    },
    openai: {
      name: "OpenAI",
      source: "OpenAI list",
      models: {
        "chatgpt-image-latest": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 0,
            input: 5,
            output: 10
          },
          name: "chatgpt-image-latest",
          tiers: [],
          release: "2025-12-16"
        },
        "gpt-3.5-turbo": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0.5,
            output: 1.5
          },
          name: "GPT-3.5-turbo",
          tiers: [],
          release: "2023-03-01"
        },
        "gpt-4": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 30,
            output: 60
          },
          name: "GPT-4",
          tiers: [],
          release: "2023-11-06"
        },
        "gpt-4-turbo": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 10,
            output: 30
          },
          name: "GPT-4 Turbo",
          tiers: [],
          release: "2023-11-06"
        },
        "gpt-4.1": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 8
          },
          name: "GPT-4.1",
          tiers: [],
          release: "2025-04-14"
        },
        "gpt-4.1-mini": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 0.4,
            output: 1.6
          },
          name: "GPT-4.1 mini",
          tiers: [],
          release: "2025-04-14"
        },
        "gpt-4.1-nano": {
          cost: {
            cacheRead: 0.025,
            cacheWrite: 0,
            input: 0.1,
            output: 0.4
          },
          name: "GPT-4.1 nano",
          tiers: [],
          release: "2025-04-14"
        },
        "gpt-4o": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 0,
            input: 2.5,
            output: 10
          },
          name: "GPT-4o",
          tiers: [],
          release: "2024-05-13"
        },
        "gpt-4o-2024-05-13": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 5,
            output: 15
          },
          name: "GPT-4o (2024-05-13)",
          tiers: [],
          release: "2024-05-13"
        },
        "gpt-4o-2024-08-06": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 0,
            input: 2.5,
            output: 10
          },
          name: "GPT-4o (2024-08-06)",
          tiers: [],
          release: "2024-08-06"
        },
        "gpt-4o-2024-11-20": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 0,
            input: 2.5,
            output: 10
          },
          name: "GPT-4o (2024-11-20)",
          tiers: [],
          release: "2024-11-20"
        },
        "gpt-4o-mini": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "GPT-4o mini",
          tiers: [],
          release: "2024-07-18"
        },
        "gpt-5": {
          cost: {
            cacheRead: 0.125,
            cacheWrite: 0,
            input: 1.25,
            output: 10
          },
          name: "GPT-5",
          tiers: [],
          release: "2025-08-07"
        },
        "gpt-5-mini": {
          cost: {
            cacheRead: 0.025,
            cacheWrite: 0,
            input: 0.25,
            output: 2
          },
          name: "GPT-5 Mini",
          tiers: [],
          release: "2025-08-07"
        },
        "gpt-5-nano": {
          cost: {
            cacheRead: 0.005,
            cacheWrite: 0,
            input: 0.05,
            output: 0.4
          },
          name: "GPT-5 Nano",
          tiers: [],
          release: "2025-08-07"
        },
        "gpt-5-pro": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 15,
            output: 120
          },
          name: "GPT-5 Pro",
          tiers: [],
          release: "2025-10-06"
        },
        "gpt-5.1": {
          cost: {
            cacheRead: 0.125,
            cacheWrite: 0,
            input: 1.25,
            output: 10
          },
          name: "GPT-5.1",
          tiers: [],
          release: "2025-11-13"
        },
        "gpt-5.2": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.2",
          tiers: [],
          release: "2025-12-11"
        },
        "gpt-5.2-pro": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 21,
            output: 168
          },
          name: "GPT-5.2 Pro",
          tiers: [],
          release: "2025-12-11"
        },
        "gpt-5.3-codex": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.3 Codex",
          tiers: [],
          release: "2026-02-05"
        },
        "gpt-5.3-codex-spark": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.3 Codex Spark",
          tiers: [],
          release: "2026-02-05"
        },
        "gpt-5.4": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 0,
            input: 2.5,
            output: 15
          },
          name: "GPT-5.4",
          tiers: [
            {
              cost: {
                cacheRead: 0.5,
                cacheWrite: 0,
                input: 5,
                output: 22.5
              },
              minContext: 272000
            }
          ],
          release: "2026-03-05"
        },
        "gpt-5.4-mini": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.75,
            output: 4.5
          },
          name: "GPT-5.4 mini",
          tiers: [],
          release: "2026-03-17"
        },
        "gpt-5.4-nano": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0,
            input: 0.2,
            output: 1.25
          },
          name: "GPT-5.4 nano",
          tiers: [],
          release: "2026-03-17"
        },
        "gpt-5.4-pro": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 30,
            output: 180
          },
          name: "GPT-5.4 Pro",
          tiers: [
            {
              cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 60,
                output: 270
              },
              minContext: 272000
            }
          ],
          release: "2026-03-05"
        },
        "gpt-5.5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 5,
            output: 30
          },
          name: "GPT-5.5",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 10,
                output: 45
              },
              minContext: 272000
            }
          ],
          release: "2026-04-23"
        },
        "gpt-5.5-pro": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 30,
            output: 180
          },
          name: "GPT-5.5 Pro",
          tiers: [
            {
              cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 60,
                output: 270
              },
              minContext: 272000
            }
          ],
          release: "2026-04-23"
        },
        "gpt-5.6": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "GPT-5.6",
          tiers: [
            {
              cost: {
                cacheRead: 0.8,
                cacheWrite: 10,
                input: 8,
                output: 30
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-luna": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0.25,
            input: 0.2,
            output: 1.2
          },
          name: "GPT-5.6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.04,
                cacheWrite: 0.5,
                input: 0.4,
                output: 1.8
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-sol": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "GPT-5.6 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.8,
                cacheWrite: 10,
                input: 8,
                output: 30
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-terra": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 12
          },
          name: "GPT-5.6 Terra",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 5,
                input: 4,
                output: 18
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-6-astra": {
          cost: {
            cacheRead: 1,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "GPT-6 Astra",
          tiers: [
            {
              cost: {
                cacheRead: 2,
                cacheWrite: 25,
                input: 20,
                output: 75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-04"
        },
        "gpt-6-luna": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "GPT-6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.02,
                cacheWrite: 0.25,
                input: 0.2,
                output: 0.75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "gpt-6-sol": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "GPT-6 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 5,
                input: 4,
                output: 15
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "gpt-6.1-sol": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "GPT-6.1 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.2,
                cacheWrite: 5,
                input: 4,
                output: 15
              },
              minContext: 272000
            }
          ],
          release: "2026-09-29"
        },
        "gpt-6.1-terra": {
          cost: {
            cacheRead: 0.05,
            cacheWrite: 1.25,
            input: 1,
            output: 5
          },
          name: "GPT-6.1 Terra",
          tiers: [
            {
              cost: {
                cacheRead: 0.1,
                cacheWrite: 2.5,
                input: 2,
                output: 7.5
              },
              minContext: 272000
            }
          ],
          release: "2026-10-26"
        },
        "gpt-daybreak-blue-latest": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "Daybreak Blue",
          tiers: [
            {
              cost: {
                cacheRead: 0.8,
                cacheWrite: 10,
                input: 8,
                output: 30
              },
              minContext: 272000
            }
          ],
          release: "2026-08-07"
        },
        "gpt-daybreak-red-latest": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 15.625,
            input: 12.5,
            output: 75
          },
          name: "Daybreak Red",
          tiers: [],
          release: "2026-08-07"
        },
        "gpt-image-1.5": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 0,
            input: 5,
            output: 10
          },
          name: "gpt-image-1.5",
          tiers: [],
          release: "2025-11-25"
        },
        "gpt-image-2": {
          cost: {
            cacheRead: 1.25,
            cacheWrite: 0,
            input: 5,
            output: 30
          },
          name: "gpt-image-2",
          tiers: [],
          release: "2026-04-21"
        },
        "gpt-realtime-2.1": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 0,
            input: 4,
            output: 24
          },
          name: "GPT-Realtime-2.1",
          tiers: [],
          release: "2026-07-06"
        },
        o1: {
          cost: {
            cacheRead: 7.5,
            cacheWrite: 0,
            input: 15,
            output: 60
          },
          name: "o1",
          tiers: [],
          release: "2024-12-05"
        },
        "o1-pro": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 150,
            output: 600
          },
          name: "o1-pro",
          tiers: [],
          release: "2025-03-19"
        },
        o3: {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 8
          },
          name: "o3",
          tiers: [],
          release: "2025-04-16"
        },
        "o3-mini": {
          cost: {
            cacheRead: 0.55,
            cacheWrite: 0,
            input: 1.1,
            output: 4.4
          },
          name: "o3-mini",
          tiers: [],
          release: "2024-12-20"
        },
        "o3-pro": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 20,
            output: 80
          },
          name: "o3-pro",
          tiers: [],
          release: "2025-06-10"
        },
        "o4-mini": {
          cost: {
            cacheRead: 0.275,
            cacheWrite: 0,
            input: 1.1,
            output: 4.4
          },
          name: "o4-mini",
          tiers: [],
          release: "2025-04-16"
        },
        "text-embedding-3-large": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0.13,
            output: 0
          },
          name: "text-embedding-3-large",
          tiers: [],
          release: "2024-01-25"
        },
        "text-embedding-3-small": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0.02,
            output: 0
          },
          name: "text-embedding-3-small",
          tiers: [],
          release: "2024-01-25"
        },
        "text-embedding-ada-002": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0.1,
            output: 0
          },
          name: "text-embedding-ada-002",
          tiers: [],
          release: "2022-12-15"
        }
      }
    },
    opencode: {
      name: "OpenCode Zen",
      source: "OpenCode Zen list",
      models: {
        "beam-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Beam Free",
          tiers: [],
          release: "2026-10-05"
        },
        "big-pickle": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Big Pickle",
          tiers: [],
          release: "2025-10-17"
        },
        "cat-jam-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Cat Jam Free",
          tiers: [],
          release: "2026-10-12"
        },
        "claude-3-5-haiku": {
          cost: {
            cacheRead: 0.08,
            cacheWrite: 1,
            input: 0.8,
            output: 4
          },
          name: "Claude Haiku 3.5",
          tiers: [],
          release: "2024-10-22"
        },
        "claude-fable-5": {
          cost: {
            cacheRead: 1,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "Claude Fable 5",
          tiers: [],
          release: "2026-06-09"
        },
        "claude-fable-5-1": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "Claude Fable 5.1",
          tiers: [],
          release: "2026-09-01"
        },
        "claude-fable-5-2": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 10,
            input: 8,
            output: 40
          },
          name: "Claude Fable 5.2",
          tiers: [],
          release: "2026-11-09"
        },
        "claude-haiku-4-5": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 1.25,
            input: 1,
            output: 5
          },
          name: "Claude Haiku 4.5",
          tiers: [],
          release: "2025-10-15"
        },
        "claude-haiku-5-5": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "Claude Haiku 5.5",
          tiers: [
            {
              cost: {
                cacheRead: 0.05,
                cacheWrite: 0.625,
                input: 0.5,
                output: 2.5
              },
              minContext: 1e5
            }
          ],
          release: "2026-10-07"
        },
        "claude-opus-4-1": {
          cost: {
            cacheRead: 1.5,
            cacheWrite: 18.75,
            input: 15,
            output: 75
          },
          name: "Claude Opus 4.1",
          tiers: [],
          release: "2025-08-05"
        },
        "claude-opus-4-5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.5",
          tiers: [],
          release: "2025-11-24"
        },
        "claude-opus-4-6": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.6",
          tiers: [],
          release: "2026-02-05"
        },
        "claude-opus-4-7": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.7",
          tiers: [],
          release: "2026-04-16"
        },
        "claude-opus-4-8": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 4.8",
          tiers: [],
          release: "2026-05-28"
        },
        "claude-opus-5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 6.25,
            input: 5,
            output: 25
          },
          name: "Claude Opus 5",
          tiers: [],
          release: "2026-07-24"
        },
        "claude-opus-5-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "Claude Opus 5.5",
          tiers: [],
          release: "2026-09-22"
        },
        "claude-sonnet-4": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4",
          tiers: [
            {
              cost: {
                cacheRead: 0.6,
                cacheWrite: 7.5,
                input: 6,
                output: 22.5
              },
              minContext: 200000
            }
          ],
          release: "2025-05-22"
        },
        "claude-sonnet-4-5": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4.5",
          tiers: [
            {
              cost: {
                cacheRead: 0.6,
                cacheWrite: 7.5,
                input: 6,
                output: 22.5
              },
              minContext: 200000
            }
          ],
          release: "2025-09-29"
        },
        "claude-sonnet-4-6": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3.75,
            input: 3,
            output: 15
          },
          name: "Claude Sonnet 4.6",
          tiers: [],
          release: "2026-02-17"
        },
        "claude-sonnet-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "Claude Sonnet 5",
          tiers: [],
          release: "2026-06-30"
        },
        "claude-sonnet-5-5": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "Claude Sonnet 5.5",
          tiers: [],
          release: "2026-09-28"
        },
        "crouton-alpha-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Crouton Alpha Free",
          tiers: [],
          release: "2026-11-03"
        },
        "deepseek-v4-flash": {
          cost: {
            cacheRead: 0.028,
            cacheWrite: 0,
            input: 0.14,
            output: 0.28
          },
          name: "DeepSeek V4 Flash",
          tiers: [],
          release: "2026-07-31"
        },
        "deepseek-v4-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "DeepSeek V4 Flash Free",
          tiers: [],
          release: "2026-07-31"
        },
        "deepseek-v4-flash-vision-exp": {
          cost: {
            cacheRead: 0.028,
            cacheWrite: 0,
            input: 0.14,
            output: 0.28
          },
          name: "DeepSeek V4 Flash Vision Exp",
          tiers: [],
          release: "2026-08-21"
        },
        "deepseek-v4-pro": {
          cost: {
            cacheRead: 0.145,
            cacheWrite: 0,
            input: 1.74,
            output: 3.48
          },
          name: "DeepSeek V4 Pro",
          tiers: [],
          release: "2026-04-24"
        },
        "deepseek-v4.1-flash": {
          cost: {
            cacheRead: 0.006,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "DeepSeek V4.1 Flash 1017",
          tiers: [],
          release: "2026-10-17"
        },
        "deepseek-v4.1-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "DeepSeek V4.1 Flash Free",
          tiers: [],
          release: "2026-10-17"
        },
        "exo-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Exo Free",
          tiers: [],
          release: "2026-10-06"
        },
        "fledge-alpha-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Fledge Alpha Free",
          tiers: [],
          release: "2026-10-01"
        },
        "flint-40b-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Flint 40B Free",
          tiers: [],
          release: "2026-10-21"
        },
        "gemini-3-flash": {
          cost: {
            cacheRead: 0.05,
            cacheWrite: 0,
            input: 0.5,
            output: 3
          },
          name: "Gemini 3 Flash",
          tiers: [],
          release: "2025-12-17"
        },
        "gemini-3-pro": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 2,
            output: 12
          },
          name: "Gemini 3 Pro",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 0,
                input: 4,
                output: 18
              },
              minContext: 200000
            }
          ],
          release: "2025-11-18"
        },
        "gemini-3.1-pro": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 2,
            output: 12
          },
          name: "Gemini 3.1 Pro Preview",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 0,
                input: 4,
                output: 18
              },
              minContext: 200000
            }
          ],
          release: "2026-02-19"
        },
        "gemini-3.5-flash": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.5,
            output: 9
          },
          name: "Gemini 3.5 Flash",
          tiers: [],
          release: "2026-05-19"
        },
        "gemini-3.5-flash-lite": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.3,
            output: 2.5
          },
          name: "Gemini 3.5 Flash Lite",
          tiers: [],
          release: "2026-07-21"
        },
        "gemini-3.6-flash": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.75,
            output: 3.75
          },
          name: "Gemini 3.6 Flash",
          tiers: [],
          release: "2026-07-21"
        },
        "gemini-3.7-flash": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.75,
            output: 3.75
          },
          name: "Gemini 3.7 Flash",
          tiers: [],
          release: "2026-08-13"
        },
        "gemini-3.8-flash": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.75,
            output: 3.75
          },
          name: "Gemini 3.8 Flash",
          tiers: [],
          release: "2026-09-02"
        },
        "gemini-4-argon": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 2,
            output: 10
          },
          name: "Gemini 4 Argon",
          tiers: [],
          release: "2026-10-13"
        },
        "gemini-4-carbon": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 2,
            output: 10
          },
          name: "Gemini 4 Carbon",
          tiers: [],
          release: "2026-11-10"
        },
        "gemini-4-hydrogen": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 1.5,
            output: 7.5
          },
          name: "Gemini 4 Hydrogen",
          tiers: [],
          release: "2026-11-12"
        },
        "glm-4.6": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 0.6,
            output: 2.2
          },
          name: "GLM-4.6",
          tiers: [],
          release: "2025-09-30"
        },
        "glm-4.7": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 0.6,
            output: 2.2
          },
          name: "GLM-4.7",
          tiers: [],
          release: "2025-12-22"
        },
        "glm-4.7-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "GLM-4.7 Free",
          tiers: [],
          release: "2025-12-22"
        },
        "glm-5": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 1,
            output: 3.2
          },
          name: "GLM-5",
          tiers: [],
          release: "2026-02-12"
        },
        "glm-5-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "GLM-5 Free",
          tiers: [],
          release: "2026-02-12"
        },
        "glm-5.1": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.1",
          tiers: [],
          release: "2026-04-07"
        },
        "glm-5.2": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.2",
          tiers: [],
          release: "2026-06-13"
        },
        "glm-5.3": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.3",
          tiers: [],
          release: "2026-08-14"
        },
        "glm-5.3-flash": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.15,
            output: 0.5
          },
          name: "GLM-5.3-Flash",
          tiers: [],
          release: "2026-08-26"
        },
        "glm-5.3-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "GLM-5.3-Flash Free",
          tiers: [],
          release: "2026-08-26"
        },
        "gpt-5": {
          cost: {
            cacheRead: 0.107,
            cacheWrite: 0,
            input: 1.07,
            output: 8.5
          },
          name: "GPT-5",
          tiers: [],
          release: "2025-08-07"
        },
        "gpt-5-codex": {
          cost: {
            cacheRead: 0.107,
            cacheWrite: 0,
            input: 1.07,
            output: 8.5
          },
          name: "GPT-5 Codex",
          tiers: [],
          release: "2025-09-15"
        },
        "gpt-5-nano": {
          cost: {
            cacheRead: 0.005,
            cacheWrite: 0,
            input: 0.05,
            output: 0.4
          },
          name: "GPT-5 Nano",
          tiers: [],
          release: "2025-08-07"
        },
        "gpt-5.1": {
          cost: {
            cacheRead: 0.107,
            cacheWrite: 0,
            input: 1.07,
            output: 8.5
          },
          name: "GPT-5.1",
          tiers: [],
          release: "2025-11-13"
        },
        "gpt-5.1-codex": {
          cost: {
            cacheRead: 0.107,
            cacheWrite: 0,
            input: 1.07,
            output: 8.5
          },
          name: "GPT-5.1 Codex",
          tiers: [],
          release: "2025-11-13"
        },
        "gpt-5.1-codex-max": {
          cost: {
            cacheRead: 0.125,
            cacheWrite: 0,
            input: 1.25,
            output: 10
          },
          name: "GPT-5.1 Codex Max",
          tiers: [],
          release: "2025-11-13"
        },
        "gpt-5.1-codex-mini": {
          cost: {
            cacheRead: 0.025,
            cacheWrite: 0,
            input: 0.25,
            output: 2
          },
          name: "GPT-5.1 Codex Mini",
          tiers: [],
          release: "2025-11-13"
        },
        "gpt-5.2": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.2",
          tiers: [],
          release: "2025-12-11"
        },
        "gpt-5.2-codex": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.2 Codex",
          tiers: [],
          release: "2025-12-11"
        },
        "gpt-5.3-codex": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.3 Codex",
          tiers: [],
          release: "2026-02-05"
        },
        "gpt-5.3-codex-spark": {
          cost: {
            cacheRead: 0.175,
            cacheWrite: 0,
            input: 1.75,
            output: 14
          },
          name: "GPT-5.3 Codex Spark",
          tiers: [],
          release: "2026-02-05"
        },
        "gpt-5.4": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 0,
            input: 2.5,
            output: 15
          },
          name: "GPT-5.4",
          tiers: [
            {
              cost: {
                cacheRead: 0.5,
                cacheWrite: 0,
                input: 5,
                output: 22.5
              },
              minContext: 272000
            }
          ],
          release: "2026-03-05"
        },
        "gpt-5.4-mini": {
          cost: {
            cacheRead: 0.075,
            cacheWrite: 0,
            input: 0.75,
            output: 4.5
          },
          name: "GPT-5.4 Mini",
          tiers: [],
          release: "2026-03-17"
        },
        "gpt-5.4-nano": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0,
            input: 0.2,
            output: 1.25
          },
          name: "GPT-5.4 Nano",
          tiers: [],
          release: "2026-03-17"
        },
        "gpt-5.4-pro": {
          cost: {
            cacheRead: 30,
            cacheWrite: 0,
            input: 30,
            output: 180
          },
          name: "GPT-5.4 Pro",
          tiers: [],
          release: "2026-03-05"
        },
        "gpt-5.5": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 5,
            output: 30
          },
          name: "GPT-5.5",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 10,
                output: 45
              },
              minContext: 272000
            }
          ],
          release: "2026-04-23"
        },
        "gpt-5.5-pro": {
          cost: {
            cacheRead: 30,
            cacheWrite: 0,
            input: 30,
            output: 180
          },
          name: "GPT-5.5 Pro",
          tiers: [],
          release: "2026-04-23"
        },
        "gpt-5.6-luna": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0.25,
            input: 0.2,
            output: 1.2
          },
          name: "GPT-5.6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.04,
                cacheWrite: 0.5,
                input: 0.4,
                output: 1.8
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-sol": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 5,
            input: 4,
            output: 20
          },
          name: "GPT-5.6 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.8,
                cacheWrite: 10,
                input: 8,
                output: 30
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-5.6-terra": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 12
          },
          name: "GPT-5.6 Terra",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 5,
                input: 4,
                output: 18
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-6-astra": {
          cost: {
            cacheRead: 1,
            cacheWrite: 12.5,
            input: 10,
            output: 50
          },
          name: "GPT-6 Astra",
          tiers: [
            {
              cost: {
                cacheRead: 2,
                cacheWrite: 25,
                input: 20,
                output: 75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-04"
        },
        "gpt-6-luna": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "GPT-6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.02,
                cacheWrite: 0.25,
                input: 0.2,
                output: 0.75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "gpt-6-sol": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "GPT-6 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.4,
                cacheWrite: 5,
                input: 4,
                output: 15
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "gpt-6.1-sol": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 2.5,
            input: 2,
            output: 10
          },
          name: "GPT-6.1 Sol",
          tiers: [
            {
              cost: {
                cacheRead: 0.2,
                cacheWrite: 5,
                input: 4,
                output: 15
              },
              minContext: 272000
            }
          ],
          release: "2026-09-29"
        },
        "grok-4.5": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.5",
          tiers: [
            {
              cost: {
                cacheRead: 0.6,
                cacheWrite: 0,
                input: 4,
                output: 12
              },
              minContext: 200000
            }
          ],
          release: "2026-07-08"
        },
        "grok-4.6": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.6",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 4,
                output: 12
              },
              minContext: 200000
            }
          ],
          release: "2026-08-12"
        },
        "grok-4.7": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.7",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 4,
                output: 12
              },
              minContext: 200000
            }
          ],
          release: "2026-09-21"
        },
        "grok-build-0.1": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 1,
            output: 2
          },
          name: "Grok Build 0.1",
          tiers: [],
          release: "2026-04-16"
        },
        "grok-code": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Grok Code Fast 1",
          tiers: [],
          release: "2025-09-02"
        },
        "hy3-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Hy3 Free",
          tiers: [],
          release: "2026-07-06"
        },
        "hy3-preview-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Hy3 preview Free",
          tiers: [],
          release: "2026-04-20"
        },
        "iceman-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Iceman Free",
          tiers: [],
          release: "2026-11-06"
        },
        "inkling-2-small-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Inkling 2 Small Free",
          tiers: [],
          release: "2026-11-05"
        },
        "kimi-k2": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 0,
            input: 0.4,
            output: 2.5
          },
          name: "Kimi K2",
          tiers: [],
          release: "2025-09-05"
        },
        "kimi-k2-thinking": {
          cost: {
            cacheRead: 0.4,
            cacheWrite: 0,
            input: 0.4,
            output: 2.5
          },
          name: "Kimi K2 Thinking",
          tiers: [],
          release: "2025-11-06"
        },
        "kimi-k2.5": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 0.6,
            output: 3
          },
          name: "Kimi K2.5",
          tiers: [],
          release: "2026-01-27"
        },
        "kimi-k2.5-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Kimi K2.5 Free",
          tiers: [],
          release: "2026-01-27"
        },
        "kimi-k2.6": {
          cost: {
            cacheRead: 0.16,
            cacheWrite: 0,
            input: 0.95,
            output: 4
          },
          name: "Kimi K2.6",
          tiers: [],
          release: "2026-04-20"
        },
        "kimi-k2.7-code": {
          cost: {
            cacheRead: 0.19,
            cacheWrite: 0,
            input: 0.95,
            output: 4
          },
          name: "Kimi K2.7 Code",
          tiers: [],
          release: "2026-06-12"
        },
        "kimi-k3": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3,
            input: 3,
            output: 15
          },
          name: "Kimi K3",
          tiers: [],
          release: "2026-07-16"
        },
        "laguna-s-2.1-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Laguna S 2.1 Free",
          tiers: [],
          release: "2026-07-21"
        },
        "ling-2.6-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ling 2.6 Flash Free",
          tiers: [],
          release: "2026-04-21"
        },
        "ling-3.0-flash-fin-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ling 3.0 Flash Fin Free",
          tiers: [],
          release: "2026-08-27"
        },
        "ling-3.0-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ling-3.0-flash Free",
          tiers: [],
          release: "2026-07-23"
        },
        "ling-3.0-tiny-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ling-3.0-tiny Free",
          tiers: [],
          release: "2026-08-06"
        },
        "ling-3.1-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ling 3.1 Flash Free",
          tiers: [],
          release: "2026-09-29"
        },
        "ll-alpha-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "LL Alpha Free",
          tiers: [],
          release: "2026-10-15"
        },
        "longcat-2.0-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "LongCat-2.0 Free",
          tiers: [],
          release: "2026-06-30"
        },
        "longcat-2.5-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "LongCat 2.5 Free",
          tiers: [],
          release: "2026-11-02"
        },
        "longcat-2.5-preview-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "LongCat 2.5 Preview Free",
          tiers: [],
          release: "2026-09-25"
        },
        "mimo-v2-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiMo V2 Flash Free",
          tiers: [],
          release: "2025-12-16"
        },
        "mimo-v2-omni-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiMo V2 Omni Free",
          tiers: [],
          release: "2026-03-18"
        },
        "mimo-v2-pro-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiMo V2 Pro Free",
          tiers: [],
          release: "2026-03-18"
        },
        "mimo-v2.5-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiMo V2.5 Free",
          tiers: [],
          release: "2026-04-22"
        },
        "mimo-v2.6-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiMo-V2.6-Flash Free",
          tiers: [],
          release: "2026-09-22"
        },
        "minimax-m2.1": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M2.1",
          tiers: [],
          release: "2025-12-23"
        },
        "minimax-m2.1-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiniMax-M2.1 Free",
          tiers: [],
          release: "2025-12-23"
        },
        "minimax-m2.5": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M2.5",
          tiers: [],
          release: "2026-02-12"
        },
        "minimax-m2.5-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiniMax-M2.5 Free",
          tiers: [],
          release: "2026-02-12"
        },
        "minimax-m2.7": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M2.7",
          tiers: [],
          release: "2026-03-18"
        },
        "minimax-m3": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M3",
          tiers: [],
          release: "2026-06-01"
        },
        "minimax-m3-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiniMax-M3 Free",
          tiers: [],
          release: "2026-06-01"
        },
        "minimax-m3.1-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiniMax M3.1 Flash Free",
          tiers: [],
          release: "2026-10-19"
        },
        "mistral-large-4": {
          cost: {
            cacheRead: 0.07,
            cacheWrite: 0,
            input: 0.68,
            output: 2.09
          },
          name: "Mistral Large 4",
          tiers: [],
          release: "2026-10-06"
        },
        "muse-ember-1.0": {
          cost: {
            cacheRead: 0.004,
            cacheWrite: 0,
            input: 0.1,
            output: 0.5
          },
          name: "Muse Ember 1.0",
          tiers: [
            {
              cost: {
                cacheRead: 0.012,
                cacheWrite: 0,
                input: 0.3,
                output: 1.5
              },
              minContext: 200000
            }
          ],
          release: "2026-11-09"
        },
        "muse-spark-1.2": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.25,
            output: 4.25
          },
          name: "Muse Spark 1.2",
          tiers: [],
          release: "2026-08-05"
        },
        "muse-spark-1.2-contributor-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Muse Spark 1.2 Free",
          tiers: [],
          release: "2026-08-05"
        },
        "muse-spark-1.3": {
          cost: {
            cacheRead: 0.15,
            cacheWrite: 0,
            input: 1.25,
            output: 4.25
          },
          name: "Muse Spark 1.3",
          tiers: [],
          release: "2026-09-02"
        },
        "muse-spark-1.3-contributor-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Muse Spark 1.3 Free",
          tiers: [],
          release: "2026-09-02"
        },
        "muse-wonder-1.0": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 4,
            output: 20
          },
          name: "Muse Wonder",
          tiers: [],
          release: "2026-10-12"
        },
        "nemotron-3-super-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Nemotron 3 Super Free",
          tiers: [],
          release: "2026-03-11"
        },
        "nemotron-3-ultra-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Nemotron 3 Ultra Free",
          tiers: [],
          release: "2026-06-04"
        },
        "nemotron-3.5-lightning-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Nemotron 3.5 Lightning Free",
          tiers: [],
          release: "2026-08-11"
        },
        "nemotron-3.5-super-vl-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Nemotron 3.5 Super VL Free",
          tiers: [],
          release: "2026-10-15"
        },
        "north-mini-code-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "North Mini Code Free",
          tiers: [],
          release: "2026-06-09"
        },
        "pulse-alpha-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Pulse Alpha Free",
          tiers: [],
          release: "2026-11-02"
        },
        "qwen3-coder": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0.45,
            output: 1.8
          },
          name: "Qwen3 Coder",
          tiers: [],
          release: "2025-07-22"
        },
        "qwen3.5-plus": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0.25,
            input: 0.2,
            output: 1.2
          },
          name: "Qwen3.5 Plus",
          tiers: [],
          release: "2026-02-16"
        },
        "qwen3.6-plus": {
          cost: {
            cacheRead: 0.05,
            cacheWrite: 0.625,
            input: 0.5,
            output: 3
          },
          name: "Qwen3.6 Plus",
          tiers: [],
          release: "2026-04-02"
        },
        "qwen3.6-plus-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Qwen3.6 Plus Free",
          tiers: [],
          release: "2026-04-02"
        },
        "qwen3.8-flash": {
          cost: {
            cacheRead: 0.016,
            cacheWrite: 0.2,
            input: 0.15,
            output: 0.47
          },
          name: "Qwen3.8 Flash",
          tiers: [],
          release: "2026-08-26"
        },
        "qwen3.8-max": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 2.5,
            input: 2,
            output: 6
          },
          name: "Qwen3.8 Max",
          tiers: [],
          release: "2026-08-03"
        },
        "ring-2.6-1t-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ring 2.6 1T Free",
          tiers: [],
          release: "2026-05-08"
        },
        "space-bunny-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Space Bunny Free",
          tiers: [],
          release: "2026-09-23"
        },
        "step-5-preview-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Step 5 Preview Free",
          tiers: [],
          release: "2026-09-16"
        },
        "trinity-large-preview-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Trinity Large Preview",
          tiers: [],
          release: "2026-01-27"
        },
        "x-preview-f-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Ox Alpha Free (Unlimited)",
          tiers: [],
          release: "2026-08-21"
        }
      }
    },
    "opencode-go": {
      name: "OpenCode Go",
      source: "OpenCode Go card",
      models: {
        "beam-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Beam Free",
          tiers: [],
          release: "2026-10-05"
        },
        "cat-jam-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Cat Jam Free",
          tiers: [],
          release: "2026-10-12"
        },
        "claude-haiku-5-5": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "Claude Haiku 5.5",
          tiers: [
            {
              cost: {
                cacheRead: 0.05,
                cacheWrite: 0.625,
                input: 0.5,
                output: 2.5
              },
              minContext: 1e5
            }
          ],
          release: "2026-10-07"
        },
        "crouton-alpha-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Crouton Alpha Free",
          tiers: [],
          release: "2026-11-03"
        },
        "deepseek-v4-pro": {
          cost: {
            cacheRead: 0.022,
            cacheWrite: 0,
            input: 0.66,
            output: 1.98
          },
          name: "DeepSeek V4 Pro",
          tiers: [],
          release: "2026-04-24"
        },
        "deepseek-v4.1-flash": {
          cost: {
            cacheRead: 0.003,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "DeepSeek V4.1 Flash 1017",
          tiers: [],
          release: "2026-10-17"
        },
        "gemini-4-argon": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 2,
            output: 10
          },
          name: "Gemini 4 Argon",
          tiers: [],
          release: "2026-10-13"
        },
        "gemini-4-argon-contributor": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 0,
            input: 4,
            output: 20
          },
          name: "Gemini 4 Argon Contributor",
          tiers: [],
          release: "2026-10-13"
        },
        "glm-5.2": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.2",
          tiers: [],
          release: "2026-06-13"
        },
        "glm-5.3": {
          cost: {
            cacheRead: 0.26,
            cacheWrite: 0,
            input: 1.4,
            output: 4.4
          },
          name: "GLM-5.3",
          tiers: [],
          release: "2026-08-14"
        },
        "glm-5.3-flash": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.15,
            output: 0.5
          },
          name: "GLM-5.3-Flash",
          tiers: [],
          release: "2026-08-26"
        },
        "gpt-5.6-luna": {
          cost: {
            cacheRead: 0.02,
            cacheWrite: 0.25,
            input: 0.2,
            output: 1.2
          },
          name: "GPT-5.6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.04,
                cacheWrite: 0.5,
                input: 0.4,
                output: 1.8
              },
              minContext: 272000
            }
          ],
          release: "2026-07-09"
        },
        "gpt-6-luna": {
          cost: {
            cacheRead: 0.01,
            cacheWrite: 0.125,
            input: 0.1,
            output: 0.5
          },
          name: "GPT-6 Luna",
          tiers: [
            {
              cost: {
                cacheRead: 0.02,
                cacheWrite: 0.25,
                input: 0.2,
                output: 0.75
              },
              minContext: 272000
            }
          ],
          release: "2026-09-22"
        },
        "grok-4.7": {
          cost: {
            cacheRead: 0.5,
            cacheWrite: 0,
            input: 2,
            output: 6
          },
          name: "Grok 4.7",
          tiers: [
            {
              cost: {
                cacheRead: 1,
                cacheWrite: 0,
                input: 4,
                output: 12
              },
              minContext: 200000
            }
          ],
          release: "2026-09-21"
        },
        hy3: {
          cost: {
            cacheRead: 0.035,
            cacheWrite: 0,
            input: 0.14,
            output: 0.58
          },
          name: "Hy3",
          tiers: [],
          release: "2026-07-06"
        },
        hy4: {
          cost: {
            cacheRead: 0.042,
            cacheWrite: 0,
            input: 0.834,
            output: 2.501
          },
          name: "Hy4",
          tiers: [],
          release: "2026-11-04"
        },
        "hy4-preview": {
          cost: {
            cacheRead: 0.042,
            cacheWrite: 0,
            input: 0.834,
            output: 2.501
          },
          name: "Hy4 preview",
          tiers: [],
          release: "2026-08-28"
        },
        "iceman-contributor-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Iceman Contributor Free",
          tiers: [],
          release: "2026-10-24"
        },
        "kimi-k2.7-code": {
          cost: {
            cacheRead: 0.19,
            cacheWrite: 0,
            input: 0.95,
            output: 4
          },
          name: "Kimi K2.7 Code",
          tiers: [],
          release: "2026-06-12"
        },
        "kimi-k3": {
          cost: {
            cacheRead: 0.3,
            cacheWrite: 3,
            input: 3,
            output: 15
          },
          name: "Kimi K3",
          tiers: [],
          release: "2026-07-16"
        },
        "kimi-k3.1-pro": {
          cost: {
            cacheRead: 0.2,
            cacheWrite: 2,
            input: 2,
            output: 10
          },
          name: "Kimi K3.1 Pro",
          tiers: [],
          release: "2026-10-23"
        },
        "longcat-2.0": {
          cost: {
            cacheRead: 0.006,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "LongCat-2.0",
          tiers: [],
          release: "2026-06-30"
        },
        "longcat-2.5-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "LongCat 2.5 Free",
          tiers: [],
          release: "2026-11-02"
        },
        "longcat-2.5-preview-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "LongCat 2.5 Preview Free",
          tiers: [],
          release: "2026-09-25"
        },
        "mimo-v2.5": {
          cost: {
            cacheRead: 0.0028,
            cacheWrite: 0,
            input: 0.14,
            output: 0.28
          },
          name: "MiMo V2.5",
          tiers: [],
          release: "2026-04-22"
        },
        "mimo-v2.5-pro": {
          cost: {
            cacheRead: 0.003625,
            cacheWrite: 0,
            input: 0.435,
            output: 0.87
          },
          name: "MiMo V2.5 Pro",
          tiers: [],
          release: "2026-04-22"
        },
        "mimo-v2.6-flash": {
          cost: {
            cacheRead: 0.0028,
            cacheWrite: 0,
            input: 0.14,
            output: 0.28
          },
          name: "MiMo-V2.6-Flash",
          tiers: [],
          release: "2026-09-22"
        },
        "mimo-v2.6-pro": {
          cost: {
            cacheRead: 0.003625,
            cacheWrite: 0,
            input: 0.435,
            output: 0.87
          },
          name: "MiMo-V2.6-Pro",
          tiers: [],
          release: "2026-09-22"
        },
        "minimax-m2.7": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0.375,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M2.7",
          tiers: [],
          release: "2026-03-18"
        },
        "minimax-m3": {
          cost: {
            cacheRead: 0.06,
            cacheWrite: 0,
            input: 0.3,
            output: 1.2
          },
          name: "MiniMax-M3",
          tiers: [
            {
              cost: {
                cacheRead: 0.12,
                cacheWrite: 0,
                input: 0.6,
                output: 2.4
              },
              minContext: 512000
            }
          ],
          release: "2026-06-01"
        },
        "minimax-m3.1-flash": {
          cost: {
            cacheRead: 0.015,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "MiniMax M3.1 Flash",
          tiers: [],
          release: "2026-10-19"
        },
        "minimax-m3.1-flash-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "MiniMax M3.1 Flash Free",
          tiers: [],
          release: "2026-10-19"
        },
        "muse-spark-1.2-contributor": {
          cost: {
            cacheRead: 0.002,
            cacheWrite: 0,
            input: 0.1,
            output: 0.2
          },
          name: "Muse Spark 1.2 Contributor",
          tiers: [],
          release: "2026-08-05"
        },
        "muse-spark-1.3-contributor": {
          cost: {
            cacheRead: 0.002,
            cacheWrite: 0,
            input: 0.1,
            output: 0.2
          },
          name: "Muse Spark 1.3 Contributor",
          tiers: [],
          release: "2026-09-02"
        },
        "qwen3.7-plus": {
          cost: {
            cacheRead: 0.04,
            cacheWrite: 0.5,
            input: 0.4,
            output: 1.6
          },
          name: "Qwen3.7 Plus",
          tiers: [
            {
              cost: {
                cacheRead: 0.12,
                cacheWrite: 1.5,
                input: 1.2,
                output: 4.8
              },
              minContext: 256000
            }
          ],
          release: "2026-06-02"
        },
        "qwen3.8-flash": {
          cost: {
            cacheRead: 0.016,
            cacheWrite: 0.2,
            input: 0.15,
            output: 0.47
          },
          name: "Qwen3.8 Flash",
          tiers: [],
          release: "2026-08-26"
        },
        "qwen3.8-max": {
          cost: {
            cacheRead: 0.25,
            cacheWrite: 2.5,
            input: 2,
            output: 6
          },
          name: "Qwen3.8 Max",
          tiers: [],
          release: "2026-08-03"
        },
        "space-bunny": {
          cost: {
            cacheRead: 0.03,
            cacheWrite: 0,
            input: 0.15,
            output: 0.6
          },
          name: "Space Bunny",
          tiers: [],
          release: "2026-09-23"
        },
        "step-5-preview": {
          cost: {
            cacheRead: 0.1,
            cacheWrite: 0,
            input: 1,
            output: 2.7
          },
          name: "Step 5 Preview",
          tiers: [],
          release: "2026-09-16"
        },
        "step-5-preview-free": {
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0
          },
          name: "Step 5 Preview Free",
          tiers: [],
          release: "2026-09-16"
        }
      }
    }
  },
  version: 1
};

// service/src/prices.js
import { readFileSync } from "node:fs";
import path from "node:path";
var RATES = ["cacheRead", "cacheWrite", "input", "output"];
function priceOverrideFile(dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? null) {
  return dataDir ? path.join(dataDir, "price-overrides.json") : null;
}
function loadPriceOverrides({ file = priceOverrideFile(), log = () => {} } = {}) {
  if (!file)
    return {};
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT")
      log(`token-meter: could not read ${file}: ${error?.message ?? error}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log(`token-meter: ${file} is not JSON: ${error.message}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
      log(`token-meter: override "${key}" needs finite non-negative ${bad.join(", ")}; ignored`);
      continue;
    }
    overrides[key] = {
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      input: value.input,
      output: value.output
    };
  }
  const count = Object.keys(overrides).length;
  if (count)
    log(`token-meter: ${count} price override${count === 1 ? "" : "s"} from ${file}`);
  return overrides;
}

// service/src/main.js
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var BASE = process.env.OPENCHAMBER_OPENCODE_URL ?? "";
var STREAM_MAX_MS = 55000;
var STREAM_RETRY_MS = 2000;
var STREAM_REOPEN_MS = 300;
var API_TIMEOUT_MS = 8000;
var HISTORY_RECONCILE_MS = 300000;
var FIRST_LOAD_BUDGET_MS = 6000;
var HOT_MS = 30000;
var COLLECTOR_TTL_MS = 10 * 60000;
var MAX_COLLECTORS = 6;
var LINEAGE_MS = 30000;
var LINEAGE_RETRY_MS = 60000;
var LINEAGE_DEPTH = 4;
var MAX_SUBAGENTS = 200;
var MAX_SUBAGENT_AGE_MS = 60 * 60000;
var SUBAGENT_HISTORY_RETRY_MS = 15000;
var TICK_MS = 250;
if (!PORT || !TOKEN) {
  console.error("token-meter: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
function createService({ fetchImpl = fetch, log = () => {}, base = BASE, token = TOKEN, port = PORT, priceBook = PRICE_BOOK, overrides = null, dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? null } = {}) {
  const collectors = new Map;
  const state = { stream: "idle", streamError: null, stopping: false, controller: null, since: Date.now() };
  const priceOverrides = overrides ?? loadPriceOverrides({ file: priceOverrideFile(dataDir), log });
  const upstreamIsLoopback = (() => {
    try {
      const host = new URL(base).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    } catch {
      return false;
    }
  })();
  const subscribeTypes = [...LIVE_TYPES].filter((type) => type !== "session.usage.recorded");
  let filterStream = true;
  const apiGet = async (path2) => {
    if (!base)
      throw new Error("OpenCode access is not available");
    if (!upstreamIsLoopback)
      throw new Error("OpenCode access is not on loopback; refusing to send the token");
    const answer = await fetchImpl(`${base}${path2}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      ...typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(API_TIMEOUT_MS) } : {}
    });
    if (!answer.ok)
      throw new Error(`OpenCode answered ${answer.status}`);
    return answer.json();
  };
  const authorized = (header) => {
    if (!token)
      return true;
    const given = Buffer.from(String(header ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const getCollector = (id) => {
    let collector = collectors.get(id);
    if (!collector) {
      collector = createCollector(id);
      collectors.set(id, collector);
    }
    collector.touchedAt = Date.now();
    collector.watched = true;
    collector.watchedAt = collector.touchedAt;
    const watched = [...collectors.values()].filter((item) => item.watched);
    if (watched.length > MAX_COLLECTORS) {
      const idle = watched.filter((item) => item !== collector && !item.turnActive && !treeOf(item).some((member) => member.status === "streaming")).sort((a, b) => a.watchedAt - b.watchedAt)[0];
      if (idle)
        dropTree(idle);
    }
    refreshLineage(collector);
    readTurnStart(collector);
    return collector;
  };
  const treeOf = (root) => {
    const tree = [root];
    const seen = new Set([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const collector of collectors.values()) {
        if (!collector.parentId || seen.has(collector.id) || !seen.has(collector.parentId))
          continue;
        seen.add(collector.id);
        tree.push(collector);
        grew = true;
      }
    }
    return tree;
  };
  const dropTree = (root) => {
    for (const member of treeOf(root)) {
      if (member !== root && member.watched) {
        member.parentId = null;
        continue;
      }
      collectors.delete(member.id);
    }
  };
  const watchedRoots = () => [...collectors.values()].filter((collector) => collector.watched);
  const ensureSubagent = (id, record, parentId) => {
    let collector = collectors.get(id);
    if (!collector) {
      collector = createCollector(id);
      collector.parentId = parentId ?? record?.parentID ?? null;
      collectors.set(id, collector);
    } else if (!collector.parentId) {
      collector.parentId = parentId ?? record?.parentID ?? null;
    }
    if (record)
      applyRecord(collector, record);
    collector.touchedAt = Date.now();
    return collector;
  };
  const refreshLineage = async (root) => {
    if (!base || !upstreamIsLoopback || root.lineageLoading)
      return;
    const now = Date.now();
    if (root.lineageAt && now - root.lineageAt < LINEAGE_MS)
      return;
    if (root.lineageTriedAt && now - root.lineageTriedAt < LINEAGE_RETRY_MS)
      return;
    root.lineageLoading = true;
    root.lineageTriedAt = now;
    try {
      const own = apiGet(`/api/session/${encodeURIComponent(root.id)}`).catch((error) => {
        log(`token-meter: could not read ${root.id}: ${error?.message ?? error}`);
        return null;
      });
      const queue = [{ id: root.id, depth: 0 }];
      const seen = new Set;
      let found = 0;
      while (queue.length && found < MAX_SUBAGENTS) {
        const { id, depth } = queue.shift();
        if (depth > LINEAGE_DEPTH)
          continue;
        const answer = await apiGet(`/api/session?parentID=${encodeURIComponent(id)}&limit=200`);
        if (!collectors.has(root.id))
          return;
        for (const record of Array.isArray(answer?.data) ? answer.data : []) {
          if (!record?.id || record.id === root.id || seen.has(record.id))
            continue;
          const quietSince = record.time?.updated ?? record.time?.created ?? 0;
          if (!collectors.has(record.id) && quietSince && Date.now() - quietSince > MAX_SUBAGENT_AGE_MS)
            continue;
          seen.add(record.id);
          found += 1;
          ensureSubagent(record.id, record, id);
          queue.push({ id: record.id, depth: depth + 1 });
          if (found >= MAX_SUBAGENTS)
            break;
        }
      }
      const ownAnswer = await own;
      if (ownAnswer?.data)
        applyRecord(root, ownAnswer.data);
      root.lineageAt = Date.now();
      root.lineageTriedAt = 0;
    } catch (error) {
      log(`token-meter: could not read the subagents of ${root.id}: ${error?.message ?? error}`);
    } finally {
      root.lineageLoading = false;
    }
  };
  const learning = new Set;
  const missedAt = new Map;
  const learnSession = async (id) => {
    if (!base || !upstreamIsLoopback || learning.has(id) || watchedRoots().length === 0)
      return;
    const now = Date.now();
    if (missedAt.has(id) && now - missedAt.get(id) < LINEAGE_RETRY_MS)
      return;
    learning.add(id);
    try {
      const chain = [];
      let cursor = id;
      let attached = false;
      for (let depth = 0;depth <= LINEAGE_DEPTH; depth += 1) {
        const record = (await apiGet(`/api/session/${encodeURIComponent(cursor)}`))?.data;
        if (!record?.id)
          break;
        chain.push(record);
        const parentId = record.parentID;
        if (!parentId)
          break;
        if (collectors.has(parentId)) {
          attached = true;
          break;
        }
        cursor = parentId;
      }
      if (!attached) {
        if (missedAt.size > 500)
          missedAt.clear();
        missedAt.set(id, Date.now());
        return;
      }
      for (let index = chain.length - 1;index >= 0; index -= 1) {
        ensureSubagent(chain[index].id, chain[index], chain[index].parentID);
      }
      missedAt.delete(id);
    } catch (error) {
      if (missedAt.size > 500)
        missedAt.clear();
      missedAt.set(id, Date.now());
      log(`token-meter: could not place ${id}: ${error?.message ?? error}`);
    } finally {
      learning.delete(id);
    }
  };
  const readTurnStart = async (collector, force = false) => {
    if (!base || !upstreamIsLoopback || collector.turnStartLoading)
      return;
    const now = Date.now();
    if (!force && collector.turnStartedAt)
      return;
    if (now - collector.turnStartTriedAt < LINEAGE_RETRY_MS)
      return;
    collector.turnStartLoading = true;
    collector.turnStartTriedAt = now;
    try {
      const answer = await apiGet(`/api/session/${encodeURIComponent(collector.id)}/message?type=user&limit=1&order=desc`);
      const created = answer?.data?.[0]?.time?.created;
      if (typeof created === "number" && created > collector.turnStartedAt)
        collector.turnStartedAt = created;
    } catch (error) {
      log(`token-meter: could not read the turn start of ${collector.id}: ${error?.message ?? error}`);
    } finally {
      collector.turnStartLoading = false;
    }
  };
  const dispatch = (event) => {
    if (!wantsEvent(event?.type))
      return;
    const sessionId = event?.data?.sessionID;
    if (sessionId) {
      const collector = collectors.get(sessionId);
      if (collector)
        applyEvent(collector, event);
      else
        learnSession(sessionId);
      return;
    }
    for (const collector of collectors.values())
      applyEvent(collector, event);
  };
  async function consume(body) {
    const decoder = new TextDecoder;
    let buffer = "";
    let warnedBadPayload = false;
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf(`
`);
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf(`
`);
        if (!line.startsWith("data:"))
          continue;
        const payload = line.slice(5).trim();
        if (!payload)
          continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch (error) {
          if (!warnedBadPayload) {
            warnedBadPayload = true;
            log(`token-meter: an event payload was not JSON: ${error.message}`);
          }
          continue;
        }
        dispatch(event);
      }
      if (buffer.length > 4000000)
        buffer = "";
    }
  }
  async function streamLoop() {
    let recycled = false;
    while (!state.stopping) {
      if (!base || !upstreamIsLoopback) {
        state.stream = "off";
        state.streamError = "OpenCode access is not available";
        await sleep(5000);
        continue;
      }
      const controller = new AbortController;
      state.controller = controller;
      if (!recycled)
        state.stream = "connecting";
      let cutByOurTimer = false;
      const timer = setTimeout(() => {
        cutByOurTimer = true;
        controller.abort();
      }, STREAM_MAX_MS);
      try {
        const streamUrl = new URL(`${base}/api/event`);
        if (filterStream)
          for (const type of subscribeTypes)
            streamUrl.searchParams.append("types", type);
        const answer = await fetchImpl(streamUrl.toString(), {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          signal: controller.signal
        });
        if (!answer.ok) {
          if (answer.status === 400 && filterStream) {
            filterStream = false;
            log("token-meter: the server refused the event filter; reading the unfiltered stream");
          }
          throw new Error(`event stream answered ${answer.status}`);
        }
        if (!answer.body)
          throw new Error("event stream answered without a body");
        state.stream = "open";
        state.streamError = null;
        await consume(answer.body);
      } catch (error) {
        if (!state.stopping && !cutByOurTimer) {
          state.stream = "retrying";
          state.streamError = error?.message ? String(error.message) : String(error);
          log("token-meter: event stream", state.streamError);
        }
      } finally {
        clearTimeout(timer);
        state.controller = null;
      }
      recycled = cutByOurTimer;
      if (state.stopping)
        break;
      if (!cutByOurTimer && state.stream === "retrying")
        await sleep(STREAM_RETRY_MS);
      else
        await sleep(STREAM_REOPEN_MS);
    }
  }
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const collector of watchedRoots()) {
      if (now - collector.watchedAt > COLLECTOR_TTL_MS) {
        dropTree(collector);
        continue;
      }
      const tree = treeOf(collector);
      if (now - collector.watchedAt > HOT_MS && !tree.some((member) => member.status === "streaming"))
        continue;
      tick(collector, now, tree);
      refreshLineage(collector);
      for (const member of tree) {
        const mayLoad = member !== collector && member.historyAt === 0 && !member.loading && !member.turnActive && member.status !== "streaming" && now - member.historyTriedAt >= SUBAGENT_HISTORY_RETRY_MS;
        if (mayLoad)
          loadHistory(member, apiGet, 0, { stepsOnly: true });
      }
    }
  }, TICK_MS);
  ticker.unref?.();
  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    res.end(payload);
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`token-meter: ${req.method} ${req.url} failed: ${error?.message ?? error}`);
      if (res.destroyed || res.writableEnded)
        return;
      if (!res.headersSent)
        json(res, 500, { ok: false, error: "internal error" });
      else
        res.destroy();
    });
  });
  async function handle(req, res) {
    if (!authorized(req.headers.authorization)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "only GET is served" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      json(res, 200, { ok: true, pid: process.pid, upstream: Boolean(base), stream: state.stream });
      return;
    }
    if (url.pathname === "/state") {
      const session = url.searchParams.get("session") ?? "";
      if (!/^ses[\w-]{1,120}$/.test(session)) {
        json(res, 400, { ok: false, error: "session is required" });
        return;
      }
      const collector = getCollector(session);
      const first = collector.historyAt === 0;
      if (!base || !upstreamIsLoopback) {
        json(res, 200, {
          ...snapshot(collector, Date.now(), [collector], priceBook, priceOverrides),
          ok: false,
          error: !base ? "OpenCode access is not available. Approve the extension in Settings → Extensions." : "OpenCode access is not on loopback; refusing to send the token.",
          stream: { state: "off", error: state.streamError },
          loading: false
        });
        return;
      }
      const now = Date.now();
      const stale = now - collector.historyAt > HISTORY_RECONCILE_MS && !collector.turnActive;
      const cutRetry = collector.historyCut && !collector.turnActive && now - collector.historyAt > 15000;
      if (stale)
        readTurnStart(collector, true);
      const mayLoad = !collector.loading && now - collector.historyTriedAt >= (collector.error ? 15000 : 0) && (first || stale || cutRetry);
      if (mayLoad) {
        const run = loadHistory(collector, apiGet, first ? now + FIRST_LOAD_BUDGET_MS : 0);
        if (first)
          await run;
      } else if (first && collector.loading) {
        await collector.loading;
      }
      const tree = treeOf(collector);
      tick(collector, now, tree);
      const answer = snapshot(collector, now, tree, priceBook, priceOverrides);
      if (url.searchParams.get("steps") === String(answer.stepsSeq))
        delete answer.steps;
      json(res, 200, {
        ...answer,
        stream: { state: state.stream, error: state.streamError, since: state.since },
        loading: Boolean(collector.loading)
      });
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  }
  return {
    server,
    start() {
      server.listen(port, "127.0.0.1");
      streamLoop();
      return server;
    },
    stop() {
      state.stopping = true;
      clearInterval(ticker);
      state.controller?.abort();
      server.close();
    }
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var isMain = process.argv[1] && process.argv[1].endsWith("main.js") && !process.env.TOKEN_METER_NO_LISTEN;
if (isMain) {
  const service = createService({ log: (message) => console.error(message) });
  service.start().on("listening", () => console.error(`token-meter: service on 127.0.0.1:${PORT}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      service.stop();
      process.exit(0);
    });
  }
}
export {
  createService
};
