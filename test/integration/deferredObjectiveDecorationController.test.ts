import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { noDeviceExclusion, noDeliveredEnergy, noStallEvidence } from '../helpers/deferredObjectiveWiringFixtures';
import { DeferredObjectiveDecorationController } from '../../lib/objectives/deferredObjectives';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';
import type { DeferredObjectiveSettingsV1 } from '../../packages/contracts/src/deferredObjectiveSettings';

const buildDevice = (): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({ available: true, currentDrawKw: 0,
  id: 'dev',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Device',
  commandableNow: true,
  objectiveSessionInactive: false,
  boostSupported: false,
  boostRequested: false,
  hasStandingDemand: true,
  surplusTracking: false,
  confirmedNotDrawing: false,
  isEvCharger: false,
  observeOnly: false,
  starvationSupported: false,
  deviceType: 'onoff',
  targets: [],
  binaryCapabilityId: 'onoff',
  binaryControl: { on: false },
  control: fixtureControlPosture({ controllable: true }),
})) as PlanInputDevice;

const buildPowerTracker = () => ({ lastTimestamp: Date.now() });

describe('DeferredObjectiveDecorationController', () => {
  it.each([
    { controllable: true, delayMs: 0 },
    { controllable: true, delayMs: 1 },
    { controllable: false, delayMs: 0 },
    { controllable: false, delayMs: 1 },
  ])('drops all task claims at expiry before the clock disarms it (control=$controllable, delay=$delayMs)', ({ controllable, delayMs }) => {
    const deadlineAtMs = Date.UTC(2026, 9, 2, 4);
    const settings: DeferredObjectiveSettingsV1 = {
      version: 1,
      objectivesByDeviceId: {
        dev: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6, deadlineAtMs },
      },
    };
    const device = { ...buildDevice(), controlModel: 'binary_power' as const, control: fixtureControlPosture({ controllable }) };
    const controller = new DeferredObjectiveDecorationController({
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getDeferredObjectiveSettings: () => settings,
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0, periodMinutes: 60 }),
      getDeferredObjectiveActivePlans: () => null,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    });

    const bundle = controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: deadlineAtMs + delayMs });

    expect(settings.objectivesByDeviceId.dev.enabled).toBe(true);
    expect(bundle.admittedDevices[0]).toBe(device);
    expect(bundle.forceShedSet.size).toBe(0);
    expect(bundle.deferredAvoidDeviceIds.size).toBe(0);
    expect(bundle.deferredReleaseIntentByDeviceId).toEqual({});
    expect(bundle.admittedDeviceIds.size).toBe(0);
    expect(bundle.drivingDeviceIds.size).toBe(0);
    expect(bundle.lentAuthorityDeviceIds.size).toBe(0);
  });

  it('reads deferred objective settings every decoration cycle so admission can run', () => {
    const getDeferredObjectiveSettings = vi.fn(() => ({
      version: 1,
      objectivesByDeviceId: {},
    } as const));
    const controller = new DeferredObjectiveDecorationController({
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getDeferredObjectiveSettings,
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0, periodMinutes: 60 }),
      getDeferredObjectiveActivePlans: () => null,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    });

    controller.decorate({ devices: [buildDevice()], dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(getDeferredObjectiveSettings).toHaveBeenCalledTimes(1);
  });

  it('consults the stall reader, so it allocates against the same reservation ledger as the lifecycle emitter', () => {
    // A stalled higher task reserves nothing against the tasks behind it. The
    // lifecycle emitter commits the lower tasks' schedules against that ledger;
    // if this path allocated without the reader, it would re-apply the stalled
    // task's reservations at the settle and disagree with the committed plan.
    const getStallClassification = vi.fn(() => undefined);
    const controller = new DeferredObjectiveDecorationController({
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getDeferredObjectiveSettings: () => ({
        version: 1,
        objectivesByDeviceId: {
          dev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 80,
            deadlineAtMs: Date.now() + 4 * 60 * 60 * 1000,
          },
        },
      }),
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0, periodMinutes: 60 }),
      getStallClassification,
      getDeliveredEnergyKWh: noDeliveredEnergy,
      getDeferredObjectiveActivePlans: () => null,
      resolveDeviceExclusion: noDeviceExclusion,
    });

    controller.decorate({ devices: [buildDevice()], dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(getStallClassification).toHaveBeenCalledWith('dev');
  });

  it('returns the identity bundle (devices untouched) when the settings read returns nothing', () => {
    const controller = new DeferredObjectiveDecorationController({
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0, periodMinutes: 60 }),
      getDeferredObjectiveSettings: () => undefined,
      getDeferredObjectiveActivePlans: () => null,
      getTimeZone: () => 'UTC',
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    });
    const devices = [buildDevice()];

    const bundle = controller.decorate({ devices, dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(bundle.admittedDevices).toHaveLength(1);
    expect(bundle.forceShedSet.size).toBe(0);
    expect(bundle.deferredAvoidDeviceIds.size).toBe(0);
    expect(bundle.deferredReleaseIntentByDeviceId).toEqual({});
  });
});
