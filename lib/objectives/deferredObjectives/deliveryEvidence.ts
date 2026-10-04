import type {
  TaskDeviceConstraint, TaskDeliveryBlocker, TaskDeliveryCause,
  TaskDeliveryControl, TaskDeliveryEvidence, TaskDeliveryInterval,
} from '../../../packages/contracts/src/taskDelivery';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import {
  DELIVERY_EPSILON_KWH, isTaskDeviceStopped, NON_DELIVERY_HOLD_MS, observeTaskNonDelivery,
} from './taskDeliveryState';

export type TaskDeliveryReader = (deviceId: string, deadlineAtMs: number) => TaskDeliveryEvidence;
export const EMPTY_DELIVERY_EVIDENCE = {
  explanation: { kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [] },
  nonDelivery: { kind: 'none' },
} satisfies TaskDeliveryEvidence;
export const LEGACY_DELIVERY_EVIDENCE: TaskDeliveryEvidence = {
  explanation: { kind: 'legacy_unrecorded' }, nonDelivery: { kind: 'none' },
};

export type TaskDeliveryFacts = {
  obligation: 'claimed' | 'unclaimed' | 'unavailable' | 'deferred' | 'satisfied' | 'expired';
  control: TaskDeliveryControl;
  observation: { kind: 'drawing'; kw: number } | { kind: 'not_drawing' } | { kind: 'unavailable' };
  progress: { kind: 'known'; value: number } | { kind: 'unavailable' };
  deviceConstraint: TaskDeviceConstraint;
  schedule: 'fits' | 'rate_insufficient' | 'estimate_uncertain' | 'unavailable';
};

const resolveObligation = (diagnostic: DeferredObjectiveDiagnostic, nowMs: number): TaskDeliveryFacts['obligation'] => {
  const evaluation = diagnostic.evaluation;
  if (nowMs >= evaluation.deadlineAtMs) return 'expired';
  if (evaluation.completion.kind === 'target_reached'
    || evaluation.completion.kind === 'accepted_near_target') return 'satisfied';
  if (evaluation.planning.kind === 'inactive') return 'unavailable';
  const claim = evaluation.planning.plan.currentHourClaim;
  return claim === 'released' ? 'deferred' : claim;
};
const resolveDraw = (diagnostic: DeferredObjectiveDiagnostic, measured: boolean): TaskDeliveryFacts['observation'] => {
  if (!measured || diagnostic.currentDrawKw === null) return { kind: 'unavailable' };
  if (diagnostic.currentDrawKw * NON_DELIVERY_HOLD_MS / 3600000 >= DELIVERY_EPSILON_KWH) {
    return { kind: 'drawing', kw: diagnostic.currentDrawKw };
  }
  return { kind: 'not_drawing' };
};
const resolveSchedule = (diagnostic: DeferredObjectiveDiagnostic): TaskDeliveryFacts['schedule'] => {
  const { planning } = diagnostic.evaluation;
  if (planning.kind === 'inactive') return 'unavailable';
  if (planning.plan.statusDetail === 'target_cannot_be_met') return 'rate_insufficient';
  if (planning.plan.statusDetail === 'estimate_uncertain') return 'estimate_uncertain';
  return 'fits';
};
export const resolveTaskDeliveryFacts = (
  diagnostic: DeferredObjectiveDiagnostic,
  control: TaskDeliveryControl,
  measured: boolean,
  deviceConstraint: TaskDeviceConstraint,
  nowMs: number,
): TaskDeliveryFacts => ({
  obligation: resolveObligation(diagnostic, nowMs),
  schedule: resolveSchedule(diagnostic),
  control,
  deviceConstraint,
  observation: resolveDraw(diagnostic, measured),
  progress: diagnostic.evaluation.progress.kind === 'known'
    ? { kind: 'known', value: diagnostic.evaluation.progress.value } : { kind: 'unavailable' },
});

const CONTROL_CAUSES = {
  pending: 'control_pending', failed: 'control_failed', uncontrolled: 'uncontrolled', no_decision: 'control_pending',
} as const;
const controlBlocker = (control: TaskDeliveryControl): TaskDeliveryBlocker => {
  if (control.kind === 'permitted') return { kind: 'clear' };
  if (control.kind === 'restricted') return { kind: 'blocked', cause: control.cause };
  return { kind: 'blocked', cause: CONTROL_CAUSES[control.kind] };
};
const unavailablePlanCause = (facts: TaskDeliveryFacts): TaskDeliveryCause =>
  facts.progress.kind === 'unavailable' ? 'progress_unavailable' : 'estimate_uncertain';
