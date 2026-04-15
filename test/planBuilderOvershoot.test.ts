import CapacityGuard from '../lib/core/capacityGuard';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  currentOn: true,
  controllable: true,
  ...overrides,
});

describe('PlanBuilder overshoot diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T11:04:01.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs controlled and reducible load when overshoot is recoverable by control', async () => {
    const state = createPlanEngineState();

    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(2.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: (deviceId: string) => (
        deviceId === 'at-temp'
          ? { action: 'set_temperature', temperature: 15, stepId: null }
          : { action: 'turn_off', temperature: null, stepId: null }
      ),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'reducible',
        name: 'Reducible',
        measuredPowerKw: 1.2,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        measuredPowerKw: 0.9,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      totalKw: 2.5,
      controlledKw: expect.closeTo(2.1, 6),
      uncontrolledKw: expect.closeTo(0.4, 6),
      controlledAtMinimumKw: expect.closeTo(0, 6),
      reducibleControlledKw: 2.1,
      eligibleAdditionalShedCount: 2,
      blockedAdditionalShedCount: 0,
      allShedCandidatesExhausted: false,
      controlRecoverable: true,
    }));
  });

  it('logs overshoot as exhausted when all shed candidates are already at minimum', async () => {
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });
    capacityGuard.reportTotalPower(4.8);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'at-temp',
        name: 'AtTemp',
        measuredPowerKw: 0.8,
        targets: [{ id: 'target_temperature', value: 15, unit: 'C' }],
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      totalKw: 4.8,
      controlledKw: 0.8,
      uncontrolledKw: 4,
      controlledAtMinimumKw: expect.closeTo(0.8, 6),
      reducibleControlledKw: 0,
      eligibleAdditionalShedCount: 0,
      blockedAdditionalShedCount: 0,
      allShedCandidatesExhausted: true,
      controlRecoverable: false,
    }));
  });

  it('does not emit a changed overshoot summary when same-sample skip keeps authority unchanged', async () => {
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(2.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: 500 }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    const devices = [
      buildDevice({
        id: 'reducible',
        name: 'Reducible',
        measuredPowerKw: 1.2,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        measuredPowerKw: 0.9,
      }),
    ];

    await builder.buildDevicePlanSnapshot(devices);
    await builder.buildDevicePlanSnapshot(devices);

    expect(structuredLog.info).toHaveBeenCalledTimes(1);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reducibleControlledKw: 2.1,
      allShedCandidatesExhausted: false,
      controlRecoverable: true,
    }));
  });
});
