import { describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildIdentityDecorationBundle } from '../../lib/plan/planBuilderDecoration';
import {
  applyDeferredAdmissionToInput,
  buildDeferredReleaseIntents,
  type DeferredAdmissionDecision,
} from '../../lib/objectives/deferredObjectives/admission';
import { resolveDeferredAvoidDeviceIds } from '../../lib/objectives/deferredObjectives/decorationController';
import {
  buildExecutableDeviceIntent,
  buildExecutablePlan,
  hasExecutableShedDevices,
} from '../../lib/executor/executablePlanProjection';
import { hasBinaryCommand } from '../../lib/executor/executablePlan';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import { PriceLevel } from '../../lib/price/priceLevels';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type {
  MeteredDiscriminantProbe, PlanInputDevice, TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { inputDevice, steppedProfile } from '../utils/planConvergenceFixtures';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';

/**
 * During an active smart task the task decides whether the device runs, also with
 * Power-limit control ON (owner ruling, 2026-09-25): "a smart task can aim for a
 * higher soc state than normal run. e.g home mode could say heater at 45 degrees,
 * while the smart task could say 65 degrees. so it doesn't make sense to let the
 * device run as normal during an active smart task period".
 *
 * So an hour the task defers (`idle`: nothing booked, or a later hour is cheaper)
 * holds a power-limited device OFF, not at its configured limiting floor, which
 * answers capacity pressure and still draws. Before, a power-limited stepped device
 * had nothing holding it in such an hour and charged on spare capacity, and a
 * binary one was released off by the task while the plan kept it on.
 *
 * Driven through the REAL admission (`applyDeferredAdmissionToInput`), from the
 * decision a task's allocator produces, into a whole plan build.
 */
const decorateWithDecision = (
  deviceId: string,
  decision: DeferredAdmissionDecision,
) => (input: { devices: PlanInputDevice[] }) => {
  const decisions = new Map([[deviceId, decision]]);
  const admission = applyDeferredAdmissionToInput(input.devices, decisions);
  return {
    ...buildIdentityDecorationBundle(admission.devices),
    forceShedSet: admission.forceShedSet,
    deferredReleaseIntentByDeviceId: buildDeferredReleaseIntents(decisions),
    admittedDeviceIds: new Set([deviceId]),
    drivingDeviceIds: new Set([deviceId]),
    lentAuthorityDeviceIds: admission.lentAuthorityDeviceIds,
    deferredAvoidDeviceIds: resolveDeferredAvoidDeviceIds(decisions),
  };
};

const idleDecision: DeferredAdmissionDecision = { kind: 'idle', budgetExempt: false };
const plannedDecision: DeferredAdmissionDecision = {
  kind: 'planned',
  budgetExempt: false,
  engageBoost: false,
  reservesStartupPower: false,
};

const buildBuilderDeps = (
  decision: DeferredAdmissionDecision,
): ConstructorParameters<typeof PlanBuilder>[0] => ({
  leaveOffOnRelease: () => 'released',
  getInferredSurplusKw: () => 0,
  getCapacityDryRun: () => false,
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  setCapacityInShortfall: vi.fn(),
  // Roomy: nothing presses on capacity, so only the task can hold the device off.
  getCapacitySettings: () => ({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 50, marginKw: 0.2, periodMinutes: 60 }),
  resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => false,
    getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
    getPriceOptimizationSettings: () => ({}),
    getShedBehavior: () => ({ action: 'set_step' }),
  }),
  getPriceOptimizationSettings: () => ({}),
  getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: 500 }),
  getDailyBudgetSnapshot: () => null,
  // The owner's limiting floor is a rung, which is what the hold must NOT stop at.
  getShedBehavior: () => ({ action: 'set_step' }),
  getDynamicSoftLimitOverride: () => 50,
  log: vi.fn(),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  decorateDeferredObjectives: decorateWithDecision('charger', decision),
});

const buildBuilder = (decision: DeferredAdmissionDecision): PlanBuilder => (
  new PlanBuilder(buildBuilderDeps(decision), createPlanEngineState())
);

/** Power-limited stepped charger (Elbillader's shape), running at its top rung. */
const steppedCharger = (): PlanInputDevice => inputDevice({
  id: 'charger',
  name: 'Charger',
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
  currentState: 'on',
  currentDrawKw: 3,
  expectedPowerKw: 3,
  steppedLoadProfile: steppedProfile,
  selectedStepId: 'max',
  desiredStepId: 'max',
  controllable: true,
  managed: true,
});