const deviceConstraintBlocker = (facts: TaskDeliveryFacts): TaskDeliveryBlocker => {
  if (facts.observation.kind === 'drawing') return { kind: 'clear' };
  if (facts.deviceConstraint.kind === 'limit_reached') return { kind: 'blocked', cause: 'device_limit' };
  if (facts.deviceConstraint.kind === 'self_stopped') {
    return { kind: 'blocked', cause: facts.deviceConstraint.cause };
  }
  return { kind: 'clear' };
};
const resolveBlocker = (facts: TaskDeliveryFacts, confirmed: boolean): TaskDeliveryBlocker => {
  if (facts.obligation === 'deferred' || facts.obligation === 'satisfied') return { kind: 'clear' };
  if (facts.obligation === 'claimed' || facts.obligation === 'unclaimed') {
    const control = controlBlocker(facts.control);
    if (control.kind === 'blocked') return control;
  }
  const deviceConstraint = deviceConstraintBlocker(facts);
  if (deviceConstraint.kind === 'blocked') return deviceConstraint;
  if (facts.obligation === 'unavailable') {
    return { kind: 'blocked', cause: unavailablePlanCause(facts) };
  }
  if (facts.observation.kind === 'unavailable') return { kind: 'blocked', cause: 'observation_unavailable' };
  if (confirmed) return { kind: 'blocked', cause: 'device_not_accepting' };
  if (facts.progress.kind === 'unavailable') return { kind: 'blocked', cause: 'progress_unavailable' };
  if (facts.schedule === 'rate_insufficient' || facts.schedule === 'estimate_uncertain') {
    return { kind: 'blocked', cause: facts.schedule };
  }
  return { kind: 'clear' };
};
/**
 * Newest intervals kept per task. Every blocked tick extends or appends one
 * interval, and the evidence is persisted every tick and copied into history,
 * so an unbounded list grows with every flip between causes (a capacity
 * shed/settle cycle appends two per cycle). The list is a recent window: the
 * durations it carries rank contributors for the past-task explanation, and
 * the first-seen `contributors` list keeps every cause that ever blocked
 * delivery, so dropping old intervals loses no cause. Older persisted rows with
 * a longer list stay valid and are trimmed on their next append.
 *
 * The window is sized so an ordinary run never fills it. A reader that needs
 * every interval of a run must treat a full list as possibly truncated: the
 * daily-budget miss attribution (`lib/weather/deadlineMissBudgetDay.ts`) does,
 * and mirrors this value as `DELIVERY_INTERVAL_WINDOW` because `lib/weather`
 * may not import `lib/objectives`. Keep both in sync.
 */
export const MAX_DELIVERY_INTERVALS = 120;
const appendInterval = (
  intervals: TaskDeliveryInterval[], cause: TaskDeliveryCause, fromMs: number, toMs: number,
): TaskDeliveryInterval[] => {
  const tail = intervals.at(-1);
  const next = tail && tail.cause === cause && tail.toMs === fromMs
    ? [...intervals.slice(0, -1), { ...tail, toMs }]
    : [...intervals, { fromMs, toMs, cause }];
  return next.length > MAX_DELIVERY_INTERVALS ? next.slice(-MAX_DELIVERY_INTERVALS) : next;
};
/** One transition per lifecycle tick; a cleared cause survives only as a contributor. */
export const observeTaskDelivery = (
  previous: TaskDeliveryEvidence,
  facts: TaskDeliveryFacts,
  nowMs: number,
  elapsedMs: number,
): TaskDeliveryEvidence => {
  // Expiry freezes the last live blocker; it is an outcome, not a cause.
  if (facts.obligation === 'expired') return previous;
  const prior = previous.explanation.kind === 'recorded' ? previous.explanation : EMPTY_DELIVERY_EVIDENCE.explanation;
  const nonDelivery = observeTaskNonDelivery(previous.nonDelivery, {
    obligation: facts.obligation === 'unavailable' ? 'inactive' : facts.obligation,
    control: facts.control.kind === 'no_decision' ? 'pending' : facts.control.kind,
    draw: facts.observation.kind === 'unavailable' ? 'unobserved' : facts.observation.kind,
  }, nowMs);
  const primary = resolveBlocker(facts, nonDelivery.kind === 'confirmed');
  let { contributors, intervals } = prior;
  if (previous.explanation.kind === 'legacy_unrecorded') contributors = ['legacy_unrecorded'];
  if (prior.primary.kind === 'blocked' && elapsedMs > 0) {
    const { cause } = prior.primary;
    contributors = contributors.includes(cause) ? contributors : [...contributors, cause];
    intervals = appendInterval(intervals, cause, nowMs - elapsedMs, nowMs);
  }
  return { explanation: { kind: 'recorded', primary, contributors, intervals }, nonDelivery };
};

export const suppressTaskDeliveryReservation = (evidence: TaskDeliveryEvidence): boolean =>
  evidence.nonDelivery.kind === 'confirmed';
