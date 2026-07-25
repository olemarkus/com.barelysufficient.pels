import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import type { PlanEngineState } from '../plan/planState';
import type {
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import {
  isPlanDeviceObservedOff,
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
} from '../plan/planSteppedLoad';
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
import { RESTORE_COOLDOWN_MS } from '../plan/planConstants';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveBinaryShedReasonCode } from './lifecycleReleaseRecording';

export function resolveConfirmedBinaryCommandReasonCode(
  pending: PlanEngineState['pendingBinaryCommands'][string],
): string {
  if (!pending.desired) {
    return resolveBinaryShedReasonCode(pending.reason, pending.lifecycleRelease);
  }
  if (pending.logContext === 'capacity_control_off') {
    return 'capacity_control_off_restore';
  }
  if (pending.actuationMode === 'reconcile') {
    return 'reconcile_restore';
  }
  return pending.restoreSource ?? 'current_plan';
}

export function hasStableUncontrolledRestoreActuation(
  dev: DevicePlan['devices'][number],
  state: PlanEngineState,
): boolean {
  return dev.controllable === false
    && dev.plannedState === 'keep'
    && isPlanDeviceObservedOff(dev)
    && Boolean(state.shedDecidedMs[dev.id]);
}

/**
 * Restore-log source label: `shed_state` when the planner still holds the
 * device in capacity-shed posture (decided-shed more recently than it was
 * restored), else `current_plan`. Reads the decision-time `shedDecidedMs`
 * clock so a write-skipped shed is still attributed to the shed state. The
 * result is a log field only — no decision branches on it.
 */
export function resolveRestoreLogSource(
  state: PlanEngineState,
  deviceId: string,
): 'shed_state' | 'current_plan' {
  const shedDecidedMs = state.shedDecidedMs[deviceId];
  if (!shedDecidedMs) return 'current_plan';
  const lastRestoreMs = state.lastDeviceRestoreMs[deviceId];
  return !lastRestoreMs || lastRestoreMs < shedDecidedMs ? 'shed_state' : 'current_plan';
}

export function hasStableBinaryReleaseActuation(dev: DevicePlan['devices'][number]): boolean {
  if (dev.binaryCommandPending === true) return false;
  if (dev.deferredReleaseIntent === 'binary_restore') {
    // Released = off-but-commandable, the only state a restore acts on. A device
    // with no control capability this cycle is not binary → not "observed off".
    // `currentOn` is the producer-resolved on/off truth (binary axis + stepped-off).
    return isBinaryPlanDevice(dev) && dev.currentOn === false && isCommandableNow(dev);
  }
  if (dev.deferredReleaseIntent === 'binary_release') {
    // On (the consolidated binary truth = `currentOn`). Non-binary keeps the prior
    // "on/unknown" default (true) so a release without observed-off evidence is not
    // yet stable.
    return isBinaryPlanDevice(dev) ? dev.currentOn : true;
  }
  return false;
}

export function isSteppedLoadRestoreFromOff(
  intent: ExecutableSteppedLoadIntent | null,
  action: ExecutableSteppedLoadDevice | null,
): boolean {
  return Boolean(intent?.purpose === 'keep' && action?.current.on === false);
}

export function hasStableSteppedLoadStepActuation(dev: DevicePlan['devices'][number]): boolean {
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep') return false;
  const desiredStepId = resolveSteppedKeepDesiredStepId(dev);
  if (!desiredStepId || !dev.selectedStepId || desiredStepId === dev.selectedStepId) return false;
  if (hasEquivalentSteppedLoadCommandHold(dev, desiredStepId)) return false;

  const selectedStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  if (!selectedStep || !desiredStep) return false;
  if (desiredStep.planningPowerW < selectedStep.planningPowerW) {
    // Stepping down. "Off" is kind-aware: a binary stepper via `currentOn`, a
    // step-only stepper (no onoff handle) via the step axis. Not-off ⇒ it can
    // still shed further (stable); when off, stability hinges on not being held
    // for a restore.
    return !isPlanDeviceObservedOff(dev) || !isRestoreHoldReason(dev.reason);
  }
  return desiredStep.planningPowerW > selectedStep.planningPowerW
    && allowsSteppedLoadKeepInvariantRestore(dev.reason);
}

