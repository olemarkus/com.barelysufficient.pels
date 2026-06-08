import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import type { ConfidenceDebug, DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { DEBUG_LOGGING_TOPICS } from '../../lib/utils/settingsKeys';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { createDailyBudgetSettingsStore } from '../../setup/dailyBudgetSettingsAdapter';

const TZ = 'Europe/Oslo';

// Inert store for service tests that never read/write config (they exercise
// plan recompute / state persistence). Reads from a throwaway null homey →
// canonical defaults; never invoked by those tests.
const nullSettingsStore = createDailyBudgetSettingsStore(
  { settings: { get: () => null, set: () => undefined } } as any,
);
const NOW_MS = new Date('2025-03-15T12:00:00Z').getTime();

function buildConfidenceDebug(overrides: Partial<ConfidenceDebug> = {}): ConfidenceDebug {
  return {
    confidenceRegularity: 0.8,
    confidenceAdaptability: 0.4,
    confidenceAdaptabilityInfluence: 0.3,
    confidenceWeightedControlledShare: 0.25,
    confidenceValidActualDays: 12,
    confidenceValidPlannedDays: 4,
    confidenceBootstrapLow: 0.45,
    confidenceBootstrapHigh: 0.75,
    profileBlendConfidence: 0.6,
    ...overrides,
  };
}

function buildDayPayload(params: {
  dateKey: string;
  confidence: number;
  confidenceDebug?: ConfidenceDebug;
}): DailyBudgetDayPayload {
  const { dateKey, confidence, confidenceDebug } = params;
  return {
    dateKey,
    timeZone: TZ,
    nowUtc: new Date(NOW_MS).toISOString(),
    dayStartUtc: new Date('2025-03-15T00:00:00Z').toISOString(),
    currentBucketIndex: 0,
    budget: {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: true,
    },
    state: {
      usedNowKWh: 1,
      allowedNowKWh: 1.2,
      remainingKWh: 9,
      deviationKWh: -0.2,
      exceeded: false,
      frozen: false,
      confidence,
      priceShapingActive: true,
      confidenceDebug,
    },
    buckets: {
      startUtc: [new Date('2025-03-15T00:00:00Z').toISOString()],
      startLocalLabels: ['01'],
      plannedWeight: [1],
      plannedKWh: [10],
      actualKWh: [1],
      allowedCumKWh: [10],
      price: [0.5],
      priceFactor: [1],
    },
  };
}

function buildService(): DailyBudgetService {
  const homey = {
    settings: {
      get: vi.fn(() => null),
      set: vi.fn(),
    },
    clock: {
      getTimezone: () => TZ,
    },
  } as any;
  return new DailyBudgetService({
    homey,
    log: () => undefined,
    getPowerTracker: () => ({ buckets: {} }),
    getPriceOptimizationEnabled: () => false,
    getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }), combinedPricesReader: { readStore: () => null },
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(homey),
  });
}

const dailyBudgetStateSetCount = (set: ReturnType<typeof vi.fn>): number => (
  set.mock.calls.filter(([key]) => key === 'daily_budget_state').length
);

const perfCount = (key: string): number => getPerfSnapshot().counts[key] ?? 0;

