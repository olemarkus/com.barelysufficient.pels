import { resolvedTrajectoryStatus } from './diagnosticTypes';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import { unitForObjectiveKind } from './objectiveUnit';
import type {
  DeferredObjectivePublishedStatus,
  DeferredObjectiveStatusBus,
  DeferredObjectiveStatusSnapshot,
} from './statusBus';

const formatTargetText = (diagnostic: DeferredObjectiveDiagnostic): string => {
  if (diagnostic.targetValue === null) return '';
  return `${formatNumber(diagnostic.targetValue)} ${unitForObjectiveKind(diagnostic.objectiveKind)}`;
};

const formatNumber = (value: number): string => (
  Number.isInteger(value) ? String(value) : value.toFixed(1)
);

const computeShortfall = (diagnostic: DeferredObjectiveDiagnostic): {
  shortfallKwh: number | null;
  shortfallText: string | null;
} => {
  const energy = diagnostic.energyNeededKWh;
  const shortfallKwh = typeof energy === 'number' && Number.isFinite(energy) && energy > 0
    ? Math.round(energy * 100) / 100
    : null;

  if (diagnostic.currentValue !== null && diagnostic.targetValue !== null) {
    const delta = diagnostic.targetValue - diagnostic.currentValue;
    if (delta > 0) {
      return {
        shortfallKwh,
        shortfallText: `${formatNumber(delta)} ${unitForObjectiveKind(diagnostic.objectiveKind)} below target`,
      };
    }
  }
  return { shortfallKwh, shortfallText: null };
};

const buildSnapshot = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  status: DeferredObjectivePublishedStatus;
  previousStatus: DeferredObjectiveStatusSnapshot['previousStatus'];
  deadlineMissed: boolean;
}): DeferredObjectiveStatusSnapshot => {
  const { diagnostic } = params;
  const shortfall = computeShortfall(diagnostic);
  return {
    deviceId: diagnostic.deviceId,
    deviceName: diagnostic.deviceName ?? null,
    kind: diagnostic.objectiveKind,
    status: params.status,
    previousStatus: params.previousStatus,
    targetText: formatTargetText(diagnostic),
    deadlineLocalTime: diagnostic.deadlineLocalTime,
    deadlineAtMs: diagnostic.deadlineAtMs,
    deadlineMissed: params.deadlineMissed,
    shortfallKwh: shortfall.shortfallKwh,
    shortfallText: shortfall.shortfallText,
  };
};

// The missed flag is sticky: once a deadline has been missed, carry the marker
// forward across status transitions so we never re-fire deadline_missed for the
// same objective. The flag clears when the objective becomes satisfied or when
// the deadline moves to a future time (e.g. user reschedules via flow).
const computeMissedTransition = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  previous: DeferredObjectiveStatusSnapshot | null;
  nextStatus: DeferredObjectivePublishedStatus;
  nowMs: number;
}): { deadlineMissed: boolean } => {
  const { diagnostic, previous, nextStatus, nowMs } = params;
  const previousMissed = previous?.deadlineMissed === true;
  const deadlineInFuture = diagnostic.deadlineAtMs !== null
    && nowMs < diagnostic.deadlineAtMs;
  const carriedMissed = previousMissed
    && nextStatus !== 'satisfied'
    && !deadlineInFuture;
  const deadlineJustPassed = !carriedMissed
    && diagnostic.deadlineAtMs !== null
    && nowMs >= diagnostic.deadlineAtMs
    && nextStatus !== 'satisfied';
  return { deadlineMissed: carriedMissed || deadlineJustPassed };
};

const processDiagnosticTransition = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  statusBus: DeferredObjectiveStatusBus;
  nowMs: number;
}): void => {
  const { diagnostic, statusBus, nowMs } = params;
  const previous = statusBus.getCurrent(diagnostic.deviceId);
  const previousStatus = previous?.status ?? 'none';
  // The publish boundary, and the only place a missing verdict becomes the
  // `'unknown'` the UI shows. Inside the module it stays a separate arm, so no
  // consumer can read it as a trajectory claim.
  const nextStatus: DeferredObjectivePublishedStatus = resolvedTrajectoryStatus(diagnostic) ?? 'unknown';
  const { deadlineMissed } = computeMissedTransition({
    diagnostic,
    previous,
    nextStatus,
    nowMs,
  });
  const snapshot = buildSnapshot({ diagnostic, status: nextStatus, previousStatus, deadlineMissed });
  // When the status transitions we notify listeners; otherwise we still refresh
  // the stored snapshot so future ticks see the latest deadlineAtMs and missed
  // flag (e.g. when the user reschedules without changing status).
  if (nextStatus !== previousStatus) {
    statusBus.publish(snapshot);
  } else {
    statusBus.setCurrent(snapshot);
  }
};

export type DeferredObjectiveLifecycleHooks = {
  onSatisfied?: (deviceId: string) => void;
  onDeadlineReached?: (
    deviceId: string,
    deadlineAtMs: number,
    nowMs: number,
  ) => void;
  onFallbackInactive?: (deviceId: string) => void;
};

/** Execute lifecycle transitions without coupling them to optional UI state. */
export const emitDeferredObjectiveLifecycleTransitions = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  knownDeviceIds: ReadonlySet<string>;
  nowMs: number;
} & DeferredObjectiveLifecycleHooks): Set<string> => {
  const {
    diagnostics, knownDeviceIds, nowMs, onSatisfied, onDeadlineReached, onFallbackInactive,
  } = params;
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    seen.add(diagnostic.deviceId);
    const deadlineAtMs = diagnostic.deadlineAtMs;
    if (deadlineAtMs !== null && nowMs >= deadlineAtMs) {
      onDeadlineReached?.(diagnostic.deviceId, deadlineAtMs, nowMs);
    } else if (diagnostic.actuationSatisfied) {
      onSatisfied?.(diagnostic.deviceId);
    } else {
      onFallbackInactive?.(diagnostic.deviceId);
    }
  }
  for (const known of knownDeviceIds) {
    if (!seen.has(known)) onFallbackInactive?.(known);
  }
  return seen;
};

export const emitDeferredObjectiveStatusTransitions = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  statusBus: DeferredObjectiveStatusBus;
  nowMs: number;
}): void => {
  const { diagnostics, statusBus, nowMs } = params;
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    seen.add(diagnostic.deviceId);
    processDiagnosticTransition({ diagnostic, statusBus, nowMs });
  }
  for (const known of statusBus.listDeviceIds()) {
    if (!seen.has(known)) {
      statusBus.forgetDevice(known);
    }
  }
};