/**
 * Phase 2 of a stepped load's restore-from-off: the step axis is already
 * prepared at the keep-desired step, so the only command left to issue is the
 * binary on.
 *
 * `hasStableSteppedLoadStepActuation` deliberately returns false once desired
 * == selected (nothing left to do on the STEP axis) — which is exactly this
 * state. Without a companion predicate on the BINARY axis the plan-apply gate
 * (`maybeApplyPlanChanges`) sees an unchanged action signature — `buildPlanSignature`
 * carries desired state only, never the observation that just materialized the
 * step — and never invokes the executor at all, wedging the device at "step
 * prepared, still off" until some unrelated device happens to change the plan.
 * That is prod incident 2026-07-25 (Elbillader off for 6+ minutes with its
 * target already at 6 A).
 *
 * The transition phase is read off `resolveSteppedLoadTransition` rather than
 * re-derived here, so this gate and the executor's own dispatch decision agree
 * by construction. The reason allow-set ({keep, restore_need}) keeps every
 * cooldown / backoff / capacity hold blocking as before.
 *
 * Two traps this deliberately avoids — they reverted the first attempt at this
 * fix, and both underlying defects are still open in TODO.md
 * ("`isCommandableNow` is always false for an EV charger on the plan-device
 * path" and "Restore actuation re-stamps the GLOBAL `state.lastRestoreMs`"):
 *   - It does NOT gate on `isCommandableNow(dev)`. On a plan device that is
 *     always false for an EV charger: `withEvDiscriminant` (`lib/plan/planTypes.ts`)
 *     strips `evChargingState`, and `commandableNow` is never copied across, so
 *     the resolver lands on "charger state unknown". Gating on it would make this
 *     predicate dead for exactly the devices that hit the bug. Commandability is
 *     still enforced downstream, on the SNAPSHOT, by `canTurnOnDevice`.
 *   - It IS rate-limited per device. `recordRestoreActuation` stamps the GLOBAL
 *     `state.lastRestoreMs`, so an unbounded per-cycle retry by one stuck device
 *     would hold every other device's restore gate open indefinitely.
 */
export function hasStableSteppedLoadBinaryRestoreActuation(
  dev: DevicePlan['devices'][number],
  state: PlanEngineState,
): boolean {
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep') return false;
  // A binary handle is required: this is the binary-axis phase, and a step-only
  // stepper has no on/off to write (its restore rides the step axis instead).
  if (!isBinaryPlanDevice(dev)) return false;
  // The binary axis must read a trusted off: `currentOn` is the producer-resolved
  // on/off truth, and `=== false` is the same gate the transition resolver uses
  // for its restore-from-off branch (unknown is not off).
  if (dev.currentOn !== false) return false;
  if (dev.binaryCommandPending === true) return false;
  if (!allowsSteppedLoadKeepInvariantRestore(dev.reason)) return false;
  if (!hasSteppedLoadBinaryRestoreSlot(state, dev.id)) return false;
  const transition = resolveSteppedLoadTransition(dev, resolveSteppedKeepDesiredStepId(dev));
  return transition?.binaryTarget === true && transition.transitionPhase === 'binary_transition';
}

/**
 * Per-device restore slot: one on-attempt per `RESTORE_COOLDOWN_MS`, measured
 * off this device's own last restore actuation (`lastDeviceRestoreMs`, which the
 * step-preparation command also stamps). Bounds a device that accepts the write
 * but never actually comes on to the same cadence as any ordinary restore,
 * instead of one attempt per rebuild cycle.
 */
const hasSteppedLoadBinaryRestoreSlot = (state: PlanEngineState, deviceId: string): boolean => {
  const lastRestoreMs = state.lastDeviceRestoreMs[deviceId];
  if (typeof lastRestoreMs !== 'number' || !Number.isFinite(lastRestoreMs)) return true;
  return Date.now() - lastRestoreMs >= RESTORE_COOLDOWN_MS;
};

export function hasEquivalentSteppedLoadCommandHold(
  dev: DevicePlan['devices'][number],
  desiredStepId: string,
): boolean {
  const lastDesiredStepId = dev.lastDesiredStepId ?? dev.desiredStepId;
  const sameCommand = lastDesiredStepId === desiredStepId;
  if (!sameCommand) return false;
  if (dev.stepCommandPending === true) return true;
  return dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && Date.now() < dev.nextStepCommandRetryAtMs;
}

export function isRestoreHoldReason(reason: DeviceReason | undefined): boolean {
  return reason ? isRestoreAdmissionHoldReason(reason) : false;
}
