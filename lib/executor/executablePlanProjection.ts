import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import { resolveCurrentOn } from '../observer/observedState';
import {
  hasSteppedCommand,
} from './executablePlan';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import {
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import {
  isDeferredRestoreBlockedReason,
  isRestoreAdmissionHoldReason,
  isSwapTargetPendingReason,
} from '../planContract/planDecisionSemantics';
import type {
  ObservedDeviceState,
  SteppedLoadDecoration,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type {
  ExecutableBinaryIntent,
  ExecutableDeviceIntent,
  ExecutableObservedDeviceState,
  ExecutableObservedSteppedLoadState,
  ExecutableObservedTargetState,
  ExecutablePlan,
  ExecutableReleaseIntent,
} from './executablePlan';
import { getCurrentDrawKw } from '../observer/observedPower';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { buildExecutableSteppedLoadIntent } from './executableSteppedLoadProjection';
import type { ExecutorDeviceRead } from './executorDeviceRead';
import { buildExecutableTargetIntent } from './executableTargetProjection';
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
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
    commandAuthority: planDevice.control.commandAuthority,
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
      commandAuthority: planDevice.control.commandAuthority,
      projectionError: error,
    };
  }
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
    if (isPostureHoldShed(planDevice)) continue;
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
// Both STANDING POSTURES, discriminated on their reason codes rather than on the
// producer flags behind them: a device that is genuinely capacity-shed carries a
// `capacity` reason and MUST still block, whatever its posture settings say.
//
// A smart task's deferred-hour hold is read off the plan's decided flag
// (`nonCapacityHoldShed`) instead: its reason, `deferredObjectiveAvoid`, is shared
// with a device the task lends authority to, so the code cannot tell the two
// apart. The flag carries the same "no fresh capacity reason" rule.
const isPostureHoldShed = (planDevice: PlanDevice): boolean => (
  planDevice.reason?.code === PLAN_REASON_CODES.awaitingSolarSurplus
  || planDevice.reason?.code === PLAN_REASON_CODES.awaitingPelsStart
  || planDevice.nonCapacityHoldShed === true
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
 * The device's effective rung.
 *
 * `reportedStepId ?? lowest active step` — the same rule the snapshot producer
 * applies (`lib/planInput/deviceControlProjection.ts`). It reads the
 * device's report and the configured ladder, and deliberately NOT the commanded
 * target step: what PELS asked for is not evidence of where the device is, and
 * treating it as such is how a command gets mistaken for its own confirmation.
 */
const resolveObservedSelectedStepId = (
  profile: SteppedLoadProfile | undefined,
  reportedStepId: string | undefined,
): string | undefined => {
  if (!profile) return undefined;
  return getSteppedLoadStep(profile, reportedStepId)?.id
    ?? getSteppedLoadLowestActiveStep(profile)?.id;
};

/**
 * The executor's one observed-state producer. Every path — plan dispatch,
 * drift, the settings-UI execution state and the lifecycle fallback request —
 * builds from the executor's read of the device, and the values the read does
 * not carry are resolved here, once:
 *
 * - `selectedStepId`, the effective rung (`resolveObservedSelectedStepId`)
 *   against `ladder`, the ladder the caller judges the device by: the plan's
 *   for drift, the configured one for the execution state, the step
 *   posture's for a lifecycle step fallback (its first build and retries).
 *   `undefined` reads no rung: plan dispatch takes the current step from the
 *   plan device instead
 *   (`resolveSteppedLoadCurrentFallback`), and a drift check of a device the
 *   plan drives no step for must not fold one into its on/off;
 * - `commandableNow` (`resolveCommandableNow`);
 * - `currentDrawKw` (`getCurrentDrawKw`): the raw `measuredPowerKw` reaches no
 *   further into this layer.
 *
 * The on/off fold is applied here too, so the raw axis (`observedBinaryAxis`)
 * and the fold (`observedEffectiveOn`) answer the same way on every path.
 */
export function buildExecutableObservedDeviceState(
  read: ExecutorDeviceRead,
  ladder: SteppedLoadProfile | undefined,
): ExecutableObservedDeviceState {
  const snapshot = ladder === undefined ? read : {
    ...read,
    steppedLoadProfile: ladder,
    selectedStepId: resolveObservedSelectedStepId(ladder, read.reportedStepId),
  };
  return {
    id: read.id,
    name: read.name,
    snapshot,
    available: read.available,
    commandableNow: resolveCommandableNow(read),
    binaryControl: read.binaryControl,
    observedBinaryAxis: isBinaryOnOrUnknown(read) ? 'on' : 'off',
    observedEffectiveOn: resolveCurrentOn(snapshot),
    target: buildObservedTargetState(read),
    steppedLoad: buildObservedSteppedLoadState(snapshot, getCurrentDrawKw(read)),
  };
}

// Stage 5: narrowed to the observed surface — reads only `targets`.
const buildObservedTargetState = (
  snapshot: Pick<ObservedDeviceState, 'targets'>,
): ExecutableObservedTargetState | null => {
  const primaryTarget = snapshot.targets?.[0];
  return primaryTarget ? { observedValue: primaryTarget.value } : null;
};

const buildObservedSteppedLoadState = (
  snapshot: ExecutorDeviceRead & Pick<SteppedLoadDecoration, 'selectedStepId'>,
  currentDrawKw: number,
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
    currentDrawKw,
  };
};

const buildExecutableBinaryIntent = (dev: PlanDevice): ExecutableBinaryIntent | undefined => {
  if (isSteppedLoadDevice(dev)) return undefined;
  if (!isBinaryPlanDevice(dev)) return undefined;
  if (dev.control.commandAuthority === false) {
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
