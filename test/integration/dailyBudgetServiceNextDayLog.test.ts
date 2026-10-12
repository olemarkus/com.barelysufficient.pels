import type Homey from 'homey';
import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { Logger, StructuredDebugEmitter } from '../../lib/logging/logger';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { resolvePlanningPowerCeiling } from '../../lib/power/capacityModel';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { createCombinedPricesReader, type CombinedPricesReader } from '../../lib/price/combinedPricesReader';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import {
  COMBINED_PRICES_VERSION,
  type CombinedPricesV1,
  type CombinedPricesV2,
} from '../../lib/price/priceTypes';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../lib/utils/settingsKeys';
import { createDailyBudgetSettingsStore } from '../../setup/dailyBudgetSettingsAdapter';
import { partialDouble } from '../helpers/partialDouble';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';

// Tomorrow's plan goes to the `daily_budget` debug topic as the `next_day`
// variant of `daily_budget_plan_debug`. It is written when the service rebuilds
// the adjacent days (tomorrow's inputs, the closed-day history mark or the
// planning ceiling moving), not on every rebuild of today's plan. The Budget
// Adjust candidate writes no debug entries at all.

type AppHomey = Homey.App['homey'];
type PlanDebugEntry = DailyBudgetDayPayload & {
  event: string;
  variant: string;
  meta: {
    settings: { dailyBudgetKWh: number };
    priceSpreadFactor: number | null;
    priceOptimizationEnabled: boolean;
    planningCeiling: unknown;
  };
};

const TZ = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
// 2025-03-15 13:00 in Oslo (CET, UTC+1).
const NOW_MS = Date.UTC(2025, 2, 15, 12, 0, 0);
const TODAY_START_UTC_MS = Date.UTC(2025, 2, 14, 23, 0, 0);
const TOMORROW_START_UTC_MS = Date.UTC(2025, 2, 15, 23, 0, 0);
const TOMORROW_TOTALS = Array.from({ length: 24 }, (_, index) => 0.5 + (index % 6) * 0.3);
const POWER_LIMITS = capacityOnlyPowerLimits(10, 2);

const buildHours = (startMs: number, totals: number[]) => totals.map((total, index) => ({
  startsAt: new Date(startMs + index * HOUR_MS).toISOString(),
  total,
  isCheap: false,
  isExpensive: false,
}));

const buildPriceStore = (withTomorrow: boolean): CombinedPricesV2 => ({
  version: COMBINED_PRICES_VERSION,
  days: {
    '2025-03-15': { hours: buildHours(TODAY_START_UTC_MS, Array.from({ length: 24 }, () => 1)) },
    ...(withTomorrow ? { '2025-03-16': { hours: buildHours(TOMORROW_START_UTC_MS, TOMORROW_TOTALS) } } : {}),
  },
  avgPrice: 1,
  lowThreshold: 0.8,
  highThreshold: 1.2,
  priceScheme: 'norway',
  priceUnit: 'kr/kWh',
});

// A legacy V1 cache whose hours all lie weeks before the three-day window.
const LEGACY_OUT_OF_WINDOW: CombinedPricesV1 = {
  prices: buildHours(Date.UTC(2025, 1, 1, 0, 0, 0), [1, 1]),
  avgPrice: 1,
  lowThreshold: 0.8,
  highThreshold: 1.2,
  priceScheme: 'norway',
  priceUnit: 'kr/kWh',
};

const buildHarness = (combinedPricesReader?: CombinedPricesReader) => {
  const settings: Record<string, unknown> = {
    [DAILY_BUDGET_ENABLED]: true,
    [DAILY_BUDGET_KWH]: 20,
    [DAILY_BUDGET_PRICE_SHAPING_ENABLED]: true,
  };
  const homey = partialDouble<AppHomey>({
    settings: partialDouble<AppHomey['settings']>({
      get: vi.fn((key: string) => settings[key] ?? null) as AppHomey['settings']['get'],
      set: vi.fn((key: string, value: unknown) => { settings[key] = value; }) as AppHomey['settings']['set'],
    }),
  });
  const prices: { store: CombinedPricesV2 | null } = { store: buildPriceStore(false) };
  const tracker: { state: PowerTrackerState } = { state: { buckets: {} } };
  const readStore = vi.fn(() => prices.store);
  const writeState = vi.fn();
  const info = vi.fn();
  const error = vi.fn();
  const debugStructured = vi.fn<StructuredDebugEmitter>();
  const service = new DailyBudgetService({
    getTimeZone: () => TZ,
    log: () => undefined,
    isDebugTopicEnabled: () => true,
    getPowerTracker: () => tracker.state,
    getPriceOptimizationEnabled: () => true,
    getCapacitySettings: () => POWER_LIMITS,
    combinedPricesReader: combinedPricesReader ?? { readStore },
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(homey),
    dailyBudgetStateStore: { read: () => null, write: writeState },
    structuredLog: partialDouble<Logger>({ info: info as Logger['info'], error: error as Logger['error'] }),
    debugStructured,
  });
  service.loadSettings();
  service.loadState();
  return { service, prices, tracker, readStore, writeState, info, error, debugStructured };
};

