import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { buildIdentityDecorationBundle, decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import {
  applyDeferredAdmissionToInput,
  buildDeferredReleaseIntents,
  type DeferredAdmissionDecision,
} from '../../lib/objectives/deferredObjectives/admission';
import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { inputDevice } from '../utils/planConvergenceFixtures';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { PriceLevel } from '../../lib/price/priceLevels';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildExecutablePlan } from '../../lib/executor/executablePlanProjection';
import { hasBinaryCommand } from '../../lib/executor/executablePlan';
import {
  applyUncontrolledBinaryRestore,
  type PlanExecutorBinaryContext,
} from '../../lib/executor/binaryExecutor';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { createBinaryCommandClaim } from '../../lib/executor/binaryCommandClaim';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * The shed PELS undoes when it loses its authority, driven through real plan
 * builds and the real release lane.
 *
 * Production shape (2026-09-25): a water heater on a relay, with an owner Flow
 * that every 30 minutes turns Power-limit control on for the cheap night hours
 * and otherwise turns it off and switches the heater off. PELS had shed the
 * heater once overnight and resumed it minutes later. Four hours on, the Flow
 * disabled control and switched the heater off — and PELS turned it straight
 * back on, because the shed it had long since undone was still on record.
 */

const HEATER = 'water-heater';

type Harness = {
  builder: PlanBuilder;
  state: PlanEngineState;
  setMeter: (params: { totalKw: number; limitKw: number }) => void;
  /** The smart-task decoration the next builds plan with; identity when unset. */
  setDecoration: (decorate: ((devices: PlanInputDevice[]) => DeferredDecorationBundle) | null) => void;
};

type ShedBehavior = { action: 'turn_off' } | { action: 'set_temperature'; temperature: number };

const makeHarness = (shedBehavior: ShedBehavior = { action: 'turn_off' }): Harness => {
  const state = createPlanEngineState();
  let totalW = 500;
  let limitKw = 50;
  let decorate: ((devices: PlanInputDevice[]) => DeferredDecorationBundle) | null = null;
  const builder = new PlanBuilder({
    leaveOffOnRelease: () => 'released',
    getInferredSurplusKw: () => 0,
    getCapacityDryRun: () => false,
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    setCapacityInShortfall: vi.fn(),
    getCapacitySettings: () => ({ limitKw: 50, marginKw: 0.2, periodMinutes: 60 }),
    resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPriceOptimizationSettings: () => ({}),
      getShedBehavior: () => shedBehavior,
    }),
    getPriceOptimizationSettings: () => ({}),
    getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: totalW }),
    getDailyBudgetSnapshot: () => null,
    getShedBehavior: () => shedBehavior,
    getDynamicSoftLimitOverride: () => limitKw,
    log: vi.fn(),
    // One record of PELS's in-flight writes, as in production: the builder and
    // the executor's release lane read the same one.
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
    decorateDeferredObjectives: (input) => (
      decorate ? decorate(input.devices) : decorateWithoutDeferredObjectives(input)
    ),
  }, state);
  return {
    builder,
    state,
    setMeter: (params) => {
      totalW = params.totalKw * 1000;
      limitKw = params.limitKw;
    },
    setDecoration: (next) => { decorate = next; },
  };
};

/**
 * A smart task governing the heater, driven by a REAL admission decision: the
 * lent authority and the idle-hour force-shed come from the producer, not the
 * fixture.
 */
const smartTaskGoverns = (decision: DeferredAdmissionDecision) => (devices: PlanInputDevice[]) => {
  const decisions = new Map([[HEATER, decision]]);
  const admission = applyDeferredAdmissionToInput(devices, decisions, {});
  return {
    ...buildIdentityDecorationBundle(admission.devices),
    forceShedSet: admission.forceShedSet,
    deferredReleaseIntentByDeviceId: buildDeferredReleaseIntents(decisions),
    admittedDeviceIds: new Set([HEATER]),
    drivingDeviceIds: new Set<string>(),
    lentAuthorityDeviceIds: admission.lentAuthorityDeviceIds,
  };
};

const heater = (params: { on: boolean; powerLimitControl: boolean; available?: boolean }): PlanInputDevice => inputDevice({
  id: HEATER,
  name: 'Water heater',
  binaryCapabilityId: 'onoff',
  binaryControl: { on: params.on },
  currentState: params.on ? 'on' : 'off',
  currentDrawKw: params.on ? 2 : 0,
  expectedPowerKw: 2,
  controllable: params.powerLimitControl,
  managed: true,
  available: params.available ?? true,
  commandableNow: params.available ?? true,
});

const heaterOf = (plan: DevicePlan) => plan.devices.find((device) => device.id === HEATER);

