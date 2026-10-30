// What the Past tasks detail offers for a missed run.
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory';
import type { TaskDeliveryCause } from '../../../contracts/src/taskDelivery';
import type { DeadlineCannotMeetRecourse } from './pendingHero';
import { RECOURSE_CAR_SCHEDULE, RECOURSE_RAISE_CAR_LIMIT } from './shortfallCauses';

// ─── History-detail missed-hero recourse (v2.7.2 PR 3) ───────────────────────

// Recourse action for a missed history entry. Mirrors the live hero's
// `DeadlineCannotMeetRecourse` shape so the click dispatcher in
// `deadlinePlanMount.ts` handles both surfaces with the same handler.
//
// Labels are action-oriented for the postmortem context: the user is reading
// what happened *after* the deadline missed, so the recourse is advice for
// the next run rather than a "fix the current plan" affordance. The
// `targetTab` slug still routes the click — Budget for the budget-exhausted
// branch; the shortfall branch lands on Overview AND deep-links the
// device-settings overlay for the device that missed (deadlines are
// configured per-device via Flow cards, so the device-settings surface is
// the closest landing place — Overview alone is a dead end, see owner walk
// 2026-05-17).
//
// Label note: the prior "Move deadline later" copy promised an action the
// destination doesn't offer (the deadline-plan panel doesn't edit
// deadlines, nor does device-settings). "Review device" is honest about
// where the click lands — the device-settings overlay shows shed behaviour,
// target power, boost, modes and deltas; the user audits the device that
// missed and can adjust those settings (or the Flow wiring) from there.
const MISSED_HISTORY_RECOURSE_LOWER_BUDGET: DeadlineCannotMeetRecourse = {
  label: 'Lower daily budget',
  targetTab: 'budget',
};

// Shortfall sibling of `MISSED_HISTORY_RECOURSE_LOWER_BUDGET`. Hoisted so the
// two branches of `resolveMissedHistoryRecourse` share the same producer
// pattern (constant + spread of the per-entry `deviceId`) instead of one
// branch returning a constant and the other returning an inline literal.
const MISSED_HISTORY_RECOURSE_SHORTFALL: Omit<DeadlineCannotMeetRecourse, 'deviceId'> = {
  label: 'Review device',
  targetTab: 'overview',
};

// The final active delivery blocker selects the relevant review destination.
// Earlier contributing restrictions stay in the explanation, but do not route
// a device-side final blocker to Budget. Legacy rows offer general device review
// without inventing a cause from their saved schedule.
//
// A run the car itself held back (its own charge limit or schedule, which only
// the EV car link records) gets no button: no PELS setting changes the car, and
// the cause sentence already names it. `resolveMissedHistoryCarHint` carries the
// widget's compact "what to do in the car" line instead. A device that stopped
// taking power keeps "Review device": its control and the Flow wiring that
// reports its state are in the device settings.
type MissedRecourseEntry = Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'outcome' | 'deliveryExplanation'>;
const missedFinalCause = (entry: MissedRecourseEntry): TaskDeliveryCause | null => {
  if (entry.outcome !== 'missed') return null;
  const explanation = entry.deliveryExplanation;
  return explanation.kind === 'recorded' && explanation.primary.kind === 'blocked'
    ? explanation.primary.cause : null;
};
const CAR_SIDE_MISS_HINT: Partial<Record<TaskDeliveryCause, string>> = {
  device_limit: RECOURSE_RAISE_CAR_LIMIT,
  device_schedule: RECOURSE_CAR_SCHEDULE,
};

export const resolveMissedHistoryRecourse = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'outcome' | 'deliveryExplanation' | 'deviceId'>,
): DeadlineCannotMeetRecourse | null => {
  if (entry.outcome !== 'missed') return null;
  const cause = missedFinalCause(entry);
  if (cause === 'budget_limited') return MISSED_HISTORY_RECOURSE_LOWER_BUDGET;
  if (cause !== null && CAR_SIDE_MISS_HINT[cause] !== undefined) return null;
  return { ...MISSED_HISTORY_RECOURSE_SHORTFALL, deviceId: entry.deviceId };
};

/** The car-side action for a run its car held back; null for any other run. */
export const resolveMissedHistoryCarHint = (entry: MissedRecourseEntry): string | null => {
  const cause = missedFinalCause(entry);
  return cause === null ? null : CAR_SIDE_MISS_HINT[cause] ?? null;
};