export const activeDeliveryCause = (evidence: TaskDeliveryEvidence): TaskDeliveryCause | 'clear' => (
  evidence.explanation.kind === 'recorded' && evidence.explanation.primary.kind === 'blocked'
    ? evidence.explanation.primary.cause : 'clear'
);

/**
 * Live causes that may downgrade a healthy reported status, and the reason code
 * each one carries to every surface.
 *
 * Only DEVICE-SIDE causes the horizon plan cannot see, and only once they are
 * confirmed, qualify:
 *  - `device_not_accepting`: the device took no energy through
 *    `NON_DELIVERY_HOLD_MS` of claimed, permitted delivery (and has not drawn
 *    since: `isTaskDeviceStopped`), or the car link confirmed a self-stop
 *    episode.
 *  - `device_limit`: the car stopped at its qualified own charge limit.
 *  - `device_schedule`: the car link confirmed a self-stop held by the car's
 *    own schedule.
 *
 * Deliberately excluded, and recorded only as delivery evidence for history:
 *  - `capacity_limited`, `budget_limited`, `priority_limited`: PELS's own
 *    per-cycle planning decisions. The horizon plan already prices them in, so
 *    a shed in a claimed hour is not new risk, and overlaying it flipped the
 *    status (and fired the status Flow trigger) on every shed/settle cycle.
 *  - `control_pending`: a settle in progress (cooldowns, restore throttles).
 *  - `control_failed`: a per-tick executor convergence fact with no hold
 *    (one unmet axis, an activation backoff, a momentarily unavailable device).
 *    A failure that persists shows up as lost progress, which the next settle
 *    re-plans against; a device that stays unavailable leaves the plan through
 *    its own inactive path.
 *  - `uncontrolled`: either the owner's "Leave off until turned on again",
 *    which `resolveDiagnosticReasonCode` reports as `objective_device_left_off`
 *    from the diagnostic itself, or a PELS policy hold (start policy, solar
 *    surplus, the task's own avoided hour, no command authority) that the plan
 *    owns. Neither is device-side evidence that delivery failed.
 */
const DELIVERY_RISK_REASON = {
  device_not_accepting: 'objective_not_accepting_energy',
  device_limit: 'objective_device_limit',
  device_schedule: 'objective_device_schedule',
} as const satisfies Partial<Record<TaskDeliveryCause, DeferredObjectiveDiagnostic['reasonCode']>>;
const isDeliveryRiskCause = (cause: TaskDeliveryCause | 'clear'): cause is keyof typeof DELIVERY_RISK_REASON => (
  Object.hasOwn(DELIVERY_RISK_REASON, cause)
);
/**
 * The live cause the status reports. The tick's own blocker when it is a
 * device-side cause; otherwise a device that stopped taking power stays the
 * cause until it draws again, through ticks PELS itself holds it back or hours
 * the plan does not book. Those ticks blame PELS's decision in the past-task
 * explanation, but they are no evidence the device would have taken power.
 * The latched cause is the last device-side one recorded (a car waiting on its
 * own schedule stays that), so the copy does not alternate with each hold.
 */
const resolveDeliveryRiskCause = (evidence: TaskDeliveryEvidence): TaskDeliveryCause | 'clear' => {
  const cause = activeDeliveryCause(evidence);
  if (isDeliveryRiskCause(cause) || !isTaskDeviceStopped(evidence.nonDelivery)) return cause;
  const intervals = evidence.explanation.kind === 'recorded' ? evidence.explanation.intervals : [];
  for (let index = intervals.length - 1; index >= 0; index -= 1) {
    const recorded = intervals[index]?.cause;
    if (recorded !== undefined && isDeliveryRiskCause(recorded)) return recorded;
  }
  return 'device_not_accepting';
};

/** A live overlay; the settled allocation continues to own admission and revision metadata. */
export const reportTaskDeliveryStatus = (
  diagnostic: DeferredObjectiveDiagnostic, read: TaskDeliveryReader,
): DeferredObjectiveDiagnostic => {
  if (diagnostic.deadlineAtMs === null || diagnostic.trajectory.kind !== 'resolved') return diagnostic;
  if (diagnostic.trajectory.status === 'satisfied' || diagnostic.trajectory.status === 'invalid') return diagnostic;
  const cause = resolveDeliveryRiskCause(read(diagnostic.deviceId, diagnostic.deadlineAtMs));
  if (!isDeliveryRiskCause(cause)) return diagnostic;
  return {
    ...diagnostic,
    trajectory: {
      kind: 'resolved', status: diagnostic.trajectory.status === 'cannot_meet' ? 'cannot_meet' : 'at_risk',
    },
    reasonCode: DELIVERY_RISK_REASON[cause],
  };
};
