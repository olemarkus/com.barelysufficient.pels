import { DeferredObjectiveDecorationController } from '../../lib/objectives/deferredObjectives';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const buildDevice = (): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  binaryControl: { on: false },
  controllable: true,
});

const buildPowerTracker = () => ({ lastTimestamp: Date.now() });

describe('DeferredObjectiveDecorationController', () => {
  it('reads deferred objective settings every decoration cycle so admission can run', () => {
    const getDeferredObjectiveSettings = vi.fn(() => ({
      version: 1,
      objectivesByDeviceId: {},
    } as const));
    const controller = new DeferredObjectiveDecorationController({
      getDeferredObjectiveSettings,
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      getHardCapKw: () => 10,
    });

    controller.decorate({ devices: [buildDevice()], dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(getDeferredObjectiveSettings).toHaveBeenCalledTimes(1);
  });

  it('returns the identity bundle (devices untouched) when no settings provider is configured', () => {
    const controller = new DeferredObjectiveDecorationController({
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      getHardCapKw: () => 10,
    });
    const devices = [buildDevice()];

    const bundle = controller.decorate({ devices, dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(bundle.admittedDevices).toHaveLength(1);
    expect(bundle.forceShedSet.size).toBe(0);
    expect(bundle.deferredAvoidDeviceIds.size).toBe(0);
    expect(bundle.deferredReleaseIntentByDeviceId).toEqual({});
  });
});
