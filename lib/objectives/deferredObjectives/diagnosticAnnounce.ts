/**
 * Debug-payload emission for smart-task diagnostics, and the one rule that keeps
 * a long-running task readable in the log instead of drowning it.
 *
 * Both arms of the trajectory announce on CHANGE plus a heartbeat. An
 * `unavailable` one is the obvious case — one prod night produced 1199 identical
 * `deferred_objective_unknown` lines for a single charger whose car was not
 * plugged in, a fact worth stating once and worth nothing repeated.
 *
 * A resolved trajectory used to be exempt, on the reasoning that its payload
 * carries the live horizon and so each one is new information. Production says
 * otherwise: over a 12 h window three objectives emitted 1201/1236/1303 lines
 * whose payloads changed 63/142/98 times — 89-95% of them restated the previous
 * line, and one objective's `status` did not move once across 1201 emissions.
 * The premise held for the SHAPE of the payload (it does carry live values) but
 * not for its CONTENT (they rarely move).
 *
 * So the signature covers the decision — status, cause, the current-hour claim,
 * the rescue bits, the external-off hold, the planned buckets — and the
 * heartbeat samples the rest. That split matters: `currentTemperatureC` and
 * `energyNeededKWh` are a trajectory trace, not a decision, and gating on them
 * would re-emit on thermal noise while gating on nothing would emit forever.
 * The heartbeat keeps a periodic sample of both, so a reader can still watch a
 * task climb toward its target and still see every decision the instant it
 * changes.
 *
 * The unavailable arm keeps the longer hourly heartbeat: a stuck cause has no
 * trajectory to trace, so the only thing a repeat adds is "still stuck", and an
 * all-night stall reading as one line at 22:00 is what `suppressedTicks` exists
 * to prevent.
 *
 * The announce map is threaded through the caller rather than held in module
 * state, so the behaviour is testable and this stays a function — matching how
 * `emitDeferredObjectiveLifecycleTransitions` carries `knownDeviceIds`. It is
 * rebuilt from each tick's diagnostics, so it cannot retain a dead objective.
 */
import { buildDeferredObjectiveDebugPayload } from './diagnosticDebugPayload';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { resolvedTrajectoryStatus } from './diagnosticTypes';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { DeferredObjectiveHorizonPlan } from './types';

const logger = getLogger('plan/deferred-diag-announce');

// A stuck cause has nothing to trace, so it only needs to prove it is still
// stuck. A live trajectory carries progress values the signature deliberately
// ignores, so it samples them far more often.
const UNKNOWN_REANNOUNCE_MS = 60 * 60 * 1000;
const PLANNED_REANNOUNCE_MS = 5 * 60 * 1000;

export type DeferredObjectiveAnnounce = {
  signature: string;
  announcedAtMs: number;
  suppressedTicks: number;
};

// Bits the shared payload carries on BOTH arms, each moving independently of the
// cause — so suppressing on the cause alone would hide the owner turning the
// device off outside PELS, a rescue permission engaging, or the live step ladder
// vanishing, behind an unchanged reason code.
//
// `liveStepsUnavailable` is the frozen-serve marker
// (`lib/objectives/deferredObjectives/AGENTS.md` § "The step-ladder gap is the
// producer's answer"). It has to be named here rather than trusted to show up
// through `expectedStepId`: during an unbooked current hour that id is already
// `null`, so a ladder gap that opens and closes inside one heartbeat would emit
// at neither edge — defeating the marker's whole purpose.
const sharedPayloadSignature = (diagnostic: DeferredObjectiveDiagnostic): string => [
  diagnostic.externalOffHoldActive === true ? 'hold' : '-',
  diagnostic.budgetExemptApplied === true ? 'budget' : '-',
  diagnostic.limitLowerPriorityApplied === true ? 'limit' : '-',
  diagnostic.pauseLowerPriorityApplied === true ? 'pause' : '-',
  diagnostic.liveStepsUnavailable === true ? 'nosteps' : '-',
].join('|');

const unavailableSignature = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: string,
): string => `${reasonCode}|${sharedPayloadSignature(diagnostic)}`;

// Quantized so a re-plan that lands on the same schedule reads as unchanged:
// 1 Wh on the energy, 0.1 price unit. Below that the buckets are identical for
// every purpose a log reader has, and float noise would re-announce forever.
const plannedBucketDigest = (plan: DeferredObjectiveHorizonPlan | undefined): string => {
  if (!plan) return '-';
  return plan.plannedBuckets.map((bucket) => [
    bucket.id,
    bucket.reserve ? 'r' : '-',
    bucket.current ? 'c' : '-',
    bucket.plannedUsefulEnergyKWh.toFixed(3),
    bucket.price === null ? '-' : bucket.price.toFixed(1),
  ].join(':')).join(',');
};

