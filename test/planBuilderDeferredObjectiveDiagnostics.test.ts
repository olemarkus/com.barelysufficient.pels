import CapacityGuard from '../lib/core/capacityGuard';
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
  it('does not read deferred objective settings when no diagnostics emitter is configured', async () => {
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

    expect(getDeferredObjectiveSettings).not.toHaveBeenCalled();
  });
});
