import type {
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsStarvationResetReasonCode,
  LiveDeviceDiagnostics,
  LiveStarvationObservation,
  LiveStarvationState,
  StarvationEvaluation,
} from './deviceDiagnosticsServiceTypes';
import type { DeviceDiagnosticsStarvationPauseReason } from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { isFiniteNumber } from './deviceDiagnosticsNumbers';

const moduleLogger = getLogger('diagnostics/device');

const DEVICE_DIAGNOSTICS_STARVATION_ENTRY_MS = 15 * 60 * 1000;
const DEVICE_DIAGNOSTICS_STARVATION_CLEAR_MS = 10 * 60 * 1000;

export const createEmptyStarvationState = (): LiveStarvationState => ({
  isStarved: false,
  starvedAccumulatedMs: 0,
  starvationCause: null,
  starvationPauseReason: null,
});

// PELS is holding the device below its intended/mode target when the target it
// is COMMANDING sits more than half a target step under the intended target. That
// half-step epsilon keeps float quantization noise from reading equal commands as
// "below". A device PELS commands in full (commanded == intended) is never below.
const pelsCommandsBelowTarget = (
  intendedNormalTargetC: number | null,
  commandedTargetC: number | null,
  targetStepC: number | null,
): boolean => {
  if (!isFiniteNumber(intendedNormalTargetC) || !isFiniteNumber(commandedTargetC)) return false;
  const epsilon = isFiniteNumber(targetStepC) && targetStepC > 0 ? targetStepC / 2 : 0.25;
  return commandedTargetC < intendedNormalTargetC - epsilon;
};

// PELS is holding a turn_off-shed device below its intended target when it has
// commanded the device OFF as a shed AND the device's temperature still sits
// more than half a target step under the intended target. The turn_off shed
// itself is PELS limiting the device (no setpoint is lowered, so
// `pelsCommandsBelowTarget` cannot see it); the temperature comparison excludes
// a device that is off because it has already reached / overshot its target
// (genuinely satisfied, not starved). Only PELS-commanded turn_off sheds set
// `pelsCommandsTurnOffShed` — a user-off device never qualifies.
const pelsHoldsOffBelowTarget = (
  pelsCommandsTurnOffShed: boolean,
  intendedNormalTargetC: number | null,
  currentTemperatureC: number | null,
  targetStepC: number | null,
): boolean => {
  if (!pelsCommandsTurnOffShed) return false;
  if (!isFiniteNumber(intendedNormalTargetC) || !isFiniteNumber(currentTemperatureC)) return false;
  const epsilon = isFiniteNumber(targetStepC) && targetStepC > 0 ? targetStepC / 2 : 0.25;
  return currentTemperatureC < intendedNormalTargetC - epsilon;
};

export const normalizeStarvationObservation = (
  observation: DeviceDiagnosticsPlanObservation,
): LiveStarvationObservation => ({
  eligibleForStarvation: observation.eligibleForStarvation,
  observationFresh: observation.observationFresh,
  currentTemperatureC: observation.currentTemperatureC,
  intendedNormalTargetC: observation.intendedNormalTargetC,
  commandedTargetC: observation.commandedTargetC,
  targetStepC: observation.targetStepC,
  pelsCommandsTurnOffShed: observation.pelsCommandsTurnOffShed,
  suppressionState: observation.suppressionState,
  countingCause: observation.countingCause,
  pauseReason: observation.pauseReason,
  pelsHoldsBelowTarget: pelsCommandsBelowTarget(
    observation.intendedNormalTargetC,
    observation.commandedTargetC,
    observation.targetStepC,
  ) || pelsHoldsOffBelowTarget(
    observation.pelsCommandsTurnOffShed,
    observation.intendedNormalTargetC,
    observation.currentTemperatureC,
    observation.targetStepC,
  ),
});

const isValidStarvationObservation = (observation: LiveStarvationObservation): boolean => (
  observation.eligibleForStarvation
  && observation.observationFresh
  && isFiniteNumber(observation.intendedNormalTargetC)
  // A setpoint comparison needs a finite commanded target; a turn_off shed
  // instead compares the device's temperature against the intended target, so a
  // turn_off shed with a known current temperature is equally valid.
  && (
    isFiniteNumber(observation.commandedTargetC)
    || (observation.pelsCommandsTurnOffShed && isFiniteNumber(observation.currentTemperatureC))
  )
);

const isCountingStarvationObservation = (observation: LiveStarvationObservation): boolean => (
  isValidStarvationObservation(observation)
  && observation.suppressionState === 'counting'
  && observation.countingCause !== null
);

export const starvationTargetChanged = (
  previous: LiveStarvationObservation | undefined,
  next: LiveStarvationObservation,
): boolean => (
  previous !== undefined
  && previous.intendedNormalTargetC !== next.intendedNormalTargetC
);

