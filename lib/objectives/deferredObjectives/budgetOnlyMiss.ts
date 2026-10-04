import type {
  BudgetOnlyMissRecord,
  DeferredObjectivePlanHistoryRecord,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { TaskDeliveryCause } from '../../../packages/contracts/src/taskDelivery';
import { MAX_DELIVERY_INTERVALS } from './deliveryEvidence';

/**
 * Whether a finalized smart-task run missed its deadline because of the daily
 * budget alone: its recorded delivery evidence names budget as the primary
 * blocker, and every other recorded cause is budget or PELS briefly settling
 * its own decision. The daily-budget correction reads these misses as damage
 * the budget did (`lib/weather/deadlineMissBudgetDay.ts` sizes and dates them);
 * the attribution rules are in `notes/starvation/README.md`.
 *
 * The recorder owns this answer because it owns the evidence it reads,
 * including the interval window (`MAX_DELIVERY_INTERVALS`) that bounds what a
 * finalized record can still prove.
 */

/**
 * The longest single `control_pending` stretch that still reads as PELS settling
 * its own decision rather than a stuck one. `control_pending` covers restore and
 * shed cooldowns, meter settling, throttled or queued restores and startup holds,
 * but also `no_decision`, unobserved actuator axes and convergence that never
 * completes (`lib/plan/taskDeliveryControl.ts`, `deliveryEvidence.ts`). The
 * planner's own settle windows top out at 5 minutes: the restore cooldown's
 * backoff cap (`RESTORE_COOLDOWN_MAX_MS`), the post-shed restore backoff
 * (`RECENT_SHED_RESTORE_BACKOFF_MS`) and the startup restore block
 * (`STARTUP_RESTORE_BLOCK_MS`, 60 s) in `lib/plan/planConstants.ts`. A stretch
 * longer than that is not a settle, so it is a competing cause.
 *
 * Stated here rather than imported: `lib/objectives` may not import `lib/plan`
 * (`no-objectives-to-peer-except-power` in `.dependency-cruiser.cjs`, and the
 * `arch:grep` objectives edge check). It is this classifier's bound on what
 * counts as a settle, read against the planner's windows, not a copy the
 * planner reads back.
 */
const MAX_SETTLE_INTERVAL_MS = 5 * 60 * 1000;
/** Settles may repeat; this bounds how much of a run they may cover in total. */
const MAX_SETTLE_TOTAL_MS = 15 * 60 * 1000;

type RecordedDeliveryExplanation = Extract<
  DeferredObjectivePlanHistoryRecord['deliveryExplanation'],
  { kind: 'recorded' }
>;

/**
 * Whether the run's `control_pending` evidence is provably transient, so the
 * contributor neither establishes nor rules out budget attribution. Nearly
 * every run passes through a settle tick, and treating each as a competing
 * cause made budget-only evidence unreachable in practice.
 *
 * Conservative in both directions it can be wrong:
 *   - A listed `control_pending` contributor with no recorded interval cannot be
 *     shown to be short, so it disqualifies.
 *   - Any recorded interval longer than a settle disqualifies, as does a total
 *     beyond `MAX_SETTLE_TOTAL_MS`. Contiguous ticks merge into one interval
 *     (`appendInterval`), so a stuck command shows up as one long interval.
 *
 * Retained intervals are what this can see. The recorder keeps only the newest
 * `MAX_DELIVERY_INTERVALS` intervals, so a full list may have dropped a long
 * `control_pending` stretch: it cannot prove the settles were short and
 * disqualifies.
 */
const hasOnlySettleControlPending = (explanation: RecordedDeliveryExplanation): boolean => {
  if (!explanation.contributors.includes('control_pending')) return true;
  if (explanation.intervals.length >= MAX_DELIVERY_INTERVALS) return false;
  const settles = explanation.intervals.filter((interval) => interval.cause === 'control_pending');
  if (settles.length === 0) return false;
  let totalMs = 0;
  for (const interval of settles) {
    const durationMs = interval.toMs - interval.fromMs;
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_SETTLE_INTERVAL_MS) return false;
    totalMs += durationMs;
  }
  return totalMs <= MAX_SETTLE_TOTAL_MS;
};

const isBudgetOrSettleCause = (cause: TaskDeliveryCause): boolean => (
  cause === 'budget_limited' || cause === 'control_pending'
);

/**
 * A missed run whose budget was the primary blocker, and every other recorded
 * contributor is either budget or a provably short settle. Interval causes are
 * checked as well as the contributor list: both are persisted, and a cause
 * present in either one is evidence. `legacy_unrecorded` is deliberately never
 * excused: a run that crossed the upgrade has an unrecorded stretch whose cause
 * may have been capacity or the device, and no recorded cause cannot establish
 * budget alone.
 *
 * Plan-time feasibility snapshots (`finalPlan`, `originalPlan`) do not prove
 * that budget control denied delivery, so neither current nor legacy snapshots
 * participate.
 *
 * A type guard to `BudgetOnlyMissRecord`, and its only producer: the
 * daily-budget correction takes that type, so history this has not classified
 * cannot reach it.
 */
export const isBudgetOnlyMiss = (
  entry: DeferredObjectivePlanHistoryRecord,
): entry is BudgetOnlyMissRecord => {
  if (entry.outcome !== 'missed') return false;
  const explanation = entry.deliveryExplanation;
  return explanation.kind === 'recorded'
    && explanation.primary.kind === 'blocked'
    && explanation.primary.cause === 'budget_limited'
    && explanation.contributors.every(isBudgetOrSettleCause)
    && explanation.intervals.every((interval) => isBudgetOrSettleCause(interval.cause))
    && hasOnlySettleControlPending(explanation);
};
