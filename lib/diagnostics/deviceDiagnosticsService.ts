import type Homey from 'homey';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import { ACTIVATION_BACKOFF_MAX_LEVEL, type ActivationAttemptSource } from '../plan/planActivationBackoff';
import type {
  DeviceDiagnosticsSummary,
  DeviceDiagnosticsWindowKey,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import {
  buildWindowSummary,
  countPersistedDays,
  countPersistedDevices,
  createEmptyDayAggregate,
  createEmptyPersistedState,
  formatDeviceRef,
  formatDurationSeconds,
  getRecentDateKeys,
  sanitizePersistedState,
  type PersistedDayAggregate,
  type PersistedDiagnosticsState,
} from './deviceDiagnosticsModel';
import type { Logger as PinoLogger } from '../logging/logger';

export const DEVICE_DIAGNOSTICS_STATE_KEY = 'device_diagnostics_v1';
export const DEVICE_DIAGNOSTICS_WINDOW_DAYS = 21;
export const DEVICE_DIAGNOSTICS_PERSIST_VERSION = 1;

const DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS = 5 * 60 * 1000;
const DEVICE_DIAGNOSTICS_MAX_SAMPLE_GAP_MS = 10 * 60 * 1000;
const DEVICE_DIAGNOSTICS_STARVATION_ENTRY_MS = 15 * 60 * 1000;
const DEVICE_DIAGNOSTICS_STARVATION_CLEAR_MS = 10 * 60 * 1000;

const STARVATION_ENTRY_ANCHORS = [
  { targetC: 16, deficitC: 2 },
  { targetC: 21, deficitC: 2 },
  { targetC: 24, deficitC: 3 },
  { targetC: 55, deficitC: 10 },
  { targetC: 80, deficitC: 20 },
] as const;

export type DeviceDiagnosticsBlockCause = 'not_blocked' | 'headroom' | 'cooldown_backoff';
export type DeviceDiagnosticsStarvationSuppressionState = 'counting' | 'paused' | 'none';
export type DeviceDiagnosticsStarvationCountingCause =
  | 'capacity'
  | 'daily_budget'
  | 'hourly_budget'
  | 'shortfall'
  | 'swap_pending'
  | 'swapped_out'
  | 'insufficient_headroom'
  | 'shedding_active';
export type DeviceDiagnosticsStarvationPauseReason =
  | 'cooldown'
  | 'headroom_cooldown'
  | 'restore_throttled'
  | 'activation_backoff'
  | 'inactive'
  | 'keep'
  | 'restore'
  | 'suppression_none'
  | 'invalid_observation'
  | 'sample_gap'
  | 'unknown_suppression_reason';

type DeviceDiagnosticsStarvationResetReasonCode = 'device_no_longer_eligible';
export type DeviceDiagnosticsPlanObservation = {
  deviceId: string;
  name: string;
  includeDemandMetrics: boolean;
  unmetDemand: boolean;
  blockCause: DeviceDiagnosticsBlockCause;
  targetDeficitActive: boolean;
  desiredStateSummary: string;
  appliedStateSummary: string;
  eligibleForStarvation: boolean;
  currentTemperatureC: number | null;
  intendedNormalTargetC: number | null;
  targetStepC: number | null;
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
  observationFresh: boolean;
};

type DeviceDiagnosticsControlEventBase = {
  deviceId: string;
  name?: string;
  nowTs?: number;
};

export type DeviceDiagnosticsControlEvent =
  | (DeviceDiagnosticsControlEventBase & {
    kind: 'shed' | 'restore';
  })
  | (DeviceDiagnosticsControlEventBase & {
    kind: 'tracked_transition';
    direction: 'up' | 'down';
  });

export type DeviceDiagnosticsBackoffTransition =
  | {
    kind: 'attempt_started';
    deviceId: string;
    source: ActivationAttemptSource;
    penaltyLevel: number;
    nowTs: number;
  }
  | {
    kind: 'stick_reached';
    deviceId: string;
    source: ActivationAttemptSource | null;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'setback_failed';
    deviceId: string;
    source: ActivationAttemptSource | null;
    previousPenaltyLevel: number;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'setback_after_stick';
    deviceId: string;
    source: ActivationAttemptSource | null;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'penalty_cleared';
    deviceId: string;
    source: ActivationAttemptSource | null;
    previousPenaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_inactive';
    deviceId: string;
    source: ActivationAttemptSource | null;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  };

export type DeviceDiagnosticsRecorder = {
  observePlanSample: (params: {
    observations: DeviceDiagnosticsPlanObservation[];
    nowTs?: number;
  }) => void;
  recordControlEvent: (event: DeviceDiagnosticsControlEvent) => void;
  recordActivationTransition: (transition: DeviceDiagnosticsBackoffTransition, params: {
    name?: string;
  }) => void;
  getUiPayload: (nowTs?: number) => SettingsUiDeviceDiagnosticsPayload;
};

type LiveDemandObservation = {
  includeDemandMetrics: boolean;
  unmetDemand: boolean;
  blockCause: DeviceDiagnosticsBlockCause;
  targetDeficitActive: boolean;
  desiredStateSummary: string;
  appliedStateSummary: string;
};

type StarvationThresholds = {
  entryDeficitC: number;
  entryThresholdC: number;
  exitDeficitC: number;
  exitThresholdC: number;
};

type LiveStarvationObservation = {
  eligibleForStarvation: boolean;
  observationFresh: boolean;
  currentTemperatureC: number | null;
  intendedNormalTargetC: number | null;
  targetStepC: number | null;
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
  thresholds: StarvationThresholds | null;
};

type StarvationEvaluation = {
  validObservation: boolean;
  counting: boolean;
  entryQualified: boolean;
  belowExitThreshold: boolean;
  clearQualified: boolean;
  pauseReason: DeviceDiagnosticsStarvationPauseReason;
};

type LiveStarvationState = {
  isStarved: boolean;
  pendingEntryStartedAt?: number;
  clearQualifiedStartedAt?: number;
  starvedAccumulatedMs: number;
  starvationEpisodeStartedAt?: number;
  starvationLastResumedAt?: number;
  starvationCause: DeviceDiagnosticsStarvationCountingCause | null;
  starvationPauseReason: DeviceDiagnosticsStarvationPauseReason | null;
};

type LiveDeviceDiagnostics = {
  name: string;
  lastObservedTs?: number;
  lastObservationBatchId?: number;
  lastObservation?: LiveDemandObservation;
  lastStarvationObservation?: LiveStarvationObservation;
  openShedTs?: number;
  openRestoreTs?: number;
  currentPenaltyLevel: number;
  starvation: LiveStarvationState;
};

type DeviceDiagnosticsServiceDeps = {
  homey: Homey.App['homey'];
  getTimeZone: () => string;
  isDebugEnabled?: () => boolean;
  structuredLog?: Pick<PinoLogger, 'info'>;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const clampPenaltyLevel = (value: unknown): number => {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(value)));
};

