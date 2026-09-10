import { describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildIdentityDecorationBundle, decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import {
  applyDeferredAdmissionToInput,
  buildDeferredReleaseIntents,
  type DeferredAdmissionDecision,
} from '../../lib/objectives/deferredObjectives/admission';
import { buildExecutableDeviceIntent } from '../../lib/executor/executablePlanProjection';
import { hasBinaryCommand } from '../../lib/executor/executablePlan';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import { PriceLevel } from '../../lib/price/priceLevels';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/power/sampleFreshness';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type {
  BinaryControlDiscriminantProbe, PlanInputDevice, TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { inputDevice, steppedProfile } from '../utils/planConvergenceFixtures';

/**
 * The "Only PELS starts this device" policy, driven through a WHOLE plan build.
 *
 * This spec exists because the first version of the feature was proved only by
 * unit tests on the hold resolver and by `buildInitialPlanDevices` in isolation.
 * Both bypass `finalizePlanDevices`, and therefore bypassed
 * `validatePlanReasonPair` — which rejects any reason code not listed as legal
 * for the device's planned state. The reason was missing from `SHED_REASON_RULES`,
 * so every `pels_only` device threw in test and would have logged
 * `plan_reason_pair_invalid` on every production build, forever, for a state that
 * is permanent by design.
 *
 * The lesson is the assertion: a new plan reason is not landed until a full build
 * has produced it.
 */

/**
 * A decoration seam driven by a REAL admission decision.
 *
 * The decision value is the input a smart task's allocator produces; everything
 * downstream of it — the authority term, the release intent, and the
 * `startPolicyHoldLifted` stamp this suite is about — runs through the real
 * `applyDeferredAdmissionToInput`. Hand-building the bundle instead would assert
 * the fixture rather than the producer.
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
  };
};

const plannedDecision: DeferredAdmissionDecision = {
  kind: 'planned',
  budgetExempt: false,
  engageBoost: false,
  reservesStartupPower: false,
  expectedStepId: null,
  releaseIntent: 'binary_restore',
};

const idleDecision: DeferredAdmissionDecision = { kind: 'idle', budgetExempt: false };

/** Neither of these claims the hour, so neither lifts the hold (owner rulings, 2026-09-10). */
const unclaimedDecision: DeferredAdmissionDecision = { kind: 'unclaimed', budgetExempt: false };
const inactiveDecision: DeferredAdmissionDecision = { kind: 'inactive', budgetExempt: false };

const buildBuilder = (
  overrides: Partial<ConstructorParameters<typeof PlanBuilder>[0]> = {},
): PlanBuilder => new PlanBuilder({
  getInferredSurplusKw: () => 0,
  getCapacityDryRun: () => false,
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  setCapacityInShortfall: vi.fn(),
  // Deliberately roomy: no capacity pressure anywhere, so the only thing that can
  // put a device in the shed set is the posture under test.
  getCapacitySettings: () => ({ limitKw: 50, marginKw: 0.2 }),
  getOperatingMode: () => 'Home',
  getModeDeviceTargets: () => ({}),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
  getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: 500 }),
  getDailyBudgetSnapshot: () => null,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getDynamicSoftLimitOverride: () => 50,
  log: vi.fn(),
  logDebug: vi.fn(),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  // Default: no smart tasks, so the policy acts on its own. The cases that need
  // one override this with `decorateWithDecision`, which drives real admission.
  decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  ...overrides,
}, createPlanEngineState());

const charger = (
  startPolicy: 'unrestricted' | 'pels_only',
  binaryControl: { on: boolean } = { on: true },
): PlanInputDevice => inputDevice({
  id: 'charger',
  name: 'Charger',
  binaryCapabilityId: 'onoff',
  binaryControl,
  currentState: binaryControl.on ? 'on' : 'off',
  currentDrawKw: binaryControl.on ? 1 : 0,
  expectedPowerKw: 1,
  // The case the feature exists for: managed, but the owner has Power-limit
  // control OFF. The policy is what gives PELS the lever at all.
  controllable: false,
  managed: true,
  commandAuthority: startPolicy === 'pels_only',
  startPolicy,
});

/** The Aug-31 production shape: a stepped charger with a configured `set_step` floor. */
const steppedCharger = (startPolicy: 'unrestricted' | 'pels_only'): PlanInputDevice => inputDevice({
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
  controllable: false,
  managed: true,
  commandAuthority: startPolicy === 'pels_only',
  startPolicy,
});

/** A thermostat that also has an on/off handle, with a configured setback floor. */
const thermostat = (startPolicy: 'unrestricted' | 'pels_only'): PlanInputDevice => {
  const loose: Partial<PlanInputDevice>
  & BinaryControlDiscriminantProbe
  & TemperatureDiscriminantProbe & {
    deviceType?: 'temperature' | 'onoff';
    binaryCapabilityId?: string;
    controllable?: boolean; managed?: boolean; commandAuthority?: boolean;
  } = {
    id: 'heater',
    name: 'Heater',
    deviceType: 'temperature',
    binaryCapabilityId: 'onoff',
    binaryControl: { on: true },
    currentState: 'on',
    currentDrawKw: 2,
    expectedPowerKw: 2,
    currentTemperature: 21,
    currentTarget: 22,
    targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
    controllable: false,
    managed: true,
    commandAuthority: startPolicy === 'pels_only',
    startPolicy,
  };
  return inputDevice(loose);
};

