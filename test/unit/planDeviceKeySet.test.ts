import { describe, expect, it } from 'vitest';
import { buildBasePlanDevice } from '../../lib/plan/planDevicesBase';
import { buildPlanInputDevice, steppedInputDevice, steppedProfile } from '../utils/planTestUtils';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { PlanInputDevice, ShedBehavior } from '../../lib/plan/planTypes';

/**
 * What a consumer SEES on a plan device, keyed on presence rather than value.
 *
 * `withBinaryDiscriminant` / `withTemperatureDiscriminant` /
 * `withSteppedDiscriminant` branch on whether a key is there, and so do several
 * readers downstream. That makes the key set — not the values — the contract
 * `buildBasePlanDevice` owes, and the one thing a refactor of its construction
 * can break while every value assertion in the suite still passes. So this pins
 * the set exactly: a new key, a dropped key, or a key that changes which kinds
 * carry it all fail here.
 *
 * A key present with an `undefined` VALUE is present. That is deliberate
 * throughout the builder (`deviceClass`, the step bookkeeping, `controlAdapter`,
 * `binaryCommandPending`), and `Object.keys` sees it the same way `in` does.
 */
const ALWAYS: readonly string[] = [
  'available', 'binaryCommandPending', 'boostActive', 'budgetExempt', 'commandableNow',
  'control', 'controlAdapter', 'currentDrawKw',
  // Every input device is binary-capable — the producer resolves `currentOn`
  // for all of them at `toPlanDevice` — so the binary cluster is universal in
  // practice even though `isBinaryPlanDevice` gates it.
  'currentOn',
  'currentState', 'desiredStepId', 'deviceClass', 'deviceRole', 'deviceType',
  'expectedPowerKw', 'expectedPowerSource', 'hasStandingDemand', 'id',
  'lastDesiredStepId', 'lastStepCommandIssuedAt', 'name', 'nextStepCommandRetryAtMs',
  'plannedState', 'previousStepId', 'priority', 'reason', 'recordRestoreOnTargetApply',
  'releaseShedStepId', 'reportedStepId', 'residualKw', 'shedAction', 'shedTemperature',
  'stepCommandPending', 'stepCommandRetryCount', 'stepCommandStatus', 'surplusAbsorbActive',
  'surplusTracking', 'targetStepId', 'zone',
];

const TEMPERATURE_CLUSTER = ['currentTarget', 'currentTemperature', 'plannedTarget'];
const STEPPED_CLUSTER = ['steppedLoadProfile', 'selectedStepId', 'planningPowerKw'];

type Kind = {
  label: string;
  dev: PlanInputDevice;
  /** Keys this kind carries ON TOP of `ALWAYS`. */
  conditional: readonly string[];
  shed?: boolean;
  behavior?: ShedBehavior;
  boost?: boolean;
  surplus?: boolean;
  ceiling?: string;
  restored?: boolean;
  pending?: boolean;
  otherLimited?: boolean;
  target?: number;
  stepTarget?: string;
};

const SET_STEP: ShedBehavior = { action: 'set_step' };
const TURN_OFF: ShedBehavior = { action: 'turn_off' };
const SET_TEMPERATURE: ShedBehavior = { action: 'set_temperature', temperature: 16 };

