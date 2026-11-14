// Test-only price book. Shapes and numbers copied from the real book so the
// resolver is tested against the same data it meets in production, plus two
// deliberate oddities: a duplicated bare id (ambiguity) and a free card.
export const FIXTURE_BOOK = {
  version: 1,
  checkedAt: '2026-11-14',
  currency: 'USD',
  providers: {
    anthropic: {
      name: 'Anthropic',
      source: 'Anthropic list',
      models: {
        'claude-opus-5': { name: 'Claude Opus 5', release: '2026-07-24', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, tiers: [] },
        'claude-opus-5-5': { name: 'Claude Opus 5.5', release: '2026-09-22', cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, tiers: [] },
        'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', release: '2026-09-28', cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, tiers: [] },
        'claude-fable-5-2': { name: 'Claude Fable 5.2', release: '2026-11-09', cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, tiers: [] },
        'claude-haiku-5-5': {
          name: 'Claude Haiku 5.5',
          release: '2026-10-07',
          cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
          tiers: [{ minContext: 100000, cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } }],
        },
        'dup-one/shared': { name: 'Duplicate A', release: '2026-01-01', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, tiers: [] },
        'dup-two/shared': { name: 'Duplicate B', release: '2026-01-02', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, tiers: [] },
      },
    },
    openai: {
      name: 'OpenAI',
      source: 'OpenAI list',
      models: {
        'gpt-6.1-terra': {
          name: 'GPT-6.1 Terra',
          release: '2026-10-26',
          cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
          tiers: [{ minContext: 272000, cost: { input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 } }],
        },
      },
    },
    'opencode-go': {
      name: 'OpenCode Go',
      source: 'OpenCode Go card',
      models: {
        'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', release: '2026-10-17', cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }, tiers: [] },
        'glm-5.3-flash': { name: 'GLM-5.3-Flash', release: '2026-08-26', cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 }, tiers: [] },
      },
    },
    commandcode: {
      name: 'Command Code',
      source: 'Command Code list',
      models: {
        'deepseek/deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', release: '2026-09-10', cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }, tiers: [] },
        'free-model': { name: 'Free Model', release: '2026-05-01', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiers: [] },
        'zai-org/GLM-5.3': { name: 'GLM-5.3', release: '2026-08-14', cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, tiers: [] },
      },
    },
    opencode: {
      name: 'OpenCode Zen',
      source: 'OpenCode Zen list',
      models: {
        'muse-spark-1.3-contributor-free': { name: 'Muse Spark 1.3 Free', release: '2026-09-01', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiers: [] },
      },
    },
    deepseek: {
      name: 'DeepSeek',
      source: 'DeepSeek list',
      models: {
        'deepseek-flash': { name: 'DeepSeek V4.1 Flash', release: '2026-04-24', cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }, tiers: [] },
      },
    },
  },
  aliases: {
    providers: {
      'claude-agent': 'anthropic',
      'command-code': 'commandcode',
      commandcode: 'commandcode',
      deepseek: 'deepseek',
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
  },
};

/** A manual override for Opus 5.5, as $OPENCHAMBER_SERVICE_DATA_DIR would hold. */
export const FIXTURE_OVERRIDES = {
  'anthropic/claude-opus-5-5': { cacheRead: 0.18, cacheWrite: 4.5, input: 3.5, output: 18 },
};

/** A step in the shape the collector keeps. `generated` is output + reasoning. */
export function step({ at = Date.UTC(2026, 10, 14, 12, 0, 0), provider = 'anthropic', model = 'claude-opus-5-5', input = 0, generated = 0, cacheRead = 0, cacheWrite = 0, cost = 0 } = {}) {
  return { at, cacheRead, cacheWrite, cost, model, provider, tokens: generated, total: input + generated };
}

export const SATURDAY_NOON = Date.UTC(2026, 10, 14, 12, 0, 0); // off-peak by weekday
export const MONDAY_PEAK = Date.UTC(2026, 10, 16, 2, 0, 0); // 02:00 UTC, inside 01–04
export const CN_HOLIDAY = Date.UTC(2026, 9, 1, 2, 0, 0); // 2026-10-01, inside a window, a holiday
