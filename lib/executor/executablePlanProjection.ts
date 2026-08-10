import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import {
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import {
  isDeferredRestoreBlockedReason,
  isRestoreAdmissionHoldReason,
  isSwapTargetPendingReason,
} from '../planContract/planDecisionSemantics';
import type {
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  ObservedDeviceState,
  ReportedStepObservedProbe,
  SteppedLoadDecoration,
  SteppedLoadDescriptorProbe,
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
  ExecutorDeviceSnapshot,
} from './executablePlan';
import { getCurrentDrawKw } from '../observer/observedPower';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { buildExecutableSteppedLoadIntent } from './executableSteppedLoadProjection';
import { buildExecutableTargetIntent } from './executableTargetProjection';
import { isSteppedLoadDevice } from '../plan/planSteppedLoad';

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
  snapshots: ExecutorDeviceSnapshot[],
): ExecutableObservedState {
  return {
    devices: snapshots.map(buildExecutableObservedDeviceStateFromSnapshot),
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
    if (isSurplusOnlyHoldShed(planDevice)) continue;
    return true;
  }
  return false;
}

// A "Run on solar surplus" hold is an OPT-IN posture (the device's baseline is
// off), NOT capacity pressure — so it must NOT count toward the keep-invariant
// stepped-restore block (`applyKeepInvariantShedBlock`), which caps unrelated
// stepped loads at their lowest non-zero step while any device is shed for
// capacity. Discriminated on the `awaitingSolarSurplus` reason code (not the
// `surplusOnly` flag): a dump load that is genuinely capacity-shed carries a
// `capacity` reason and MUST still block. See `notes/state-management/`.
const isSurplusOnlyHoldShed = (planDevice: PlanDevice): boolean => (
  planDevice.reason?.code === PLAN_REASON_CODES.awaitingSolarSurplus
);

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
  && isSteppedLoadDevice(planDevice)
  && planDevice.shedAction === 'set_step'
  && executableDevice?.steppedLoad === null
  && !isHeldByRestoreAdmission(planDevice)
);

const isHeldByRestoreAdmission = (planDevice: PlanDevice): boolean => (
  Boolean(planDevice.reason && isRestoreAdmissionHoldReason(planDevice.reason))
);

/**
 * The executor's producer boundary for a RAW transport snapshot: resolve the
 * device's draw once, here, then build the observed state from the resolved
 * value. The raw `measuredPowerKw` reaches no further into this layer.
 *
 * It is a separate entry point rather than a resolution inside
 * `buildExecutableObservedDeviceState` because that function also serves the
 * drift path, which feeds a live `PlanInputDevice` — a shape with no
 * `measuredPowerKw` at all. Resolving inside would silently answer `0` for
 * every device on that path.
 */
export function buildExecutableObservedDeviceStateFromSnapshot(
  snapshot: ExecutorDeviceSnapshot & Pick<SteppedLoadDecoration, 'selectedStepId'>
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe & MeasuredPowerObservedProbe
    & EvObservedProbe
    & { currentOn?: boolean; commandableNow?: boolean },
): ExecutableObservedDeviceState {
  return buildExecutableObservedDeviceState({
    ...snapshot,
    currentDrawKw: getCurrentDrawKw(snapshot),
  });
}

