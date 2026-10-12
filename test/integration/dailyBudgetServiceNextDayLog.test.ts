import type Homey from 'homey';
import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { Logger, StructuredDebugEmitter } from '../../lib/logging/logger';
import { COMBINED_PRICES_VERSION, type CombinedPricesV2 } from '../../lib/price/priceTypes';
import {
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../lib/utils/settingsKeys';
import { createDailyBudgetSettingsStore } from '../../setup/dailyBudgetSettingsAdapter';
import { partialDouble } from '../helpers/partialDouble';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

// Tomorrow's plan goes to the `daily_budget` debug topic as the `next_day`
// variant of `daily_budget_plan_debug`. It is written when tomorrow's inputs
// move (prices, settings, the learned model, the day rolling over), not on
// every rebuild of today's plan, and never for the Budget Adjust candidate.

type AppHomey = Homey.App['homey'];
type PlanDebugEntry = DailyBudgetDayPayload & {
  event: string;
  variant: string;
  meta: { settings: { dailyBudgetKWh: number } };
};

const TZ = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
// 2025-03-15 13:00 in Oslo (CET, UTC+1).
const NOW_MS = Date.UTC(2025, 2, 15, 12, 0, 0);
const TODAY_START_UTC_MS = Date.UTC(2025, 2, 14, 23, 0, 0);
const TOMORROW_START_UTC_MS = Date.UTC(2025, 2, 15, 23, 0, 0);
const TOMORROW_TOTALS = Array.from({ length: 24 }, (_, index) => 0.5 + (index % 6) * 0.3);

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

const buildHarness = () => {
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
  const debugStructured = vi.fn<StructuredDebugEmitter>();
  const service = new DailyBudgetService({
    getTimeZone: () => TZ,
    log: () => undefined,
    isDebugTopicEnabled: () => true,
    getPowerTracker: () => ({ buckets: {} }),
    getPriceOptimizationEnabled: () => true,
    getCapacitySettings: () => capacityOnlyPowerLimits(10, 2),
    combinedPricesReader: { readStore: () => prices.store },
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(homey),
    dailyBudgetStateStore: { read: () => null, write: vi.fn() },
    structuredLog: partialDouble<Logger>({ info: vi.fn() as Logger['info'], error: vi.fn() as Logger['error'] }),
    debugStructured,
  });
  service.loadSettings();
  service.loadState();
  return { service, prices, debugStructured };
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

  it('writes none for the Budget Adjust model preview', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { service, prices, debugStructured } = buildHarness();
    prices.store = buildPriceStore(true);
    service.updateState({ nowMs: NOW_MS });
    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(1);
    debugStructured.mockClear();

    const preview = service.previewModelSettings({ dailyBudgetKWh: 30, priceShapingEnabled: false });

    expect(preview.candidate.tomorrowKey).toBe('2025-03-16');
    expect(planDebugEntries(debugStructured, 'next_day')).toHaveLength(0);
  });
});
