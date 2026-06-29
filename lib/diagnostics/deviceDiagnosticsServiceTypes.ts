import type { ActivationAttemptSource } from '../plan/admission';
import type {
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type { DeviceDiagnosticsStateStore } from './deviceDiagnosticsStateStore';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

export type DeviceDiagnosticsBlockCause = 'not_blocked' | 'headroom' | 'cooldown_backoff';
export type DeviceDiagnosticsStarvationSuppressionState = 'counting' | 'paused' | 'none';

export type DeviceDiagnosticsStarvationResetReasonCode = 'device_no_longer_eligible';
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
  // The effective target PELS is currently COMMANDING the device toward (the
  // applied/held setpoint, quantized to the device's target step). A device is
  // starved only when PELS holds this BELOW `intendedNormalTargetC` — i.e. PELS
  // is actively limiting the device, not merely waiting for it to reach a target
  // it is already commanding in full.
  commandedTargetC: number | null;
  targetStepC: number | null;
  // True when PELS is shedding this temperature device by commanding it OFF
  // (`plannedState === 'shed'` with the `turn_off` shed behavior). A turn_off
  // shed cuts power without lowering a setpoint, so the commanded-vs-intended
  // target check alone cannot see it; this flag carries the "PELS holds the
  // device off" signal so a below-target turn_off shed still counts as
  // suppression. A device the USER turned off (PELS not shedding it) has
  // `plannedState !== 'shed'` and never sets this.
  pelsCommandsTurnOffShed: boolean;
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

export type DeviceDiagnosticsTrackedTransitionReconciliation =
  | 'startup'
  | 'snapshot_refresh'
  | 'post_actuation';

export type DeviceDiagnosticsControlEvent =
  | (DeviceDiagnosticsControlEventBase & {
    kind: 'pels_shed' | 'pels_restore';
  })
  | (DeviceDiagnosticsControlEventBase & {
    kind: 'tracked_usage_rise' | 'tracked_usage_drop';
    fromKw: number;
    toKw: number;
    reconciliation?: DeviceDiagnosticsTrackedTransitionReconciliation;
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
    kind: 'setback_failed';
    deviceId: string;
    source: ActivationAttemptSource | null;
    previousPenaltyLevel: number;
    penaltyLevel: number;
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
  }
  | {
    kind: 'attempt_closed_by_shed';
    deviceId: string;
    source: ActivationAttemptSource | null;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_by_admission';
    deviceId: string;
    source: ActivationAttemptSource | null;
    previousPenaltyLevel: number;
    penaltyLevel: 0;
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

export type LiveDemandObservation = {
  includeDemandMetrics: boolean;
  unmetDemand: boolean;
  blockCause: DeviceDiagnosticsBlockCause;
  targetDeficitActive: boolean;
  desiredStateSummary: string;
  appliedStateSummary: string;
};


export type LiveStarvationObservation = {
  eligibleForStarvation: boolean;
  observationFresh: boolean;
  currentTemperatureC: number | null;
  intendedNormalTargetC: number | null;
  commandedTargetC: number | null;
  targetStepC: number | null;
  pelsCommandsTurnOffShed: boolean;
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
  // True when PELS is holding the device below its intended/mode target — the
  // entry signal for starvation. Either PELS commands a lowered setpoint
  // (`commandedTargetC < intendedNormalTargetC` by at least the target step) OR
  // PELS sheds the device by turning it OFF while its temperature sits below the
  // intended target. Both are PELS actively limiting the device; a device PELS
  // commands in full (`keep`) is never below.
  pelsHoldsBelowTarget: boolean;
};

export type StarvationEvaluation = {
  validObservation: boolean;
  // PELS is actively limiting the device (a real capacity/budget/shortfall
  // suppression) AND commanding it below its intended/mode target.
  counting: boolean;
  // Starvation may ENTER or keep ACCUMULATING: PELS holds the device below its
  // mode target right now. A device PELS commands in full (`keep`) never starves,
  // regardless of how far its physical temperature sits below target.
  entryQualified: boolean;
  // PELS no longer holds the device below its mode target — clear the episode.
  clearQualified: boolean;
  pauseReason: DeviceDiagnosticsStarvationPauseReason;
};

export type LiveStarvationState = {
  isStarved: boolean;
  pendingEntryStartedAt?: number;
  clearQualifiedStartedAt?: number;
  starvedAccumulatedMs: number;
  starvationEpisodeStartedAt?: number;
  starvationLastResumedAt?: number;
  starvationCause: DeviceDiagnosticsStarvationCountingCause | null;
  starvationPauseReason: DeviceDiagnosticsStarvationPauseReason | null;
};

export type LiveDeviceDiagnostics = {
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

export type DeviceDiagnosticsServiceDeps = {
  diagnosticsStateStore: DeviceDiagnosticsStateStore;
  getTimeZone: () => string;
  isDebugEnabled?: () => boolean;
  structuredLog?: Pick<PinoLogger, 'info' | 'error'>;
  debugStructured?: StructuredDebugEmitter;
};