export function buildExecutableObservedDeviceState(
  // Widened past the raw snapshot to carry the optional `selectedStepId`
  // decoration: the drift path feeds a live `PlanInputDevice` (decoration
  // present), the raw observed-state path feeds transport snapshots (absent).
  // Producer-fed funnel: also carries the stepped-descriptor + reported-step
  // probes the base type omits, which the stepped-load projection
  // (`buildObservedSteppedLoadState`) reads.
  //
  // `currentDrawKw` is REQUIRED: a plan device carries it, and a raw snapshot
  // gets it from `buildExecutableObservedDeviceStateFromSnapshot` above. Making
  // it optional here would let a caller drop it without a compile error, which
  // reads as "not drawing" and silently un-prices every unknown-step shed.
  snapshot: ExecutorDeviceSnapshot & Pick<SteppedLoadDecoration, 'selectedStepId'>
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
    & EvObservedProbe
    & { currentOn?: boolean; commandableNow?: boolean; currentDrawKw: number },
): ExecutableObservedDeviceState {
  return {
    id: snapshot.id,
    name: snapshot.name,
    snapshot,
    available: typeof snapshot.available === 'boolean' ? snapshot.available : null,
    commandableNow: snapshot.commandableNow ?? resolveCommandableNow(snapshot),
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
  // Prefer the producer-resolved `currentOn` — the drift path feeds a live plan
  // device that carries it (not the raw `binaryControl`); the raw-snapshot executor
  // path has no `currentOn`, so it falls back to the observed binary axis.
  snapshot: Pick<ObservedDeviceState, 'binaryControl'> & { currentOn?: boolean },
): 'on' | 'off' => {
  if (typeof snapshot.currentOn === 'boolean') return snapshot.currentOn ? 'on' : 'off';
  return isBinaryOnOrUnknown(snapshot) ? 'on' : 'off';
};

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
  // `buildExecutableObservedDeviceStateFromSnapshot` path it is always absent
  // (the transport snapshot carries no decoration), but on the drift path
  // (`planExecutionDrift` → live `PlanInputDevice`) it is the producer-resolved
  // effective step. The read must survive both, so widen past the raw snapshot.
  snapshot: ExecutorDeviceSnapshot & Pick<SteppedLoadDecoration, 'selectedStepId'>
    & ReportedStepObservedProbe & { currentOn?: boolean; currentDrawKw: number },
): ExecutableObservedSteppedLoadState | null => {
  if (snapshot.controlModel !== 'stepped_load') return null;
  return {
    on: typeof snapshot.currentOn === 'boolean' ? snapshot.currentOn : isBinaryOnOrUnknown(snapshot),
    stepId: snapshot.selectedStepId,
    reportedStepId: snapshot.reportedStepId,
    currentDrawKw: snapshot.currentDrawKw,
  };
};

const buildExecutableBinaryIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (isSteppedLoadDevice(dev)) return null;
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
  if (isSwapTargetPendingReason(dev.reason)) return null;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return null;
  return { kind: 'restore', deviceId: dev.id, name: dev.name, source: 'controlled' };
};

const buildExecutableBinaryShedIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (isSwapTargetPendingReason(dev.reason)) return null;
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

const buildExecutableReleaseIntent = (
  dev: PlanDevice,
  planMeta?: PlanMeta,
): ExecutableReleaseIntent | null => {
  const kind = dev.deferredReleaseIntent;
  if (!kind) return null;
  // The release intent is producer-resolved in deferred-objective admission. This per-cycle
  // projection only reconciles a binary_restore (resume) against the current cycle's planner
  // state — power-freshness (re-evaluated every cycle, incl. realtime reconcile) and the final
  // plan reason — via shared predicates in planDecisionSemantics. The actual executor
  // (planExecutor) then actuates the resulting intent flatly, without re-checking reasons.
  if (kind === 'shed_release') {
    // shed_release fires the device's configured shedBehavior; the executor resolves the
    // concrete actuation primitive (turn_off / set_temperature / set_step) at apply time.
    // `releaseShedStepId` is producer-resolved (see `resolveShedIntent`); the lifecycle-end
    // release path reads it for the stepped-no-binary case and falls back to binary off otherwise.
    return { kind, deviceId: dev.id, name: dev.name, releaseShedStepId: dev.releaseShedStepId };
  }
  if (kind === 'binary_release') return { kind, deviceId: dev.id, name: dev.name };
  // binary_restore is the only positive (turn-on) intent: require a fresh power sample
  // (avoid racing the capacity guard), the device kept, no pending swap target, and a plan
  // reason that does not block restore (capacity/cooldown/etc).
  if (planMeta?.powerFreshnessState && planMeta.powerFreshnessState !== 'fresh') return null;
  if (dev.plannedState !== 'keep') return null;
  if (isSwapTargetPendingReason(dev.reason)) return null;
  if (dev.reason && isDeferredRestoreBlockedReason(dev.reason)) return null;
  return { kind, deviceId: dev.id, name: dev.name };
};
