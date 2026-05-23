import {
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type {
  ExecutableBinaryIntent,
  ExecutableDeviceIntent,
  ExecutableEvIntent,
  ExecutableObservedDeviceState,
  ExecutableObservedState,
  ExecutableObservedSteppedLoadState,
  ExecutableObservedTargetState,
  ExecutablePlan,
} from './executablePlan';
import { buildExecutableSteppedLoadIntent } from './executableSteppedLoadProjection';
import { buildExecutableTargetIntent } from './executableTargetProjection';

type PlanDevice = DevicePlan['devices'][number];
type PlanMeta = DevicePlan['meta'];

export function buildExecutablePlan(plan: DevicePlan): ExecutablePlan {
  return {
    devices: plan.devices.map((device) => buildExecutableDeviceIntentSafe(device, plan.meta)),
  };
}

export function buildExecutableDeviceIntent(planDevice: PlanDevice, planMeta?: PlanMeta): ExecutableDeviceIntent {
  return {
    id: planDevice.id,
    name: planDevice.name,
    controllable: planDevice.controllable !== false,
    target: buildExecutableTargetIntent(planDevice),
    binary: buildExecutableBinaryIntent(planDevice),
    ev: buildExecutableEvIntent(planDevice, planMeta),
    steppedLoad: buildExecutableSteppedLoadIntent(planDevice),
  };
}

function buildExecutableDeviceIntentSafe(planDevice: PlanDevice, planMeta?: PlanMeta): ExecutableDeviceIntent {
  try {
    return buildExecutableDeviceIntent(planDevice, planMeta);
  } catch (error) {
    return {
      id: planDevice.id,
      name: planDevice.name,
      controllable: planDevice.controllable !== false,
      target: null,
      binary: null,
      ev: null,
      steppedLoad: null,
      projectionError: error,
    };
  }
}

export function buildExecutableObservedState(
  snapshots: TargetDeviceSnapshot[],
): ExecutableObservedState {
  return {
    devices: snapshots.map(buildExecutableObservedDeviceState),
  };
}

/**
 * Executor-facing shed posture for the keep-invariant gate.
 *
 * Counts any planner-shed device EXCEPT the underspecified stepped `set_step` case where
 * the executor projection cannot resolve a target step. Devices held off by restore
 * admission (cooldown / meter settling) still count as shed posture: they are currently
 * shed, just temporarily uncommandable. Excluding only the phantom underspecified
 * `set_step` drop prevents it from blocking unrelated stepped restores at the lowest
 * non-zero step, without losing posture for legitimate held-shed devices.
 */
export function hasExecutableShedDevices(
  plan: DevicePlan,
  executablePlan: ExecutablePlan,
): boolean {
  for (let i = 0; i < plan.devices.length; i += 1) {
    const planDevice = plan.devices[i];
    if (planDevice.plannedState !== 'shed') continue;
    if (isDroppedUnderspecifiedSetStepShed(planDevice, executablePlan.devices[i])) continue;
    return true;
  }
  return false;
}

export type DroppedSteppedShedIntent = {
  deviceId: string;
  deviceName: string;
  shedAction: PlanDevice['shedAction'];
  selectedStepId: string | null;
  desiredStepId: string | null;
};

/**
 * Stepped-load shed intents the planner emitted that the executor projection dropped
 * specifically because the `set_step` target step could not be resolved. Surfacing these
 * makes the silent drop detectable in production with a reliable reason code.
 *
 * Other null-projection causes (restore admission hold, malformed profiles) are
 * intentionally excluded so the `underspecified_set_step` diagnostic stays meaningful.
 */
export function findDroppedSteppedShedIntents(
  plan: DevicePlan,
  executablePlan: ExecutablePlan,
): DroppedSteppedShedIntent[] {
  const result: DroppedSteppedShedIntent[] = [];
  for (let i = 0; i < plan.devices.length; i += 1) {
    const planDevice = plan.devices[i];
    if (!isDroppedUnderspecifiedSetStepShed(planDevice, executablePlan.devices[i])) continue;
    // eslint-disable-next-line functional/immutable-data -- Local accumulator over plan devices.
    result.push({
      deviceId: planDevice.id,
      deviceName: planDevice.name,
      shedAction: planDevice.shedAction,
      selectedStepId: planDevice.selectedStepId ?? null,
      desiredStepId: planDevice.desiredStepId ?? null,
    });
  }
  return result;
}

const isDroppedUnderspecifiedSetStepShed = (
  planDevice: PlanDevice,
  executableDevice: ExecutableDeviceIntent | undefined,
): boolean => (
  planDevice.plannedState === 'shed'
  && planDevice.controlModel === 'stepped_load'
  && planDevice.shedAction === 'set_step'
  && executableDevice?.steppedLoad === null
  && !isHeldByRestoreAdmission(planDevice)
);

const isHeldByRestoreAdmission = (planDevice: PlanDevice): boolean => (
  Boolean(planDevice.reason && isRestoreAdmissionHoldReason(planDevice.reason))
);

export function buildExecutableObservedDeviceState(
  snapshot: TargetDeviceSnapshot,
): ExecutableObservedDeviceState {
  return {
    id: snapshot.id,
    name: snapshot.name,
    snapshot,
    available: typeof snapshot.available === 'boolean' ? snapshot.available : null,
    currentOn: snapshot.currentOn,
    observedBinaryState: resolveObservedBinaryStateFromSnapshot(snapshot),
    target: buildObservedTargetState(snapshot),
    steppedLoad: buildObservedSteppedLoadState(snapshot),
  };
}

/**
 * Trusted binary evidence is carried by `binaryControlObservation` (set by the
 * snapshot parser whenever a real `onoff`/`evcharger_charging` value or
 * `evcharger_charging_state` is present). When that evidence is absent, the
 * snapshot's `currentOn` is a default — never a real observation — so the
 * projection reports the binary state as `'unknown'`.
 */
const resolveObservedBinaryStateFromSnapshot = (
  snapshot: TargetDeviceSnapshot,
): 'on' | 'off' | 'unknown' => {
  const observation = snapshot.binaryControlObservation;
  if (!observation) return 'unknown';
  return observation.observedValue ? 'on' : 'off';
};

const buildObservedTargetState = (snapshot: TargetDeviceSnapshot): ExecutableObservedTargetState | null => {
  const primaryTarget = snapshot.targets?.[0];
  return primaryTarget
    ? {
      targetCap: primaryTarget.id,
      observedValue: primaryTarget.value,
    }
    : null;
};

const buildObservedSteppedLoadState = (
  snapshot: TargetDeviceSnapshot,
): ExecutableObservedSteppedLoadState | null => {
  if (snapshot.controlModel !== 'stepped_load') return null;
  return {
    on: snapshot.currentOn,
    stepId: snapshot.selectedStepId,
    reportedStepId: snapshot.reportedStepId,
    actualStepId: snapshot.actualStepId,
    actualStepSource: snapshot.actualStepSource,
    assumedStepId: snapshot.assumedStepId,
    measuredPowerKw: snapshot.measuredPowerKw,
  };
};

const buildExecutableBinaryIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (dev.controlModel === 'stepped_load') return null;
  if (dev.hasBinaryControl === false) return null;
  if (dev.controllable === false) {
    return dev.plannedState === 'keep'
      ? { kind: 'restore', deviceId: dev.id, name: dev.name, source: 'uncontrolled' }
      : null;
  }
  if (dev.plannedState === 'shed') {
    return buildExecutableBinaryShedIntent(dev);
  }
  if (dev.plannedState !== 'keep') return null;
  if (isSwapTargetPendingReason(dev)) return null;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return null;
  return { kind: 'restore', deviceId: dev.id, name: dev.name, source: 'controlled' };
};

const buildExecutableBinaryShedIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (isSwapTargetPendingReason(dev)) return null;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return null;
  if ((dev.shedAction ?? 'turn_off') === 'set_temperature') return null;
  const isSwap = dev.reason?.code === PLAN_REASON_CODES.swappedOut;
  return {
    kind: 'shed',
    deviceId: dev.id,
    name: dev.name,
    reason: isSwap && dev.reason ? formatDeviceReason(dev.reason) : undefined,
  };
};

const isSwapTargetPendingReason = (dev: PlanDevice): boolean => (
  dev.reason?.code === PLAN_REASON_CODES.swapPending && dev.reason.targetName === null
);

const buildExecutableEvIntent = (dev: PlanDevice, planMeta?: PlanMeta): ExecutableEvIntent | null => {
  const kind = dev.deferredEvCommandIntent;
  if (!kind) return null;
  if (dev.deviceClass !== 'evcharger' && dev.controlCapabilityId !== 'evcharger_charging') return null;
  if (kind === 'ev_pause') return { kind, deviceId: dev.id, name: dev.name };
  if (planMeta?.powerFreshnessState && planMeta.powerFreshnessState !== 'fresh') return null;
  if (dev.plannedState !== 'keep') return null;
  if (isSwapTargetPendingReason(dev)) return null;
  if (dev.reason && isEvResumeBlockedReason(dev.reason)) return null;
  return { kind, deviceId: dev.id, name: dev.name };
};

const EV_RESUME_BLOCK_REASON_CODES = new Set<string>([
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.headroomCooldown,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.shedInvariant,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.waitingForOtherDevices,
]);

const isEvResumeBlockedReason = (reason: NonNullable<PlanDevice['reason']>): boolean => (
  EV_RESUME_BLOCK_REASON_CODES.has(reason.code)
);
