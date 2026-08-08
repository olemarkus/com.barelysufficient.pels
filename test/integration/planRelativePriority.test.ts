import CapacityGuard from '../../lib/power/capacityGuard';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { buildIdentityDecorationBundle } from '../../lib/plan/planBuilderDecoration';
import { createPlanEngineState } from '../../lib/plan/planState';
import { type PlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { buildPlanInputDevice } from '../helpers/buildPlanInputDevice';

const buildDevice = (id: string, priority: number): PlanInputDevice => withBinaryDiscriminant({
  ...buildPlanInputDevice({
    id,
    controllable: true,
    currentState: 'off',
    expectedPowerKw: 1,
    priority,
  }),
  controlCapabilityId: 'onoff',
  currentOn: false,
}) as PlanInputDevice;

describe('PlanBuilder relative priority constraint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps producer-resolved ranks consistent through smart-task decoration and materialization', async () => {
    const capacityGuard = new CapacityGuard({ homeId: 'main', limitKw: 10, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0);
    const decoratedPriorities: Record<string, number | undefined> = {};
    const builder = new PlanBuilder({
      setCapacityInShortfall: vi.fn(),
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      // The live dependency is intentionally stale: every consumer in this
      // cycle must use the relative ranks snapshotted on the input devices.
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      decorateDeferredObjectives: (input) => {
        for (const device of input.devices) decoratedPriorities[device.id] = device.priority;
        return buildIdentityDecorationBundle(input.devices);
      },
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    }, createPlanEngineState());

    const plan = await builder.buildDevicePlanSnapshot([
      buildDevice('z-unconfigured', 3),
      buildDevice('configured', 1),
      buildDevice('a-unconfigured', 2),
    ]);

    expect(decoratedPriorities).toEqual({
      'z-unconfigured': 3,
      configured: 1,
      'a-unconfigured': 2,
    });
    expect(Object.fromEntries(plan.devices.map((device) => [device.id, device.priority]))).toEqual(
      decoratedPriorities,
    );
    expect(new Set(plan.devices.map((device) => device.priority)).size).toBe(plan.devices.length);
  });
});