const createEmptyStarvationState = (): LiveStarvationState => ({
  isStarved: false,
  starvedAccumulatedMs: 0,
  starvationCause: null,
  starvationPauseReason: null,
});

const UNKNOWN_DEVICE_NAME = 'unknown device';

const roundUpToStep = (value: number, step: number): number => (
  Math.ceil(value / step) * step
);

const roundDownToStep = (value: number, step: number): number => (
  Math.floor(value / step) * step
);

const interpolateEntryDeficitC = (targetC: number): number => {
  const firstAnchor = STARVATION_ENTRY_ANCHORS[0];
  const lastAnchor = STARVATION_ENTRY_ANCHORS[STARVATION_ENTRY_ANCHORS.length - 1];
  if (targetC <= firstAnchor.targetC) return firstAnchor.deficitC;
  if (targetC >= lastAnchor.targetC) return lastAnchor.deficitC;

  for (let index = 1; index < STARVATION_ENTRY_ANCHORS.length; index += 1) {
    const previous = STARVATION_ENTRY_ANCHORS[index - 1];
    const current = STARVATION_ENTRY_ANCHORS[index];
    if (targetC > current.targetC) continue;
    const span = current.targetC - previous.targetC;
    const progress = span <= 0 ? 0 : (targetC - previous.targetC) / span;
    return previous.deficitC + ((current.deficitC - previous.deficitC) * progress);
  }

  return lastAnchor.deficitC;
};

const buildStarvationThresholds = (
  intendedNormalTargetC: number | null,
  targetStepC: number | null,
): StarvationThresholds | null => {
  if (!isFiniteNumber(intendedNormalTargetC) || !isFiniteNumber(targetStepC) || targetStepC <= 0) {
    return null;
  }
  const entryDeficitC = Math.max(
    targetStepC,
    roundUpToStep(interpolateEntryDeficitC(intendedNormalTargetC), targetStepC),
  );
  const exitDeficitC = Math.max(targetStepC, roundDownToStep(entryDeficitC * 0.5, targetStepC));
  return {
    entryDeficitC,
    entryThresholdC: intendedNormalTargetC - entryDeficitC,
    exitDeficitC,
    exitThresholdC: intendedNormalTargetC - exitDeficitC,
  };
};

const normalizeStarvationObservation = (
  observation: DeviceDiagnosticsPlanObservation,
): LiveStarvationObservation => ({
  eligibleForStarvation: observation.eligibleForStarvation,
  observationFresh: observation.observationFresh,
  currentTemperatureC: observation.currentTemperatureC,
  intendedNormalTargetC: observation.intendedNormalTargetC,
  targetStepC: observation.targetStepC,
  suppressionState: observation.suppressionState,
  countingCause: observation.countingCause,
  pauseReason: observation.pauseReason,
  thresholds: buildStarvationThresholds(
    observation.intendedNormalTargetC,
    observation.targetStepC,
  ),
});

const isValidStarvationObservation = (observation: LiveStarvationObservation): boolean => (
  observation.eligibleForStarvation
  && observation.observationFresh
  && isFiniteNumber(observation.currentTemperatureC)
  && observation.thresholds !== null
);

const isCountingStarvationObservation = (observation: LiveStarvationObservation): boolean => (
  isValidStarvationObservation(observation)
  && observation.suppressionState === 'counting'
  && observation.countingCause !== null
);