const planDebugEntries = (
  debugStructured: ReturnType<typeof vi.fn<StructuredDebugEmitter>>,
  variant: 'current' | 'next_day',
): PlanDebugEntry[] => debugStructured.mock.calls
  .map(([payload]) => payload as PlanDebugEntry)
  .filter((payload) => payload.event === 'daily_budget_plan_debug' && payload.variant === variant);

describe('DailyBudgetService next-day plan log', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes no next-day entry on a routine update that rebuilds only today\'s plan', () => {
    const { service, debugStructured } = buildHarness();
    service.updateState({ nowMs: NOW_MS });
    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(1);
    debugStructured.mockClear();

    // The next hour: today's plan rebuilds, tomorrow's inputs are unchanged.
    service.updateState({ nowMs: NOW_MS + HOUR_MS + 10_000 });

    expect(planDebugEntries(debugStructured, 'current')).toHaveLength(1);
    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(0);
  });

  it('writes tomorrow\'s live preview once when tomorrow\'s prices arrive', () => {
    const { service, prices, debugStructured } = buildHarness();
    service.updateState({ nowMs: NOW_MS });
    service.updateState({ nowMs: NOW_MS + 10_000 });
    debugStructured.mockClear();

    prices.store = buildPriceStore(true);
    service.updateState({ nowMs: NOW_MS + 20_000 });

    const [entry, ...extra] = planDebugEntries(debugStructured, 'next_day');
    expect(extra).toHaveLength(0);
    expect(entry?.dateKey).toBe('2025-03-16');
    expect(entry?.buckets.price).toEqual(TOMORROW_TOTALS);
    const tomorrow = service.getSnapshot()?.days['2025-03-16'];
    expect(entry?.buckets.plannedKWh).toEqual(tomorrow?.buckets.plannedKWh);
    // The price block and settings come from the same read as the preview.
    expect(entry?.meta.priceOptimizationEnabled).toBe(true);
    expect(entry?.meta.planningCeiling).not.toBeNull();
    expect(entry?.meta.planningCeiling).toEqual(resolvePlanningPowerCeiling(POWER_LIMITS));
    expect(entry?.meta.priceSpreadFactor).toBeGreaterThan(0);

    debugStructured.mockClear();
    service.updateState({ nowMs: NOW_MS + 30_000 });
    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(0);
  });

  it('writes it once when the budget settings are applied', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { service, debugStructured } = buildHarness();
    service.updateState({ nowMs: NOW_MS });
    debugStructured.mockClear();

    vi.setSystemTime(NOW_MS + 10_000);
    service.applyModelSettings({ dailyBudgetKWh: 25 });

    const entries = planDebugEntries(debugStructured, 'next_day');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.meta.settings.dailyBudgetKWh).toBe(25);
  });

  it('writes it once for the new tomorrow when the day rolls over', () => {
    const { service, debugStructured } = buildHarness();
    // 23:59:50 and then 00:00:10 in Oslo.
    service.updateState({ nowMs: TOMORROW_START_UTC_MS - 10_000 });
    debugStructured.mockClear();

    service.updateState({ nowMs: TOMORROW_START_UTC_MS + 10_000 });

    const entries = planDebugEntries(debugStructured, 'next_day');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.dateKey).toBe('2025-03-17');
  });

  it('reads the prices once per update, for today, the adjacent days and the next-day entry', () => {
    const { service, readStore, debugStructured } = buildHarness();

    service.updateState({ nowMs: NOW_MS });

    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(1);
    expect(readStore).toHaveBeenCalledTimes(1);
  });

  // The price reader answers a cache it has to rebuild with no prices and a
  // rebuild request, which the coordinator serves synchronously. The update keeps
  // its one empty read; the next update plans tomorrow on the rebuilt prices.
  it.each([
    ['a malformed cache', { unexpected: 'shape' }],
    ['a legacy cache with no hour in the window', LEGACY_OUT_OF_WINDOW],
  ])('restores tomorrow\'s prices on the update after the reader recovers from %s', (_label, cached) => {
    const priceCache = createInMemoryPriceCache();
    priceCache.write(COMBINED_PRICES, cached);
    const settingsPort: SettingsPort = {
      get: () => null, set: () => undefined, unset: () => undefined, getKeys: () => [],
    };
    const requestRebuild = vi.fn(() => priceCache.write(COMBINED_PRICES, buildPriceStore(true)));
    const reader = createCombinedPricesReader(createPriceDataStore(settingsPort, priceCache), requestRebuild);
    const { service, debugStructured } = buildHarness(reader);

    service.updateState({ nowMs: NOW_MS });

    expect(requestRebuild).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot()?.days['2025-03-16']?.buckets.price).toBeUndefined();
    const [unpriced, ...extraUnpriced] = planDebugEntries(debugStructured, 'next_day');
    expect(extraUnpriced).toHaveLength(0);
    expect(unpriced?.buckets.price).toBeUndefined();
    expect(unpriced?.meta.priceSpreadFactor).toBe(0);
    debugStructured.mockClear();

    service.updateState({ nowMs: NOW_MS + 10_000 });

    expect(requestRebuild).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot()?.days['2025-03-16']?.buckets.price).toEqual(TOMORROW_TOTALS);
    const [entry, ...extra] = planDebugEntries(debugStructured, 'next_day');
    expect(extra).toHaveLength(0);
    expect(entry?.buckets.price).toEqual(TOMORROW_TOTALS);
    expect(entry?.meta.priceSpreadFactor).toBeGreaterThan(0);
  });

  it('keeps the update and its persistence when the next-day entry fails', () => {
    const { service, writeState, error, debugStructured } = buildHarness();
    service.updateState({ nowMs: TOMORROW_START_UTC_MS - 10_000 });
    writeState.mockClear();
    service['manager'].logNextDayPlan = () => {
      throw new Error('debug write failed');
    };

    // The rollover rebuilds the adjacent days and carries a high-priority persist reason.
    service.updateState({ nowMs: TOMORROW_START_UTC_MS + 10_000 });

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'daily_budget_next_day_plan_log_failed',
      err: expect.objectContaining({ message: 'debug write failed' }),
    }));
    expect(error).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'daily_budget_state_update_failed' }));
    expect(service.getSnapshot()?.todayKey).toBe('2025-03-16');
    expect(writeState).toHaveBeenCalled();
    expect(planDebugEntries(debugStructured, 'current').length).toBeGreaterThan(0);
  });

  it('writes no daily_budget debug entry for the Budget Adjust model preview', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { service, prices, tracker, info, debugStructured } = buildHarness();
    prices.store = buildPriceStore(true);
    service.updateState({ nowMs: NOW_MS });
    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(1);
    // Overrun the current hour so the live plan freezes: the candidate then also
    // takes the recompute-a-frozen-plan path.
    tracker.state = { buckets: { [new Date(NOW_MS).toISOString()]: 10 } };
    service.updateState({ nowMs: NOW_MS + 10_000 });
    expect(service.getSnapshot()?.days['2025-03-15']?.state.frozen).toBe(true);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({ event: 'daily_budget_plan_frozen' }));
    debugStructured.mockClear();
    info.mockClear();

    vi.setSystemTime(NOW_MS + 20_000);
    const preview = service.previewModelSettings({ dailyBudgetKWh: 30, priceShapingEnabled: false });

    expect(preview.candidate.todayKey).toBe('2025-03-15');
    expect(preview.candidate.tomorrowKey).toBe('2025-03-16');
    expect(preview.candidate.days['2025-03-15']?.budget.dailyBudgetKWh).toBe(30);
    expect(debugStructured).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ debugTopic: 'daily_budget' }));
  });
});