describe('a smart task’s deferred hour on a power-limited device', () => {
  it('turns a running stepped device off, not down to its limiting floor', async () => {
    const plan = await buildBuilder(idleDecision).buildDevicePlanSnapshot([steppedCharger()]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('shed');
    expect(resolvePlannedShedTargetKind(device!)).toBe('binary_off');
    expect(device?.reason).toEqual({ code: PLAN_REASON_CODES.deferredObjectiveAvoid });
  });

  it('lets it run in an hour the task booked', async () => {
    const plan = await buildBuilder(plannedDecision).buildDevicePlanSnapshot([steppedCharger()]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('keep');
  });

  it('keeps an off binary device off instead of starting it on spare capacity', async () => {
    const offCharger = inputDevice({
      id: 'charger',
      name: 'Charger',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: false },
      currentState: 'off',
      currentDrawKw: 0,
      expectedPowerKw: 1,
      controllable: true,
      managed: true,
    });
    const plan = await buildBuilder(idleDecision).buildDevicePlanSnapshot([offCharger]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).not.toBe('keep');
    const intent = buildExecutableDeviceIntent(device!, plan.meta);
    expect(hasBinaryCommand(intent) ? intent.binary.desiredOn : false).toBe(false);
  });

  it('does not cap another stepped device at its lowest step as if capacity were short', async () => {
    // The hold is the task's schedule, not capacity pressure: the keep-invariant
    // stepped clamp and the restore-side shed invariant must not read it as a
    // device "limited" for power.
    const heater = inputDevice({
      id: 'heater',
      name: 'Heater',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: true },
      currentState: 'on',
      currentDrawKw: 1.25,
      expectedPowerKw: 3,
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      desiredStepId: 'max',
      controllable: true,
      managed: true,
    });
    const plan = await buildBuilder(idleDecision).buildDevicePlanSnapshot([steppedCharger(), heater]);

    const held = plan.devices.find((entry) => entry.id === 'charger');
    expect(held?.plannedState).toBe('shed');
    const other = plan.devices.find((entry) => entry.id === 'heater');
    expect(other?.plannedState).toBe('keep');
    expect(other?.reason?.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect(other?.desiredStepId).toBe('max');
    // And the executor's own keep-invariant gate agrees, so it does not hold the
    // heater at `low` against a plan that says `max`.
    expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(false);
  });

  it('limits another stepped device one rung, not to its lowest step, while the task holds a binary device off', async () => {
    // A binary device off because PELS shed it and not yet restored forces a
    // `set_step` device straight to its lowest active step when it is shed
    // (`isNonSteppedDeviceRecovering`): power it is waiting for must not sit at a
    // middle rung. A device its task holds off is waiting for nothing, since the
    // task will not let it on this hour however much room there is. Four steps, so
    // the next rung down (`mid`) and the lowest active step (`low`) differ.
    const fourStepProfile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1000 },
        { id: 'mid', planningPowerW: 2000 },
        { id: 'max', planningPowerW: 3000 },
      ],
    };
    const heater = inputDevice({
      id: 'heater',
      name: 'Heater',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: true },
      currentState: 'on',
      currentDrawKw: 3,
      expectedPowerKw: 3,
      steppedLoadProfile: fourStepProfile,
      selectedStepId: 'max',
      desiredStepId: 'max',
      controllable: true,
      managed: true,
    });
    const binaryCharger = (on: boolean): PlanInputDevice => inputDevice({
      id: 'charger',
      name: 'Charger',
      binaryCapabilityId: 'onoff',
      binaryControl: { on },
      currentState: on ? 'on' : 'off',
      currentDrawKw: on ? 1 : 0,
      expectedPowerKw: 1,
      controllable: true,
      managed: true,
    });
    let powerW = 4000;
    const builder = new PlanBuilder({
      ...buildBuilderDeps(idleDecision),
      getCapacitySettings: () => ({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, periodMinutes: 60 }),
      getDynamicSoftLimitOverride: () => 5,
      getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: powerW }),
    }, createPlanEngineState());

    // The task's deferred hour begins: the running charger is held off, with room to spare.
    const entering = await builder.buildDevicePlanSnapshot([binaryCharger(true), heater]);
    expect(entering.devices.find((entry) => entry.id === 'charger')?.plannedState).toBe('shed');

    // The charger now reads off, and the house goes 0.5 kW over.
    powerW = 5500;
    const plan = await builder.buildDevicePlanSnapshot([binaryCharger(false), heater]);

    const limited = plan.devices.find((entry) => entry.id === 'heater');
    expect(limited?.plannedState).toBe('shed');
    expect(limited?.desiredStepId).toBe('mid');
  });

  it('still counts the device as limited when capacity sheds it as well', async () => {
    // A fresh capacity reason is pressure: the hold alone is what is excluded.
    const tight = new PlanBuilder({
      ...buildBuilderDeps(idleDecision),
      getCapacitySettings: () => ({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 1, marginKw: 0.2, periodMinutes: 60 }),
      getDynamicSoftLimitOverride: () => 0.8,
      getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: 4500 }),
    }, createPlanEngineState());
    const plan = await tight.buildDevicePlanSnapshot([steppedCharger()]);

    const held = plan.devices.find((entry) => entry.id === 'charger');
    expect(held?.plannedState).toBe('shed');
    expect(held?.nonCapacityHoldShed).toBeUndefined();
  });

  it('keeps a temperature-only device on its setback, since it has no OFF to reach', async () => {
    // No on/off handle and no step ladder: an OFF would issue no command and the
    // plain setpoint write would keep it heating to its mode target under a plan
    // that says off. Its configured floor is the most "off" it has.
    const setback = { action: 'set_temperature' as const, temperature: 15 };
    const builder = new PlanBuilder({
      ...buildBuilderDeps(idleDecision),
      getShedBehavior: () => setback,
      resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
        getPriceOptimizationSettings: () => ({}),
        getShedBehavior: () => setback,
      }),
    }, createPlanEngineState());
    const loose: Partial<PlanInputDevice> & MeteredDiscriminantProbe & TemperatureDiscriminantProbe & {
      deviceType?: 'temperature'; controllable?: boolean; managed?: boolean;
    } = {
      id: 'charger',
      name: 'Heater',
      deviceType: 'temperature',
      currentDrawKw: 2,
      expectedPowerKw: 2,
      currentTemperature: 21,
      currentTarget: 22,
      targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
      controllable: true,
      managed: true,
    };
    const heater = inputDevice(loose);
    const plan = await builder.buildDevicePlanSnapshot([heater]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('shed');
    expect(device?.shedAction).toBe('set_temperature');
  });
});
