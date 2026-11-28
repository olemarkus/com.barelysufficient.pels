import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import { createEmptyActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import { createCommittedTaskPlanning } from '../helpers/committedTaskPlanning';
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
      prefersContinuousCharging: () => false,
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
      prefersContinuousCharging: () => false,
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
      prefersContinuousCharging: () => false,
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
      prefersContinuousCharging: () => false,
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
    prefersContinuousCharging: () => false,
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
  const buildExemptController = (
    temporaryTemperatureActive = false,
    readBatteryDischargeW?: (excludedDeviceIds: ReadonlySet<string>) => number,
    batteries: readonly PlanInputDevice[] = [],
  ) => {
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
    const planning = createCommittedTaskPlanning({
      ...(readBatteryDischargeW ? {
        getHomeBatteryDischargeW: readBatteryDischargeW,
        evSmartTaskSettings: () => ({ pauseOnBatteryDischarge: true }),
      } : {}),
      prefersContinuousCharging: () => false,
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
    });
    const device = {
      ...buildDevice(), controlModel: 'binary_power' as const,
      ...(readBatteryDischargeW ? { isEvCharger: true, evChargingState: 'plugged_in' as const } : {}),
      control: fixtureControlPosture({ controllable: false }),
    };
    planning.settle({ devices: [device, ...batteries], dailyBudgetSnapshot: null, nowTs: startMs }, settings);
    buildPriceHorizon.mockClear();
    const readRoster = vi.fn(() => settings);
    const controller = new DeferredObjectiveDecorationController(
      planning.source, readRoster, () => temporaryTemperatureActive,
    );
    return { controller, settings, device, buildPriceHorizon, readRoster };
  };

  it('pauses a charger through the booked quarter, then retries when discharge clears', () => {
    let dischargeW = 500;
    const { controller, device } = buildExemptController(false, () => dischargeW);
    const at = (nowTs: number) => controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs });
    expect(at(startMs).drivingDeviceIds.has('dev')).toBe(true);

    dischargeW = 600;
    const paused = at(startMs + 1);
    expect(paused.admittedDevices[0].deferredHold).toBe('battery_pause');
    expect(paused.drivingDeviceIds.has('dev')).toBe(false);
    expect(paused.bookedEvTask).toBe(true);
    expect(paused.deferredReleaseIntentByDeviceId.dev).toBe('binary_release');
    expect(paused.deferredHoldCauseByDeviceId.get('dev')).toBe('battery_discharging');

    dischargeW = 0;
    expect(at(startMs + quarterMs - 1).drivingDeviceIds.has('dev')).toBe(false);
    expect(at(startMs + quarterMs).drivingDeviceIds.has('dev')).toBe(true);
  });

  it('ignores discharge from a battery that holds its scheduled discharge for the booked task', () => {
    const battery = (holdDischargeDuringEvCharging?: true): PlanInputDevice => ({
      ...buildDevice(), id: 'battery', name: 'Battery',
      storage: {
        reading: 'observed',
        ...(holdDischargeDuringEvCharging ? { holdDischargeDuringEvCharging } : {}),
        continuousPlan: { reason: 'supply_house', setpointW: -2000, validUntilMs: startMs + quarterMs },
      },
    }) as unknown as PlanInputDevice;
    const readDischarge = vi.fn((excluded: ReadonlySet<string>) => (excluded.has('battery') ? 0 : 2000));
    const decorate = (holds: boolean, nowTs: number) => {
      const storage = holds ? battery(true) : battery();
      const { controller, device } = buildExemptController(false, readDischarge, [storage]);
      return controller.decorate({ devices: [device, storage], dailyBudgetSnapshot: null, nowTs });
    };

    const held = decorate(true, startMs);
    expect(readDischarge).toHaveBeenLastCalledWith(new Set(['battery']));
    expect(held.drivingDeviceIds.has('dev')).toBe(true);
    expect(held.admittedDevices[0].deferredHold).toBeUndefined();

    expect(decorate(false, startMs).admittedDevices[0].deferredHold).toBe('battery_pause');
    expect(readDischarge).toHaveBeenLastCalledWith(new Set());
  });

  it('serves a capacity-off task claim without reevaluating or publishing a plan', () => {
    const { controller, device, buildPriceHorizon, readRoster } = buildExemptController();
    expect(controller.readBudgetExemptDeviceIds(startMs)).toEqual(new Set());
    expect(readRoster).not.toHaveBeenCalled();
    const result = controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: startMs });
    expect(result.admittedDevices[0].budgetExempt).toBe(true);
    const evaluations = buildPriceHorizon.mock.calls.length;
    readRoster.mockClear();

    expect(controller.readBudgetExemptDeviceIds(startMs + quarterMs - 1)).toEqual(new Set(['dev']));
    expect(buildPriceHorizon).toHaveBeenCalledTimes(evaluations);
    expect(controller.readBudgetExemptDeviceIds(startMs - 1)).toEqual(new Set());
    expect(controller.readBudgetExemptDeviceIds(startMs + quarterMs)).toEqual(new Set());
    expect(readRoster).toHaveBeenCalledTimes(1);
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
