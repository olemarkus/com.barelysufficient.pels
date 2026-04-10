import CapacityGuard from '../lib/core/capacityGuard';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { createPlanEngineState } from '../lib/plan/planState';
import type { DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const buildDailyBudgetSnapshot = (params: {
  nowIso: string;
  currentHourIso: string;
  nextHourIso: string;
  todayKey: string;
  plannedKWh: number;
}): DailyBudgetUiPayload => ({
  todayKey: params.todayKey,
  days: {
    [params.todayKey]: {
      dateKey: params.todayKey,
      timeZone: 'UTC',
      nowUtc: params.nowIso,
      dayStartUtc: `${params.todayKey}T00:00:00.000Z`,
      currentBucketIndex: 0,
      budget: {
        enabled: true,
        dailyBudgetKWh: 6,
        priceShapingEnabled: false,
      },
      state: {
        usedNowKWh: 3,
        allowedNowKWh: 1,
        remainingKWh: 3,
        deviationKWh: 2,
        exceeded: true,
        frozen: false,
        confidence: 1,
        priceShapingActive: false,
      },
      buckets: {
        startUtc: [params.currentHourIso, params.nextHourIso],
        startLocalLabels: ['10', '11'],
        plannedWeight: [0.5, 0.5],
        plannedKWh: [params.plannedKWh, 0.5],
        actualKWh: [3, 0],
        allowedCumKWh: [params.plannedKWh, params.plannedKWh + 0.5],
      },
    },
  },
});

describe('PlanBuilder budget exemption handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T10:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not shed other devices only because exempt load keeps the daily budget over plan', async () => {
    const nowIso = new Date().toISOString();
    const currentHourIso = '2026-03-11T10:00:00.000Z';
    const nextHourIso = '2026-03-11T11:00:00.000Z';
    const todayKey = '2026-03-11';
    const capacityGuard = new CapacityGuard({ limitKw: 10, softMarginKw: 0.2 });
    capacityGuard.reportTotalPower(3);

    const devices: PlanInputDevice[] = [
      {
        id: 'budget-exempt',
        name: 'Budget Exempt Heater',
        targets: [],
        currentOn: true,
        controllable: true,
        budgetExempt: true,
        measuredPowerKw: 2,
      },
      {
        id: 'regular',
        name: 'Regular Heater',
        targets: [],
        currentOn: true,
        controllable: true,
        measuredPowerKw: 1,
      },
    ];

    const builder = new PlanBuilder({
      homey: {
        settings: {
          set: vi.fn(),
        },
      } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({
        buckets: {
          [currentHourIso]: 3,
        },
        exemptBuckets: {
          [currentHourIso]: 2,
        },
        lastTimestamp: Date.now(),
      }),
      getDailyBudgetSnapshot: () => buildDailyBudgetSnapshot({
        nowIso,
        currentHourIso,
        nextHourIso,
        todayKey,
        plannedKWh: 1.5,
      }),
      getPriorityForDevice: (deviceId: string) => (deviceId === 'budget-exempt' ? 100 : 10),
      getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
      getDynamicSoftLimitOverride: () => 10,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, createPlanEngineState());

    const plan = await builder.buildDevicePlanSnapshot(devices);

    expect(plan.meta.softLimitSource).toBe('daily');
    expect(plan.meta.dailySoftLimitKw).toBeCloseTo(3, 6);
    expect(plan.meta.headroomKw).toBeCloseTo(0, 6);
    expect(plan.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'budget-exempt', plannedState: 'keep' }),
      expect.objectContaining({ id: 'regular', plannedState: 'keep' }),
    ]));
  });
});
