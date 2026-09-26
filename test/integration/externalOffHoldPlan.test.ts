/**
 * Planner-side consequences of an active external-off hold: the device is
 * inactive with its own semantic reason, invisible to every restore lane, and
 * never counted as starved.
 *
 * Integration tier: drives the real `lib/plan` predicates and the real
 * plan-contract classifiers against plan-device fixtures. The provenance
 * question ("was the off ours?") is settled upstream and covered in
 * `externalOffHoldDetection.test.ts`; here the hold is a given.
 */
import { buildPlanCycleObject, type PlanCycle } from '../utils/planContextPowerFixture';
import { describe, expect, it, vi } from 'vitest';
import { ShedDecisions } from '../../lib/plan/shedDecisions';
import {
  applyUncontrolledBinaryRestore,
  type PlanExecutorBinaryContext,
} from '../../lib/executor/binaryExecutor';
import { applyBinaryRestoreWithSnapshot } from '../../lib/executor/binaryRestoreHelpers';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { createBinaryCommandClaim } from '../../lib/executor/binaryCommandClaim';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  getInactiveReason,
  getRestoreCandidates,
  isOffBinaryRestoreHoldCandidate,
  isRestoreLiveEligibleDevice,
} from '../../lib/plan/restore/devices';
import { applyOffStateReason } from '../../lib/plan/planOffStateReason';
import {
  isDeferredRestoreBlockedReason,
  resolveStarvationSuppressionSemantics,
} from '../../lib/planContract/planDecisionSemantics';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { withBinaryDiscriminant, type DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice, buildPlanInputDevice, sheddingPlanFixture } from '../utils/planTestUtils';
import { buildInitialPlanDevices, type PlanDevicesDeps } from '../../lib/plan/planDevices';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { PlanContext } from '../../lib/plan/planContext';

// A plain, unremarkable meter reading: fixtures that only need power to be
// MEASURED say so through the reading, the way production does.
const FIXTURE_TOTAL_KW = 3;

const makeDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => (
  withBinaryDiscriminant({
    ...buildPlanDevice({
      id: 'heater-1',
      currentState: 'off',
      currentOn: false,
      controllable: true,
      ...overrides,
    }),
    binaryControl: { on: false },
  }) as DevicePlanDevice
);

const heldDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => makeDevice({
  externalOffHoldActive: true,
  ...overrides,
});

describe('external-off hold — restore exclusion', () => {
  it('makes the device ineligible for every restore lane', () => {
    expect(isRestoreLiveEligibleDevice(heldDevice())).toBe(false);
    expect(isOffBinaryRestoreHoldCandidate(heldDevice())).toBe(false);
  });

  it('allows a prior-shed, unheld device into the restore lane', () => {
    const device = makeDevice();
    const history = new ShedDecisions();
    history.lastPlannedShedIds = new Set([device.id]);
    history.lastPlannedDeviceIds = new Set([device.id]);
    expect(isRestoreLiveEligibleDevice(device)).toBe(true);
    expect(isOffBinaryRestoreHoldCandidate(device)).toBe(true);
    expect(getRestoreCandidates([device], history)).toHaveLength(1);
  });

  it('drops the held device from restore candidates while keeping its peers', () => {
    const history = new ShedDecisions();
    history.lastPlannedShedIds = new Set(['held', 'free']);
    history.lastPlannedDeviceIds = new Set(['held', 'free']);
    const candidates = getRestoreCandidates([
      heldDevice({ id: 'held' }),
      makeDevice({ id: 'free' }),
    ], history);
    expect(candidates.map((candidate) => candidate.device.id)).toEqual(['free']);
  });
});

describe('external-off hold — plan reason', () => {
  it('reports its own semantic reason rather than a generic inactive detail', () => {
    expect(getInactiveReason(heldDevice())).toEqual({ code: PLAN_REASON_CODES.externalOffHold });
  });

  it('marks the device inactive during materialization', () => {
    const result = applyOffStateReason(heldDevice(), { inShortfall: false });
    expect(result.plannedState).toBe('inactive');
    expect(result.reason).toEqual({ code: PLAN_REASON_CODES.externalOffHold });
  });

  it('keeps an unplugged charger reading as unplugged, with the hold stored underneath', () => {
    // The EV plug-state block is checked first on purpose: "unplugged" is the
    // more immediate fact for the user. The hold itself is untouched — it lives
    // in the store, not on the plan device, and becomes visible again on
    // reconnection.
    const charger = withBinaryDiscriminant({
      ...buildPlanDevice({
        id: 'ev-1',
        currentState: 'off',
        deviceClass: 'evcharger',
        binaryCapabilityId: 'evcharger_charging',
        controllable: true,
        externalOffHoldActive: true,
        evChargingState: 'plugged_out',
      }),
      binaryControl: { on: false },
    }) as DevicePlanDevice;
    expect(getInactiveReason(charger)).toEqual({
      code: PLAN_REASON_CODES.inactive,
      detail: 'charger is unplugged',
    });
  });
});

describe('external-off hold — plan contract classification', () => {
  it('blocks a smart-task binary restore from lifting the hold', () => {
    expect(isDeferredRestoreBlockedReason({ code: PLAN_REASON_CODES.externalOffHold })).toBe(true);
  });

  it('is not classified as starvation counting or a starvation pause', () => {
    expect(resolveStarvationSuppressionSemantics({ code: PLAN_REASON_CODES.externalOffHold }))
      .toEqual({ state: 'none', countingCause: null, pauseReason: null });
  });
});

