// Time-of-day tariffs the meter can name.
//
// The same DeepSeek model can be billed by OpenCode Go or by DeepSeek's own
// API. Both publish two tiers, but the provider ids, model ids and holiday
// rule differ. A provider we do not know gets no tariff: the meter shows the
// rate recovered from that provider's own step costs instead of applying
// someone else's card. Only a flat-priced provider needs no entry here.
//
// Cards checked against https://opencode.ai/docs/go and
// https://api-docs.deepseek.com/quick_start/pricing/ on 2026-11-13.

const UTC_WEEKDAY = {
  windows: [
    [1, 4],
    [6, 10],
  ],
  label: '01:00–04:00 and 06:00–10:00 UTC, Mon–Fri',
  holidays: null,
};

// Chinese public holidays 2026, off-peak in full on DeepSeek's own API. Peak
// windows are 09:00–12:00 and 14:00–18:00 China Standard Time, so inside every
// window the UTC date and the Chinese date are the same day.
const CN_HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

function holidaySet(ranges) {
  const days = new Set();
  for (const [start, end] of ranges) {
    const from = Date.parse(`${start}T00:00:00Z`);
    const to = Date.parse(`${end}T00:00:00Z`);
    for (let at = from; at <= to; at += 86_400_000) {
      days.add(new Date(at).toISOString().slice(0, 10));
    }
  }
  return days;
}

const UTC_WEEKDAY_CN = {
  windows: UTC_WEEKDAY.windows,
  label: '01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays',
  holidays: holidaySet(CN_HOLIDAY_RANGES),
  holidayYear: 2026,
};

const flash = (schedule) => ({
  schedule,
  peakMultiplier: 2,
  offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
  peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
});

const pro = (schedule) => ({
  schedule,
  peakMultiplier: 2,
  offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
  peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
});

const TIME_TARIFFS = {
  'opencode-go/deepseek-v4.1-flash': flash(UTC_WEEKDAY),
  'opencode-go/deepseek-v4-pro': pro(UTC_WEEKDAY),
  'deepseek/deepseek-flash': flash(UTC_WEEKDAY_CN),
  'deepseek/deepseek-v4-flash': flash(UTC_WEEKDAY_CN),
  'deepseek/deepseek-v4-flash-vision-exp': flash(UTC_WEEKDAY_CN),
  'deepseek/deepseek-v4-pro': pro(UTC_WEEKDAY_CN),
};

/** The published time tariff for a provider/model pair, or null for a flat model. */
export function timeTariff(provider, model) {
  if (!provider || !model) return null;
  return TIME_TARIFFS[`${provider}/${model}`] ?? null;
}

/**
 * True when `at` falls inside a peak window. Windows are UTC hours, end-
 * exclusive; weekends and the schedule's holidays are off-peak.
 */
export function isPeakAt(at, schedule = UTC_WEEKDAY) {
  const date = new Date(Number(at));
  if (!Number.isFinite(date.getTime())) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (!schedule.windows.some(([start, end]) => minute >= start * 60 && minute < end * 60)) return false;
  if (schedule.holidays?.has(date.toISOString().slice(0, 10))) return false;
  return true;
}

const pick = (rates) => ({ input: rates.input, output: rates.output, cacheRead: rates.cacheRead });

const scale = (rates, factor) => ({
  input: Math.round(rates.input * factor * 1e6) / 1e6,
  output: Math.round(rates.output * factor * 1e6) / 1e6,
  cacheRead: Math.round(rates.cacheRead * factor * 1e6) / 1e6,
});

/**
 * The two sides of a tariff to draw. Recovered step rates win when they match
 * one side of the published card; otherwise the card is the answer. A session
 * that only ever ran at peak recovers the peak side, and matching it stops the
 * meter from doubling an already-peak rate.
 */
export function tariffTiers(tariff, rates = null) {
  const card = {
    source: 'card',
    offPeak: { ...tariff.offPeak },
    peak: { ...tariff.peak },
  };
  if (!rates) return card;
  const near = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.01);
  const matches = (side) => near(rates.input, side.input) && near(rates.output, side.output) && near(rates.cacheRead, side.cacheRead);
  const atPeak = matches(tariff.peak);
  const atOffPeak = matches(tariff.offPeak);
  if (atPeak && !atOffPeak) {
    return { source: 'recovered', offPeak: scale(rates, 1 / tariff.peakMultiplier), peak: pick(rates) };
  }
  if (atOffPeak || !atPeak) {
    return { source: 'recovered', offPeak: pick(rates), peak: scale(rates, tariff.peakMultiplier) };
  }
  return card;
}
