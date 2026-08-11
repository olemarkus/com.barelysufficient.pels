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
import { getDateKeyInTimeZone, getDateKeyStartMs, getNextLocalDayStartUtcMs } from '../utils/dateUtils';

const moduleLogger = getLogger('diagnostics/device');

const DEVICE_DIAGNOSTICS_STARVATION_ENTRY_MS = 15 * 60 * 1000;
const DEVICE_DIAGNOSTICS_STARVATION_CLEAR_MS = 10 * 60 * 1000;

export const createEmptyStarvationState = (): LiveStarvationState => ({
  isStarved: false,
  starvedAccumulatedMs: 0,
  starvationCause: null,
  starvationPauseReason: null,
  deniedBudgetDayMs: 0,
});

// `pelsHoldsBelowTarget` is resolved in the PRODUCER (`lib/plan/planDiagnostics.ts`)
// and carried on the observation, so this is a copy, not a second derivation. It
// used to be computed here while the demand/censoring counters derived their own,
// narrower notion of the same thing from a setpoint gap alone — the two disagreed
// by hours a day on turn_off-shed devices.
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
  pelsHoldsBelowTarget: observation.pelsHoldsBelowTarget,
});

const isValidStarvationObservation = (observation: LiveStarvationObservation): boolean => (
  observation.eligibleForStarvation
  // A stale observation is not "confirmed no progress" — never count
  // stale-but-unobserved time toward starvation (the freshness is observer-resolved).
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
  // Local-day boundaries for the day-scoped denied accrual — the damage verdict
  // is "still latched when the LOCAL day closed", so the roll must follow the
  // home's timezone (and its 23/25-hour DST days), not UTC.
  getTimeZone: () => string;
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

  handleGap(deviceId: string, nowTs: number, sinceTs?: number): void {
    const live = this.deps.getLiveDeviceState(deviceId);
    // In-place mutation: avoid allocating a fresh starvation object on every
    // observation cycle. The class instance is the only holder of this state
    // (no consumers cache the reference), so mutating in place is safe and
    // halves the per-cycle allocation churn that was inflating heapTotal.
    live.starvation.pendingEntryStartedAt = undefined;
    live.starvation.clearQualifiedStartedAt = undefined;
    // A gap spanning local midnight makes the state AT the boundary unknowable,
    // and unprovable means not damage: wipe both denied slots rather than let
    // the join claim a day close nobody witnessed. A same-day gap keeps them —
    // time already accrued is proven held time; only the boundary needs a witness.
    if (isFiniteNumber(sinceTs)) {
      const timeZone = this.deps.getTimeZone();
      if (getDateKeyInTimeZone(new Date(sinceTs), timeZone) !== getDateKeyInTimeZone(new Date(nowTs), timeZone)) {
        live.starvation.deniedBudgetDayMs = 0;
        live.starvation.deniedBudgetDayKey = getDateKeyInTimeZone(new Date(nowTs), timeZone);
        live.starvation.deniedBudgetPrevDayMs = undefined;
        live.starvation.deniedBudgetPrevDayKey = undefined;
        live.starvation.deniedBudgetPrevDayClosedByBudget = undefined;
        live.starvation.deniedBudgetDayCauseWasBudget = undefined;
      }
    }
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

  /**
   * Advances the day-scoped denied accumulator over one LATCHED counting span.
   * Called only with continuous spans (the service skips wider ones as gaps), so
   * when a span crosses local midnight the roll it performs doubles as the
   * witness that the boundary was actually observed. Every latched counting span
   * walks the day bookkeeping; only spans whose cause is the daily budget add
   * time — a capacity- or cooldown-caused stretch inside a budget episode rolls
   * the day but accrues nothing, keeping the magnitude strictly the time the
   * BUDGET held the device (span-level attribution, not episode-level).
   */
  private accrueDeniedBudgetSpan(
    live: LiveDeviceDiagnostics,
    cause: LiveStarvationObservation['countingCause'],
    startTs: number,
    endTs: number,
  ): void {
    if (endTs <= startTs) return;
    const timeZone = this.deps.getTimeZone();
    const state = live.starvation;
    let cursorTs = startTs;
    while (cursorTs < endTs) {
      const dateKey = getDateKeyInTimeZone(new Date(cursorTs), timeZone);
      if (state.deniedBudgetDayKey !== dateKey) {
        // The current slot's day is over (or this is the first accrual of the
        // episode). Roll it into the previous-day slot; the join reads that slot
        // as "accrued up to a witnessed close of that day". The closing cause is
        // the per-slice flag, NOT the live `starvationCause`: a zero-length span
        // at the first post-midnight observation refreshes the live cause before
        // this roll runs, and the budget's own midnight reset makes exactly that
        // flip likely — reading it here would re-attribute the closing cause out
        // from under the verdict.
        state.deniedBudgetPrevDayMs = state.deniedBudgetDayKey === undefined ? undefined : state.deniedBudgetDayMs;
        state.deniedBudgetPrevDayKey = state.deniedBudgetDayKey;
        state.deniedBudgetPrevDayClosedByBudget = state.deniedBudgetDayKey === undefined
          ? undefined
          : state.deniedBudgetDayCauseWasBudget === true;
        state.deniedBudgetDayKey = dateKey;
        state.deniedBudgetDayMs = 0;
        state.deniedBudgetDayCauseWasBudget = undefined;
      }
      const dayStartTs = getDateKeyStartMs(dateKey, timeZone);
      const sliceEndTs = Math.min(endTs, getNextLocalDayStartUtcMs(dayStartTs, timeZone));
      state.deniedBudgetDayCauseWasBudget = cause === 'daily_budget';
      if (cause === 'daily_budget') {
        state.deniedBudgetDayMs += sliceEndTs - cursorTs;
      }
      cursorTs = sliceEndTs;
    }
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
      deniedBudgetDayMs: 0,
    };
    // The denied clock mirrors the episode clock exactly: it starts at the latch
    // (`entryAt`), never backdated into the 15-minute entry window.
    this.accrueDeniedBudgetSpan(live, observation.countingCause, entryAt, endTs);
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
    // Hold the counting cause through the clear-hysteresis window — accumulation
    // has stopped, so nothing overwrites it — leaving device detail and a later
    // `device_starvation_resumed` attributed until the episode fully resets. Not
    // an immutable episode-entry cause: while accumulation IS running,
    // `applyStarvationAccumulationProgress` refreshes it from each observation.
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
    this.accrueDeniedBudgetSpan(live, observation.countingCause, startTs, endTs);
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
    // Keep the counting cause so a paused-but-latched episode still reports its
    // last attributed cause to device detail, and to `device_starvation_resumed`
    // if it resumes — a pause does not change WHY the device became starved.
    // (`device_starvation_paused` / `_cleared` carry no cause field themselves.)
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