describe('external-off hold — plan-device propagation', () => {
  // Without this the whole suite is blind to a dropped `externalOffHoldActive`
  // propagation in `buildBasePlanDevice`: the e2e's "never resumes" assertion
  // passes on the executor guard alone,
  // and the other plan specs build fixtures with the bit already set.
  const buildContext = (devices: PlanContext['devices']): PlanCycle => buildPlanCycleObject({
    devices,
    total: FIXTURE_TOTAL_KW,
    hourBucketKey: '2026-07-25T12',
    softLimit: 10,
    capacitySoftLimit: 10,
    dailySoftLimit: null,
    budgetPaceKw: null,
    projectedExemptKw: null,
    softLimitSource: 'capacity',
    budgetReleasableHeadroomHold: false,
    capacityHeadroomKw: 1,
    budgetHeadroomKw: null,
    budgetKWh: 0,
    usedKWh: 0,
    minutesRemaining: 60,
    headroomRaw: 5,
    headroom: 5,
  });

  const deps: PlanDevicesDeps = {
    getInferredSurplusKw: () => 0,
    getShedBehavior: () => ({ action: 'turn_off' }),
    getPriceOptimizationSettings: () => ({}),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  };

  const buildFor = (externalOffHoldActive?: true): DevicePlanDevice => buildInitialPlanDevices({
    context: buildContext([buildPlanInputDevice({
      id: 'heater-1',
      name: 'Water heater',
      currentOn: false,
      controllable: true,
      managed: true,
      currentState: 'off',
      ...(externalOffHoldActive ? { externalOffHoldActive } : {}),
    })]),
    state: createPlanEngineState(),
    sheddingPlan: sheddingPlanFixture(),
    shortfall: { inShortfall: false },
    deps,
  })[0];

  it('carries the producer bit onto the plan device and makes it inactive', () => {
    const planDevice = buildFor(true);
    expect(planDevice.externalOffHoldActive).toBe(true);
    expect(planDevice.plannedState).toBe('inactive');
    expect(planDevice.reason).toEqual({ code: PLAN_REASON_CODES.externalOffHold });
  });

  it('leaves an unheld device alone', () => {
    const planDevice = buildFor();
    expect(planDevice.externalOffHoldActive).toBeUndefined();
    expect(planDevice.plannedState).not.toBe('inactive');
  });
});

// ─── Executor carve-outs: the plan-less-safe guard ────────────────────────────
//
// The planner exclusions above are not enough on their own. Every restore lane
// that can reach a device WITHOUT consulting the current plan has to carry the
// guard itself, or a stale/cold plan reaches around it. Mirrors the equivalent
// block in `surplusDumpLoadPlan.test.ts`.

const HEATER = 'heater-1';

const offHeaterSnapshot: TargetDeviceSnapshot = {
  id: HEATER,
  binaryCapabilityId: 'onoff',
  capabilities: ['onoff'],
  canSetControl: true,
  binaryControl: { on: false },
  available: true,
} as unknown as TargetDeviceSnapshot;

const buildExecutorCtx = (held: boolean) => {
  const state = createPlanEngineState(Date.now(), (deviceId: string) => held && deviceId === HEATER);
  const setCapabilityCalls: { capabilityId: string; value: boolean }[] = [];
  const observation = {
    getSnapshot: () => [offHeaterSnapshot],
    getSnapshotByDeviceId: (id: string) => (id === HEATER ? offHeaterSnapshot : undefined),
  };
  const ctx: PlanExecutorBinaryContext = {
    state,
    readDevice: observation.getSnapshotByDeviceId,
    capacityDryRun: false,
    buildBinaryControlTransport: () => ({
      getObservedBinaryControl: observation.getSnapshotByDeviceId,
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      actuator: createDeviceActuator({
        resolveTemperatureTarget: (_deviceId, desired) => desired,
        requestSteppedLoadStep: async () => ({ requested: false }),
        requestBinaryControl: async (_deviceId: string, desired: boolean) => {
          setCapabilityCalls.push({ capabilityId: 'onoff', value: desired });
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
  return { ctx, state, setCapabilityCalls };
};

const uncontrolledRestoreIntent = {
  desiredOn: true as const,
  deviceId: HEATER,
  name: 'Water heater',
  source: 'uncontrolled' as const,
};

describe('external-off hold — executor carve-outs', () => {
  it('never force-turns-ON a held device when control is switched off', async () => {
    // A shed PELS has not undone is still on record, but the device is off
    // under the owner's own hold too. Losing control authority is not consent
    // to undo the owner's off action.
    const h = buildExecutorCtx(true);
    h.state.shedDecisions.standingShedIds = new Set([HEATER]);

    const applied = await applyUncontrolledBinaryRestore(h.ctx, uncontrolledRestoreIntent, undefined);
    expect(applied).toBe(false);
    expect(h.setCapabilityCalls).toEqual([]);
  });

  it('blocks the controlled plan lane even against a plan built before the hold', async () => {
    const h = buildExecutorCtx(true);
    const applied = await applyBinaryRestoreWithSnapshot(h.ctx, HEATER, 'Water heater', offHeaterSnapshot);
    expect(applied).toBe(false);
    expect(h.setCapabilityCalls).toEqual([]);
  });

  it('control case: with no hold, every one of those lanes still restores', async () => {
    const uncontrolled = buildExecutorCtx(false);
    uncontrolled.state.shedDecisions.standingShedIds = new Set([HEATER]);
    expect(await applyUncontrolledBinaryRestore(uncontrolled.ctx, uncontrolledRestoreIntent, undefined))
      .toBe(true);
    expect(uncontrolled.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: true }]);

    const controlled = buildExecutorCtx(false);
    expect(await applyBinaryRestoreWithSnapshot(controlled.ctx, HEATER, 'Water heater', offHeaterSnapshot)).toBe(true);
    expect(controlled.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: true }]);
  });
});
