import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import { resolveCurrentOn } from '../observer/observedState';
import {
  hasSteppedCommand,
} from './executablePlan';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import {
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan, PlannedShedTargetKind } from '../plan/planTypes';
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
  ExecutableConvergenceDevice,
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
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
import { isTemperaturePlanDevice } from '../plan/planTemperatureDevice';
import { isSteppedLoadDevice } from '../plan/planSteppedLoad';

type PlanDevice = DevicePlan['devices'][number];
type PlanMeta = DevicePlan['meta'];

export function buildExecutablePlan(plan: DevicePlan): ExecutablePlan {
  return {
    devices: plan.devices.map((device) => buildExecutableDeviceIntentSafe(device, plan.meta)),
  };
}

export function buildExecutableDeviceIntent(planDevice: PlanDevice, planMeta?: PlanMeta): ExecutableDeviceIntent {
  const target = buildExecutableTargetIntent(planDevice);
  const binary = buildExecutableBinaryIntent(planDevice);
  const release = buildExecutableReleaseIntent(planDevice, planMeta);
  const steppedLoad = buildExecutableSteppedLoadIntent(planDevice);
  // Attach a command only for an axis the plan drives; absence IS the answer, so
  // no consumer re-derives it. See `ExecutableDeviceIntent`.
  return {
    id: planDevice.id,
    name: planDevice.name,
    controllable: planDevice.controllable,
    ...(target ? { target } : {}),
    ...(binary ? { binary } : {}),
    ...(release ? { release } : {}),
    ...(steppedLoad ? { steppedLoad } : {}),
  };
}

function buildExecutableDeviceIntentSafe(planDevice: PlanDevice, planMeta?: PlanMeta): ExecutableDeviceIntent {
  try {
    return buildExecutableDeviceIntent(planDevice, planMeta);
  } catch (error) {
    return {
      id: planDevice.id,
      name: planDevice.name,
      controllable: planDevice.controllable,
      projectionError: error,
    };
  }
}

/**
 * Projects a plan device onto the narrow convergence view
 * (`ExecutableConvergenceDevice`). This is the producer for that seam: it
 * resolves the plan's decided end state per axis here, once, so the convergence
 * predicates never see the plan device — nor the shed policy behind the
 * decision.
 */
export function buildExecutableConvergenceDevice(dev: PlanDevice): ExecutableConvergenceDevice {
  const shedTargetKind = dev.plannedShedTargetKind;
  return {
    id: dev.id,
    available: dev.available,
    observedState: dev.currentState,
    observedBinaryOn: isBinaryPlanDevice(dev) ? dev.currentOn : null,
    observedTarget: isTemperaturePlanDevice(dev) ? dev.currentTarget : null,
    observedStep: isSteppedLoadDevice(dev)
      ? { selectedStepId: dev.selectedStepId, reportedStepId: dev.reportedStepId }
      : null,
    desiredStepId: dev.desiredStepId,
    desiredBinaryState: resolveConvergenceDesiredBinaryState(dev, shedTargetKind),
    desiredTarget: resolveConvergenceDesiredTarget(dev, shedTargetKind),
  };
}

// The plan wants the binary axis OFF when that is where its shed lands, and ON
// for a managed device it is keeping. Anything else (a shed carried on the step
// or setpoint axis, an unmanaged device, a device with no binary axis this
// cycle) leaves the axis undemanded.
const resolveConvergenceDesiredBinaryState = (
  dev: PlanDevice,
  shedTargetKind: PlannedShedTargetKind | undefined,
): 'on' | 'off' | null => {
  if (shedTargetKind === 'binary_off') return 'off';
  if (shedTargetKind !== undefined) return null;
  // `keep` is required, not implied by the absent kind: an `inactive` device
  // (external-off and the other inactive holds) also carries no shed target, and
  // demanding `on` for one would leave convergence waiting on a restore the
  // executor never intends to issue.
  return dev.controllable && dev.plannedState === 'keep' && isBinaryPlanDevice(dev) ? 'on' : null;
};

// A setpoint is wanted whenever the device has a temperature axis, unless this
// cycle's shed lands on another axis — then the setpoint is not what execution
// is converging on.
const resolveConvergenceDesiredTarget = (
  dev: PlanDevice,
  shedTargetKind: PlannedShedTargetKind | undefined,
): number | null => {
  if (shedTargetKind !== undefined && shedTargetKind !== 'target_value') return null;
  return isTemperaturePlanDevice(dev) ? dev.plannedTarget : null;
};

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
  for (const [index, planDevice] of plan.devices.entries()) {
    if (planDevice.plannedState !== 'shed') continue;
    if (isDroppedUnderspecifiedSetStepShed(planDevice, executablePlan.devices[index])) continue;
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
  for (const [index, planDevice] of plan.devices.entries()) {
    if (!isDroppedUnderspecifiedSetStepShed(planDevice, executablePlan.devices[index])) continue;
    // eslint-disable-next-line functional/immutable-data -- Local accumulator over plan devices.
    result.push({
      deviceId: planDevice.id,
      deviceName: planDevice.name,
      selectedStepId: isSteppedLoadDevice(planDevice) ? planDevice.selectedStepId : null,
      desiredStepId: planDevice.desiredStepId ?? null,
    });
  }
  return result;
}