const kinds: Kind[] = [
  {
    label: 'a binary heater that keeps',
    dev: buildPlanInputDevice({ id: 'b1', name: 'B', binaryControl: { on: true }, expectedPowerKw: 1.2, currentDrawKw: 1.2 }),
    conditional: [],
  },
  {
    label: 'a binary heater that is limited',
    dev: buildPlanInputDevice({ id: 'b2', name: 'B2', binaryControl: { on: true }, expectedPowerKw: 1.2, currentDrawKw: 1.2 }),
    shed: true, conditional: [],
  },
  {
    label: 'a binary heater just resumed, with a command in flight',
    dev: buildPlanInputDevice({ id: 'b3', name: 'B3', binaryControl: { on: false }, expectedPowerKw: 1.2, currentDrawKw: 0 }),
    restored: true, pending: true, conditional: [],
  },
  {
    label: 'a thermostat that keeps',
    dev: buildPlanInputDevice({
      id: 't1', name: 'T', deviceType: 'temperature', currentTarget: 21, currentTemperature: 20,
      expectedPowerKw: 0.8, currentDrawKw: 0.8,
    }),
    behavior: SET_TEMPERATURE, target: 21, conditional: TEMPERATURE_CLUSTER,
  },
  {
    label: 'a thermostat lowered to its floor',
    dev: buildPlanInputDevice({
      id: 't2', name: 'T2', deviceType: 'temperature', currentTarget: 21, currentTemperature: 20,
      expectedPowerKw: 0.8, currentDrawKw: 0.8,
    }),
    shed: true, behavior: SET_TEMPERATURE, target: 21, conditional: TEMPERATURE_CLUSTER,
  },
  {
    label: 'a stepped load at its top rung',
    dev: steppedInputDevice({ id: 's1', name: 'S', steppedLoadProfile: steppedProfile, selectedStepId: 'max', currentDrawKw: 3 }),
    behavior: SET_STEP, conditional: STEPPED_CLUSTER,
  },
  {
    label: 'a stepped load lowered to a named rung',
    dev: steppedInputDevice({ id: 's2', name: 'S2', steppedLoadProfile: steppedProfile, selectedStepId: 'max', currentDrawKw: 3 }),
    shed: true, behavior: SET_STEP, stepTarget: 'low', otherLimited: true,
    conditional: [...STEPPED_CLUSTER, 'plannedShedStepId'],
  },
  {
    label: 'a stepped load already sitting at its off rung',
    dev: steppedInputDevice({
      id: 's3', name: 'S3', steppedLoadProfile: steppedProfile, selectedStepId: 'off',
      binaryControl: { on: false }, currentDrawKw: 0,
    }),
    shed: true, behavior: SET_STEP, conditional: [...STEPPED_CLUSTER, 'plannedShedStepId'],
  },
  {
    label: 'a stepped load capped by this cycle’s surplus ceiling',
    dev: steppedInputDevice({ id: 's4', name: 'S4', steppedLoadProfile: steppedProfile, selectedStepId: 'low', currentDrawKw: 1.25 }),
    behavior: SET_STEP, surplus: true, ceiling: 'medium', conditional: STEPPED_CLUSTER,
  },
  {
    label: 'a device that only runs on solar surplus',
    dev: buildPlanInputDevice({
      id: 'p1', name: 'P', binaryControl: { on: true }, surplusOnly: true, expectedPowerKw: 1, currentDrawKw: 1,
    }),
    boost: true, conditional: ['surplusOnly'],
  },
  {
    label: 'a device only PELS may start, still held',
    dev: buildPlanInputDevice({
      id: 'sp1', name: 'SP', binaryControl: { on: true }, startPolicy: 'pels_only',
      expectedPowerKw: 1.4, currentDrawKw: 1.4,
    }),
    shed: true, behavior: SET_STEP, conditional: ['startPolicyHoldActive'],
  },
  {
    label: 'a device only PELS may start, lifted by a smart task',
    dev: buildPlanInputDevice({
      id: 'sp2', name: 'SP2', binaryControl: { on: true }, startPolicy: 'pels_only',
      startPolicyHoldLifted: true, expectedPowerKw: 1.4, currentDrawKw: 1.4,
    }),
    shed: true, behavior: SET_STEP, conditional: [],
  },
  {
    label: 'an EV charger with calibrated rungs and an unplugged cable',
    dev: steppedInputDevice({
      id: 'ev1', name: 'EV', deviceRole: 'ev_charger', steppedLoadProfile: steppedProfile,
      selectedStepId: 'medium', currentDrawKw: 2,
      stepPowerCalibration: { low: 1180, medium: 1950, max: 2900 },
      objectiveKind: 'ev_soc', commandabilityReason: 'charger_unplugged',
      reservesStartupPower: true, surplusTracking: true,
    }),
    behavior: SET_STEP,
    conditional: [...STEPPED_CLUSTER, 'stepPowerCalibration', 'objectiveKind', 'commandabilityReason', 'reservesStartupPower'],
  },
  {
    label: 'a binary device tracking surplus for a temperature objective',
    dev: buildPlanInputDevice({
      id: 'st1', name: 'ST', binaryControl: { on: true }, surplusTracking: true,
      objectiveKind: 'temperature', expectedPowerKw: 2, currentDrawKw: 2,
    }),
    surplus: true, conditional: ['objectiveKind'],
  },
  {
    label: 'a device with power limiting turned off',
    dev: buildPlanInputDevice({
      id: 'u1', name: 'U', binaryControl: { on: true }, controllable: false, commandAuthority: false,
      expectedPowerKw: 1, currentDrawKw: 1,
    }),
    conditional: [],
  },
  {
    label: 'a device turned off outside PELS',
    dev: buildPlanInputDevice({
      id: 'e1', name: 'E', binaryControl: { on: false }, externalOffHoldActive: true,
      expectedPowerKw: 1, currentDrawKw: 0,
    }),
    conditional: ['externalOffHoldActive'],
  },
];

const buildFor = (kind: Kind): Record<string, unknown> => {
  const shedReasons = new Map<string, DeviceReason>();
  if (kind.shed === true) shedReasons.set(kind.dev.id, { code: PLAN_REASON_CODES.capacity });
  const shedStepTargets = new Map<string, string>();
  if (kind.stepTarget !== undefined) shedStepTargets.set(kind.dev.id, kind.stepTarget);
  return buildBasePlanDevice({
    dev: kind.dev,
    priority: 3,
    recentlyRestored: kind.restored === true,
    binaryCommandPending: kind.pending === true,
    currentState: kind.dev.currentState ?? 'on',
    plannedTarget: kind.target,
    control: kind.dev.control,
    shedBehavior: kind.behavior ?? TURN_OFF,
    shedSet: new Set<string>(kind.shed === true ? [kind.dev.id] : []),
    shedStepTargets,
    anyOtherDeviceLimited: kind.otherLimited === true,
    shedReasons,
    boostActive: kind.boost === true,
    surplusAbsorbActive: kind.surplus === true,
    surplusCeilingStepId: kind.ceiling,
  }) as unknown as Record<string, unknown>;
};

describe('buildBasePlanDevice — the key set a consumer sees', () => {
  for (const kind of kinds) {
    it(`${kind.label} carries exactly its kind's keys`, () => {
      expect(Object.keys(buildFor(kind)).sort()).toEqual([...ALWAYS, ...kind.conditional].sort());
    });
  }

  // The runtime half of what `SteppedClusterFields` / `TemperatureClusterFields`
  // enforce at compile time. Both halves matter: the types catch the producer
  // that drops a field, this catches a condition that splits the cluster.
  it('never carries a cluster in half', () => {
    const partial: string[] = [];
    for (const kind of kinds) {
      const keys = new Set(Object.keys(buildFor(kind)));
      for (const cluster of [TEMPERATURE_CLUSTER, STEPPED_CLUSTER]) {
        const present = cluster.filter((key) => keys.has(key));
        if (present.length !== 0 && present.length !== cluster.length) {
          partial.push(`${kind.label}: ${present.join(', ')}`);
        }
      }
    }
    expect(partial).toEqual([]);
  });
});