const starvationTargetChanged = (
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
  const currentTemperatureC = observation.currentTemperatureC ?? Number.NaN;
  const thresholds = observation.thresholds;
  const counting = isCountingStarvationObservation(observation);
  const pauseReason = !validObservation
    ? 'invalid_observation'
    : observation.pauseReason ?? (
      observation.suppressionState === 'none' ? 'suppression_none' : 'unknown_suppression_reason'
    );
  return {
    validObservation,
    counting,
    entryQualified: counting && thresholds !== null && currentTemperatureC <= thresholds.entryThresholdC,
    belowExitThreshold: validObservation
      && thresholds !== null
      && currentTemperatureC < thresholds.exitThresholdC,
    clearQualified: validObservation
      && thresholds !== null
      && currentTemperatureC >= thresholds.exitThresholdC,
    pauseReason,
  };
};

export class DeviceDiagnosticsService implements DeviceDiagnosticsRecorder {
  private persistedState: PersistedDiagnosticsState = createEmptyPersistedState({
    persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION,
    windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
  });
  private liveByDeviceId: Record<string, LiveDeviceDiagnostics> = {};
  private dirty = false;
  private dirtyDeviceIds = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushMs = 0;
  private lastSkippedFlushLogMs = 0;
  private lastSeenDateKey: string | null = null;
  private latestObservationBatchId = 0;

  constructor(private deps: DeviceDiagnosticsServiceDeps) {
    this.loadFromSettings();
  }

  observePlanSample(params: {
    observations: DeviceDiagnosticsPlanObservation[];
    nowTs?: number;
  }): void {
    const nowTs = params.nowTs ?? Date.now();
    this.latestObservationBatchId += 1;
    const observationBatchId = this.latestObservationBatchId;
    this.ensureDayRollover(nowTs);
    for (const observation of params.observations) {
      this.observeDeviceSample(observation, nowTs, observationBatchId);
    }
    this.scheduleFlush(nowTs);
  }

  recordControlEvent(event: DeviceDiagnosticsControlEvent): void {
    const nowTs = event.nowTs ?? Date.now();
    this.ensureDayRollover(nowTs);
    const live = this.getLiveDeviceState(event.deviceId);
    if (typeof event.name === 'string' && event.name.length > 0) {
      live.name = event.name;
    }
    switch (event.kind) {
      case 'shed':
        this.addCount(event.deviceId, nowTs, 'shedCount', 1);
        if (isFiniteNumber(live.openRestoreTs)) {
          const durationMs = Math.max(0, nowTs - live.openRestoreTs);
          this.addRestoreToSetback(event.deviceId, nowTs, durationMs);
          live.openRestoreTs = undefined;
          this.deps.logDebug(
            `Diagnostics: restore-to-setback completed ${formatDeviceRef(event.deviceId, live.name)} `
            + `duration=${formatDurationSeconds(durationMs)}`,
          );
        }
        live.openShedTs = nowTs;
        this.deps.logDebug(`Diagnostics: shed recorded ${formatDeviceRef(event.deviceId, live.name)}`);
        break;
      case 'restore':
        this.addCount(event.deviceId, nowTs, 'restoreCount', 1);
        if (isFiniteNumber(live.openShedTs)) {
          const durationMs = Math.max(0, nowTs - live.openShedTs);
          this.addShedToRestore(event.deviceId, nowTs, durationMs);
          live.openShedTs = undefined;
          this.deps.logDebug(
            `Diagnostics: shed-to-restore completed ${formatDeviceRef(event.deviceId, live.name)} `
            + `duration=${formatDurationSeconds(durationMs)}`,
          );
        }
        live.openRestoreTs = nowTs;
        this.deps.logDebug(`Diagnostics: restore recorded ${formatDeviceRef(event.deviceId, live.name)}`);
        break;
      case 'tracked_transition':
        this.deps.logDebug(
          `Diagnostics: tracked transition recorded ${formatDeviceRef(event.deviceId, live.name)} `
          + `direction=${event.direction}`,
        );
        break;
      default:
        return;
    }
    this.scheduleFlush(nowTs);
  }

  recordActivationTransition(
    transition: DeviceDiagnosticsBackoffTransition,
    params: { name?: string },
  ): void {
    const live = this.getLiveDeviceState(transition.deviceId);
    if (typeof params.name === 'string' && params.name.length > 0) {
      live.name = params.name;
    }
    this.ensureDayRollover(transition.nowTs);

    switch (transition.kind) {
      case 'attempt_started':
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.deps.logDebug(
          `Diagnostics: activation attempt started ${formatDeviceRef(transition.deviceId, live.name)} `
          + `source=${transition.source} penalty=${live.currentPenaltyLevel}`,
        );
        break;
      case 'stick_reached':
        this.addCount(transition.deviceId, transition.nowTs, 'stableActivationCount', 1);
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.deps.logDebug(
          `Diagnostics: activation stick reached ${formatDeviceRef(transition.deviceId, live.name)} `
          + `source=${transition.source ?? 'unknown'} penalty=${live.currentPenaltyLevel} `
          + `elapsed=${formatDurationSeconds(transition.elapsedMs)}`,
        );
        break;
      case 'setback_failed':
        this.addCount(transition.deviceId, transition.nowTs, 'failedActivationCount', 1);
        this.addCount(transition.deviceId, transition.nowTs, 'penaltyBumpCount', 1);
        this.updatePenaltyMaxSeen(transition.deviceId, transition.nowTs, transition.penaltyLevel);
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.deps.logDebug(
          `Diagnostics: failed activation ${formatDeviceRef(transition.deviceId, live.name)} `
          + `source=${transition.source ?? 'unknown'} `
          + `penalty=${transition.previousPenaltyLevel}->${transition.penaltyLevel} `
          + `elapsed=${formatDurationSeconds(transition.elapsedMs)}`,
        );
        break;
      case 'setback_after_stick':
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.deps.logDebug(
          `Diagnostics: setback after stick ${formatDeviceRef(transition.deviceId, live.name)} `
          + `source=${transition.source ?? 'unknown'} penalty=${transition.penaltyLevel} `
          + `elapsed=${formatDurationSeconds(transition.elapsedMs)}`,
        );
        break;
      case 'penalty_cleared':
        live.currentPenaltyLevel = 0;
        this.deps.logDebug(
          `Diagnostics: penalty cleared ${formatDeviceRef(transition.deviceId, live.name)} `
          + `source=${transition.source ?? 'unknown'} previousPenalty=${transition.previousPenaltyLevel} `
          + `elapsed=${formatDurationSeconds(transition.elapsedMs)}`,
        );
        break;
      case 'attempt_closed_inactive':
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.deps.logDebug(
          `Diagnostics: activation attempt closed inactive ${formatDeviceRef(transition.deviceId, live.name)} `
          + `source=${transition.source ?? 'unknown'} penalty=${transition.penaltyLevel} `
          + `elapsed=${formatDurationSeconds(transition.elapsedMs)}`,
        );
        break;
      default:
        return;
    }

    this.scheduleFlush(transition.nowTs);
  }

