import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import {
  type BinaryControlDiscriminantProbe,
  type PlanInputDevice,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { resolveFixtureCurrentOn } from '../utils/planTestUtils';

const emptyPendingStore = createPendingBinaryCommandStore({});

// `binaryControl` moved off the `PlanInputDevice` base onto the binary cluster.
// Route a loose fixture (with `binaryCapabilityId` so the device stays binary)
// through the discriminant regrouper to reattach it.
const buildInputDevice = (
  loose: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & {
    id: string;
    name: string;
    targets: PlanInputDevice['targets'];
  },
): PlanInputDevice => {
  const merged = {
    binaryCapabilityId: 'onoff' as const,
    binaryControl: { on: true },
    ...loose,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentOn: resolveFixtureCurrentOn(merged),
  }) as PlanInputDevice;
};

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
        plannedUncontrolledKWh: [0, 0],
        plannedControlledKWh: [params.plannedKWh, 0.5],
        actualKWh: [3, 0],
        actualControlledKWh: [3, 0],
        actualUncontrolledKWh: [0, 0],
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
    let lastPowerW = (3) * 1000;
    const nowIso = new Date().toISOString();
    const currentHourIso = '2026-03-11T10:00:00.000Z';
    const nextHourIso = '2026-03-11T11:00:00.000Z';
    const todayKey = '2026-03-11';
    let dynamicSoftLimitKw = 10;
    let dailyBudgetSnapshot: DailyBudgetUiPayload | null = buildDailyBudgetSnapshot({
      nowIso,
      currentHourIso,
      nextHourIso,
      todayKey,
      plannedKWh: 1.5,
    });
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

    const devices: PlanInputDevice[] = [
      buildInputDevice({
        id: 'budget-exempt',
        name: 'Budget Exempt Heater',
        targets: [],
        binaryControl: { on: true },
        controllable: true,
        budgetExempt: true,
        currentDrawKw: 2,
      }),
      buildInputDevice({
        id: 'regular',
        name: 'Regular Heater',
        targets: [],
        binaryControl: { on: true },
        controllable: true,
        currentDrawKw: 1,
      }),
    ];

    const builder = new PlanBuilder({
      capacityGuard: capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({
        buckets: {
          [currentHourIso]: 3,
        },
        exemptBuckets: {
          [currentHourIso]: 2,
        },
        lastTimestamp: Date.now(),
        lastPowerW,
      }),
      getDailyBudgetSnapshot: () => dailyBudgetSnapshot,
      getPriorityForDevice: (deviceId: string) => (deviceId === 'budget-exempt' ? 100 : 10),
      getShedBehavior: () => ({ action: 'turn_off' }),
      getDynamicSoftLimitOverride: () => dynamicSoftLimitKw,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, createPlanEngineState());

    let plan = await builder.buildDevicePlanSnapshot(devices);

    expect(plan.meta.softLimitSource).toBe('daily');
    expect(plan.meta.budgetPaceKw).toBeCloseTo(1, 6);
    expect(plan.meta.projectedExemptKw).toBeCloseTo(2, 6);
    expect(plan.meta.dailySoftLimitKw).toBeCloseTo(3, 6);
    expect(plan.meta.dailySoftLimitKw).toBeCloseTo(
      (plan.meta.budgetPaceKw ?? 0) + (plan.meta.projectedExemptKw ?? 0),
      6,
    );
    expect(plan.meta.headroomKw).toBeCloseTo(0, 6);
    expect(plan.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'budget-exempt', plannedState: 'keep' }),
      expect.objectContaining({ id: 'regular', plannedState: 'keep' }),
    ]));

    dynamicSoftLimitKw = 2.5;
    lastPowerW = (2.5) * 1000;
    plan = await builder.buildDevicePlanSnapshot(devices);

    expect(plan.meta.softLimitSource).toBe('capacity');
    expect(plan.meta.softLimitKw).toBeCloseTo(2.5, 6);
    expect(plan.meta.budgetPaceKw).toBeCloseTo(1, 6);
    expect(plan.meta.projectedExemptKw).toBeCloseTo(2, 6);
    expect(plan.meta.dailySoftLimitKw).toBeCloseTo(3, 6);

    dynamicSoftLimitKw = 10;
    dailyBudgetSnapshot = null;
    plan = await builder.buildDevicePlanSnapshot(devices);

    expect(plan.meta.softLimitSource).toBe('capacity');
    expect(plan.meta.dailySoftLimitKw).toBeNull();
    expect(plan.meta.budgetPaceKw).toBeNull();
    expect(plan.meta.projectedExemptKw).toBeNull();
  });

  it('uses the producer-resolved gross uncontrolled bucket for plan meta hourly other energy', async () => {
    const lastPowerW = (2.5) * 1000;
    const currentHourIso = '2026-03-11T10:00:00.000Z';
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

    const builder = new PlanBuilder({
      capacityGuard: capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({
        buckets: {
          [currentHourIso]: 1.8,
        },
        controlledBuckets: {
          [currentHourIso]: 0.6,
        },
        uncontrolledBuckets: {
          [currentHourIso]: 0.15,
        },
        lastTimestamp: Date.now(),
        lastPowerW,
      }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off' }),
      getDynamicSoftLimitOverride: () => 10,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, createPlanEngineState());

    const plan = await builder.buildDevicePlanSnapshot([]);

    // Gross attribution: managed (0.6) + background (0.15) come straight from the buckets,
    // not re-derived from the net total (usedKWh stays the net 1.8 for pacing).
    expect(plan.meta.hourControlledKWh).toBeCloseTo(0.6, 6);
    expect(plan.meta.hourUncontrolledKWh).toBeCloseTo(0.15, 6);
    expect(plan.meta.usedKWh).toBeCloseTo(1.8, 6);
    expect(plan.meta.budgetPaceKw).toBeNull();
    expect(plan.meta.projectedExemptKw).toBeNull();
  });

  it('uses the planning hour bucket for plan meta hourly energy split', async () => {
    const lastPowerW = (2.5) * 1000;
    const currentHourIso = '2026-03-11T10:00:00.000Z';
    const lastSampleHourIso = '2026-03-11T09:00:00.000Z';
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

    const builder = new PlanBuilder({
      capacityGuard: capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0.2 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({
        buckets: {
          [lastSampleHourIso]: 9,
          [currentHourIso]: 1.8,
        },
        controlledBuckets: {
          [lastSampleHourIso]: 8,
          [currentHourIso]: 0.6,
        },
        lastTimestamp: new Date(lastSampleHourIso).getTime(),
        lastPowerW,
      }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off' }),
      getDynamicSoftLimitOverride: () => 10,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, createPlanEngineState());

    const plan = await builder.buildDevicePlanSnapshot([]);

    expect(plan.meta.usedKWh).toBeCloseTo(1.8, 6);
    expect(plan.meta.hourControlledKWh).toBeCloseTo(0.6, 6);
    expect(plan.meta.hourUncontrolledKWh).toBeCloseTo(1.2, 6);
  });
});