describe('start policy through a whole plan build', () => {
  it('produces a valid finalized plan for a pels_only device', async () => {
    // `validatePlanReasonPair` throws in the test tiers, so reaching the
    // assertion at all is half of what this proves.
    const plan = await buildBuilder().buildDevicePlanSnapshot([charger('pels_only')]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason?.code).toBe(PLAN_REASON_CODES.awaitingPelsStart);
  });

  it('leaves an unrestricted device alone when nothing is pressing on capacity', async () => {
    const plan = await buildBuilder().buildDevicePlanSnapshot([charger('unrestricted')]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).not.toBe('shed');
    expect(device?.reason?.code).not.toBe(PLAN_REASON_CODES.awaitingPelsStart);
  });

  it('lets a smart task start a held device once its planned hour arrives', async () => {
    // The feature's headline promise, and the case the hold made unreachable: a
    // device the policy has already taken OFF is exactly the device a task has to
    // be able to start. While `getInactiveReason` read the owner's raw policy it
    // pinned this device `inactive` every cycle, and no start intent is ever built
    // for an inactive device — so "It runs when a Smart task needs it to" was
    // false for every device the hold was working on.
    const plan = await buildBuilder({
      decorateDeferredObjectives: decorateWithDecision('charger', plannedDecision),
    }).buildDevicePlanSnapshot([charger('pels_only', { on: false })]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('keep');
    expect(device?.reason?.code).not.toBe(PLAN_REASON_CODES.awaitingPelsStart);
    // Through the executor projection, because `plannedState: 'keep'` alone is
    // not a turn-on: the intent is what actually reaches a device write.
    const intent = buildExecutableDeviceIntent(device!, plan.meta);
    expect(hasBinaryCommand(intent) ? intent.binary : undefined)
      .toMatchObject({ deviceId: 'charger', desiredOn: true });
  });

  it('keeps holding a device whose own task left this hour idle', async () => {
    // The owner ruling the lift is deliberately narrow for: `idle` means the task
    // is on track with nothing booked this hour. It GOVERNS the device without
    // driving it, and a baseline of off must survive that — lifting here would let
    // the ordinary restore lane start a device its own task just decided to leave
    // alone.
    const plan = await buildBuilder({
      decorateDeferredObjectives: decorateWithDecision('charger', idleDecision),
    }).buildDevicePlanSnapshot([charger('pels_only', { on: false })]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('inactive');
    expect(device?.reason?.code).toBe(PLAN_REASON_CODES.awaitingPelsStart);
  });

  it('takes a stepped device to OFF rather than the owner\u2019s configured rung', async () => {
    // The production shape: an EV charger whose Power limiting is configured
    // `set_step`. The hold's own intent is off, but the rung was priced from the
    // CONFIGURED floor before the override applied, and the materializer then read
    // that active rung as the decided end state — so the charger parked at its
    // lowest current and kept drawing under a switch promising PELS turns it off.
    const plan = await buildBuilder({
      getShedBehavior: () => ({ action: 'set_step' as const }),
    }).buildDevicePlanSnapshot([steppedCharger('pels_only')]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('shed');
    expect(resolvePlannedShedTargetKind(device!)).toBe('binary_off');
  });

  it.each([
    ['unclaimed', unclaimedDecision],
    ['inactive', inactiveDecision],
  ])('keeps holding a device whose task decision is %s', async (_kind, decision) => {
    // `unclaimed` is the owner ruling that costs something: the task booked
    // nothing this hour and cannot finish without it, and the planner would
    // normally let such a device compete on its own priority. A `pels_only`
    // device does not get that — "PELS could not book this hour" is not PELS
    // starting it. `inactive` is the blunt case the feature was built for: a
    // task whose precondition failed (an EV that will not report its state of
    // charge) must leave the device off, not running on a manual start.
    const plan = await buildBuilder({
      decorateDeferredObjectives: decorateWithDecision('charger', decision),
    }).buildDevicePlanSnapshot([charger('pels_only', { on: false })]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('inactive');
    expect(device?.reason?.code).toBe(PLAN_REASON_CODES.awaitingPelsStart);
  });

  it('still sheds the hold to OFF when the meter has gone silent', async () => {
    // The fail-closed pass sheds every candidate to its floor, and for this
    // device the floor is OFF — the policy carries its own shed intent, not the
    // owner's power-limiting one. Worth pinning here because the composed gate
    // blocks every further rebuild until a sample returns, so whatever this pass
    // decides is where the device stays for the whole outage.
    const plan = await buildBuilder({
      getShedBehavior: () => ({ action: 'set_step' as const }),
      getPowerTracker: () => ({
        lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
        lastPowerW: 4_400,
      }),
    }).buildDevicePlanSnapshot([steppedCharger('pels_only')]);

    const device = plan.devices.find((entry) => entry.id === 'charger');
    expect(device?.plannedState).toBe('shed');
    expect(device?.reason?.code).toBe(PLAN_REASON_CODES.awaitingPelsStart);
    expect(resolvePlannedShedTargetKind(device!)).toBe('binary_off');
  });

  it('takes a thermostat to OFF rather than its configured limiting temperature', async () => {
    // Same defect on the temperature axis: the configured `set_temperature` floor
    // answers "how far down when the house is short of power", and borrowing it
    // here left the device pinned at its setback, still drawing.
    const plan = await buildBuilder({
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16 }),
    }).buildDevicePlanSnapshot([thermostat('pels_only')]);

    const device = plan.devices.find((entry) => entry.id === 'heater');
    expect(device?.plannedState).toBe('shed');
    expect(device?.shedAction).toBe('turn_off');
    expect(resolvePlannedShedTargetKind(device!)).toBe('binary_off');
  });
});
