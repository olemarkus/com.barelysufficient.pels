// What holds a smart task back from its target: the car's own charge limit,
// a confirmed device-side stop, or the daily budget, with the why and recourse
// lines the detail hero, the list card and the widget share.
import type {
  DeferredObjectiveActivePlanCarChargeLimitV1,
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../../contracts/src/deferredObjectiveActivePlans';
import { formatSmartTaskGoalValue } from './valueFormat';

export const WHY_CANNOT_MEET_BUDGET = 'Today’s daily budget runs out before the deadline.';
export const WHY_CANNOT_MEET_DEVICE = 'Not enough delivery before the deadline.';
// At-risk is the same two causes as cannot-finish, hedged to "may" because the
// task can still land. Disambiguated so the detail panel never shows the
// "time OR budget" guess the user would otherwise have to resolve themselves.
export const WHY_AT_RISK_BUDGET = 'Today’s daily budget may run out before the deadline.';
const WHY_AT_RISK_TIME = 'Limited time left before the deadline.';
// The window is long enough, but higher-priority tasks and devices use the room
// the house limit leaves (`higher_priority_load`). Says nothing about time.
export const WHY_AT_RISK_HIGHER_PRIORITY_LOAD = 'Other devices use the power your limit allows before the deadline.';
// The budget squeezed the schedule without being the whole reason. Deliberately
// does NOT point at Budget settings the way the sole-cause lines do — lifting the
// budget would not close this gap, and the honest lever is the task's own
// permission (see `cannotMeetDailyBudgetContributed` for the hero's wording).
export const WHY_CANNOT_MEET_BUDGET_PARTIAL = 'Today’s daily budget is holding part of this back, '
  + 'but there is not enough time either.';
export const WHY_AT_RISK_BUDGET_PARTIAL = 'Today’s daily budget may be holding part of this back, '
  + 'and time is short too.';

// Exported so the widget's recently-ended detail reuses the SAME recourse copy
// for a Missed task that the active cannot-finish path uses — budget-bound vs
// device-bound — keeping the two surfaces consistent and hard-cap-safe (never
// "raise the cap"). Which one applies is resolved per missed entry in the
// widget payload builder from the plan snapshot's daily-budget-exhausted count.
export const RECOURSE_CANNOT_MEET_BUDGET = 'Budget settings show whether future days need power reserved earlier.';
export const RECOURSE_CANNOT_MEET_DEVICE = 'Device settings show what’s holding it back.';
export const RECOURSE_BUDGET_PARTIAL = 'Edit the task and open Extra permissions to let it go over budget.';

/**
 * An EV smart task whose car's own charge limit sits below its target: the
 * car's limit, the owner's target above it, and whether the car has reached the
 * limit. The target stays the task's target; the limit only explains why
 * delivery stops short, and the copy suggests raising it in the car. Only an EV
 * task carries one, so both values are percentages.
 */
export type SmartTaskCarChargeLimit = { limitValue: number; targetValue: number; reached: boolean };

/** Resolves the cap from a plan's flat fields; null unless the limit sits below the target. */
export const resolveSmartTaskCarChargeLimit = (
  carChargeLimit: DeferredObjectiveActivePlanCarChargeLimitV1 | undefined,
  targetValue: number | null,
): SmartTaskCarChargeLimit | null => (
  carChargeLimit !== undefined && targetValue !== null && carChargeLimit.limitValue < targetValue
    ? { limitValue: carChargeLimit.limitValue, targetValue, reached: carChargeLimit.reached }
    : null
);

const formatCarLimitPercent = (value: number): string => formatSmartTaskGoalValue(value, '%');

/**
 * The detail page's line for a task held below its target by its car's limit:
 * while it charges toward the limit, and once the car has stopped there.
 */
export const formatSmartTaskCarLimitReason = (cap: SmartTaskCarChargeLimit): string => {
  const limit = formatCarLimitPercent(cap.limitValue);
  const target = formatCarLimitPercent(cap.targetValue);
  return cap.reached
    ? `Your car stopped at its own charge limit of ${limit}, below this smart task’s ${target} target.`
      + ' Raise the car’s charge limit to let it continue.'
    : `Your car stops at its own charge limit of ${limit}, below this smart task’s ${target} target.`
      + ' Raise the car’s charge limit to allow this task to reach its target.';
};

/** The widget's shorter why-line for the same task. */
export const formatSmartTaskCarLimitWhy = (cap: SmartTaskCarChargeLimit): string => {
  const limit = formatCarLimitPercent(cap.limitValue);
  const target = formatCarLimitPercent(cap.targetValue);
  return cap.reached
    ? `Your car stopped at its own charge limit of ${limit}, below the ${target} target.`
    : `Your car stops at its own charge limit of ${limit}, below the ${target} target.`;
};

/** The smart-task list card's one-line note, beside "Target 80%". */
export const formatSmartTaskCarLimitListLine = (cap: SmartTaskCarChargeLimit): string => (
  cap.reached
    ? `Car stopped at its limit of ${formatCarLimitPercent(cap.limitValue)}`
    : `Car stops at ${formatCarLimitPercent(cap.limitValue)}`
);

export const RECOURSE_RAISE_CAR_LIMIT = 'Raise the car’s charge limit to reach the target.';

/**
 * A live cause outside the plan that explains why a task is at risk or cannot
 * finish: a confirmed device-side stop or the car's own charge limit. `why`
 * and `recourseHint` are the Smart tasks widget's short lines; `listLine` is
 * the Smart tasks list card's line beside the target; `reason` is the detail
 * hero's reason line. None of them comes with a
 * PELS settings button: the fix is on the device or in the car.
 */
export type SmartTaskLiveCause = {
  why: string;
  recourseHint: string | null;
  listLine: string;
  reason: string;
};

// Device-neutral: the 15-minute non-delivery confirmation covers any metered
// device (a water heater at its own thermostat, a relay cut-off, a car that
// stopped charging). Never says "charge": temperature devices read it too.
const LIVE_CAUSE_NOT_ACCEPTING: SmartTaskLiveCause = {
  why: 'Device stopped taking power.',
  recourseHint: null,
  listLine: 'Device stopped taking power',
  reason: 'The device stopped taking power while PELS allowed it to run. Check whether it switched itself off.',
};
// `objective_device_limit` and `objective_device_schedule` have one producer,
// the EV car link (`lib/device/evCarLinkSelfStop.ts`), which reads them from the
// car behind a charger whatever the task's kind. A new producer must revisit
// this wording.
const LIVE_CAUSE_CAR_LIMIT_UNKNOWN: SmartTaskLiveCause = {
  why: 'Your car stopped at its own charge limit.',
  recourseHint: RECOURSE_RAISE_CAR_LIMIT,
  listLine: 'Car stopped at its own limit',
  reason: 'Your car stopped at its own charge limit, below this smart task’s target. '
    + 'Raise the car’s charge limit to let it continue.',
};
export const RECOURSE_CAR_SCHEDULE = 'Turn off the car’s own charging schedule or smart charging.';
const LIVE_CAUSE_CAR_SCHEDULE: SmartTaskLiveCause = {
  why: 'Your car is delaying charging on its own schedule.',
  recourseHint: RECOURSE_CAR_SCHEDULE,
  listLine: 'Car is delaying charging',
  reason: 'Your car is delaying charging, for example on its own charging schedule or smart charging. '
    + 'Turn that off in the car so PELS can charge it before the deadline.',
};

const carLimitLiveCause = (cap: SmartTaskCarChargeLimit): SmartTaskLiveCause => ({
  why: formatSmartTaskCarLimitWhy(cap),
  recourseHint: RECOURSE_RAISE_CAR_LIMIT,
  listLine: formatSmartTaskCarLimitListLine(cap),
  reason: formatSmartTaskCarLimitReason(cap),
});

/**
 * The one resolver for a task's live cause, shared by the detail hero, the
 * Smart tasks list card and widget, so they can never explain the same task
 * differently. Its causes are exactly the ones that downgrade a healthy status
 * in `resolveEffectivePlanStatus`, in precedence order: the car stopped at its
 * known limit (which explains a device limit or a stop with numbers); then the
 * confirmed device-side causes; last, a known car limit below the target that
 * the car has not reached yet, which a more specific stop outranks. `carChargeLimit` is the reported cap
 * (`resolveReportedCarChargeLimit`), so it is only present below the target
 * and only while it explains the status.
 *
 * An unreached limit also yields to a daily-budget cause (`budgetRole`): the
 * car is still charging toward its limit, so today's budget is what holds the
 * task back now, and raising the car's limit would not finish it. A car that
 * has stopped at its limit is the cause whatever the budget says.
 *
 * Null when no live cause applies; the caller then explains the committed
 * verdict (budget, time) itself.
 */
export const resolveSmartTaskLiveCause = (
  diagnosticReasonCode: DeferredObjectiveActivePlanDiagnosticReason | undefined,
  carChargeLimit: SmartTaskCarChargeLimit | null,
  budgetRole: DeadlineBudgetRole,
): SmartTaskLiveCause | null => {
  if (carChargeLimit?.reached === true) return carLimitLiveCause(carChargeLimit);
  if (diagnosticReasonCode === 'objective_device_limit') return LIVE_CAUSE_CAR_LIMIT_UNKNOWN;
  if (diagnosticReasonCode === 'objective_device_schedule') return LIVE_CAUSE_CAR_SCHEDULE;
  if (diagnosticReasonCode === 'objective_not_accepting_energy') return LIVE_CAUSE_NOT_ACCEPTING;
  if (carChargeLimit !== null && budgetRole === 'none') return carLimitLiveCause(carChargeLimit);
  return null;
};

/**
 * How far the daily budget accounts for a task's shortfall, from the revision's
 * producer-resolved fields. The one rule the detail hero, the list card and
 * the widget share. `floorShortfallCause` decides, alone (per
 * `feedback_layering_resolution_in_producer`). Absence is NOT "unknown": the
 * recorder suppresses the `none` case for byte-stability, so an absent cause
 * means the floor was not short at all.
 */
export const resolveSmartTaskBudgetRole = (revision: {
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
  budgetContributedToShortfall?: true;
}): DeadlineBudgetRole => {
  if (revision.floorShortfallCause === 'budget') return 'sole';
  // Only a genuine miss. `estimate` (short only by the estimator's confidence
  // padding) and `step_power` (climbing fits) are at-risk shapes, and the
  // contributing sentence asserts the task cannot finish.
  if (revision.floorShortfallCause === 'time_capacity' && revision.budgetContributedToShortfall === true) {
    return 'contributing';
  }
  return 'none';
};

/**
 * The at-risk why-line for a task with no live cause, hedged because the task
 * can still land. Shared by the widget row, the detail hero's reason line and
 * the create preview so they say the same thing about the same task. The
 * budget role comes first; otherwise the producer's `floorShortfallCause` says
 * whether higher-priority load holds the task back, and only a task it does not
 * explain is told its time is short.
 */
export const resolveSmartTaskAtRiskWhy = (
  budgetRole: DeadlineBudgetRole,
  floorShortfallCause: DeferredObjectiveActivePlanFloorShortfallCause | undefined,
): string => {
  if (budgetRole === 'sole') return WHY_AT_RISK_BUDGET;
  if (budgetRole === 'contributing') return WHY_AT_RISK_BUDGET_PARTIAL;
  if (floorShortfallCause === 'higher_priority_load') return WHY_AT_RISK_HIGHER_PRIORITY_LOAD;
  return WHY_AT_RISK_TIME;
};

/**
 * How far the soft daily budget accounts for a cannot-finish shortfall, as the
 * surface reports it. Mirrors the producer's own three states so the copy and
 * the recourse cannot disagree: `sole` sends the owner to the Budget tab,
 * `contributing` names the budget without promising it is the fix, and `none`
 * says nothing about it at all.
 */
export type DeadlineBudgetRole = 'none' | 'contributing' | 'sole';
