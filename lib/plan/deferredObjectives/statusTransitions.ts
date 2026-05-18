import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type {
  DeferredObjectivePublishedStatus,
  DeferredObjectiveStatusBus,
  DeferredObjectiveStatusSnapshot,
} from './statusBus';

const formatTargetText = (diagnostic: DeferredObjectiveDiagnostic): string => {
  if (diagnostic.objectiveKind === 'temperature') {
    return `${formatNumber(diagnostic.targetTemperatureC)} °C`;
  }
  if (diagnostic.objectiveKind === 'ev_soc' && diagnostic.targetPercent !== null) {
    return `${formatNumber(diagnostic.targetPercent)} %`;
  }
  return '';
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

  if (diagnostic.objectiveKind === 'temperature' && diagnostic.currentTemperatureC !== null) {
    const delta = diagnostic.targetTemperatureC - diagnostic.currentTemperatureC;
    if (delta > 0) {
      return { shortfallKwh, shortfallText: `${formatNumber(delta)} °C below target` };
    }
  }
  if (diagnostic.objectiveKind === 'ev_soc'
    && diagnostic.targetPercent !== null
    && diagnostic.currentPercent !== null) {
    const delta = diagnostic.targetPercent - diagnostic.currentPercent;
    if (delta > 0) {
      return { shortfallKwh, shortfallText: `${formatNumber(delta)} % below target` };
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
  onDeadlinePassed?: (deviceId: string) => void;
}): void => {
  const { diagnostic, statusBus, nowMs, onDeadlinePassed } = params;
  const previous = statusBus.getCurrent(diagnostic.deviceId);
  const previousStatus = previous?.status ?? 'none';
  const nextStatus: DeferredObjectivePublishedStatus = diagnostic.status;
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
  // The sticky `deadlineMissed` snapshot flag still drives the status-change
  // trigger's "don't fire while missed" gate. The dedicated "ended" Flow
  // trigger is published separately from `planHistory.ts` when the run
  // finalizes (outcome `missed`), so we no longer fan-out a duplicate missed
  // event from here.
  //
  // Auto-disable as soon as the deadline has passed, regardless of whether
  // the device reached `satisfied` first. A satisfied-at-deadline objective
  // must still be disarmed so it does not linger as enabled forever. The
  // callback is idempotent on enabled=false entries, so firing it on each
  // post-deadline cycle is harmless.
  if (
    onDeadlinePassed
    && diagnostic.deadlineAtMs !== null
    && nowMs >= diagnostic.deadlineAtMs
  ) {
    onDeadlinePassed(diagnostic.deviceId);
  }
};

export const emitDeferredObjectiveStatusTransitions = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  statusBus: DeferredObjectiveStatusBus;
  nowMs: number;
  onDeadlinePassed?: (deviceId: string) => void;
}): void => {
  const { diagnostics, statusBus, nowMs, onDeadlinePassed } = params;
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    seen.add(diagnostic.deviceId);
    processDiagnosticTransition({ diagnostic, statusBus, nowMs, onDeadlinePassed });
  }
  for (const known of statusBus.listDeviceIds()) {
    if (!seen.has(known)) statusBus.forgetDevice(known);
  }
};