describe('DailyBudgetService', () => {
  it('applies the same overall confidence to adjacent day payloads', () => {
    const service = buildService();
    const todayDebug = buildConfidenceDebug();
    const today = buildDayPayload({
      dateKey: '2025-03-15',
      confidence: 0.72,
      confidenceDebug: todayDebug,
    });
    const tomorrow = buildDayPayload({
      dateKey: '2025-03-16',
      confidence: 0.15,
      confidenceDebug: buildConfidenceDebug({ profileBlendConfidence: 0.15 }),
    });
    const yesterday = buildDayPayload({
      dateKey: '2025-03-14',
      confidence: 0.2,
      confidenceDebug: buildConfidenceDebug({ profileBlendConfidence: 0.2 }),
    });

    (service as any).buildTomorrowPreview = vi.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => yesterday);

    (service as any).setDaySnapshot(today, NOW_MS, null, true);

    const snapshot = service.getSnapshot();
    expect(snapshot?.days['2025-03-15']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-16']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-16']?.state.confidenceDebug).toEqual(todayDebug);
    expect(snapshot?.days['2025-03-14']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-14']?.state.confidenceDebug).toEqual(todayDebug);
  });

  it('preserves cached tomorrow and yesterday across hot-path snapshot updates', () => {
    const service = buildService();
    const today = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.72 });
    const tomorrow = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.15 });
    const yesterday = buildDayPayload({ dateKey: '2025-03-14', confidence: 0.2 });

    (service as any).buildTomorrowPreview = vi.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => yesterday);

    (service as any).setDaySnapshot(today, NOW_MS, null, true);
    const cachedTomorrow = service.getSnapshot()?.days['2025-03-16'];
    const cachedYesterday = service.getSnapshot()?.days['2025-03-14'];
    expect(service.getSnapshot()?.tomorrowKey).toBe('2025-03-16');
    expect(service.getSnapshot()?.yesterdayKey).toBe('2025-03-14');

    (service as any).buildTomorrowPreview = vi.fn(() => {
      throw new Error('buildTomorrowPreview should not run on hot-path updates');
    });
    (service as any).buildYesterdayHistory = vi.fn(() => {
      throw new Error('buildYesterdayHistory should not run on hot-path updates');
    });

    const refreshedToday = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.65 });
    (service as any).setDaySnapshot(refreshedToday, NOW_MS, null);

    const snapshot = service.getSnapshot();
    expect(snapshot?.todayKey).toBe('2025-03-15');
    expect(snapshot?.days['2025-03-15']?.state.confidence).toBe(0.65);
    expect(snapshot?.tomorrowKey).toBe('2025-03-16');
    expect(snapshot?.days['2025-03-16']).toBe(cachedTomorrow);
    expect(snapshot?.yesterdayKey).toBe('2025-03-14');
    expect(snapshot?.days['2025-03-14']).toBe(cachedYesterday);
  });

  it('re-seeds adjacent days when the day rolls over on a hot-path update', () => {
    const service = buildService();
    const today = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.72 });
    const tomorrow = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.15 });
    const yesterday = buildDayPayload({ dateKey: '2025-03-14', confidence: 0.2 });

    (service as any).buildTomorrowPreview = vi.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => yesterday);

    (service as any).setDaySnapshot(today, NOW_MS, null, true);

    const newToday = buildDayPayload({ dateKey: '2025-03-17', confidence: 0.5 });
    const newTomorrow = buildDayPayload({ dateKey: '2025-03-18', confidence: 0.5 });
    const newYesterday = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.5 });
    (service as any).buildTomorrowPreview = vi.fn(() => newTomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => newYesterday);
    (service as any).setDaySnapshot(newToday, NOW_MS, null);

    const snapshot = service.getSnapshot();
    expect(snapshot?.todayKey).toBe('2025-03-17');
    expect(snapshot?.tomorrowKey).toBe('2025-03-18');
    expect(snapshot?.yesterdayKey).toBe('2025-03-16');
    expect(Object.keys(snapshot?.days ?? {}).sort()).toEqual([
      '2025-03-16',
      '2025-03-17',
      '2025-03-18',
    ]);
  });

  it('seeds tomorrow on a hot-path update once tomorrow prices become available', () => {
    const service = buildService();
    const today = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.72 });

    let combinedPrices: { prices: { startsAt: string; total: number }[]; lastFetched: string } | null = {
      prices: [{ startsAt: '2025-03-15T00:00:00Z', total: 1 }],
      lastFetched: '2025-03-15T10:00:00Z',
    };

    // First hot-path update: tomorrow prices not yet available.
    const noTomorrowBuilder = vi.fn(() => null);
    (service as any).buildTomorrowPreview = noTomorrowBuilder;
    (service as any).buildYesterdayHistory = vi.fn(() => null);
    (service as any).setDaySnapshot(today, NOW_MS, combinedPrices);
    expect(service.getSnapshot()?.tomorrowKey).toBe(null);
    expect(noTomorrowBuilder).toHaveBeenCalledTimes(1);

    // Subsequent hot-path updates with the same prices: no rebuild attempt.
    (service as any).setDaySnapshot(today, NOW_MS, combinedPrices);
    (service as any).setDaySnapshot(today, NOW_MS, combinedPrices);
    expect(noTomorrowBuilder).toHaveBeenCalledTimes(1);

    // Tomorrow prices arrive: a new entry appears.
    const tomorrow = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.3 });
    combinedPrices = {
      prices: [
        { startsAt: '2025-03-15T00:00:00Z', total: 1 },
        { startsAt: '2025-03-16T00:00:00Z', total: 1 },
      ],
      lastFetched: '2025-03-15T13:00:00Z',
    };
    const tomorrowBuilder = vi.fn(() => tomorrow);
    (service as any).buildTomorrowPreview = tomorrowBuilder;

    (service as any).setDaySnapshot(today, NOW_MS, combinedPrices);
    expect(tomorrowBuilder).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot()?.tomorrowKey).toBe('2025-03-16');
    expect(service.getSnapshot()?.days['2025-03-16']).toBeDefined();

    // Once seeded, further hot-path updates do not re-attempt the rebuild.
    (service as any).setDaySnapshot(today, NOW_MS, combinedPrices);
    expect(tomorrowBuilder).toHaveBeenCalledTimes(1);
  });

  it('does not re-seed adjacent days when only combined_prices.lastFetched changes', () => {
    // PriceService.updateCombinedPrices may bump `lastFetched` on a no-op
    // refresh. Such ticks must not trigger the expensive adjacent-day rebuild.
    const service = buildService();
    const today = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.72 });
    const tomorrow = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.3 });
    const prices = {
      prices: [
        { startsAt: '2025-03-15T00:00:00Z', total: 1 },
        { startsAt: '2025-03-16T00:00:00Z', total: 1 },
      ],
      lastFetched: '2025-03-15T13:00:00Z',
    };
    (service as any).buildTomorrowPreview = vi.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => null);
    (service as any).setDaySnapshot(today, NOW_MS, prices);
    expect(service.getSnapshot()?.tomorrowKey).toBe('2025-03-16');

    const builderSpy = vi.spyOn(service as any, 'rebuildSnapshotWithAdjacentDays');
    for (const lastFetched of [
      '2026-01-01T00:00:00Z',
      '2026-01-01T01:00:00Z',
      '2026-01-01T02:00:00Z',
    ]) {
      (service as any).setDaySnapshot(today, NOW_MS, { ...prices, lastFetched });
    }
    expect(builderSpy).not.toHaveBeenCalled();
  });

  it('refreshes confidence explicitly when fetching the UI payload', () => {
    const service = buildService();
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));
    (service as any).deps.homey.settings.get = vi.fn((key: string) => (
      key === 'debug_logging_enabled' ? true : null
    ));
    (service as any).manager.update = updateSpy;

    service.getUiPayload();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      refreshConfidence: true,
      includeConfidenceBootstrapDebug: true,
    }));
  });

  it('does not enable confidence bootstrap debug for unrelated topic filters', () => {
    const service = buildService();
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));
    (service as any).deps.homey.settings.get = vi.fn((key: string) => (
      key === DEBUG_LOGGING_TOPICS ? ['plan'] : null
    ));
    (service as any).manager.update = updateSpy;

    service.getUiPayload();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      refreshConfidence: true,
      includeConfidenceBootstrapDebug: false,
    }));
  });

  it('enables confidence bootstrap debug for legacy object-form daily_budget topic settings', () => {
    const service = buildService();
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));
    (service as any).deps.homey.settings.get = vi.fn((key: string) => (
      key === DEBUG_LOGGING_TOPICS ? { plan: true, daily_budget: true } : null
    ));
    (service as any).manager.update = updateSpy;

    service.getUiPayload();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      refreshConfidence: true,
      includeConfidenceBootstrapDebug: true,
    }));
  });

  it('normalizes legacy persisted tuning values to dropdown modes on load', () => {
    const service = buildService();
    (service as any).deps.homey.settings.get = vi.fn((key: string) => {
      if (key === 'daily_budget_enabled') return true;
      if (key === 'daily_budget_kwh') return 24;
      if (key === 'daily_budget_price_shaping_enabled') return true;
      if (key === 'daily_budget_controlled_weight') return 0.3;
      if (key === 'daily_budget_price_flex_share') return 0.35;
      return null;
    });

    service.loadSettings();

    expect((service as any).settings).toEqual(expect.objectContaining({
      controlledUsageWeight: 0,
      priceShapingFlexShare: 0.6,
    }));
  });

  it('recomputes today plan with frozen-plan override and adjacent day payloads', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const service = buildService();
    const today = buildDayPayload({
      dateKey: '2025-03-15',
      confidence: 0.72,
      confidenceDebug: buildConfidenceDebug(),
    });
    const updateSpy = vi.fn(() => ({
      snapshot: today,
      persistReason: null,
    }));
    (service as any).manager.update = updateSpy;

    const payload = service.recomputeTodayPlan();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: NOW_MS,
      forcePlanRebuild: true,
      recomputeFrozenPlan: true,
      refreshConfidence: true,
    }));
    expect(payload?.todayKey).toBe('2025-03-15');
    vi.useRealTimers();
  });

  it('previews draft settings without persisting them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;

    const preview = service.previewModelSettings({
      enabled: true,
      dailyBudgetKWh: 24,
      priceShapingEnabled: true,
      controlledUsageWeight: 0.7,
      priceShapingFlexShare: 0.4,
    });

    expect(set).not.toHaveBeenCalled();
    expect(preview.settings.dailyBudgetKWh).toBe(24);
    expect(preview.candidate?.todayKey).toBe('2025-03-15');
    expect(preview.candidate?.tomorrowKey).toBe('2025-03-16');
    vi.useRealTimers();
  });

  it('applies draft settings before recomputing the active plan', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;

    const payload = service.applyModelSettings({
      enabled: true,
      dailyBudgetKWh: 24,
      priceShapingEnabled: false,
      controlledUsageWeight: 0.7,
      priceShapingFlexShare: 0.4,
    });

    expect(set).toHaveBeenCalledWith('daily_budget_enabled', true);
    expect(set).toHaveBeenCalledWith('daily_budget_kwh', 24);
    expect(set).toHaveBeenCalledWith('daily_budget_price_shaping_enabled', false);
    expect(set).toHaveBeenCalledWith('daily_budget_controlled_weight', 0.7);
    expect(set).toHaveBeenCalledWith('daily_budget_price_flex_share', 0.4);
    expect(payload?.days[payload.todayKey]?.budget.dailyBudgetKWh).toBe(24);
    vi.useRealTimers();
  });

  it('logs daily budget update failures as a structured event', () => {
    const error = vi.fn();
    const service = new DailyBudgetService({
      homey: {
        settings: {
          get: vi.fn(() => null),
          set: vi.fn(),
        },
        clock: {
          getTimezone: () => TZ,
        },
      } as any,
      log: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }), combinedPricesReader: { readStore: () => null }, dailyBudgetSettingsStore: nullSettingsStore,
      structuredLog: { error } as any,
    });
    (service as any).manager.update = vi.fn(() => {
      throw 'boom';
    });

    service.updateState();

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'daily_budget_state_update_failed',
      err: expect.objectContaining({ message: 'boom' }),
    }));
  });

  it('does not emit budget_recomputed when refreshing for periodic status only', () => {
    const info = vi.fn();
    const service = new DailyBudgetService({
      homey: {
        settings: {
          get: vi.fn(() => null),
          set: vi.fn(),
        },
        clock: {
          getTimezone: () => TZ,
        },
      } as any,
      log: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }), combinedPricesReader: { readStore: () => null }, dailyBudgetSettingsStore: nullSettingsStore,
      structuredLog: { info } as any,
    });
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));

    const fields = service.getPeriodicStatusFields();
    const result = service.getPeriodicStatusLog();

    expect(fields).toEqual(expect.objectContaining({
      event: 'daily_budget_periodic_status',
      originalBudgetKWh: expect.any(Number),
      currentBudgetKWh: expect.any(Number),
      actualKWh: expect.any(Number),
      budgetedKWh: expect.any(Number),
      remainingOriginalKWh: expect.any(Number),
      remainingCurrentKWh: expect.any(Number),
      exceeded: false,
    }));
    expect(result).toContain('Daily budget:');
    expect(info).not.toHaveBeenCalled();
  });

  it('emits budget_recomputed during normal updates', () => {
    const info = vi.fn();
    const service = new DailyBudgetService({
      homey: {
        settings: {
          get: vi.fn(() => null),
          set: vi.fn(),
        },
        clock: {
          getTimezone: () => TZ,
        },
      } as any,
      log: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }), combinedPricesReader: { readStore: () => null }, dailyBudgetSettingsStore: nullSettingsStore,
      structuredLog: { info } as any,
    });
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));

    service.updateState();

    expect(info).toHaveBeenCalledWith({
      event: 'budget_recomputed',
      newBudgetKWh: 10,
      actualKWh: 1,
      remainingNewKWh: 9,
      exceeded: false,
    });
  });

  it('does not emit budget_recomputed repeatedly for unchanged steady-state updates', () => {
    const info = vi.fn();
    const service = new DailyBudgetService({
      homey: {
        settings: {
          get: vi.fn(() => null),
          set: vi.fn(),
        },
        clock: {
          getTimezone: () => TZ,
        },
      } as any,
      log: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }), combinedPricesReader: { readStore: () => null }, dailyBudgetSettingsStore: nullSettingsStore,
      structuredLog: { info } as any,
    });
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));

    service.updateState();
    service.updateState();

    expect(info).toHaveBeenCalledTimes(1);
  });

  it('emits budget_recomputed when exceeded state changes', () => {
    const info = vi.fn();
    const service = new DailyBudgetService({
      homey: {
        settings: {
          get: vi.fn(() => null),
          set: vi.fn(),
        },
        clock: {
          getTimezone: () => TZ,
        },
      } as any,
      log: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }), combinedPricesReader: { readStore: () => null }, dailyBudgetSettingsStore: nullSettingsStore,
      structuredLog: { info } as any,
    });
    const snapshots = [
      buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      {
        ...buildDayPayload({
          dateKey: '2025-03-15',
          confidence: 0.72,
          confidenceDebug: buildConfidenceDebug(),
        }),
        state: {
          ...buildDayPayload({
            dateKey: '2025-03-15',
            confidence: 0.72,
            confidenceDebug: buildConfidenceDebug(),
          }).state,
          exceeded: true,
        },
      },
    ];
    (service as any).manager.update = vi
      .fn()
      .mockReturnValueOnce({ snapshot: snapshots[0], persistReason: null })
      .mockReturnValueOnce({ snapshot: snapshots[1], persistReason: null });

    service.updateState();
    service.updateState();

    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'budget_recomputed',
      exceeded: true,
    }));
  });

  it('uses usable hourly capacity when updating daily budget plans', () => {
    const service = new DailyBudgetService({
      homey: {
        settings: {
          get: vi.fn(() => null),
          set: vi.fn(),
        },
        clock: {
          getTimezone: () => TZ,
        },
      } as any,
      log: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 1 }),
      combinedPricesReader: { readStore: () => null }, dailyBudgetSettingsStore: nullSettingsStore,
    });
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: null,
    }));
    (service as any).manager.update = updateSpy;

    service.updateState();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      capacityBudgetKWh: 4,
    }));
  });

  it('throttles low-priority daily budget state writes from frequent updates', () => {
    const skippedBefore = perfCount('settings_set.daily_budget_state_skipped_throttle_total');
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: 'runtime',
    }));
    let exportIndex = 0;
    (service as any).manager.update = updateSpy;
    (service as any).manager.exportState = vi.fn(() => ({ lastUsedNowKWh: exportIndex++ }));

    service.updateState({ nowMs: NOW_MS });
    service.updateState({ nowMs: NOW_MS + 60_000 });
    service.updateState({ nowMs: NOW_MS + 2 * 60_000 });
    service.updateState({ nowMs: NOW_MS + 10 * 60_000 });

    expect(dailyBudgetStateSetCount(set)).toBe(2);
    expect(set).toHaveBeenNthCalledWith(1, 'daily_budget_state', { lastUsedNowKWh: 0 });
    expect(set).toHaveBeenLastCalledWith('daily_budget_state', { lastUsedNowKWh: 3 });
    expect(perfCount('settings_set.daily_budget_state_skipped_throttle_total')).toBe(skippedBefore + 2);
  });

  it('skips daily budget state writes when exported state is unchanged', () => {
    const skippedBefore = perfCount('settings_set.daily_budget_state_skipped_unchanged_total');
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: 'manual',
    }));
    (service as any).manager.exportState = vi.fn(() => ({ plannedKWh: [10] }));

    service.updateState({ nowMs: NOW_MS });
    service.updateState({ nowMs: NOW_MS + 1_000 });

    expect(dailyBudgetStateSetCount(set)).toBe(1);
    expect(perfCount('settings_set.daily_budget_state_skipped_unchanged_total')).toBe(skippedBefore + 1);
  });

  it('persists manual and rollover daily budget state changes despite low-priority throttling', () => {
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    const reasons = ['runtime', 'manual', 'rollover'];
    let exportIndex = 0;
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: reasons.shift(),
    }));
    (service as any).manager.exportState = vi.fn(() => ({ revision: exportIndex++ }));

    service.updateState({ nowMs: NOW_MS });
    service.updateState({ nowMs: NOW_MS + 1_000 });
    service.updateState({ nowMs: NOW_MS + 2_000 });

    expect(dailyBudgetStateSetCount(set)).toBe(3);
    expect(set).toHaveBeenNthCalledWith(1, 'daily_budget_state', { revision: 0 });
    expect(set).toHaveBeenNthCalledWith(2, 'daily_budget_state', { revision: 1 });
    expect(set).toHaveBeenNthCalledWith(3, 'daily_budget_state', { revision: 2 });
  });

  it('throttles low-priority writes after a recent high-priority persist', () => {
    const skippedBefore = perfCount('settings_set.daily_budget_state_skipped_throttle_total');
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    const reasons = ['manual', 'runtime'];
    let exportIndex = 0;
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: reasons.shift(),
    }));
    (service as any).manager.exportState = vi.fn(() => ({ revision: exportIndex++ }));

    service.updateState({ nowMs: NOW_MS });
    service.updateState({ nowMs: NOW_MS + 1_000 });

    expect(dailyBudgetStateSetCount(set)).toBe(1);
    expect(perfCount('settings_set.daily_budget_state_skipped_throttle_total')).toBe(skippedBefore + 1);
  });

  it('persists reset learning immediately with a reset reason counter', () => {
    const reasonBefore = perfCount('settings_set.daily_budget_state_reason.reset_total');
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;

    service.resetLearning();

    expect(dailyBudgetStateSetCount(set)).toBe(1);
    expect(perfCount('settings_set.daily_budget_state_reason.reset_total')).toBe(reasonBefore + 1);
  });

  it('persistState flushes a throttled low-priority write on shutdown', () => {
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    let exportIndex = 0;
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: 'runtime',
    }));
    (service as any).manager.exportState = vi.fn(() => ({ lastUsedNowKWh: exportIndex++ }));

    service.updateState({ nowMs: NOW_MS });
    service.updateState({ nowMs: NOW_MS + 60_000 });
    expect(dailyBudgetStateSetCount(set)).toBe(1);

    service.persistState('runtime', NOW_MS + 60_000);

    expect(dailyBudgetStateSetCount(set)).toBe(2);
    expect(set).toHaveBeenLastCalledWith('daily_budget_state', { lastUsedNowKWh: 2 });
  });

  it('persistState is a no-op when the exported state matches the last persisted write', () => {
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: 'manual',
    }));
    (service as any).manager.exportState = vi.fn(() => ({ plannedKWh: [10] }));

    service.updateState({ nowMs: NOW_MS });
    expect(dailyBudgetStateSetCount(set)).toBe(1);
    const skippedBefore = perfCount('settings_set.daily_budget_state_skipped_unchanged_total');

    service.persistState('runtime', NOW_MS + 1_000);

    expect(dailyBudgetStateSetCount(set)).toBe(1);
    expect(perfCount('settings_set.daily_budget_state_skipped_unchanged_total')).toBe(skippedBefore + 1);
  });

  it('does not carry reset persistence reason into the next update', () => {
    const reasonBefore = perfCount('settings_set.daily_budget_state_reason.reset_total');
    const service = buildService();

    service.resetLearning();
    service.updateState({ nowMs: NOW_MS });

    expect(perfCount('settings_set.daily_budget_state_reason.reset_total')).toBe(reasonBefore + 1);
  });

  it('re-seeds adjacent days when only price tier flags flip on existing entries', () => {
    // A price-threshold or surcharge change can rebuild combined_prices with the
    // same horizon (entry count and bounds unchanged) but flip per-entry
    // isCheap/isExpensive flags. Without folding those flags into the
    // signature, the cached tomorrow keeps stale price-tier metadata until the
    // next includeAdjacentDays caller forces a rebuild.
    const service = buildService();
    const today = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.72 });
    const tomorrow = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.3 });
    const baseEntries = [
      { startsAt: '2025-03-15T00:00:00Z', total: 1, isCheap: false, isExpensive: false },
      { startsAt: '2025-03-16T00:00:00Z', total: 1, isCheap: false, isExpensive: false },
    ];
    (service as any).buildTomorrowPreview = vi.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => null);
    (service as any).setDaySnapshot(today, NOW_MS, { prices: baseEntries });
    expect(service.getSnapshot()?.tomorrowKey).toBe('2025-03-16');

    const builderSpy = vi.spyOn(service as any, 'rebuildSnapshotWithAdjacentDays');
    // Same entry count, same first/last startsAt — only the price-tier flags differ.
    const flippedEntries = [
      { startsAt: '2025-03-15T00:00:00Z', total: 1, isCheap: true, isExpensive: false },
      { startsAt: '2025-03-16T00:00:00Z', total: 1, isCheap: false, isExpensive: true },
    ];
    (service as any).setDaySnapshot(today, NOW_MS, { prices: flippedEntries });
    expect(builderSpy).toHaveBeenCalledTimes(1);
  });

  it('re-seeds adjacent days when only per-entry totals change on existing entries', () => {
    // A surcharge/tariff/raw-price refresh can rebuild combined_prices with the
    // same horizon (entry count and bounds unchanged) and the same tier flags
    // but shifted per-entry `total` values. Those totals drive `buckets.price`,
    // `priceFactor`, and planned allocation in the rebuilt tomorrow/yesterday
    // snapshots, so the cached preview must be re-seeded when they move.
    const service = buildService();
    const today = buildDayPayload({ dateKey: '2025-03-15', confidence: 0.72 });
    const tomorrow = buildDayPayload({ dateKey: '2025-03-16', confidence: 0.3 });
    const baseEntries = [
      { startsAt: '2025-03-15T00:00:00Z', total: 1, isCheap: false, isExpensive: false },
      { startsAt: '2025-03-16T00:00:00Z', total: 1, isCheap: false, isExpensive: false },
    ];
    (service as any).buildTomorrowPreview = vi.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = vi.fn(() => null);
    (service as any).setDaySnapshot(today, NOW_MS, { prices: baseEntries });
    expect(service.getSnapshot()?.tomorrowKey).toBe('2025-03-16');

    const builderSpy = vi.spyOn(service as any, 'rebuildSnapshotWithAdjacentDays');
    // Same horizon and tier flags — only the totals differ (e.g., surcharge bump).
    const shiftedTotals = [
      { startsAt: '2025-03-15T00:00:00Z', total: 1.25, isCheap: false, isExpensive: false },
      { startsAt: '2025-03-16T00:00:00Z', total: 1.25, isCheap: false, isExpensive: false },
    ];
    (service as any).setDaySnapshot(today, NOW_MS, { prices: shiftedTotals });
    expect(builderSpy).toHaveBeenCalledTimes(1);
  });

  it('forces a daily-budget state flush across an hour boundary even with low-priority reasons', () => {
    // Without an hour-boundary bypass, `runtime`/`plan` writes are throttled
    // for 10 minutes. On a crash inside that window, the in-memory
    // lastUsedNowKWh increment since the last persist is lost. Hour-boundary
    // forcing caps that loss at the most recent hour bucket of accumulation,
    // which matches how the daily budget reconstructs (in hour buckets).
    const service = buildService();
    const set = (service as any).deps.homey.settings.set as ReturnType<typeof vi.fn>;
    let exportIndex = 0;
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      persistReason: 'runtime',
    }));
    (service as any).manager.exportState = vi.fn(() => ({ lastUsedNowKWh: exportIndex++ }));

    // First persist happens at 10:55. Subsequent samples land within the 10-min
    // throttle window but cross the 11:00 hour boundary.
    const firstPersistMs = new Date('2025-03-15T10:55:00Z').getTime();
    service.updateState({ nowMs: firstPersistMs }); // first persist
    service.updateState({ nowMs: firstPersistMs + 1 * 60_000 }); // 10:56, throttled
    service.updateState({ nowMs: firstPersistMs + 6 * 60_000 }); // 11:01, hour boundary -> persist
    service.updateState({ nowMs: firstPersistMs + 8 * 60_000 }); // 11:03, throttled (same new hour)

    expect(dailyBudgetStateSetCount(set)).toBe(2);
    expect(set).toHaveBeenLastCalledWith('daily_budget_state', { lastUsedNowKWh: 2 });
  });
});