const evaluateStarvationObservation = (
  observation: LiveStarvationObservation,
): StarvationEvaluation => {
  const validObservation = isValidStarvationObservation(observation);
  const counting = isCountingStarvationObservation(observation);
  const pauseReason = !validObservation
    ? 'invalid_observation'
    : observation.pauseReason ?? (
      observation.suppressionState === 'none' ? 'suppression_none' : 'unknown_suppression_reason'
    );
  return {
    validObservation,
    counting,
    // ENTER / ACCUMULATE only when PELS is actively limiting the device (a real
    // counting suppression) AND commanding it below its mode target. A device PELS
    // commands in full (`keep`) never enters, however cold it physically is.
    entryQualified: counting && observation.pelsHoldsBelowTarget,
    // CLEAR only when PELS has restored the device to its full mode target
    // (commanded == intended). A still-below device under a transient pause
    // (cooldown/keep/suppression_none) stays latched-and-paused — not cleared —
    // so a brief non-counting blip never resets an episode mid-hold.
    clearQualified: validObservation && !observation.pelsHoldsBelowTarget,
    pauseReason,
  };
};

type StarvationTrackerDeps = {
  getLiveDeviceState: (deviceId: string) => LiveDeviceDiagnostics;
  structuredLog?: Pick<PinoLogger, 'info'>;
  emitDebug: StructuredDebugEmitter;
};

// Owns the per-device starvation episode state machine. Kept as a class so the
// in-place mutations of `live.starvation` (deliberate, to avoid per-cycle
// allocation churn) stay inside a class body where they read naturally. Each
// method resolves the canonical `live` record via the injected accessor, exactly
// as the methods did when they lived on the service.
export class StarvationTracker {
  constructor(private deps: StarvationTrackerDeps) {}