const binaryIntentOf = (plan: DevicePlan) => (
  ((device) => (device && hasBinaryCommand(device) ? device.binary : null))(
    buildExecutablePlan(plan).devices.find((device) => device.id === HEATER),
  )
);

const offHeaterSnapshot = {
  id: HEATER,
  binaryCapabilityId: 'onoff',
  capabilities: ['onoff'],
  canSetControl: true,
  binaryControl: { on: false },
  available: true,
} as unknown as TargetDeviceSnapshot;

/** The executor's release lane over the SAME engine state the builds wrote. */
const releaseLane = (state: PlanEngineState) => {
  const turnOnCalls: boolean[] = [];
  const read = (id: string) => (id === HEATER ? offHeaterSnapshot : undefined);
  const ctx: PlanExecutorBinaryContext = {
    state,
    readDevice: read,
    capacityDryRun: false,
    buildBinaryControlTransport: () => ({
      getObservedBinaryControl: read,
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      actuator: createDeviceActuator({
        resolveTemperatureTarget: (_deviceId, desired) => desired,
        requestSteppedLoadStep: async () => ({ requested: false }),
        requestBinaryControl: async (_deviceId: string, desired: boolean) => {
          turnOnCalls.push(desired);
          return undefined;
        },
        requestTemperatureTarget: (_deviceId, desired) => Promise.resolve(desired),
      }),
    }),
    recordShedActuation: vi.fn(),
    recordReleaseShedActuation: vi.fn(),
    recordRestoreActuation: vi.fn(),
    binaryCommandClaim: createBinaryCommandClaim(),
    binaryCommandOwner: 'ordinary',
  };
  return { ctx, turnOnCalls };
};

const uncontrolledIntent = {
  desiredOn: true as const,
  deviceId: HEATER,
  name: 'Water heater',
  source: 'uncontrolled' as const,
};

