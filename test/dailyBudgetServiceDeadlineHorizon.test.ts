// Regression: when the daily-budget hot path runs many times before tomorrow's
// spot prices land, the cached snapshot must still expose tomorrow once prices
// arrive so the deferred-objective `policyHorizon` can reach a next-day deadline
// (the failure mode that produced "Deadline plan unavailable" in the UI).
import { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import {
  buildDeferredObjectivePolicyHorizon,
} from '../lib/plan/deferredObjectives/policyHorizon';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../lib/utils/settingsKeys';
import { COMBINED_PRICES_VERSION, type CombinedPricesV2 } from '../lib/price/priceTypes';

const TZ = 'Europe/Oslo';
// 2026-05-10 21:00 local (Oslo CEST, UTC+2). Below the 06:00 next-day deadline
// we want policyHorizon to cover.
const NOW_MS = Date.UTC(2026, 4, 10, 19, 0, 0);
// 2026-05-11 06:00 local (Oslo CEST) → 04:00 UTC.
const DEADLINE_MS = Date.UTC(2026, 4, 11, 4, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

const buildHours = (startMs: number, count: number) => (
  Array.from({ length: count }, (_, index) => ({
    startsAt: new Date(startMs + index * HOUR_MS).toISOString(),
    total: 1.5 + (index % 5) * 0.1,
    isCheap: false,
    isExpensive: false,
  }))
);

const buildCombinedPricesV2 = (
  days: Record<string, { startMs: number; count: number }>,
  lastFetched: string,
): CombinedPricesV2 => ({
  version: COMBINED_PRICES_VERSION,
  days: Object.fromEntries(
    Object.entries(days).map(([dateKey, { startMs, count }]) => [
      dateKey,
      { hours: buildHours(startMs, count) },
    ]),
  ),
  avgPrice: 1.6,
  lowThreshold: 1.2,
  highThreshold: 2.0,
  priceScheme: 'norway',
  priceUnit: 'kr/kWh',
  lastFetched,
});

// Today (Oslo) starts at 2026-05-09 22:00 UTC, tomorrow starts at 2026-05-10 22:00 UTC.
const TODAY_START_UTC_MS = Date.UTC(2026, 4, 9, 22, 0, 0);
const TOMORROW_START_UTC_MS = Date.UTC(2026, 4, 10, 22, 0, 0);

type SettingsStore = Record<string, unknown>;

const buildService = (initialSettings: SettingsStore): {
  service: DailyBudgetService;
  setCombinedPrices: (prices: SettingsStore[typeof COMBINED_PRICES]) => void;
} => {
  const settings: SettingsStore = { ...initialSettings };
  const get = vi.fn((key: string) => settings[key] ?? null);
  const set = vi.fn((key: string, value: unknown) => {
    settings[key] = value;
  });
  const service = new DailyBudgetService({
    homey: {
      settings: { get, set, on: vi.fn(), off: vi.fn() },
      clock: { getTimezone: () => TZ },
    } as any,
    log: () => undefined,
    logDebug: () => undefined,
    error: () => undefined,
    getPowerTracker: () => ({ buckets: {} }),
    getPriceOptimizationEnabled: () => true,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 2 }),
    requestPriceRefetch: () => undefined,
  });
  service.loadSettings();
  return {
    service,
    setCombinedPrices: (value) => {
      settings[COMBINED_PRICES] = value;
    },
  };
};

describe('DailyBudgetService → deferred objective policy horizon', () => {
  it('seeds tomorrow on the next hot-path update once prices arrive, and policyHorizon then covers a next-day deadline', () => {
    const settings: SettingsStore = {
      [DAILY_BUDGET_ENABLED]: true,
      [DAILY_BUDGET_KWH]: 60,
      [DAILY_BUDGET_PRICE_SHAPING_ENABLED]: true,
      // Start with only today's prices — reproduces the user-observed state
      // where Nordpool tomorrow has not been published / fetched yet.
      [COMBINED_PRICES]: buildCombinedPricesV2(
        { '2026-05-10': { startMs: TODAY_START_UTC_MS, count: 24 } },
        '2026-05-10T05:00:00Z',
      ),
    };
    const { service, setCombinedPrices } = buildService(settings);

    // Many hot-path power samples flow before any settings UI has opened.
    // With today-only prices the deferred-objective policy horizon cannot
    // cover a next-day deadline, regardless of whether tomorrow is seeded.
    for (let i = 0; i < 25; i += 1) {
      service.updateState({ nowMs: NOW_MS + i * 10_000 });
    }
    let snapshot = service.getSnapshot();
    expect(snapshot?.todayKey).toBe('2026-05-10');
    let horizon = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: DEADLINE_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: snapshot,
    });
    expect(horizon.reasonCode).toBe('objective_missing_price_horizon');

    // User reloads prices: tomorrow's day-ahead lands. lastFetched changes too,
    // matching how the price service rewrites the COMBINED_PRICES setting.
    setCombinedPrices(buildCombinedPricesV2(
      {
        '2026-05-10': { startMs: TODAY_START_UTC_MS, count: 24 },
        '2026-05-11': { startMs: TOMORROW_START_UTC_MS, count: 24 },
      },
      '2026-05-10T13:00:00Z',
    ));

    // The very next plan-rebuild tick (a regular hot-path update; no
    // includeAdjacentDays) must seed tomorrow into the cached snapshot.
    service.updateState({ nowMs: NOW_MS + 30 * 10_000 });
    snapshot = service.getSnapshot();
    expect(snapshot?.tomorrowKey).toBe('2026-05-11');
    expect(snapshot?.days['2026-05-11']).toBeDefined();

    // policyHorizon now covers the 06:00 next-day deadline.
    horizon = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: DEADLINE_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: snapshot,
    });
    expect(horizon.reasonCode).toBeNull();
    expect(horizon.horizonBucketCount).toBeGreaterThan(0);
    const lastBucket = horizon.buckets[horizon.buckets.length - 1];
    expect(lastBucket.endMs).toBeGreaterThanOrEqual(DEADLINE_MS);
  });

  it('does not run repeated tomorrow rebuilds while prices are unchanged', () => {
    const settings: SettingsStore = {
      [DAILY_BUDGET_ENABLED]: true,
      [DAILY_BUDGET_KWH]: 60,
      [DAILY_BUDGET_PRICE_SHAPING_ENABLED]: true,
      [COMBINED_PRICES]: buildCombinedPricesV2(
        { '2026-05-10': { startMs: TODAY_START_UTC_MS, count: 24 } },
        '2026-05-10T05:00:00Z',
      ),
    };
    const { service } = buildService(settings);

    service.updateState({ nowMs: NOW_MS });
    const buildPreviewSpy = vi.spyOn(service as any, 'buildTomorrowPreview');
    for (let i = 0; i < 20; i += 1) {
      service.updateState({ nowMs: NOW_MS + (i + 1) * 10_000 });
    }
    expect(buildPreviewSpy).not.toHaveBeenCalled();
  });
});