  getUiPayload(nowTs: number = Date.now()): SettingsUiDeviceDiagnosticsPayload {
    this.ensureDayRollover(nowTs);
    const timeZone = this.deps.getTimeZone();
    const currentDateKey = getDateKeyInTimeZone(new Date(nowTs), timeZone);
    const dateKeysByWindow = this.buildWindowDateKeys(currentDateKey);
    const diagnosticsByDeviceId: Record<string, DeviceDiagnosticsSummary> = {};
    const deviceIds = new Set([
      ...Object.keys(this.persistedState.devicesById),
      ...Object.keys(this.liveByDeviceId),
    ]);

    for (const deviceId of deviceIds) {
      diagnosticsByDeviceId[deviceId] = {
        currentPenaltyLevel: this.liveByDeviceId[deviceId]?.currentPenaltyLevel ?? 0,
        windows: {
          '1d': buildWindowSummary(this.persistedState.devicesById[deviceId], dateKeysByWindow['1d']),
          '7d': buildWindowSummary(this.persistedState.devicesById[deviceId], dateKeysByWindow['7d']),
          '21d': buildWindowSummary(this.persistedState.devicesById[deviceId], dateKeysByWindow['21d']),
        },
      };
    }

    return {
      generatedAt: nowTs,
      windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
      diagnosticsByDeviceId,
    };
  }

  getCurrentStarvedDeviceCount(): number {
    return Object.values(this.liveByDeviceId)
      .filter((live) => live.lastObservationBatchId === this.latestObservationBatchId)
      .filter((live) => live.starvation.isStarved)
      .length;
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush('shutdown', { force: true });
  }

  private isDiagnosticsDebugEnabled(): boolean {
    return this.deps.isDebugEnabled?.() ?? true;
  }

  private loadFromSettings(): void {
    const raw = this.deps.homey.settings.get(DEVICE_DIAGNOSTICS_STATE_KEY) as unknown;
    const sanitized = sanitizePersistedState({
      raw,
      persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION,
      windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
    });
    this.persistedState = sanitized.state;
    const prunedDayCount = this.pruneExpiredDays(Date.now());
    this.lastSeenDateKey = getDateKeyInTimeZone(new Date(), this.deps.getTimeZone());

    if (sanitized.resetReason) {
      this.deps.logDebug(`Diagnostics: reset persisted payload reason="${sanitized.resetReason}"`);
      this.dirty = true;
      this.flush('startup_repair', { force: true });
      return;
    }

    if (prunedDayCount > 0 || sanitized.repaired) {
      this.dirty = true;
      this.flush('startup_repair', { force: true });
    }

    this.deps.logDebug(
      `Diagnostics: loaded persisted payload version=${this.persistedState.version} `
      + `devices=${countPersistedDevices(this.persistedState)} days=${countPersistedDays(this.persistedState)}`,
    );
    if (prunedDayCount > 0) {
      this.deps.logDebug(`Diagnostics: pruned expired days count=${prunedDayCount}`);
    }
  }

