import { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import type { ConfidenceDebug, DailyBudgetDayPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import { DEBUG_LOGGING_TOPICS } from '../lib/utils/settingsKeys';

const TZ = 'Europe/Oslo';
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
  return new DailyBudgetService({
    homey: {
      settings: {
        get: vi.fn(() => null),
        set: vi.fn(),
      },
      clock: {
        getTimezone: () => TZ,
      },
    } as any,
    log: () => undefined,
    logDebug: () => undefined,
    error: () => undefined,
    getPowerTracker: () => ({ buckets: {} }),
    getPriceOptimizationEnabled: () => false,
    getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
  });
}

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

    (service as any).setDaySnapshot(today, NOW_MS, true);

    const snapshot = service.getSnapshot();
    expect(snapshot?.days['2025-03-15']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-16']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-16']?.state.confidenceDebug).toEqual(todayDebug);
    expect(snapshot?.days['2025-03-14']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-14']?.state.confidenceDebug).toEqual(todayDebug);
  });

  it('refreshes confidence explicitly when fetching the UI payload', () => {
    const service = buildService();
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      shouldPersist: false,
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
      shouldPersist: false,
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
      shouldPersist: false,
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
      shouldPersist: false,
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

  it('logs daily budget update failures to error', () => {
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
      logDebug: vi.fn(),
      error,
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
    });
    (service as any).manager.update = vi.fn(() => {
      throw 'boom';
    });

    service.updateState();

    expect(error).toHaveBeenCalledWith('Daily budget: failed to update state', expect.any(Error));
    expect((error.mock.calls[0]?.[1] as Error).message).toBe('boom');
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
      logDebug: vi.fn(),
      error: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
      structuredLog: { info } as any,
    });
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      shouldPersist: false,
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
      logDebug: vi.fn(),
      error: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
      structuredLog: { info } as any,
    });
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      shouldPersist: false,
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
      logDebug: vi.fn(),
      error: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
      structuredLog: { info } as any,
    });
    (service as any).manager.update = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      shouldPersist: false,
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
      logDebug: vi.fn(),
      error: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
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
      .mockReturnValueOnce({ snapshot: snapshots[0], shouldPersist: false })
      .mockReturnValueOnce({ snapshot: snapshots[1], shouldPersist: false });

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
      logDebug: vi.fn(),
      error: vi.fn(),
      getPowerTracker: () => ({ buckets: {} }),
      getPriceOptimizationEnabled: () => false,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 1 }),
    });
    const updateSpy = vi.fn(() => ({
      snapshot: buildDayPayload({
        dateKey: '2025-03-15',
        confidence: 0.72,
        confidenceDebug: buildConfidenceDebug(),
      }),
      shouldPersist: false,
    }));
    (service as any).manager.update = updateSpy;

    service.updateState();

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      capacityBudgetKWh: 4,
    }));
  });
});
