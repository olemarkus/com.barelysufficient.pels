/* eslint-disable max-lines -- Stateful diagnostics orchestration stays consolidated in one service. */
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

export const DEVICE_DIAGNOSTICS_STATE_KEY = 'device_diagnostics_v1';
export const DEVICE_DIAGNOSTICS_WINDOW_DAYS = 21;
export const DEVICE_DIAGNOSTICS_PERSIST_VERSION = 1;

const DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS = 5 * 60 * 1000;
const DEVICE_DIAGNOSTICS_MAX_SAMPLE_GAP_MS = 10 * 60 * 1000;

export type DeviceDiagnosticsBlockCause = 'not_blocked' | 'headroom' | 'cooldown_backoff';
export type DeviceDiagnosticsControlEventOrigin = 'pels' | 'tracked';

export type DeviceDiagnosticsPlanObservation = {
  deviceId: string;
  name?: string;
  includeDemandMetrics: boolean;
  unmetDemand: boolean;
  blockCause: DeviceDiagnosticsBlockCause;
  targetDeficitActive: boolean;
  desiredStateSummary: string;
  appliedStateSummary: string;
};

export type DeviceDiagnosticsControlEvent = {
  kind: 'shed' | 'restore';
  origin: DeviceDiagnosticsControlEventOrigin;
  deviceId: string;
  name?: string;
  nowTs?: number;
};

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
  recordActivationTransition: (transition: DeviceDiagnosticsBackoffTransition, params?: {
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

type LiveDeviceDiagnostics = {
  name?: string;
  lastObservedTs?: number;
  lastObservation?: LiveDemandObservation;
  openShedTs?: number;
  openRestoreTs?: number;
  currentPenaltyLevel: number;
};

type DeviceDiagnosticsServiceDeps = {
  homey: Homey.App['homey'];
  getTimeZone: () => string;
  isDebugEnabled?: () => boolean;
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

  constructor(private deps: DeviceDiagnosticsServiceDeps) {
    this.loadFromSettings();
  }

  observePlanSample(params: {
    observations: DeviceDiagnosticsPlanObservation[];
    nowTs?: number;
  }): void {
    const nowTs = params.nowTs ?? Date.now();
    this.ensureDayRollover(nowTs);
    for (const observation of params.observations) {
      this.observeDeviceSample(observation, nowTs);
    }
    this.scheduleFlush(nowTs);
  }

  recordControlEvent(event: DeviceDiagnosticsControlEvent): void {
    const nowTs = event.nowTs ?? Date.now();
    this.ensureDayRollover(nowTs);
    const live = this.getLiveDeviceState(event.deviceId);
    if (event.name) live.name = event.name;
    if (event.kind === 'shed') {
      this.addCount(event.deviceId, nowTs, 'shedCount', 1);
      if (isFiniteNumber(live.openRestoreTs)) {
        const durationMs = Math.max(0, nowTs - live.openRestoreTs);
        this.addRestoreToSetback(event.deviceId, nowTs, durationMs);
        live.openRestoreTs = undefined;
        this.deps.logDebug(
          `Diagnostics: restore-to-setback completed ${formatDeviceRef(event.deviceId, live.name)} `
          + `origin=${event.origin} duration=${formatDurationSeconds(durationMs)}`,
        );
      }
      live.openShedTs = nowTs;
      this.deps.logDebug(
        `Diagnostics: shed recorded ${formatDeviceRef(event.deviceId, live.name)} origin=${event.origin}`,
      );
    } else {
      this.addCount(event.deviceId, nowTs, 'restoreCount', 1);
      if (isFiniteNumber(live.openShedTs)) {
        const durationMs = Math.max(0, nowTs - live.openShedTs);
        this.addShedToRestore(event.deviceId, nowTs, durationMs);
        live.openShedTs = undefined;
        this.deps.logDebug(
          `Diagnostics: shed-to-restore completed ${formatDeviceRef(event.deviceId, live.name)} `
          + `origin=${event.origin} duration=${formatDurationSeconds(durationMs)}`,
        );
      }
      live.openRestoreTs = nowTs;
      this.deps.logDebug(
        `Diagnostics: restore recorded ${formatDeviceRef(event.deviceId, live.name)} origin=${event.origin}`,
      );
    }
    this.scheduleFlush(nowTs);
  }

  recordActivationTransition(
    transition: DeviceDiagnosticsBackoffTransition,
    params: { name?: string } = {},
  ): void {
    const live = this.getLiveDeviceState(transition.deviceId);
    if (params.name) live.name = params.name;
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

  private observeDeviceSample(observation: DeviceDiagnosticsPlanObservation, nowTs: number): void {
    const live = this.getLiveDeviceState(observation.deviceId);
    if (observation.name) live.name = observation.name;
    const nextObservation: LiveDemandObservation = {
      includeDemandMetrics: observation.includeDemandMetrics,
      unmetDemand: observation.unmetDemand,
      blockCause: observation.blockCause,
      targetDeficitActive: observation.targetDeficitActive,
      desiredStateSummary: observation.desiredStateSummary,
      appliedStateSummary: observation.appliedStateSummary,
    };

    if (isFiniteNumber(live.lastObservedTs) && live.lastObservation) {
      const gapMs = Math.max(0, nowTs - live.lastObservedTs);
      if (gapMs > DEVICE_DIAGNOSTICS_MAX_SAMPLE_GAP_MS) {
        this.deps.logDebug(
          `Diagnostics: gap skipped ${formatDeviceRef(observation.deviceId, live.name)} `
          + `gap=${formatDurationSeconds(gapMs)}`,
        );
      } else {
        this.accumulateObservationSpan(observation.deviceId, live.lastObservedTs, nowTs, live.lastObservation);
      }
    }

    this.logObservationTransition(observation.deviceId, live.name, live.lastObservation, nextObservation);
    live.lastObservation = nextObservation;
    live.lastObservedTs = nowTs;
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
    name: string | undefined,
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
    name: string | undefined;
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
    name: string | undefined;
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
        currentPenaltyLevel: 0,
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
