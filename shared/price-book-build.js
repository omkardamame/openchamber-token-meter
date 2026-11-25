// Shared price-book builder used by both scripts/sync-prices.mjs and the
// service's background refresher so offline snapshots and live refreshes
// produce the exact same schema and provider filter.

export const PRICE_SOURCE = 'https://models.dev/api.json';

// Order is alphabetical; buildPriceBook preserves that order.
export const PROVIDERS = {
  anthropic: { name: 'Anthropic', source: 'Anthropic list' },
  commandcode: { name: 'Command Code', source: 'Command Code list' },
  deepseek: { name: 'DeepSeek', source: 'DeepSeek list' },
  google: { name: 'Google', source: 'Google list' },
  openai: { name: 'OpenAI', source: 'OpenAI list' },
  opencode: { name: 'OpenCode Zen', source: 'OpenCode Zen list' },
  'opencode-go': { name: 'OpenCode Go', source: 'OpenCode Go card' },
};

// Static: how an OpenCode provider or model name reaches a card.
export const ALIASES = {
  providers: {
    'antigravity-acp': 'google',
    'claude-agent': 'anthropic',
    'command-code': 'commandcode',
    commandcode: 'commandcode',
    deepseek: 'deepseek',
    google: 'google',
    openai: 'openai',
    opencode: 'opencode',
    'opencode-go': 'opencode-go',
  },
  models: {
    'claude-agent': {
      fable: 'claude-fable-5-2',
      haiku: 'claude-haiku-5-5',
      opus: 'claude-opus-5-5',
      sonnet: 'claude-sonnet-5-5',
    },
  },
  labs: {
    commandcode: { 'claude-': 'anthropic', 'gpt-': 'openai' },
  },
};

const rate = (value) => (Number.isFinite(value) ? value : 0);

function tierCost(raw) {
  return {
    cacheRead: rate(raw.cache_read),
    cacheWrite: rate(raw.cache_write),
    input: rate(raw.input),
    output: rate(raw.output),
  };
}

function modelCard(id, raw) {
  const cost = raw?.cost;
  if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return null;
  const tiers = [];
  for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) {
    const minContext = tier?.tier?.size;
    if (tier?.tier?.type !== 'context' || !Number.isFinite(minContext)) continue;
    tiers.push({ cost: tierCost(tier), minContext });
  }
  tiers.sort((a, b) => a.minContext - b.minContext);
  const card = {
    cost: tierCost(cost),
    name: raw.name ?? id,
    tiers,
  };
  if (typeof raw.release_date === 'string') card.release = raw.release_date;
  return card;
}

/** Build a validated price book from a models.dev API payload. */
export function buildPriceBook(api, checkedAt) {
  const providers = {};
  for (const id of Object.keys(PROVIDERS).sort()) {
    const upstream = api?.[id]?.models;
    if (!upstream || typeof upstream !== 'object') throw new Error(`models.dev has no provider "${id}"`);
    const models = {};
    for (const modelId of Object.keys(upstream).sort()) {
      const card = modelCard(modelId, upstream[modelId]);
      if (card) models[modelId] = card;
    }
    if (!Object.keys(models).length) throw new Error(`provider "${id}" produced no priced model`);
    providers[id] = { ...PROVIDERS[id], models };
  }
  return {
    aliases: ALIASES,
    checkedAt,
    currency: 'USD',
    providers,
    version: 1,
  };
}

/** True when a parsed object looks like a complete v1 price book. */
export function isValidPriceBook(book) {
  if (!book || typeof book !== 'object' || book.version !== 1) return false;
  if (typeof book.checkedAt !== 'string' || !book.checkedAt) return false;
  if (!book.providers || typeof book.providers !== 'object') return false;
  for (const id of Object.keys(PROVIDERS)) {
    const models = book.providers[id]?.models;
    if (!models || typeof models !== 'object' || !Object.keys(models).length) return false;
  }
  return true;
}
