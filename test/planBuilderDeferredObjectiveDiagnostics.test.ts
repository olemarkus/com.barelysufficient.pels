import CapacityGuard from '../lib/power/capacityGuard';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const buildDevice = (): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  currentOn: false,
  controllable: true,
});

describe('PlanBuilder deferred objective diagnostics', () => {
  it('reads deferred objective settings every cycle so admission can run, even without a diagnostics emitter', async () => {
    const getDeferredObjectiveSettings = vi.fn(() => ({
      version: 1,
      objectivesByDeviceId: {},
    } as const));
    const capacityGuard = new CapacityGuard({ limitKw: 10, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getDeferredObjectiveSettings,
      getTimeZone: () => 'UTC',
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
    }, createPlanEngineState());

    await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(getDeferredObjectiveSettings).toHaveBeenCalledTimes(1);
  });

  it('forwards each cycle\'s diagnostic stream to the plan-history observer', async () => {
    const observeDeferredObjectivePlanHistory = vi.fn();
    const getDeferredObjectiveSettings = vi.fn(() => ({
      version: 1,
      objectivesByDeviceId: {},
    } as const));
    const capacityGuard = new CapacityGuard({ limitKw: 10, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getDeferredObjectiveSettings,
      observeDeferredObjectivePlanHistory,
      getTimeZone: () => 'UTC',
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
    }, createPlanEngineState());

    await builder.buildDevicePlanSnapshot([buildDevice()]);

    expect(observeDeferredObjectivePlanHistory).toHaveBeenCalledTimes(1);
    const [diagnostics, nowTs] = observeDeferredObjectivePlanHistory.mock.calls[0]!;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(typeof nowTs).toBe('number');
  });

  it('skips evaluation when no settings provider is configured', async () => {
    const capacityGuard = new CapacityGuard({ limitKw: 10, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getTimeZone: () => 'UTC',
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      log: vi.fn(),
      logDebug: vi.fn(),
    }, createPlanEngineState());

    const snapshot = await builder.buildDevicePlanSnapshot([buildDevice()]);
    expect(snapshot.devices).toHaveLength(1);
  });
});
