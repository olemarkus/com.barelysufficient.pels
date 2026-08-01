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
import { describe, expect, it, vi } from 'vitest';
import {
  applyUncontrolledBinaryRestore,
  type PlanExecutorBinaryContext,
} from '../../lib/executor/binaryExecutor';
import {
  applyBinaryRestoreWithSnapshot,
  applyCapacityControlOffRestoreWithSnapshot,
} from '../../lib/executor/binaryRestoreHelpers';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { DeviceObservation } from '../../lib/device/deviceObservation';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  getInactiveReason,
  getRestoreCandidates,
  isBinaryRestoreCandidate,
  isRestoreLiveEligibleDevice,
} from '../../lib/plan/restore/devices';
import { applyOffStateReason } from '../../lib/plan/planOffStateReason';
import {
  isDeferredRestoreBlockedReason,
  resolveStarvationSuppressionSemantics,
} from '../../lib/planContract/planDecisionSemantics';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { withBinaryDiscriminant, type DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice } from '../utils/planTestUtils';
import { buildPlanInputDevice } from '../helpers/buildPlanInputDevice';
import { buildInitialPlanDevices, type PlanDevicesDeps } from '../../lib/plan/planDevices';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { PlanContext } from '../../lib/plan/planContext';

const makeDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => (
  withBinaryDiscriminant({
    ...buildPlanDevice({
      id: 'heater-1',
      currentState: 'off',
      controlCapabilityId: 'onoff',
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
    expect(isBinaryRestoreCandidate(heldDevice())).toBe(false);
  });

  it('leaves an unheld off device restorable, so existing behaviour is unchanged', () => {
    expect(isRestoreLiveEligibleDevice(makeDevice())).toBe(true);
    expect(isBinaryRestoreCandidate(makeDevice())).toBe(true);
  });

  it('drops the held device from restore candidates while keeping its peers', () => {
    const candidates = getRestoreCandidates([
      heldDevice({ id: 'held' }),
      makeDevice({ id: 'free' }),
    ]);
    expect(candidates.map((candidate) => candidate.device.id)).toEqual(['free']);
  });
});

describe('external-off hold — plan reason', () => {
  it('reports its own semantic reason rather than a generic inactive detail', () => {
    expect(getInactiveReason(heldDevice())).toEqual({ code: PLAN_REASON_CODES.externalOffHold });
  });

  it('marks the device inactive during materialization', () => {
    const result = applyOffStateReason({
      planDevice: heldDevice(),
      headroomRaw: 5,
      guardInShortfall: false,
    });
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
        controlCapabilityId: 'evcharger_charging',
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
  // Without this the whole suite is blind to a dropped `pickPropagatedPlanFields`
  // line: the e2e's "never resumes" assertion passes on the executor guard alone,
  // and the other plan specs build fixtures with the bit already set.
  const buildContext = (devices: PlanContext['devices']): PlanContext => ({
    devices,
    desiredForMode: {},
    total: 1,
    powerKnown: true,
    hasLivePowerSample: true,
    powerSampleAgeMs: 0,
    powerFreshnessState: 'fresh',
    hourBucketKey: '2026-07-25T12',
    softLimit: 10,
    capacitySoftLimit: 10,
    dailySoftLimit: null,
    softLimitSource: 'capacity',
    budgetReleasableHeadroomHold: false,
    budgetKWh: 0,
    usedKWh: 0,
    minutesRemaining: 60,
    headroomRaw: 5,
    headroom: 5,
    restoreMarginPlanning: 0.2,
  });

  const deps: PlanDevicesDeps = {
    getPriorityForDevice: () => 100,
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getPriceOptimizationEnabled: () => false,
    getPriceOptimizationSettings: () => ({}),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  };

  const buildFor = (externalOffHoldActive?: true): DevicePlanDevice => buildInitialPlanDevices({
    context: buildContext([buildPlanInputDevice({
      id: 'heater-1',
      name: 'Water heater',
      controlCapabilityId: 'onoff',
      controllable: true,
      managed: true,
      currentState: 'off',
      ...(externalOffHoldActive ? { externalOffHoldActive } : {}),
    })]),
    state: createPlanEngineState(),
    shedSet: new Set<string>(),
    shedReasons: new Map(),
    guardInShortfall: false,
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
  controlCapabilityId: 'onoff',
  capabilities: ['onoff'],
  canSetControl: true,
  binaryControl: { on: false },
  available: true,
} as unknown as TargetDeviceSnapshot;

const buildExecutorCtx = (held: boolean) => {
  const state = createPlanEngineState();
  state.isExternalOffHeld = (deviceId: string) => held && deviceId === HEATER;
  const setCapabilityCalls: { capabilityId: string; value: boolean }[] = [];
  const observation = {
    getSnapshot: () => [offHeaterSnapshot],
    getSnapshotByDeviceId: (id: string) => (id === HEATER ? offHeaterSnapshot : undefined),
  } as unknown as DeviceObservation;
  const ctx: PlanExecutorBinaryContext = {
    state,
    observation,
    capacityDryRun: false,
    buildBinaryControlTransport: () => ({
      observation,
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      actuator: createDeviceActuator({
        setCapability: async (_deviceId: string, capabilityId: string, value: unknown) => {
          setCapabilityCalls.push({ capabilityId, value: value as boolean });
          return undefined;
        },
        applyDeviceTargets: () => Promise.resolve(),
        triggerFlowBackedBinaryControl: () => Promise.reject(new Error('flow binary not expected here')),
      }),
    }),
    getRestoreLogSource: () => 'shed_state',
    recordShedActuation: vi.fn(),
    recordReleaseShedActuation: vi.fn(),
    recordRestoreActuation: vi.fn(),
  };
  return { ctx, state, setCapabilityCalls };
};

const uncontrolledRestoreIntent = {
  kind: 'restore' as const,
  deviceId: HEATER,
  name: 'Water heater',
  source: 'uncontrolled' as const,
};

describe('external-off hold — executor carve-outs', () => {
  it('never force-turns-ON a held device when it is unmanaged or control is switched off', async () => {
    // The shape that gets here: PELS shed the device at some point (so
    // `shedDecidedMs` is still stamped), the user then turned it off themselves,
    // and only then was Power-limit control disabled. Losing control authority is
    // not consent to undo the user's own off action.
    const h = buildExecutorCtx(true);
    h.state.shedDecidedMs[HEATER] = 1000;

    const applied = await applyUncontrolledBinaryRestore(h.ctx, uncontrolledRestoreIntent, undefined);
    expect(applied).toBe(false);
    expect(h.setCapabilityCalls).toEqual([]);
  });

  it('honours the hold in the capacity-control-off funnel too (second lane)', async () => {
    const h = buildExecutorCtx(true);
    const applied = await applyCapacityControlOffRestoreWithSnapshot(h.ctx, {
      deviceId: HEATER,
      name: 'Water heater',
      snapshot: offHeaterSnapshot,
    });
    expect(applied).toBe(false);
    expect(h.setCapabilityCalls).toEqual([]);
  });

  it('blocks the controlled plan lane even against a plan built before the hold', async () => {
    const h = buildExecutorCtx(true);
    const applied = await applyBinaryRestoreWithSnapshot(h.ctx, {
      deviceId: HEATER,
      name: 'Water heater',
      snapshot: offHeaterSnapshot,
      logContext: 'capacity',
      mode: 'plan',
    });
    expect(applied).toBe(false);
    expect(h.setCapabilityCalls).toEqual([]);
  });

  it('control case: with no hold, every one of those lanes still restores', async () => {
    const uncontrolled = buildExecutorCtx(false);
    uncontrolled.state.shedDecidedMs[HEATER] = 1000;
    expect(await applyUncontrolledBinaryRestore(uncontrolled.ctx, uncontrolledRestoreIntent, undefined))
      .toBe(true);
    expect(uncontrolled.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: true }]);

    const capacityControlOff = buildExecutorCtx(false);
    expect(await applyCapacityControlOffRestoreWithSnapshot(capacityControlOff.ctx, {
      deviceId: HEATER,
      name: 'Water heater',
      snapshot: offHeaterSnapshot,
    })).toBe(true);
    expect(capacityControlOff.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: true }]);

    const controlled = buildExecutorCtx(false);
    expect(await applyBinaryRestoreWithSnapshot(controlled.ctx, {
      deviceId: HEATER,
      name: 'Water heater',
      snapshot: offHeaterSnapshot,
      logContext: 'capacity',
      mode: 'plan',
    })).toBe(true);
    expect(controlled.setCapabilityCalls).toEqual([{ capabilityId: 'onoff', value: true }]);
  });
});
