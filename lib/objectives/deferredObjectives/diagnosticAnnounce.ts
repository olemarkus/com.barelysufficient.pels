/**
 * Debug-payload emission for smart-task diagnostics, and the one rule that makes
 * a stuck task readable in the log instead of drowning it.
 *
 * A resolved trajectory is re-emitted every cycle on purpose: its payload
 * carries the live horizon, so each one is new information. An `unavailable`
 * one is mostly not — one prod night produced 1199 identical
 * `deferred_objective_unknown` lines for a single charger whose car was not
 * plugged in, a fact worth stating once and worth nothing repeated.
 *
 * "Mostly", because the unavailable payload is not constant: the external-off
 * hold and the three rescue-applied bits move independently of the cause, so
 * suppressing on `reasonCode` alone would hide the owner turning the device off
 * outside PELS, or a rescue permission engaging, behind an unchanged cause. The
 * signature covers those, and a change in any of them re-announces.
 *
 * A stuck task also re-announces hourly, carrying `suppressedTicks`. Without it
 * an all-night stall is one line at 22:00, and an operator reading the log
 * cannot tell "still stuck at 06:00" from "silently resolved" without
 * cross-referencing the status bus.
 *
 * The announce map is threaded through the caller rather than held in module
 * state, so the behaviour is testable and this stays a function — matching how
 * `emitDeferredObjectiveLifecycleTransitions` carries `knownDeviceIds`. It is
 * rebuilt from each tick's diagnostics, so it cannot retain a dead objective.
 */
import { buildDeferredObjectiveDebugPayload } from './diagnosticDebugPayload';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';

const logger = getLogger('plan/deferred-diag-announce');

const UNKNOWN_REANNOUNCE_MS = 60 * 60 * 1000;

export type DeferredObjectiveUnknownAnnounce = {
  signature: string;
  announcedAtMs: number;
  suppressedTicks: number;
};

// Everything on the unavailable payload that can move while the cause holds.
const announceSignature = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: string,
): string => [
  reasonCode,
  diagnostic.externalOffHoldActive === true ? 'hold' : '-',
  diagnostic.budgetExemptApplied === true ? 'budget' : '-',
  diagnostic.limitLowerPriorityApplied === true ? 'limit' : '-',
  diagnostic.pauseLowerPriorityApplied === true ? 'pause' : '-',
].join('|');

type AnnounceDecision =
  | { emit: false; next: DeferredObjectiveUnknownAnnounce }
  | { emit: true; next: DeferredObjectiveUnknownAnnounce; suppressedTicks: number };

// Resolved per diagnostic outside the emit loop so the allocations here are not
// loop-body spreads (`no-restricted-syntax`).
const decideUnknownAnnounce = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  reasonCode: string;
  nowMs: number;
  previous: DeferredObjectiveUnknownAnnounce | undefined;
}): AnnounceDecision => {
  const { diagnostic, reasonCode, nowMs, previous } = params;
  const signature = announceSignature(diagnostic, reasonCode);
  const unchanged = previous !== undefined && previous.signature === signature;
  if (unchanged && nowMs - previous.announcedAtMs < UNKNOWN_REANNOUNCE_MS) {
    return {
      emit: false,
      next: {
        signature,
        announcedAtMs: previous.announcedAtMs,
        suppressedTicks: previous.suppressedTicks + 1,
      },
    };
  }
  return {
    emit: true,
    next: { signature, announcedAtMs: nowMs, suppressedTicks: 0 },
    suppressedTicks: unchanged ? previous.suppressedTicks : 0,
  };
};

const buildPayload = (
  diagnostic: DeferredObjectiveDiagnostic,
  suppressedTicks: number,
): Record<string, unknown> => {
  const payload = buildDeferredObjectiveDebugPayload(diagnostic);
  return suppressedTicks > 0 ? { ...payload, suppressedTicks } : payload;
};

export const emitDeferredObjectiveDiagnostics = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  debugStructured?: StructuredDebugEmitter;
  nowMs: number;
  announcedUnknownCauses: ReadonlyMap<string, DeferredObjectiveUnknownAnnounce>;
}): ReadonlyMap<string, DeferredObjectiveUnknownAnnounce> => {
  const {
    diagnostics, debugStructured, nowMs, announcedUnknownCauses,
  } = params;
  const emit = debugStructured ?? ((payload: Record<string, unknown>) => { logger.debug(payload); });
  const nextAnnounced = new Map<string, DeferredObjectiveUnknownAnnounce>();
  for (const diagnostic of diagnostics) {
    const { trajectory } = diagnostic;
    if (trajectory.kind !== 'unavailable') {
      emit(buildPayload(diagnostic, 0));
      continue;
    }
    const decision = decideUnknownAnnounce({
      diagnostic,
      reasonCode: trajectory.reasonCode,
      nowMs,
      previous: announcedUnknownCauses.get(diagnostic.objectiveId),
    });
    nextAnnounced.set(diagnostic.objectiveId, decision.next);
    if (decision.emit) emit(buildPayload(diagnostic, decision.suppressedTicks));
  }
  return nextAnnounced;
};
