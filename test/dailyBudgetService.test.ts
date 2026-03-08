import { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import type { ConfidenceDebug, DailyBudgetDayPayload } from '../lib/dailyBudget/dailyBudgetTypes';

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
        get: jest.fn(() => null),
        set: jest.fn(),
      },
      clock: {
        getTimezone: () => TZ,
      },
    } as any,
    log: () => undefined,
    logDebug: () => undefined,
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

    (service as any).buildTomorrowPreview = jest.fn(() => tomorrow);
    (service as any).buildYesterdayHistory = jest.fn(() => yesterday);

    (service as any).setDaySnapshot(today, NOW_MS, true);

    const snapshot = service.getSnapshot();
    expect(snapshot?.days['2025-03-15']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-16']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-16']?.state.confidenceDebug).toEqual(todayDebug);
    expect(snapshot?.days['2025-03-14']?.state.confidence).toBe(0.72);
    expect(snapshot?.days['2025-03-14']?.state.confidenceDebug).toEqual(todayDebug);
  });
});
