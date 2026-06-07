import type { ShedAction } from '../plan/planTypes';
import type {
  SteppedLoadProfile,
  SteppedLoadStep,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import {
  applyBinarySheddingToDevice,
  type PlanExecutorBinaryContext,
} from './binaryExecutor';
import {
  applyTargetUpdate,
  type PlanExecutorTargetContext,
} from './targetExecutor';
import {
  applySteppedLoadCommand,
  type PlanExecutorSteppedContext,
} from './steppedLoadExecutor';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { resolveSteppedStepActuationState } from './steppedLoadActuation';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/shed-release');

// shed_release fires the device's configured shedBehavior exactly once for a cap-off device
// whose smart task transitioned out of plannable status (or is in an idle bucket). The
// executor resolves the concrete actuation primitive at apply time from getShedBehavior():
//   'turn_off' / 'set_step' → binary shed via the onoff/evcharger_charging capability,
//                              or (for set_step on a stepped-only device) a synthesized
//                              shed-purpose stepped command via the step capability
//   'set_temperature'       → target write at the configured shed setpoint, with an
//                              explicit recordReleaseShedActuation so diagnostics see the event
// Each axis's existing idempotency guard prevents re-actuation when the device is already in
// the configured shed posture (binary observedBinaryState; target pendingTargetCommand
// dampening inside applyTargetUpdate; stepped commandStepId vs current.stepId), so the
// per-cycle re-emission of the intent is safe.
//
// `recordReleaseShedActuation` writes the per-device `pels_shed` diagnostic event and closes
// any open activation attempt for the (now satisfied) smart task. Unlike a capacity-driven
// shed, it does NOT poke `lastInstabilityMs` or `lastDeviceShedMs`, so a lifecycle-end
// release doesn't start a 5 s shed-throttle window that would interfere with later capacity
// decisions for unrelated devices.
export type ShedReleaseActuationDeps = {
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  buildBinaryExecutorContext: () => PlanExecutorBinaryContext;
  buildTargetExecutorContext: () => PlanExecutorTargetContext;
  buildSteppedExecutorContext: () => PlanExecutorSteppedContext;
  recordReleaseShedActuation: (deviceId: string, name: string, now: number) => void;
};

export const applyShedReleaseIntent = async (params: {
  intent: ExecutableReleaseIntent;
  steppedLoadIntent: ExecutableSteppedLoadIntent | null;
  observed: ExecutableObservedDeviceState | undefined;
  snapshot: TargetDeviceSnapshot | undefined;
  mode: PlanActuationMode;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const { intent, steppedLoadIntent, observed, snapshot, mode, deps } = params;
  if (intent.kind !== 'shed_release') return false;
  const behavior = deps.getShedBehavior(intent.deviceId);
  if (behavior.action === 'set_temperature' && behavior.temperature !== null) {
    return applyShedReleaseTemperature({ intent, shedTemperature: behavior.temperature, observed, mode, deps });
  }
  // Stepped-only devices (no `onoff`/`evcharger_charging` capability) cannot route through
  // the binary off path: re-project a shed-purpose stepped action at apply time and dispatch
  // via the step capability before falling through to the binary handler.
  if (
    behavior.action === 'set_step'
    && steppedLoadIntent
    && !snapshot?.controlCapabilityId
  ) {
    const handled = await applyShedReleaseSteppedLoad({
      intent,
      steppedLoadIntent,
      observed,
      mode,
      deps,
    });
    if (handled) return true;
  }
  return applyShedReleaseBinaryOff({ intent, behavior, snapshot, observed, deps });
};

const applyShedReleaseTemperature = async (params: {
  intent: ExecutableReleaseIntent;
  shedTemperature: number;
  observed: ExecutableObservedDeviceState | undefined;
  mode: PlanActuationMode;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const { intent, shedTemperature, observed, mode, deps } = params;
  const target = observed?.target;
  if (!target) return false;
  if (typeof target.observedValue === 'number' && target.observedValue === shedTemperature) return false;
  const wrote = await applyTargetUpdate(deps.buildTargetExecutorContext(), {
    deviceId: intent.deviceId,
    name: intent.name,
    targetCap: target.targetCap,
    desired: shedTemperature,
    observedValue: target.observedValue,
    isRestoring: false,
  }, mode);
  if (wrote && mode === 'plan') {
    // applyTargetUpdate only records on the restore axis. Mirror trySetShedTemperature's
    // diagnostics: the per-device `pels_shed` event must fire for the release write so
    // forensic traces and per-device actuation counters stay accurate.
    deps.recordReleaseShedActuation(intent.deviceId, intent.name, Date.now());
  }
  return wrote;
};

const applyShedReleaseBinaryOff = async (params: {
  intent: ExecutableReleaseIntent;
  behavior: { action: ShedAction };
  snapshot: TargetDeviceSnapshot | undefined;
  observed: ExecutableObservedDeviceState | undefined;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const { intent, behavior, snapshot, observed, deps } = params;
  // Defensive: binary-controlled deferred objectives route through 'binary_release', not
  // 'shed_release'; the projection already rejects shed_release for EV devices
  // (`isEvDevice`), but guard at apply time too — faithful mirror of that gate.
  if (snapshot && isEvDevice(snapshot)) return false;
  if (!snapshot?.controlCapabilityId) {
    // No binary handle, and the stepped re-projection above either didn't apply (turn_off
    // shedBehavior, or no steppedLoad intent available) or returned false. Stay silent on
    // turn_off (rare config); for set_step log a one-off so any remaining gap shows up in
    // prod traces.
    if (behavior.action === 'set_step') {
      logger.debug({
        event: 'shed_release_skipped',
        reasonCode: 'no_binary_handle_for_set_step',
        deviceId: intent.deviceId,
        deviceName: intent.name,
      });
    }
    return false;
  }
  // Idempotency: only fire the release when the device is observed 'on'; treat 'off' as
  // already in shed posture (no-op). Observed binary state is the producer-resolved
  // `currentOn` (an honest boolean — an unobserved binary control resolves to a
  // non-optimistic `false`), so there is no separate 'unknown' to grace here.
  if (!observed || observed.observedBinaryState !== 'on') return false;
  return applyBinarySheddingToDevice(deps.buildBinaryExecutorContext(), {
    deviceId: intent.deviceId,
    deviceName: intent.name,
    // Lifecycle-end disable, not a capacity shed: lifecycleRelease records via the
    // diagnostic-only recorder and (by default) bypasses the capacity precheck /
    // pendingSheds bookkeeping, for both the direct write here and any deferred
    // flow-backed confirmation in handleConfirmedBinaryCommand.
    lifecycleRelease: true,
  });
};

const buildShedReleaseSteppedAction = (params: {
  intent: ExecutableReleaseIntent;
  steppedLoadIntent: ExecutableSteppedLoadIntent;
  observed: ExecutableObservedDeviceState | undefined;
  targetStep: SteppedLoadStep;
  currentStepId: string | undefined;
}): ExecutableSteppedLoadDevice => {
  const {
    intent, steppedLoadIntent, observed, targetStep, currentStepId,
  } = params;
  const profile = steppedLoadIntent.steppedLoadProfile;
  const currentStep = currentStepId ? getSteppedLoadStep(profile, currentStepId) : null;
  // Provenance mirrors `toExecutableSteppedStepState`: only real telemetry
  // (`reportedStepId`) is `reported` evidence; the effective `stepId` is a
  // planning fallback, not a confirmed report. (This release path always requests
  // the shed target, never the current step, so materialization resolves to
  // `no_observed_match` either way — but keep the labeling honest so a future
  // reader can't mistake the fallback for telemetry.)
  const reportedStepId = observed?.steppedLoad?.reportedStepId;
  const stepActuation = resolveSteppedStepActuationState({
    step: {
      requestedStepId: targetStep.id,
      observedStep: reportedStepId
        ? { kind: 'reported', stepId: reportedStepId }
        : { kind: 'unknown' },
      fallbackStepId: observed?.steppedLoad?.stepId,
    },
  });
  return {
    id: intent.deviceId,
    name: intent.name,
    purpose: 'shed',
    steppedLoadProfile: profile,
    communicationModel: steppedLoadIntent.communicationModel,
    controlAdapter: steppedLoadIntent.controlAdapter,
    targetPowerConfig: steppedLoadIntent.targetPowerConfig,
    shedAction: 'set_step',
    current: {
      on: observed?.steppedLoad?.on
        ?? (observed ? (observed.binaryControl?.on ?? true) : steppedLoadIntent.planningCurrentOn),
      stepId: currentStepId,
      stepForShed: currentStep
        ? { stepId: currentStep.id, planningPowerW: currentStep.planningPowerW }
        : undefined,
      stepIsOffStep: currentStepId ? isSteppedLoadOffStep(profile, currentStepId) : false,
    },
    desired: {
      // Keep `on: true` so applySteppedLoadCommand does not early-return on the
      // `currentOn === false && desired.on === false` guard — we are dispatching a step
      // command via the step capability, not a binary off.
      on: true,
      stepId: targetStep.id,
      plannedStepId: targetStep.id,
    },
    previousStepId: currentStepId,
    transition: null,
    stepActuation,
    commandStepActuation: stepActuation,
    matchingRestoreAttempt: null,
    matchingCommandAttempt: null,
    stepNeedsAdjustment: true,
    stepCommandRetryCount: 0,
  };
};

// Producer-resolved release-cascade step (see `resolveShedIntent` in
// `lib/device/deviceActionProjection.ts`). Returns null on a degenerate empty profile or
// when the intent isn't a `set_step` release; the caller treats that as "no target to
// release toward" and bails. Emits a debug log so the silent no-op is observable in
// /tmp/pels logs (otherwise a stepped-no-binary device with an unpopulated `releaseShedStepId`
// on fresh boot stays at its current step with zero log signal).
const resolveProducerShedReleaseStep = (
  intent: ExecutableReleaseIntent,
  profile: SteppedLoadProfile,
): SteppedLoadStep | null => {
  const targetStepId = intent.releaseShedStepId;
  const targetStep = targetStepId ? getSteppedLoadStep(profile, targetStepId) : null;
  if (!targetStep) {
    logger.debug({
      event: 'shed_release_skipped',
      reasonCode: 'no_producer_step_target',
      deviceId: intent.deviceId,
      deviceName: intent.name,
      releaseShedStepId: targetStepId ?? null,
    });
    return null;
  }
  return targetStep;
};

const applyShedReleaseSteppedLoad = async (params: {
  intent: ExecutableReleaseIntent;
  steppedLoadIntent: ExecutableSteppedLoadIntent;
  observed: ExecutableObservedDeviceState | undefined;
  mode: PlanActuationMode;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const {
    intent, steppedLoadIntent, observed, mode, deps,
  } = params;
  const profile = steppedLoadIntent.steppedLoadProfile;
  const targetStep = resolveProducerShedReleaseStep(intent, profile);
  if (!targetStep) return false;
  // Trusted-evidence gate (mirrors the binary path's `observedBinaryState === 'on'` check):
  // require an observed step id from a real snapshot. `planningCurrentStepId` can carry a
  // stale value from before a Homey restart; firing a step command against it would race
  // against an SDK that hasn't yet reported the device's true state. No observation → wait
  // for real evidence.
  const observedStepId = observed?.steppedLoad?.stepId;
  if (!observedStepId) {
    logger.debug({
      event: 'shed_release_skipped',
      reasonCode: 'no_trusted_step_observation',
      deviceId: intent.deviceId,
      deviceName: intent.name,
    });
    return false;
  }
  const currentStepId = observedStepId;
  // Already at the shed target — done.
  if (currentStepId === targetStep.id) return false;
  // Look up the observed step in the current profile. If it is missing (driver swap remapped
  // the profile mid-session; observed step id no longer references a known step), we have
  // ambiguous state — the power-comparison "never step up" guard below cannot fire safely
  // without a known current step, so refuse to act.
  const currentStep = getSteppedLoadStep(profile, currentStepId);
  if (!currentStep) {
    logger.debug({
      event: 'shed_release_skipped',
      reasonCode: 'unknown_current_step',
      deviceId: intent.deviceId,
      deviceName: intent.name,
      observedStepId: currentStepId,
    });
    return false;
  }
  // Never step up into the shed target. If we are already at or below it, nothing to do.
  if (currentStep.planningPowerW <= targetStep.planningPowerW) return false;
  // In-flight gate: defer the release if the planner already has a step command awaiting
  // confirmation or a retry scheduled for this device. The synthesized release action carries
  // `matchingCommandAttempt: null`, which would otherwise bypass `applySteppedLoadCommand`'s
  // `awaiting_confirmation` / `retry_backoff` short-circuits and re-dispatch every cycle while
  // the device has not reported back.
  if (steppedLoadIntent.matchingCommandAttempt?.status === 'awaiting_confirmation') return false;
  const retryAtMs = steppedLoadIntent.nextStepCommandRetryAtMs;
  if (typeof retryAtMs === 'number' && retryAtMs > Date.now()) return false;
  const action = buildShedReleaseSteppedAction({
    intent,
    steppedLoadIntent,
    observed,
    targetStep,
    currentStepId,
  });
  const wrote = await applySteppedLoadCommand(deps.buildSteppedExecutorContext(), action, mode);
  if (wrote && mode === 'plan') {
    // applySteppedLoadCommand only records `pels_shed` when the transition is
    // `step_down_while_on`; the synthesized release action carries `transition: null` so
    // we record explicitly here.
    deps.recordReleaseShedActuation(intent.deviceId, intent.name, Date.now());
  }
  return wrote;
};
