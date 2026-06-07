import {
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import type {
  ObservedDeviceState,
  SteppedLoadDecoration,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type {
  ExecutableBinaryIntent,
  ExecutableDeviceIntent,
  ExecutableObservedDeviceState,
  ExecutableObservedState,
  ExecutableObservedSteppedLoadState,
  ExecutableObservedTargetState,
  ExecutablePlan,
  ExecutableReleaseIntent,
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
    release: buildExecutableReleaseIntent(planDevice, planMeta),
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
      release: null,
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
  // Widened past the raw snapshot to carry the optional `selectedStepId`
  // decoration: the drift path feeds a live `PlanInputDevice` (decoration
  // present), the raw observed-state path feeds transport snapshots (absent).
  snapshot: TargetDeviceSnapshot & Pick<SteppedLoadDecoration, 'selectedStepId'>,
): ExecutableObservedDeviceState {
  return {
    id: snapshot.id,
    name: snapshot.name,
    snapshot,
    available: typeof snapshot.available === 'boolean' ? snapshot.available : null,
    binaryControl: snapshot.binaryControl,
    observedBinaryState: resolveObservedBinaryStateFromSnapshot(snapshot),
    target: buildObservedTargetState(snapshot),
    steppedLoad: buildObservedSteppedLoadState(snapshot),
  };
}

/**
 * The executor acts on the producer-resolved `currentOn` directly. Observation
 * freshness/staleness is deliberately NOT consulted here: staleness only matters
 * to the planner (to avoid over-committing capacity against stale data — an
 * overshoot it can pre-empt); the executor just actuates against the observed
 * value. So this never returns `'unknown'` — that state existed only to carry the
 * old `binaryControlObservation` "no trusted evidence" signal.
 */
export const resolveObservedBinaryStateFromSnapshot = (
  // Stage 5: narrowed to the observed surface — reads only `binaryControl`.
  snapshot: Pick<ObservedDeviceState, 'binaryControl'>,
): 'on' | 'off' => ((snapshot.binaryControl?.on ?? true) ? 'on' : 'off');

// Stage 5: narrowed to the observed surface — reads only `targets`.
const buildObservedTargetState = (
  snapshot: Pick<ObservedDeviceState, 'targets'>,
): ExecutableObservedTargetState | null => {
  const primaryTarget = snapshot.targets?.[0];
  return primaryTarget
    ? {
      targetCap: primaryTarget.id,
      observedValue: primaryTarget.value,
    }
    : null;
};

const buildObservedSteppedLoadState = (
  // Accepts the optional `selectedStepId` decoration: on the raw
  // `buildExecutableObservedState(snapshots)` path it is always absent (the
  // transport snapshot carries no decoration), but on the drift path
  // (`planExecutionDrift` → live `PlanInputDevice`) it is the producer-resolved
  // effective step. The read must survive both, so widen past the raw snapshot.
  snapshot: TargetDeviceSnapshot & Pick<SteppedLoadDecoration, 'selectedStepId'>,
): ExecutableObservedSteppedLoadState | null => {
  if (snapshot.controlModel !== 'stepped_load') return null;
  return {
    on: snapshot.binaryControl?.on ?? true,
    stepId: snapshot.selectedStepId,
    reportedStepId: snapshot.reportedStepId,
    measuredPowerKw: snapshot.measuredPowerKw,
  };
};

const buildExecutableBinaryIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (dev.controlModel === 'stepped_load') return null;
  if (dev.controlCapabilityId === undefined) return null;
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

const buildExecutableReleaseIntent = (
  dev: PlanDevice,
  planMeta?: PlanMeta,
): ExecutableReleaseIntent | null => {
  const kind = dev.deferredReleaseIntent;
  if (!kind) return null;
  // The release intent is producer-resolved in deferred-objective admission, keyed on
  // objectiveKind which is 1:1 with device type (`ev_soc` → EV charger → binary_*;
  // `temperature` → thermostat → shed_release). The executor trusts the intent and does
  // NOT re-derive EV-ness: `shed_release` never targets an EV device and `binary_*` always
  // does, so the old `isEvDevice` guards here were unreachable. See the invariant note at
  // `resolveReleaseIntentForCapOff` in lib/objectives/deferredObjectives/admission.ts.
  if (kind === 'shed_release') {
    // shed_release fires the device's configured shedBehavior; the executor resolves the
    // concrete actuation primitive (turn_off / set_temperature / set_step) at apply time.
    // `releaseShedStepId` is producer-resolved (see `resolveShedIntent`); the lifecycle-end
    // release path reads it for the stepped-no-binary case and falls back to binary off otherwise.
    return { kind, deviceId: dev.id, name: dev.name, releaseShedStepId: dev.releaseShedStepId };
  }
  if (kind === 'binary_release') return { kind, deviceId: dev.id, name: dev.name };
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