describe('the shed PELS undoes when it loses authority over a device', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'] });
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const shedTheHeater = async (h: Harness): Promise<void> => {
    h.setMeter({ totalKw: 5, limitKw: 2 });
    const plan = await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: true })]);
    expect(heaterOf(plan)?.plannedState).toBe('shed');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);
  };

  it('does not turn a device back on when its owner switches it off after PELS already resumed it', async () => {
    const h = makeHarness();
    await shedTheHeater(h);

    // Room returns; once the shed cooldown that the cleared overshoot starts has
    // run out, PELS resumes the heater and it runs.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    h.setMeter({ totalKw: 0.5, limitKw: 10 });
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: true })]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const resumed = await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: true })]);
    expect(heaterOf(resumed)?.plannedState).toBe('keep');
    await vi.advanceTimersByTimeAsync(60_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: true })]);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);

    // Hours later the owner's Flow turns Power-limit control off and switches
    // the heater off. The plan hands PELS's last word to the release lane...
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    h.setMeter({ totalKw: 2.5, limitKw: 10 });
    const letGo = await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    expect(binaryIntentOf(letGo)).toEqual(uncontrolledIntent);

    // ...which has nothing of PELS's to undo: the off is the owner's.
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(false);
    expect(lane.turnOnCalls).toEqual([]);
  });

  it('turns a device back on when control goes off while PELS still holds it shed, until it is seen on', async () => {
    const h = makeHarness();
    await shedTheHeater(h);

    // Control goes off while the heater is still shed: PELS must not strand it.
    await vi.advanceTimersByTimeAsync(60_000);
    const letGo = await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    expect(binaryIntentOf(letGo)).toEqual(uncontrolledIntent);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(true);
    expect(lane.turnOnCalls).toEqual([true]);

    // A turn-on that has not landed yet is still owed on the next build...
    await vi.advanceTimersByTimeAsync(10_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);

    // ...and once the heater is seen on, nothing is: a later off is the owner's.
    await vi.advanceTimersByTimeAsync(10_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: false })]);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    const later = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(later.ctx, uncontrolledIntent, undefined)).toBe(false);
    expect(later.turnOnCalls).toEqual([]);
  });

  it('forgets the shed once the executor confirms the turn-on', async () => {
    const h = makeHarness();
    await shedTheHeater(h);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);

    h.state.shedDecisions.noteShedReleased(HEATER);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);
    // The confirmation is final: the next build, with the heater off again,
    // does not bring the shed back.
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);
  });

  it('does not turn on a device that was already off when PELS held it', async () => {
    // The reported Flow's other half: control comes on at night while the
    // heater is already off, and there is no room to resume it, so the plan
    // holds it. PELS never turned it off, so letting go must not start it.
    const h = makeHarness();
    h.setMeter({ totalKw: 9.5, limitKw: 10 });
    const held = await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: true })]);
    expect(heaterOf(held)?.plannedState).toBe('shed');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(false);
    expect(lane.turnOnCalls).toEqual([]);
  });

  it('keeps the shed while PELS\'s own turn-off is still in flight when control goes off', async () => {
    const h = makeHarness();
    await shedTheHeater(h);
    // The OFF is sent but the relay has not reported it yet.
    h.state.pendingBinaryCommands[HEATER] = { dispatchState: 'accepted', desired: false, startedMs: Date.now() };

    await vi.advanceTimersByTimeAsync(5_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: false })]);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);

    // The OFF lands; PELS no longer controls the heater, so it turns it back on.
    delete h.state.pendingBinaryCommands[HEATER];
    await vi.advanceTimersByTimeAsync(5_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(true);
  });

  it('keeps the shed while the device is unavailable, and undoes it once control goes off and it is back', async () => {
    const h = makeHarness();
    await shedTheHeater(h);

    await vi.advanceTimersByTimeAsync(60_000);
    const unavailable = await h.builder.buildDevicePlanSnapshot([
      heater({ on: false, powerLimitControl: true, available: false }),
    ]);
    expect(heaterOf(unavailable)?.plannedState).toBe('inactive');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(true);
  });

  it('leaves a shed a smart task governed to the task, when the task lets go of the device', async () => {
    // Power-limit control is off; a smart task lends PELS authority and holds
    // the heater off in an hour it skips. When the task is disarmed its own
    // lifecycle clock decides what happens to the heater, not this lane.
    const h = makeHarness();
    h.setDecoration(smartTaskGoverns({ kind: 'idle', budgetExempt: false }));
    const held = await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: false })]);
    expect(heaterOf(held)?.plannedState).toBe('shed');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);

    h.setDecoration(null);
    await vi.advanceTimersByTimeAsync(60_000);
    const letGo = await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    expect(binaryIntentOf(letGo)).toEqual(uncontrolledIntent);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(false);
    expect(lane.turnOnCalls).toEqual([]);
  });

  it('keeps the shed while a resume has not landed when control goes off', async () => {
    const h = makeHarness();
    await shedTheHeater(h);

    // Room returns and PELS decides to resume the heater, but the relay never
    // comes on — then the owner turns control off.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    h.setMeter({ totalKw: 0.5, limitKw: 10 });
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: true })]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const resumed = await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: true })]);
    expect(heaterOf(resumed)?.plannedState).toBe('keep');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(true);
  });

  it('never counts a shed that lowers a setpoint: PELS did not switch the device off', async () => {
    const h = makeHarness({ action: 'set_temperature', temperature: 15 });
    h.setMeter({ totalKw: 5, limitKw: 2 });
    const thermostat = buildPlanInputDevice({
      id: HEATER,
      name: 'Water heater',
      deviceType: 'temperature',
      currentTemperature: 55,
      currentTarget: 60,
      targets: [{ id: 'target_temperature', value: 60, unit: '°C', min: 10, max: 75, step: 1 }],
      binaryCapabilityId: 'onoff',
      binaryControl: { on: true },
      currentState: 'on',
      currentDrawKw: 2,
      expectedPowerKw: 2,
      controllable: true,
      managed: true,
    });
    const plan = await h.builder.buildDevicePlanSnapshot([thermostat]);
    expect(heaterOf(plan)?.plannedState).toBe('shed');
    expect(heaterOf(plan)?.plannedShedTargetKind).toBe('target_value');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(false);
  });

  it('records PELS switching a device off again after its owner switched it on while held', async () => {
    const h = makeHarness();
    await shedTheHeater(h);
    // The owner switches the heater on at the wall; the plan still sheds it,
    // and this build sees it on before PELS's second turn-off is sent.
    await vi.advanceTimersByTimeAsync(10_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: true })]);
    await vi.advanceTimersByTimeAsync(10_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: true })]);
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await h.builder.buildDevicePlanSnapshot([heater({ on: false, powerLimitControl: false })]);
    const lane = releaseLane(h.state);
    expect(await applyUncontrolledBinaryRestore(lane.ctx, uncontrolledIntent, undefined)).toBe(true);
  });

  it('keeps a capacity shed PELS\'s own during a smart task, when the device has authority of its own', async () => {
    // Power limiting is on, so the task lends nothing: a capacity shed in its
    // planned hour is PELS's, and PELS undoes it if control goes off later.
    const h = makeHarness();
    h.setDecoration(smartTaskGoverns({
      kind: 'planned',
      budgetExempt: false,
      engageBoost: false,
      reservesStartupPower: false,
      expectedStepId: null,
      releaseIntent: 'binary_restore',
    }));
    h.setMeter({ totalKw: 5, limitKw: 2 });
    const plan = await h.builder.buildDevicePlanSnapshot([heater({ on: true, powerLimitControl: true })]);
    expect(heaterOf(plan)?.plannedState).toBe('shed');
    expect(h.state.shedDecisions.standingShedIds.has(HEATER)).toBe(true);
  });
});