const isDroppedUnderspecifiedSetStepShed = (
  planDevice: PlanDevice,
  executableDevice: ExecutableDeviceIntent | undefined,
): boolean => (
  isSteppedLoadDevice(planDevice)
  && planDevice.plannedShedTargetKind === 'step'
  // A MISSING executable device is not a dropped shed — the old `?.steppedLoad
  // === null` answered false for `undefined`, and this arm feeds
  // `hasExecutableShedDevices`, which gates the keep-invariant stepped-restore
  // block. Only a device that IS projected and carries no step command counts.
  && executableDevice !== undefined
  && !hasSteppedCommand(executableDevice)
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
    available: snapshot.available,
    commandableNow: snapshot.commandableNow ?? resolveCommandableNow(snapshot),
    binaryControl: snapshot.binaryControl,
    observedBinaryAxis: isBinaryOnOrUnknown(snapshot) ? 'on' : 'off',
    observedEffectiveOn: resolveCurrentOn(snapshot),
    target: buildObservedTargetState(snapshot),
    steppedLoad: buildObservedSteppedLoadState(snapshot),
  };
}

// Stage 5: narrowed to the observed surface — reads only `targets`.
const buildObservedTargetState = (
  snapshot: Pick<ObservedDeviceState, 'targets'>,
): ExecutableObservedTargetState | null => {
  const primaryTarget = snapshot.targets?.[0];
  return primaryTarget
    ? {
      target: 'temperature',
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
  if (!isSteppedLoadSnapshot(snapshot)) return null;
  return {
    // The RAW axis, like `observedBinaryAxis` beside it: every reader of this
    // flag is on the actuation path (`buildCurrentState`, `shedReleaseActuation`)
    // and each already falls back to `isBinaryOnOrUnknown`. Convergence asks the
    // folded question through `observedEffectiveOn` instead.
    on: isBinaryOnOrUnknown(snapshot),
    stepId: snapshot.selectedStepId,
    reportedStepId: snapshot.reportedStepId,
    currentDrawKw: snapshot.currentDrawKw,
  };
};

const buildExecutableBinaryIntent = (dev: PlanDevice): ExecutableBinaryIntent | undefined => {
  if (isSteppedLoadDevice(dev)) return undefined;
  if (!isBinaryPlanDevice(dev)) return undefined;
  if (dev.controllable === false) {
    return dev.plannedState === 'keep'
      ? { deviceId: dev.id, name: dev.name, desiredOn: true, source: 'uncontrolled' }
      : undefined;
  }
  if (dev.plannedState === 'shed') {
    return buildExecutableBinaryShedIntent(dev);
  }
  if (dev.plannedState !== 'keep') return undefined;
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return undefined;
  return { deviceId: dev.id, name: dev.name, desiredOn: true, source: 'controlled' };
};

const buildExecutableBinaryShedIntent = (dev: PlanDevice): ExecutableBinaryIntent | undefined => {
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return undefined;
  // A shed whose end state is the setpoint has no binary intent to issue.
  if (dev.plannedShedTargetKind === 'target_value') return undefined;
  return {
    deviceId: dev.id,
    name: dev.name,
    desiredOn: false,
    // A shed never rides the managed -> unmanaged release path; that path only
    // ever turns a device back ON.
    source: 'controlled',
  };
};

const buildExecutableReleaseIntent = (
  dev: PlanDevice,
  planMeta?: PlanMeta,
): ExecutableReleaseIntent | undefined => {
  const kind = dev.deferredReleaseIntent;
  if (!kind) return undefined;
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
  // binary_restore is the only positive (turn-on) intent: require a MEASURED power
  // sample (avoid racing the capacity guard), the device kept, no pending swap target,
  // and a plan reason that does not block restore (capacity/cooldown/etc).
  //
  // Reads the producer-resolved `powerIsMeasured`, not the freshness label: this is
  // the same question `planBuilderDecoration` answers for the same intent, and testing
  // the label here answered it differently (a fresh timestamp with no total counted as
  // fresh). `undefined` on an older persisted plan means "do not block" — unchanged
  // from the previous optional-chained read.
  if (planMeta?.powerIsMeasured === false) return undefined;
  if (dev.plannedState !== 'keep') return undefined;
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isDeferredRestoreBlockedReason(dev.reason)) return undefined;
  return { kind, deviceId: dev.id, name: dev.name };
};