  private observeDeviceSample(
    observation: DeviceDiagnosticsPlanObservation,
    nowTs: number,
    observationBatchId: number,
  ): void {
    const live = this.getLiveDeviceState(observation.deviceId);
    live.name = observation.name;
    live.lastObservationBatchId = observationBatchId;
    const nextObservation: LiveDemandObservation = {
      includeDemandMetrics: observation.includeDemandMetrics,
      unmetDemand: observation.unmetDemand,
      blockCause: observation.blockCause,
      targetDeficitActive: observation.targetDeficitActive,
      desiredStateSummary: observation.desiredStateSummary,
      appliedStateSummary: observation.appliedStateSummary,
    };
    const nextStarvationObservation = normalizeStarvationObservation(observation);

    if (isFiniteNumber(live.lastObservedTs) && live.lastObservation) {
      const gapMs = Math.max(0, nowTs - live.lastObservedTs);
      if (gapMs > DEVICE_DIAGNOSTICS_MAX_SAMPLE_GAP_MS) {
        this.deps.logDebug(
          `Diagnostics: gap skipped ${formatDeviceRef(observation.deviceId, live.name)} `
          + `gap=${formatDurationSeconds(gapMs)}`,
        );
        this.handleStarvationGap(observation.deviceId, nowTs);
      } else {
        this.accumulateObservationSpan(observation.deviceId, live.lastObservedTs, nowTs, live.lastObservation);
        if (live.lastStarvationObservation) {
          this.applyStarvationObservationSpan(
            observation.deviceId,
            live,
            live.lastStarvationObservation,
            live.lastObservedTs,
            nowTs,
          );
        }
      }
    }

    this.logObservationTransition(observation.deviceId, live.name, live.lastObservation, nextObservation);
    if (starvationTargetChanged(live.lastStarvationObservation, nextStarvationObservation)) {
      this.handleStarvationTargetChange(observation.deviceId, nowTs);
    }
    this.applyStarvationObservationSpan(
      observation.deviceId,
      live,
      nextStarvationObservation,
      nowTs,
      nowTs,
    );
    live.lastObservation = nextObservation;
    live.lastStarvationObservation = nextStarvationObservation;
    live.lastObservedTs = nowTs;
  }

