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
  onDeadlineReached?: (
    deviceId: string,
    objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
    deadlineAtMs: number,
    nowMs: number,
  ) => void;
}): void => {
  const { diagnostic, statusBus, nowMs, onDeadlineReached } = params;
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
    diagnostic.deadlineAtMs !== null
    && nowMs >= diagnostic.deadlineAtMs
  ) {
    // Single ending hook, owned by the app wiring: it both (a) returns a cap-off
    // device the task was driving to its configured fallback posture directly via
    // the transport (closing the `power_source = flow` gap where the next plan
    // cycle — which used to emit the `shed_release` — can be hours away), and
    // (b) DISARMS the task. Critically the disarm is **gated on the release being
    // settled** (device observed in the shed posture) or a grace window: the
    // callback keeps the task enabled (so this diagnostic survives and re-fires
    // next tick) until the device confirms off, rather than disarming on the
    // first tick — which would remove the diagnostic and make the release a
    // single shot that a transient `unknown` observation could miss. `objectiveKind`
    // lets the callback route EV tasks to `evcharger_charging` pause.
    // See notes/state-management/deferred-objective-lifecycle-carveout.md.
    onDeadlineReached?.(diagnostic.deviceId, diagnostic.objectiveKind, diagnostic.deadlineAtMs, nowMs);
  }
};

export const emitDeferredObjectiveStatusTransitions = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  statusBus: DeferredObjectiveStatusBus;
  nowMs: number;
  onDeadlineReached?: (
    deviceId: string,
    objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
    deadlineAtMs: number,
    nowMs: number,
  ) => void;
}): void => {
  const { diagnostics, statusBus, nowMs, onDeadlineReached } = params;
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    seen.add(diagnostic.deviceId);
    processDiagnosticTransition({ diagnostic, statusBus, nowMs, onDeadlineReached });
  }
  for (const known of statusBus.listDeviceIds()) {
    if (!seen.has(known)) statusBus.forgetDevice(known);
  }
};