  applyObservationSpan(
    deviceId: string,
    observation: LiveStarvationObservation,
    startTs: number,
    endTs: number,
  ): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    if (!observation.eligibleForStarvation) {
      this.hardResetStarvation(deviceId, 'device_no_longer_eligible', startTs);
      return;
    }
    const evaluation = evaluateStarvationObservation(observation);
    if (!live.starvation.isStarved) {
      this.applyStarvationEntryProgress(deviceId, observation, evaluation, { startTs, endTs });
      return;
    }
    if (evaluation.clearQualified) {
      this.applyStarvationClearProgress(deviceId, { startTs, endTs });
      return;
    }
    if (evaluation.entryQualified) {
      this.applyStarvationAccumulationProgress(deviceId, observation, startTs, endTs);
      return;
    }
    this.pauseStarvation(deviceId, evaluation.pauseReason, startTs);
  }

  handleGap(deviceId: string, nowTs: number): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    // In-place mutation: avoid allocating a fresh starvation object on every
    // observation cycle. The class instance is the only holder of this state
    // (no consumers cache the reference), so mutating in place is safe and
    // halves the per-cycle allocation churn that was inflating heapTotal.
    live.starvation.pendingEntryStartedAt = undefined;
    live.starvation.clearQualifiedStartedAt = undefined;
    if (!live.starvation.isStarved) return;
    this.pauseStarvation(deviceId, 'sample_gap', nowTs);
  }

  handleTargetChange(deviceId: string, nowTs: number): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    if (!live.starvation.isStarved) {
      live.starvation.pendingEntryStartedAt = undefined;
      live.starvation.clearQualifiedStartedAt = undefined;
      live.starvation.starvationCause = null;
      live.starvation.starvationPauseReason = null;
      this.deps.emitDebug({
        event: 'diagnostics_starvation_pending_reset',
        deviceId,
        deviceName: live.name,
        reason: 'target_changed',
        atMs: nowTs,
      });
      return;
    }
    live.starvation.clearQualifiedStartedAt = undefined;
    this.deps.emitDebug({
      event: 'diagnostics_starvation_thresholds_refreshed',
      deviceId,
      deviceName: live.name,
      reason: 'target_changed',
      atMs: nowTs,
    });
  }

  private resetStarvationState(deviceId: string): void {
    this.deps.getLiveDeviceState(deviceId).starvation = createEmptyStarvationState();
  }

  private applyStarvationEntryProgress(
    deviceId: string,
    observation: LiveStarvationObservation,
    evaluation: StarvationEvaluation,
    span: { startTs: number; endTs: number },
  ): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    const { startTs, endTs } = span;
    if (!evaluation.entryQualified) {
      live.starvation.pendingEntryStartedAt = undefined;
      live.starvation.starvationCause = null;
      live.starvation.starvationPauseReason = null;
      return;
    }
    const pendingEntryStartedAt = isFiniteNumber(live.starvation.pendingEntryStartedAt)
      ? live.starvation.pendingEntryStartedAt
      : startTs;
    const entryAt = pendingEntryStartedAt + DEVICE_DIAGNOSTICS_STARVATION_ENTRY_MS;
    live.starvation.pendingEntryStartedAt = pendingEntryStartedAt;
    if (endTs < entryAt) return;

    // `entryQualified` implies a real counting cause (PELS holds the device below
    // its mode target), so every starting episode carries a capacity/budget cause.
    const accumulatedMs = endTs > entryAt ? endTs - entryAt : 0;
    live.starvation = {
      isStarved: true,
      pendingEntryStartedAt: undefined,
      clearQualifiedStartedAt: undefined,
      starvedAccumulatedMs: accumulatedMs,
      starvationEpisodeStartedAt: entryAt,
      starvationLastResumedAt: entryAt,
      starvationCause: observation.countingCause,
      starvationPauseReason: null,
    };
    (this.deps.structuredLog ?? moduleLogger).info({
      event: 'device_starvation_started',
      deviceId,
      deviceName: live.name,
      cause: observation.countingCause,
      starvationEpisodeStartedAtMs: entryAt,
      starvedDurationMs: accumulatedMs,
    });
  }

  private applyStarvationClearProgress(
    deviceId: string,
    span: { startTs: number; endTs: number },
  ): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    const { startTs, endTs } = span;
    const clearQualifiedStartedAt = isFiniteNumber(live.starvation.clearQualifiedStartedAt)
      ? live.starvation.clearQualifiedStartedAt
      : startTs;
    const clearAt = clearQualifiedStartedAt + DEVICE_DIAGNOSTICS_STARVATION_CLEAR_MS;
    live.starvation.clearQualifiedStartedAt = clearQualifiedStartedAt;
    live.starvation.starvationLastResumedAt = undefined;
    // Hold the original capacity/budget cause through the clear-hysteresis window
    // so the overview badge stays attributed until the episode fully resets.
    live.starvation.starvationPauseReason = null;
    if (endTs < clearAt) return;
    (this.deps.structuredLog ?? moduleLogger).info({
      event: 'device_starvation_cleared',
      deviceId,
      deviceName: live.name,
      transitionAtMs: clearAt,
      starvedDurationMs: live.starvation.starvedAccumulatedMs,
    });
    this.resetStarvationState(deviceId);
  }

  private applyStarvationAccumulationProgress(
    deviceId: string,
    observation: LiveStarvationObservation,
    startTs: number,
    endTs: number,
  ): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    if (!isFiniteNumber(live.starvation.starvationLastResumedAt)) {
      (this.deps.structuredLog ?? moduleLogger).info({
        event: 'device_starvation_resumed',
        deviceId,
        deviceName: live.name,
        cause: observation.countingCause,
        transitionAtMs: startTs,
        starvedDurationMs: live.starvation.starvedAccumulatedMs,
      });
    }
    live.starvation.clearQualifiedStartedAt = undefined;
    if (!isFiniteNumber(live.starvation.starvationLastResumedAt)) {
      live.starvation.starvationLastResumedAt = startTs;
    }
    live.starvation.starvedAccumulatedMs += Math.max(0, endTs - startTs);
    // Accumulation runs only while `entryQualified` (a real counting hold), so the
    // cause stays the capacity/budget cause; it is never a pause reason.
    live.starvation.starvationCause = observation.countingCause;
    live.starvation.starvationPauseReason = null;
  }

  private pauseStarvation(
    deviceId: string,
    pauseReason: DeviceDiagnosticsStarvationPauseReason,
    nowTs: number,
  ): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    if (isFiniteNumber(live.starvation.starvationLastResumedAt)) {
      (this.deps.structuredLog ?? moduleLogger).info({
        event: 'device_starvation_paused',
        deviceId,
        deviceName: live.name,
        pauseReason,
        transitionAtMs: nowTs,
        starvedDurationMs: live.starvation.starvedAccumulatedMs,
      });
    }
    live.starvation.clearQualifiedStartedAt = undefined;
    live.starvation.starvationLastResumedAt = undefined;
    // Keep the original capacity/budget cause so a paused-but-latched episode
    // still reports its true cause to the overview badge (capacity vs budget) —
    // a pause does not change WHY the device became starved.
    live.starvation.starvationPauseReason = pauseReason;
  }

  private hardResetStarvation(
    deviceId: string,
    reasonCode: DeviceDiagnosticsStarvationResetReasonCode,
    nowTs: number,
  ): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    const starvation = live.starvation;
    if (
      !starvation.isStarved
      && !isFiniteNumber(starvation.pendingEntryStartedAt)
      && starvation.starvedAccumulatedMs === 0
    ) {
      return;
    }
    (this.deps.structuredLog ?? moduleLogger).info({
      event: 'device_starvation_hard_reset',
      deviceId,
      deviceName: live.name,
      reasonCode,
      transitionAtMs: nowTs,
      starvedDurationMs: starvation.starvedAccumulatedMs,
      wasStarved: starvation.isStarved,
    });
    this.resetStarvationState(deviceId);
  }
}