  private applyStarvationObservationSpan(
    deviceId: string,
    live: LiveDeviceDiagnostics,
    observation: LiveStarvationObservation,
    startTs: number,
    endTs: number,
  ): void {
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
      this.applyStarvationClearProgress(deviceId, observation, evaluation, { startTs, endTs });
      return;
    }
    if (evaluation.counting && evaluation.belowExitThreshold) {
      this.applyStarvationCountingProgress(deviceId, observation, startTs, endTs);
      return;
    }
    this.pauseStarvation(deviceId, evaluation.pauseReason, startTs);
  }

  private handleStarvationGap(
    deviceId: string,
    nowTs: number,
  ): void {
    const live = this.getLiveDeviceState(deviceId);
    live.starvation = {
      ...live.starvation,
      pendingEntryStartedAt: undefined,
      clearQualifiedStartedAt: undefined,
    };
    if (!live.starvation.isStarved) return;
    this.pauseStarvation(deviceId, 'sample_gap', nowTs);
  }

  private handleStarvationTargetChange(deviceId: string, nowTs: number): void {
    const live = this.getLiveDeviceState(deviceId);
    if (!live.starvation.isStarved) {
      live.starvation = {
        ...live.starvation,
        pendingEntryStartedAt: undefined,
        clearQualifiedStartedAt: undefined,
        starvationCause: null,
        starvationPauseReason: null,
      };
      this.deps.logDebug(
        `Diagnostics: starvation pending reset ${formatDeviceRef(deviceId, live.name)} `
        + `reason=target_changed at=${new Date(nowTs).toISOString()}`,
      );
      return;
    }
    live.starvation = {
      ...live.starvation,
      clearQualifiedStartedAt: undefined,
    };
    this.deps.logDebug(
      `Diagnostics: starvation thresholds refreshed ${formatDeviceRef(deviceId, live.name)} `
      + `reason=target_changed at=${new Date(nowTs).toISOString()}`,
    );
  }

  private resetStarvationState(deviceId: string): void {
    this.getLiveDeviceState(deviceId).starvation = createEmptyStarvationState();
  }

  private applyStarvationEntryProgress(
    deviceId: string,
    observation: LiveStarvationObservation,
    evaluation: StarvationEvaluation,
    span: { startTs: number; endTs: number },
  ): void {
    const live = this.getLiveDeviceState(deviceId);
    const { startTs, endTs } = span;
    if (!evaluation.entryQualified) {
      live.starvation = {
        ...live.starvation,
        pendingEntryStartedAt: undefined,
        starvationCause: null,
        starvationPauseReason: null,
      };
      return;
    }
    const pendingEntryStartedAt = isFiniteNumber(live.starvation.pendingEntryStartedAt)
      ? live.starvation.pendingEntryStartedAt
      : startTs;
    const entryAt = pendingEntryStartedAt + DEVICE_DIAGNOSTICS_STARVATION_ENTRY_MS;
    live.starvation = {
      ...live.starvation,
      pendingEntryStartedAt,
    };
    if (endTs < entryAt) return;

    const accumulatedMs = endTs > entryAt && evaluation.belowExitThreshold
      ? endTs - entryAt
      : 0;
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
    this.deps.structuredLog?.info({
      event: 'device_starvation_started',
      deviceId,
      deviceName: live.name,
      cause: observation.countingCause,
      starvationEpisodeStartedAtMs: entryAt,
      starvedDurationMs: accumulatedMs,
    });
    this.deps.logDebug(
      `Diagnostics: starvation started ${formatDeviceRef(deviceId, live.name)} `
      + `cause=${observation.countingCause ?? 'unknown'} at=${new Date(entryAt).toISOString()}`,
    );
  }

  private applyStarvationClearProgress(
    deviceId: string,
    observation: LiveStarvationObservation,
    evaluation: StarvationEvaluation,
    span: { startTs: number; endTs: number },
  ): void {
    const live = this.getLiveDeviceState(deviceId);
    const { startTs, endTs } = span;
    const clearQualifiedStartedAt = isFiniteNumber(live.starvation.clearQualifiedStartedAt)
      ? live.starvation.clearQualifiedStartedAt
      : startTs;
    const clearAt = clearQualifiedStartedAt + DEVICE_DIAGNOSTICS_STARVATION_CLEAR_MS;
    live.starvation = {
      ...live.starvation,
      clearQualifiedStartedAt,
      starvationLastResumedAt: undefined,
      starvationCause: evaluation.counting ? observation.countingCause : null,
      starvationPauseReason: evaluation.counting ? null : evaluation.pauseReason,
    };
    if (endTs < clearAt) return;
    this.deps.structuredLog?.info({
      event: 'device_starvation_cleared',
      deviceId,
      deviceName: live.name,
      transitionAtMs: clearAt,
      starvedDurationMs: live.starvation.starvedAccumulatedMs,
    });
    this.deps.logDebug(
      `Diagnostics: starvation cleared ${formatDeviceRef(deviceId, live.name)} `
      + `at=${new Date(clearAt).toISOString()}`,
    );
    this.resetStarvationState(deviceId);
  }

  private applyStarvationCountingProgress(
    deviceId: string,
    observation: LiveStarvationObservation,
    startTs: number,
    endTs: number,
  ): void {
    const live = this.getLiveDeviceState(deviceId);
    if (!isFiniteNumber(live.starvation.starvationLastResumedAt)) {
      this.deps.structuredLog?.info({
        event: 'device_starvation_resumed',
        deviceId,
        deviceName: live.name,
        cause: observation.countingCause,
        transitionAtMs: startTs,
        starvedDurationMs: live.starvation.starvedAccumulatedMs,
      });
      this.deps.logDebug(
        `Diagnostics: starvation resumed ${formatDeviceRef(deviceId, live.name)} `
        + `cause=${observation.countingCause ?? 'unknown'} at=${new Date(startTs).toISOString()}`,
      );
    }
    live.starvation = {
      ...live.starvation,
      clearQualifiedStartedAt: undefined,
      starvationLastResumedAt: isFiniteNumber(live.starvation.starvationLastResumedAt)
        ? live.starvation.starvationLastResumedAt
        : startTs,
      starvedAccumulatedMs: live.starvation.starvedAccumulatedMs + Math.max(0, endTs - startTs),
      starvationCause: observation.countingCause,
      starvationPauseReason: null,
    };
  }

  private pauseStarvation(
    deviceId: string,
    pauseReason: DeviceDiagnosticsStarvationPauseReason,
    nowTs: number,
  ): void {
    const live = this.getLiveDeviceState(deviceId);
    if (isFiniteNumber(live.starvation.starvationLastResumedAt)) {
      this.deps.structuredLog?.info({
        event: 'device_starvation_paused',
        deviceId,
        deviceName: live.name,
        pauseReason,
        transitionAtMs: nowTs,
        starvedDurationMs: live.starvation.starvedAccumulatedMs,
      });
      this.deps.logDebug(
        `Diagnostics: starvation paused ${formatDeviceRef(deviceId, live.name)} `
        + `reason=${pauseReason} at=${new Date(nowTs).toISOString()}`,
      );
    }
    live.starvation = {
      ...live.starvation,
      clearQualifiedStartedAt: undefined,
      starvationLastResumedAt: undefined,
      starvationCause: null,
      starvationPauseReason: pauseReason,
    };
  }

  private hardResetStarvation(
    deviceId: string,
    reasonCode: DeviceDiagnosticsStarvationResetReasonCode,
    nowTs: number,
  ): void {
    const live = this.getLiveDeviceState(deviceId);
    const starvation = live.starvation;
    if (
      !starvation.isStarved
      && !isFiniteNumber(starvation.pendingEntryStartedAt)
      && starvation.starvedAccumulatedMs === 0
    ) {
      return;
    }
    this.deps.structuredLog?.info({
      event: 'device_starvation_hard_reset',
      deviceId,
      deviceName: live.name,
      reasonCode,
      transitionAtMs: nowTs,
      starvedDurationMs: starvation.starvedAccumulatedMs,
      wasStarved: starvation.isStarved,
    });
    this.deps.logDebug(
      `Diagnostics: starvation hard-reset ${formatDeviceRef(deviceId, live.name)} `
      + `reason=${reasonCode} at=${new Date(nowTs).toISOString()}`,
    );
    this.resetStarvationState(deviceId);
  }

  private accumulateObservationSpan(
    deviceId: string,
    startTs: number,
    endTs: number,
    observation: LiveDemandObservation,
  ): void {
    if (!observation.includeDemandMetrics || !observation.unmetDemand || endTs <= startTs) return;
    this.addDurationByDay(deviceId, startTs, endTs, 'unmetDemandMs');
    if (observation.targetDeficitActive) {
      this.addDurationByDay(deviceId, startTs, endTs, 'targetDeficitMs');
    }
    if (observation.blockCause === 'headroom') {
      this.addDurationByDay(deviceId, startTs, endTs, 'blockedByHeadroomMs');
    } else if (observation.blockCause === 'cooldown_backoff') {
      this.addDurationByDay(deviceId, startTs, endTs, 'blockedByCooldownBackoffMs');
    }
  }

  private logObservationTransition(
    deviceId: string,
    name: string,
    previous: LiveDemandObservation | undefined,
    next: LiveDemandObservation,
  ): void {
    const previousUnmet = previous?.includeDemandMetrics === true && previous.unmetDemand;
    const nextUnmet = next.includeDemandMetrics && next.unmetDemand;
    const transition = {
      deviceId,
      name,
      previous,
      next,
      previousUnmet,
      nextUnmet,
    };
    this.logDemandBoundary(transition);
    this.logBlockCauseChange(transition);
  }

  private logDemandBoundary(transition: {
    deviceId: string;
    name: string;
    previous: LiveDemandObservation | undefined;
    next: LiveDemandObservation;
    previousUnmet: boolean;
    nextUnmet: boolean;
  }): void {
    const {
      deviceId,
      name,
      previous,
      next,
      previousUnmet,
      nextUnmet,
    } = transition;
    if (!previousUnmet && nextUnmet) {
      this.deps.logDebug(
        `Diagnostics: unmet demand started ${formatDeviceRef(deviceId, name)} `
        + `desired="${next.desiredStateSummary}" applied="${next.appliedStateSummary}" `
        + `cause=${next.blockCause}`,
      );
      return;
    }
    if (!previousUnmet || nextUnmet) return;
    this.deps.logDebug(
      `Diagnostics: unmet demand ended ${formatDeviceRef(deviceId, name)} `
      + `desired="${previous?.desiredStateSummary ?? 'unknown'}" `
      + `applied="${previous?.appliedStateSummary ?? 'unknown'}"`,
    );
  }

  private logBlockCauseChange(transition: {
    deviceId: string;
    name: string;
    previous: LiveDemandObservation | undefined;
    next: LiveDemandObservation;
    previousUnmet: boolean;
    nextUnmet: boolean;
  }): void {
    const {
      deviceId,
      name,
      previous,
      next,
      previousUnmet,
      nextUnmet,
    } = transition;
    const previousCause = previousUnmet ? previous?.blockCause : 'not_blocked';
    const nextCause = nextUnmet ? next.blockCause : 'not_blocked';
    if (!(previousUnmet || nextUnmet) || previousCause === nextCause) return;
    this.deps.logDebug(
      `Diagnostics: block cause changed ${formatDeviceRef(deviceId, name)} `
      + `desired="${next.desiredStateSummary}" applied="${next.appliedStateSummary}" `
      + `cause=${previousCause ?? 'not_blocked'}->${nextCause}`,
    );
  }

  private addDurationByDay(
    deviceId: string,
    startTs: number,
    endTs: number,
    key: keyof Pick<
      PersistedDayAggregate,
      'unmetDemandMs' | 'blockedByHeadroomMs' | 'blockedByCooldownBackoffMs' | 'targetDeficitMs'
    >,
  ): void {
    if (endTs <= startTs) return;
    let cursorTs = startTs;
    const timeZone = this.deps.getTimeZone();
    while (cursorTs < endTs) {
      const dateKey = getDateKeyInTimeZone(new Date(cursorTs), timeZone);
      const dayStartTs = getDateKeyStartMs(dateKey, timeZone);
      const nextDayStartTs = getNextLocalDayStartUtcMs(dayStartTs, timeZone);
      const sliceEndTs = Math.min(endTs, nextDayStartTs);
      const aggregate = this.getDayAggregate(deviceId, dateKey);
      aggregate[key] += Math.max(0, sliceEndTs - cursorTs);
      cursorTs = sliceEndTs;
      this.markDirty(deviceId);
    }
  }

  private addCount(
    deviceId: string,
    nowTs: number,
    key: keyof Pick<
      PersistedDayAggregate,
      'shedCount' | 'restoreCount' | 'failedActivationCount' | 'stableActivationCount' | 'penaltyBumpCount'
    >,
    delta: number,
  ): void {
    if (delta <= 0) return;
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate[key] += delta;
    this.markDirty(deviceId);
  }

  private addShedToRestore(deviceId: string, nowTs: number, durationMs: number): void {
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate.shedToRestoreCount += 1;
    aggregate.shedToRestoreTotalMs += Math.max(0, durationMs);
    this.markDirty(deviceId);
  }

  private addRestoreToSetback(deviceId: string, nowTs: number, durationMs: number): void {
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate.restoreToSetbackCount += 1;
    aggregate.restoreToSetbackTotalMs += Math.max(0, durationMs);
    aggregate.restoreToSetbackMinMs = aggregate.restoreToSetbackMinMs === null
      ? Math.max(0, durationMs)
      : Math.min(aggregate.restoreToSetbackMinMs, Math.max(0, durationMs));
    aggregate.restoreToSetbackMaxMs = aggregate.restoreToSetbackMaxMs === null
      ? Math.max(0, durationMs)
      : Math.max(aggregate.restoreToSetbackMaxMs, Math.max(0, durationMs));
    this.markDirty(deviceId);
  }

  private updatePenaltyMaxSeen(deviceId: string, nowTs: number, penaltyLevel: number): void {
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate.penaltyMaxLevelSeen = Math.max(aggregate.penaltyMaxLevelSeen, clampPenaltyLevel(penaltyLevel));
    this.markDirty(deviceId);
  }

  private getDayAggregateForTs(deviceId: string, nowTs: number): PersistedDayAggregate {
    const dateKey = getDateKeyInTimeZone(new Date(nowTs), this.deps.getTimeZone());
    return this.getDayAggregate(deviceId, dateKey);
  }

  private getDayAggregate(deviceId: string, dateKey: string): PersistedDayAggregate {
    let deviceState = this.persistedState.devicesById[deviceId];
    if (!deviceState) {
      deviceState = { daysByDateKey: {} };
      this.persistedState.devicesById[deviceId] = deviceState;
    }
    let aggregate = deviceState.daysByDateKey[dateKey];
    if (!aggregate) {
      aggregate = createEmptyDayAggregate();
      deviceState.daysByDateKey[dateKey] = aggregate;
      this.markDirty(deviceId);
    }
    return aggregate;
  }

  private getLiveDeviceState(deviceId: string): LiveDeviceDiagnostics {
    let live = this.liveByDeviceId[deviceId];
    if (!live) {
      live = {
        name: UNKNOWN_DEVICE_NAME,
        currentPenaltyLevel: 0,
        starvation: createEmptyStarvationState(),
      };
      this.liveByDeviceId[deviceId] = live;
    }
    return live;
  }

  private buildWindowDateKeys(currentDateKey: string): Record<DeviceDiagnosticsWindowKey, string[]> {
    return {
      '1d': this.getRecentDateKeys(currentDateKey, 1),
      '7d': this.getRecentDateKeys(currentDateKey, 7),
      '21d': this.getRecentDateKeys(currentDateKey, 21),
    };
  }

  private getRecentDateKeys(currentDateKey: string, count: number): string[] {
    return getRecentDateKeys({
      currentDateKey,
      count,
      timeZone: this.deps.getTimeZone(),
    });
  }

  private pruneExpiredDays(nowTs: number): number {
    const timeZone = this.deps.getTimeZone();
    const currentDateKey = getDateKeyInTimeZone(new Date(nowTs), timeZone);
    const allowedKeys = new Set(this.getRecentDateKeys(currentDateKey, DEVICE_DIAGNOSTICS_WINDOW_DAYS));
    let removed = 0;
    for (const [deviceId, deviceState] of Object.entries(this.persistedState.devicesById)) {
      let removedForDevice = false;
      for (const dateKey of Object.keys(deviceState.daysByDateKey)) {
        if (allowedKeys.has(dateKey)) continue;
        delete deviceState.daysByDateKey[dateKey];
        removed += 1;
        removedForDevice = true;
      }
      if (Object.keys(deviceState.daysByDateKey).length === 0) {
        delete this.persistedState.devicesById[deviceId];
        removedForDevice = true;
      }
      if (removedForDevice) {
        this.markDirty(deviceId);
      }
    }
    return removed;
  }

  private ensureDayRollover(nowTs: number): void {
    const currentDateKey = getDateKeyInTimeZone(new Date(nowTs), this.deps.getTimeZone());
    if (this.lastSeenDateKey === null) {
      this.lastSeenDateKey = currentDateKey;
      return;
    }
    if (this.lastSeenDateKey === currentDateKey) return;
    this.flush('day_rollover', { force: true });
    const pruned = this.pruneExpiredDays(nowTs);
    if (pruned > 0) {
      this.deps.logDebug(`Diagnostics: pruned expired days count=${pruned}`);
    }
    this.lastSeenDateKey = currentDateKey;
  }

  private scheduleFlush(nowTs: number): void {
    if (!this.dirty) {
      this.logSkippedFlush(nowTs, 'no changes');
      return;
    }
    if (this.flushTimer) return;
    const waitMs = this.lastFlushMs === 0
      ? 0
      : Math.max(0, DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS - (nowTs - this.lastFlushMs));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush('throttle');
    }, waitMs);
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null && 'unref' in this.flushTimer
      && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  private logSkippedFlush(nowTs: number, detail: string): void {
    if (nowTs - this.lastSkippedFlushLogMs < DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS) return;
    this.lastSkippedFlushLogMs = nowTs;
    this.deps.logDebug(`Diagnostics: skipped flush detail="${detail}"`);
  }

  private flush(reason: 'startup_repair' | 'throttle' | 'day_rollover' | 'shutdown', options: {
    force?: boolean;
  } = {}): void {
    const nowTs = Date.now();
    if (!this.dirty) {
      this.logSkippedFlush(nowTs, `nothing dirty (${reason})`);
      return;
    }
    if (!options.force && this.lastFlushMs > 0 && (nowTs - this.lastFlushMs) < DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS) {
      this.scheduleFlush(nowTs);
      return;
    }

    this.persistedState.generatedAt = nowTs;
    try {
      this.deps.homey.settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, this.persistedState);
      this.lastFlushMs = nowTs;
      this.dirty = false;
      const dirtyDeviceCount = this.dirtyDeviceIds.size;
      const dayCount = countPersistedDays(this.persistedState);
      const bytesSuffix = this.isDiagnosticsDebugEnabled()
        ? ` bytes=${Buffer.byteLength(JSON.stringify(this.persistedState), 'utf8')}`
        : '';
      this.dirtyDeviceIds.clear();
      this.deps.logDebug(
        `Diagnostics: flushed reason=${reason} dirtyDevices=${dirtyDeviceCount} `
        + `days=${dayCount}${bytesSuffix}`,
      );
    } catch (error) {
      this.deps.error('Failed to persist device diagnostics state', error as Error);
    }
  }

  private markDirty(deviceId: string): void {
    this.dirty = true;
    if (deviceId) {
      this.dirtyDeviceIds.add(deviceId);
    }
  }
}
