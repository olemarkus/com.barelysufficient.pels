import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import { createEmptyActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import { noReservationSuppression } from '../helpers/deferredObjectiveWiringFixtures';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { noDeviceExclusion, noDeliveredEnergy, noStallEvidence } from '../helpers/deferredObjectiveWiringFixtures';
import { DeferredObjectiveDecorationController } from '../../lib/objectives/deferredObjectives';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';
import type { DeferredObjectiveRoster } from '../../packages/contracts/src/deferredObjectiveSettings';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

const buildDevice = (): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({ available: true, currentDrawKw: 0,
  id: 'dev',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Device',
  commandableNow: true,
  objectiveSessionInactive: false, waitingForCarAssociation: false,
  boostSupported: false,
  boostRequested: false,
  hasStandingDemand: true,
  surplusTracking: false,
  confirmedNotDrawing: false,
  isEvCharger: false,
  isBatteryOrSolar: false,
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
    const settings: DeferredObjectiveRoster = {
      objectivesByDeviceId: {
        dev: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6, deadlineAtMs },
      },
    };
    const device = { ...buildDevice(), controlModel: 'binary_power' as const, control: fixtureControlPosture({ controllable }) };
    const controller = new DeferredObjectiveDecorationController({
      getChargingPhaseEnvelopes: () => new Map(),
      allocationRoster: new TaskAllocationRoster(() => new Date()),
      hasSolarProduction: () => false,
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => capacityOnlyPowerLimits(10),
      getDeferredObjectiveActivePlans: createEmptyActivePlans,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      hasObservedTask: () => false,
      isReservationSuppressed: noReservationSuppression,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    }, () => settings, () => false);

    const bundle = controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: deadlineAtMs + delayMs });

    expect(settings.objectivesByDeviceId.dev.enabled).toBe(true);
    expect(bundle.admittedDevices[0]).toBe(device);
    expect(bundle.forceShedSet.size).toBe(0);
    expect(bundle.deferredHoldCauseByDeviceId.size).toBe(0);
    expect(bundle.deferredReleaseIntentByDeviceId).toEqual({});
    expect(bundle.admittedDeviceIds.size).toBe(0);
    expect(bundle.drivingDeviceIds.size).toBe(0);
    expect(bundle.lentAuthorityDeviceIds.size).toBe(0);
  });

  it('reads deferred objective settings every decoration cycle so admission can run', () => {
    const getDeferredObjectiveSettings = vi.fn(() => ({
      objectivesByDeviceId: {},
    } as const));
    const controller = new DeferredObjectiveDecorationController({
      getChargingPhaseEnvelopes: () => new Map(),
      allocationRoster: new TaskAllocationRoster(() => new Date()),
      hasSolarProduction: () => false,
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => capacityOnlyPowerLimits(10),
      getDeferredObjectiveActivePlans: createEmptyActivePlans,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      hasObservedTask: () => false,
      isReservationSuppressed: noReservationSuppression,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    }, getDeferredObjectiveSettings, () => false);

    controller.decorate({ devices: [buildDevice()], dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(getDeferredObjectiveSettings).toHaveBeenCalledTimes(1);
  });

  it('does not consume thermal completion evidence for a SoC task', () => {
    // A stalled higher task reserves nothing against the tasks behind it. The
    // lifecycle emitter commits the lower tasks' schedules against that ledger;
    // if this path allocated without the reader, it would re-apply the stalled
    // task's reservations at the settle and disagree with the committed plan.
    const getStallClassification = vi.fn(() => undefined);
    const controller = new DeferredObjectiveDecorationController({
      getChargingPhaseEnvelopes: () => new Map(),
      allocationRoster: new TaskAllocationRoster(() => new Date()),
      hasSolarProduction: () => false,
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => capacityOnlyPowerLimits(10),
      getStallClassification,
      hasObservedTask: () => false,
      isReservationSuppressed: noReservationSuppression,
      getDeliveredEnergyKWh: noDeliveredEnergy,
      getDeferredObjectiveActivePlans: createEmptyActivePlans,
      resolveDeviceExclusion: noDeviceExclusion,
    }, () => ({
      objectivesByDeviceId: {
        dev: {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'soft',
          targetPercent: 80,
          deadlineAtMs: Date.now() + 4 * 60 * 60 * 1000,
        },
      },
    }), () => false);

    controller.decorate({ devices: [buildDevice()], dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(getStallClassification).not.toHaveBeenCalled();
  });

  it('returns the identity bundle (devices untouched) when the settings read returns nothing', () => {
    const controller = new DeferredObjectiveDecorationController({
      getChargingPhaseEnvelopes: () => new Map(),
      allocationRoster: new TaskAllocationRoster(() => new Date()),
      hasSolarProduction: () => false,
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getCapacitySettings: () => capacityOnlyPowerLimits(10),
      getDeferredObjectiveActivePlans: createEmptyActivePlans,
      getTimeZone: () => 'UTC',
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      hasObservedTask: () => false,
      isReservationSuppressed: noReservationSuppression,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    }, () => undefined, () => false);
    const devices = [buildDevice()];

    const bundle = controller.decorate({ devices, dailyBudgetSnapshot: null, nowTs: Date.now() });

    expect(bundle.admittedDevices).toHaveLength(1);
    expect(bundle.forceShedSet.size).toBe(0);
    expect(bundle.deferredHoldCauseByDeviceId.size).toBe(0);
    expect(bundle.deferredReleaseIntentByDeviceId).toEqual({});
  });
});

describe('DeferredObjectiveDecorationController latest cycle', () => {
  const deadlineAtMs = Date.UTC(2026, 9, 2, 4);
  const settings: DeferredObjectiveRoster = {
    objectivesByDeviceId: {
      dev: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6, deadlineAtMs },
    },
  };
  const buildController = () => new DeferredObjectiveDecorationController({
    getChargingPhaseEnvelopes: () => new Map(),
    allocationRoster: new TaskAllocationRoster(() => new Date()),
    hasSolarProduction: () => false,
    getThermalDirection: () => 'heating',
    getPrioritiesForDevices: createFixturePriorityQuery(),
    getTimeZone: () => 'UTC',
    getPowerTracker: buildPowerTracker,
    getPriceOptimizationEnabled: () => true,
    // No prices: the task cannot plan, the case a report has to explain.
    buildPriceHorizon: () => [],
    getCapacitySettings: () => capacityOnlyPowerLimits(10),
    getDeferredObjectiveActivePlans: createEmptyActivePlans,
    resolveDeviceExclusion: noDeviceExclusion,
    getStallClassification: noStallEvidence,
    hasObservedTask: () => false,
    isReservationSuppressed: noReservationSuppression,
    getDeliveredEnergyKWh: noDeliveredEnergy,
  }, () => settings, () => false);
  const device = () => ({ ...buildDevice(), controlModel: 'binary_power' as const });

  it('keeps the decision and its reason for a task that could not plan', () => {
    const controller = buildController();
    const nowTs = deadlineAtMs - 6 * 60 * 60 * 1000;
    controller.decorate({ devices: [device()], dailyBudgetSnapshot: null, nowTs });

    expect(controller.readLatestCycle('dev')).toMatchObject({
      atMs: nowTs, decision: 'inactive', reasonCode: 'objective_missing_price_horizon', trajectory: 'unavailable',
    });
    expect(controller.readLatestCycle('other')).toBeUndefined();
  });

  it('drops the record once the task no longer governs the device', () => {
    const controller = buildController();
    controller.decorate({ devices: [device()], dailyBudgetSnapshot: null, nowTs: deadlineAtMs - 60_000 });
    expect(controller.readLatestCycle('dev')).toBeDefined();

    controller.decorate({ devices: [device()], dailyBudgetSnapshot: null, nowTs: deadlineAtMs });
    expect(controller.readLatestCycle('dev')).toBeUndefined();
  });
});


describe('DeferredObjectiveDecorationController measured budget exemption', () => {
  const startMs = Date.UTC(2026, 9, 2, 0);
  const quarterMs = 15 * 60_000;
  const deadlineAtMs = startMs + 4 * quarterMs;
  const buildExemptController = (temporaryTemperatureActive = false) => {
    const settings: DeferredObjectiveRoster = {
      objectivesByDeviceId: {
        dev: {
          enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6, deadlineAtMs,
          rescue: { exemptFromBudget: 'always' },
        },
      },
    };
    const buildPriceHorizon = vi.fn(() => Array.from({ length: 4 }, (_, index) => ({
      startMs: startMs + index * quarterMs,
      endMs: startMs + (index + 1) * quarterMs,
      price: 1,
      moneyPrice: 1,
    })));
    const controller = new DeferredObjectiveDecorationController({
      getChargingPhaseEnvelopes: () => new Map(),
      allocationRoster: new TaskAllocationRoster(() => new Date()),
      hasSolarProduction: () => false,
      getThermalDirection: () => 'heating',
      getPrioritiesForDevices: createFixturePriorityQuery(),
      getTimeZone: () => 'UTC',
      getPowerTracker: buildPowerTracker,
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon,
      getCapacitySettings: () => capacityOnlyPowerLimits(10),
      getDeferredObjectiveActivePlans: createEmptyActivePlans,
      resolveDeviceExclusion: noDeviceExclusion,
      getStallClassification: noStallEvidence,
      hasObservedTask: () => false,
      isReservationSuppressed: noReservationSuppression,
      getDeliveredEnergyKWh: noDeliveredEnergy,
    }, () => settings, () => temporaryTemperatureActive);
    const device = {
      ...buildDevice(), controlModel: 'binary_power' as const,
      control: fixtureControlPosture({ controllable: false }),
    };
    return { controller, settings, device, buildPriceHorizon };
  };

  it('serves a capacity-off task claim without reevaluating or publishing a plan', () => {
    const { controller, device, buildPriceHorizon } = buildExemptController();
    expect(controller.readBudgetExemptDeviceIds(startMs)).toEqual(new Set());
    const result = controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: startMs });
    expect(result.admittedDevices[0].budgetExempt).toBe(true);
    const evaluations = buildPriceHorizon.mock.calls.length;

    expect(controller.readBudgetExemptDeviceIds(startMs + quarterMs - 1)).toEqual(new Set(['dev']));
    expect(buildPriceHorizon).toHaveBeenCalledTimes(evaluations);
    expect(controller.readBudgetExemptDeviceIds(startMs - 1)).toEqual(new Set());
    expect(controller.readBudgetExemptDeviceIds(startMs + quarterMs)).toEqual(new Set());
  });

  it.each(['clear', 'disable', 'replace', 'permission'] as const)(
    'invalidates the cached exemption after a task %s before another decoration', (change) => {
      const { controller, settings, device } = buildExemptController();
      controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: startMs });
      expect(controller.readBudgetExemptDeviceIds(startMs + 1)).toEqual(new Set(['dev']));
      if (change === 'clear') delete settings.objectivesByDeviceId.dev;
      if (change === 'disable') settings.objectivesByDeviceId.dev.enabled = false;
      if (change === 'replace') settings.objectivesByDeviceId.dev.deadlineAtMs += quarterMs;
      if (change === 'permission') settings.objectivesByDeviceId.dev.rescue = {};
      expect(controller.readBudgetExemptDeviceIds(startMs + 2)).toEqual(new Set());
    },
  );

  it('decides nothing for a device while a Flow\'s temporary temperature is in force', () => {
    // The temporary temperature outranks the task: no claim, hold or lent
    // authority reaches the device, and the task itself is left as it was.
    const { controller, device, settings } = buildExemptController(true);
    const result = controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: startMs });

    expect(result.admittedDevices[0]).toBe(device);
    expect(result.admittedDeviceIds.size).toBe(0);
    expect(result.forceShedSet.size).toBe(0);
    expect(result.lentAuthorityDeviceIds.size).toBe(0);
    expect(controller.readBudgetExemptDeviceIds(startMs + 1)).toEqual(new Set());
    expect(settings.objectivesByDeviceId.dev.enabled).toBe(true);
  });

  it('never carries the last interval claim beyond the task deadline', () => {
    const { controller, device } = buildExemptController();
    controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: deadlineAtMs - 60_000 });
    expect(controller.readBudgetExemptDeviceIds(deadlineAtMs - 1)).toEqual(new Set(['dev']));
    expect(controller.readBudgetExemptDeviceIds(deadlineAtMs)).toEqual(new Set());
  });
});
