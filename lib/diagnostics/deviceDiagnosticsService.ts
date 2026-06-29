import type { SettingsUiDeviceDiagnosticsPayload } from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUiApi';
import type {
  DeviceDiagnosticsBackoffTransition,
  DeviceDiagnosticsControlEvent,
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsRecorder,
  DeviceDiagnosticsServiceDeps,
  LiveDemandObservation,
  LiveDeviceDiagnostics,
} from './deviceDiagnosticsServiceTypes';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { clampPenaltyLevel, isFiniteNumber } from './deviceDiagnosticsNumbers';
import { DeviceDiagnosticsPersistence } from './deviceDiagnosticsPersistence';
import {
  StarvationTracker,
  createEmptyStarvationState,
  normalizeStarvationObservation,
  starvationTargetChanged,
} from './deviceDiagnosticsEpisodes';
import { logObservationTransition, logTrackedUsageEvent } from './deviceDiagnosticsLogging';
import {
  buildUiPayload,
  getCurrentStarvedDeviceCount as computeCurrentStarvedDeviceCount,
  getOverviewStarvation as computeOverviewStarvation,
  getStarvedRescueEntries as computeStarvedRescueEntries,
  type StarvedRescueEntry,
} from './deviceDiagnosticsUiPayload';

export type {
  DeviceDiagnosticsBlockCause,
  DeviceDiagnosticsStarvationSuppressionState,
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsTrackedTransitionReconciliation,
  DeviceDiagnosticsControlEvent,
  DeviceDiagnosticsBackoffTransition,
  DeviceDiagnosticsRecorder,
} from './deviceDiagnosticsServiceTypes';
export type {
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
export {
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DEVICE_DIAGNOSTICS_WINDOW_DAYS,
  DEVICE_DIAGNOSTICS_PERSIST_VERSION,
} from './deviceDiagnosticsPersistence';

const moduleLogger = getLogger('diagnostics/device');
// Hoisted once so `emitDebug` allocates no per-call closure on the (test-only;
// production always wires `debugStructured`) fallback path.
const debugFallbackEmit: StructuredDebugEmitter = (payload) => moduleLogger.debug(payload);

const DEVICE_DIAGNOSTICS_MAX_SAMPLE_GAP_MS = 10 * 60 * 1000;

const UNKNOWN_DEVICE_NAME = 'unknown device';

export class DeviceDiagnosticsService implements DeviceDiagnosticsRecorder {
  private liveByDeviceId: Record<string, LiveDeviceDiagnostics> = {};
  private latestObservationBatchId = 0;
  // Stable bound emitter so the demand-transition logging helpers receive a
  // single closure instead of allocating one per observation cycle.
  private readonly emit: StructuredDebugEmitter = (payload) => this.emitDebug(payload);
  private readonly persistence: DeviceDiagnosticsPersistence;
  private readonly starvation: StarvationTracker;

  constructor(private deps: DeviceDiagnosticsServiceDeps) {
    this.persistence = new DeviceDiagnosticsPersistence({
      diagnosticsStateStore: deps.diagnosticsStateStore,
      getTimeZone: deps.getTimeZone,
      isDebugEnabled: deps.isDebugEnabled,
      structuredLog: deps.structuredLog,
      debugStructured: deps.debugStructured,
    });
    this.starvation = new StarvationTracker({
      getLiveDeviceState: (deviceId) => this.getLiveDeviceState(deviceId),
      structuredLog: deps.structuredLog,
      emitDebug: this.emit,
    });
  }

  // Topic-gated (`diagnostics`) structured debug emit. Mirrors the
  // `structuredLog ?? moduleLogger` fallback used for info events so events
  // still surface at debug level when no wired emitter is present (e.g. tests).
  private emitDebug(payload: Record<string, unknown>): void {
    (this.deps.debugStructured ?? debugFallbackEmit)(payload);
  }

  observePlanSample(params: {
    observations: DeviceDiagnosticsPlanObservation[];
    nowTs?: number;
  }): void {
    const nowTs = params.nowTs ?? Date.now();
    this.latestObservationBatchId += 1;
    const observationBatchId = this.latestObservationBatchId;
    this.persistence.ensureDayRollover(nowTs);
    for (const observation of params.observations) {
      this.observeDeviceSample(observation, nowTs, observationBatchId);
    }
    this.persistence.scheduleFlush(nowTs);
  }

  recordControlEvent(event: DeviceDiagnosticsControlEvent): void {
    const nowTs = event.nowTs ?? Date.now();
    this.persistence.ensureDayRollover(nowTs);
    const live = this.getLiveDeviceState(event.deviceId);
    if (typeof event.name === 'string' && event.name.length > 0) {
      live.name = event.name;
    }
    switch (event.kind) {
      case 'pels_shed':
        this.recordPelsShedEvent(event.deviceId, nowTs);
        this.persistence.scheduleFlush(nowTs);
        break;
      case 'pels_restore':
        this.recordPelsRestoreEvent(event.deviceId, nowTs);
        this.persistence.scheduleFlush(nowTs);
        break;
      case 'tracked_usage_rise':
        logTrackedUsageEvent(this.emit, 'rise', event, live.name);
        break;
      case 'tracked_usage_drop':
        logTrackedUsageEvent(this.emit, 'drop', event, live.name);
        break;
      default: {
        const exhaustiveCheck: never = event;
        void exhaustiveCheck;
      }
    }
  }

  recordActivationTransition(
    transition: DeviceDiagnosticsBackoffTransition,
    params: { name?: string },
  ): void {
    const live = this.getLiveDeviceState(transition.deviceId);
    if (typeof params.name === 'string' && params.name.length > 0) {
      live.name = params.name;
    }
    this.persistence.ensureDayRollover(transition.nowTs);

    switch (transition.kind) {
      case 'attempt_started':
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.emitDebug({
          event: 'diagnostics_activation_transition',
          kind: 'attempt_started',
          deviceId: transition.deviceId,
          deviceName: live.name,
          source: transition.source,
          penaltyLevel: live.currentPenaltyLevel,
        });
        break;
      case 'setback_failed':
        this.persistence.addCount(transition.deviceId, transition.nowTs, 'failedActivationCount', 1);
        this.persistence.addCount(transition.deviceId, transition.nowTs, 'penaltyBumpCount', 1);
        this.persistence.updatePenaltyMaxSeen(transition.deviceId, transition.nowTs, transition.penaltyLevel);
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.emitDebug({
          event: 'diagnostics_activation_transition',
          kind: 'setback_failed',
          deviceId: transition.deviceId,
          deviceName: live.name,
          source: transition.source ?? 'unknown',
          previousPenaltyLevel: transition.previousPenaltyLevel,
          penaltyLevel: transition.penaltyLevel,
          elapsedMs: transition.elapsedMs,
        });
        break;
      case 'attempt_closed_inactive':
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.emitDebug({
          event: 'diagnostics_activation_transition',
          kind: 'attempt_closed_inactive',
          deviceId: transition.deviceId,
          deviceName: live.name,
          source: transition.source ?? 'unknown',
          penaltyLevel: transition.penaltyLevel,
          elapsedMs: transition.elapsedMs,
        });
        break;
      case 'attempt_closed_by_shed':
        live.currentPenaltyLevel = clampPenaltyLevel(transition.penaltyLevel);
        this.emitDebug({
          event: 'diagnostics_activation_transition',
          kind: 'attempt_closed_by_shed',
          deviceId: transition.deviceId,
          deviceName: live.name,
          source: transition.source ?? 'unknown',
          penaltyLevel: transition.penaltyLevel,
          elapsedMs: transition.elapsedMs,
        });
        break;
      case 'attempt_closed_by_admission':
        this.persistence.addCount(transition.deviceId, transition.nowTs, 'stableActivationCount', 1);
        live.currentPenaltyLevel = 0;
        this.emitDebug({
          event: 'diagnostics_activation_transition',
          kind: 'attempt_closed_by_admission',
          deviceId: transition.deviceId,
          deviceName: live.name,
          source: transition.source ?? 'unknown',
          previousPenaltyLevel: transition.previousPenaltyLevel,
          penaltyLevel: 0,
          elapsedMs: transition.elapsedMs,
        });
        break;
      default:
        return;
    }

    this.persistence.scheduleFlush(transition.nowTs);
  }

  getDaySuppressionTotals(dateKey: string): { targetDeficitMs: number; blockedByHeadroomMs: number } | undefined {
    return this.persistence.getDaySuppressionTotals(dateKey);
  }

  getUiPayload(nowTs: number = Date.now()): SettingsUiDeviceDiagnosticsPayload {
    this.persistence.ensureDayRollover(nowTs);
    return buildUiPayload({
      liveByDeviceId: this.liveByDeviceId,
      latestObservationBatchId: this.latestObservationBatchId,
      persistence: this.persistence,
      timeZone: this.deps.getTimeZone(),
      nowTs,
    });
  }

  getCurrentStarvedDeviceCount(): number {
    return computeCurrentStarvedDeviceCount(this.liveByDeviceId, this.latestObservationBatchId);
  }

  getOverviewStarvation(deviceId: string): SettingsUiPlanDeviceStarvation | null {
    return computeOverviewStarvation(this.liveByDeviceId[deviceId], this.latestObservationBatchId);
  }

  getStarvedRescueEntries(): StarvedRescueEntry[] {
    return computeStarvedRescueEntries(this.liveByDeviceId, this.latestObservationBatchId);
  }

  destroy(): void {
    this.persistence.destroy();
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
        this.emitDebug({
          event: 'diagnostics_sample_gap_skipped',
          deviceId: observation.deviceId,
          deviceName: live.name,
          gapMs,
        });
        this.starvation.handleGap(observation.deviceId, nowTs);
      } else {
        this.persistence.recordDemandSpan(observation.deviceId, live.lastObservedTs, nowTs, live.lastObservation);
        if (live.lastStarvationObservation) {
          this.starvation.applyObservationSpan(
            observation.deviceId,
            live.lastStarvationObservation,
            live.lastObservedTs,
            nowTs,
          );
        }
      }
    }

    logObservationTransition(this.emit, observation.deviceId, live.name, live.lastObservation, nextObservation);
    if (starvationTargetChanged(live.lastStarvationObservation, nextStarvationObservation)) {
      this.starvation.handleTargetChange(observation.deviceId, nowTs);
    }
    this.starvation.applyObservationSpan(
      observation.deviceId,
      nextStarvationObservation,
      nowTs,
      nowTs,
    );
    live.lastObservation = nextObservation;
    live.lastStarvationObservation = nextStarvationObservation;
    live.lastObservedTs = nowTs;
  }

  private recordPelsShedEvent(deviceId: string, nowTs: number): void {
    const live = this.getLiveDeviceState(deviceId);
    this.persistence.addCount(deviceId, nowTs, 'shedCount', 1);
    if (isFiniteNumber(live.openRestoreTs)) {
      const durationMs = Math.max(0, nowTs - live.openRestoreTs);
      this.persistence.addRestoreToSetback(deviceId, nowTs, durationMs);
      live.openRestoreTs = undefined;
      this.emitDebug({
        event: 'diagnostics_restore_to_setback_completed',
        deviceId,
        deviceName: live.name,
        durationMs,
      });
    }
    live.openShedTs = nowTs;
    this.emitDebug({ event: 'diagnostics_shed_recorded', deviceId, deviceName: live.name });
  }

  private recordPelsRestoreEvent(deviceId: string, nowTs: number): void {
    const live = this.getLiveDeviceState(deviceId);
    this.persistence.addCount(deviceId, nowTs, 'restoreCount', 1);
    if (isFiniteNumber(live.openShedTs)) {
      const durationMs = Math.max(0, nowTs - live.openShedTs);
      this.persistence.addShedToRestore(deviceId, nowTs, durationMs);
      live.openShedTs = undefined;
      this.emitDebug({
        event: 'diagnostics_shed_to_restore_completed',
        deviceId,
        deviceName: live.name,
        durationMs,
      });
    }
    live.openRestoreTs = nowTs;
    this.emitDebug({ event: 'diagnostics_restore_recorded', deviceId, deviceName: live.name });
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
}