// What the owner configured, and which of it the producer engaged this cycle.
const rescueSignature = (diagnostic: DeferredObjectiveDiagnostic): string => [
  diagnostic.rescue?.exemptFromBudget ?? 'off',
  diagnostic.rescue?.limitLowerPriorityDevices ?? 'off',
  diagnostic.rescue?.pauseLowerPriorityDevices ?? 'off',
].join('|');

// The learned-rate provenance the plan was computed from. A rate that changes
// band is a different plan even when the schedule happens to land the same.
const rateSignature = (diagnostic: DeferredObjectiveDiagnostic): string => [
  diagnostic.rateConfidence ?? '-',
  diagnostic.displayConfidence ?? '-',
  diagnostic.kwhPerUnitSource ?? '-',
].join('|');

// The horizon's own decisions: the claim on the current hour, the three release
// gates, whether anything failed to place, and the schedule itself.
//
// `unplannedUsefulEnergyKWh` enters as a BOOLEAN. Its magnitude drifts with
// `energyNeededKWh` on every thermal tick, so gating on the number would
// re-announce on noise; what a reader must not miss is the crossing — the cycle
// where the horizon first could not place all of the need.
const horizonSignature = (plan: DeferredObjectiveHorizonPlan | undefined): string => [
  plan?.currentHourClaim ?? '-',
  plan?.priceDeferralEligible === true ? 'defer' : '-',
  plan?.coldStartReleaseEligible === true ? 'cold' : '-',
  plan?.usesDeadlineReserve === true ? 'reserve' : '-',
  (plan?.unplannedUsefulEnergyKWh ?? 0) > 0 ? 'unplanned' : '-',
  plannedBucketDigest(plan),
].join('|');

// Everything that says what the planner DECIDED. Deliberately excludes the
// progress values (`currentPercent`, `currentTemperatureC`, `energyNeededKWh`,
// `kWhPerUnitBanded`): they move on measurement noise, carry no decision, and
// the heartbeat samples them.
// `targetValue` and `enforcement` are what the OWNER configured. Neither is a
// trajectory value, and a plan can absorb an edit to either without moving a
// bucket — lowering the target of an already-satisfied task leaves the schedule
// at zero and the status at `satisfied` — so without them an edit could sit
// unannounced until the heartbeat. `targetValue` is the unit-agnostic target, so
// one entry covers both the °C and the SoC-% kinds.
const plannedSignature = (diagnostic: DeferredObjectiveDiagnostic): string => [
  resolvedTrajectoryStatus(diagnostic) ?? 'unknown',
  diagnostic.reasonCode,
  diagnostic.enforcement,
  String(diagnostic.targetValue ?? '-'),
  sharedPayloadSignature(diagnostic),
  rescueSignature(diagnostic),
  rateSignature(diagnostic),
  diagnostic.expectedStepId ?? '-',
  String(diagnostic.deadlineAtMs ?? '-'),
  horizonSignature(diagnostic.horizonPlan),
].join('|');

type AnnounceDecision =
  | { emit: false; next: DeferredObjectiveAnnounce }
  | { emit: true; next: DeferredObjectiveAnnounce; suppressedTicks: number };

// Resolved per diagnostic outside the emit loop so the allocations here are not
// loop-body spreads (`no-restricted-syntax`).
const decideAnnounce = (params: {
  signature: string;
  reannounceMs: number;
  nowMs: number;
  previous: DeferredObjectiveAnnounce | undefined;
}): AnnounceDecision => {
  const { signature, reannounceMs, nowMs, previous } = params;
  const unchanged = previous !== undefined && previous.signature === signature;
  if (unchanged && nowMs - previous.announcedAtMs < reannounceMs) {
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

// Built only once the gate says emit — the payload flattens the whole horizon
// (a ~1.7 KB object graph including a per-bucket map), so building it ahead of
// the decision would pay the full cost on every suppressed tick.
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
  announced: ReadonlyMap<string, DeferredObjectiveAnnounce>;
}): ReadonlyMap<string, DeferredObjectiveAnnounce> => {
  const {
    diagnostics, debugStructured, nowMs, announced,
  } = params;
  const emit = debugStructured ?? ((payload: Record<string, unknown>) => { logger.debug(payload); });
  const nextAnnounced = new Map<string, DeferredObjectiveAnnounce>();
  for (const diagnostic of diagnostics) {
    const { trajectory } = diagnostic;
    const unavailable = trajectory.kind === 'unavailable';
    const decision = decideAnnounce({
      signature: unavailable
        ? unavailableSignature(diagnostic, trajectory.reasonCode)
        : plannedSignature(diagnostic),
      reannounceMs: unavailable ? UNKNOWN_REANNOUNCE_MS : PLANNED_REANNOUNCE_MS,
      nowMs,
      previous: announced.get(diagnostic.objectiveId),
    });
    nextAnnounced.set(diagnostic.objectiveId, decision.next);
    if (decision.emit) emit(buildPayload(diagnostic, decision.suppressedTicks));
  }
  return nextAnnounced;
};
