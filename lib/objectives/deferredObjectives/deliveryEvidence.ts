import type {
  TaskDeviceConstraint, TaskDeliveryBlocker, TaskDeliveryCause,
  TaskDeliveryControl, TaskDeliveryEvidence, TaskDeliveryInterval,
} from '../../../packages/contracts/src/taskDelivery';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import { DELIVERY_EPSILON_KWH, NON_DELIVERY_HOLD_MS, observeTaskNonDelivery } from './taskDeliveryState';

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
const appendInterval = (
  intervals: TaskDeliveryInterval[], cause: TaskDeliveryCause, fromMs: number, toMs: number,
): TaskDeliveryInterval[] => {
  const tail = intervals.at(-1);
  if (tail && tail.cause === cause && tail.toMs === fromMs) {
    return [...intervals.slice(0, -1), { ...tail, toMs }];
  }
  return [...intervals, { fromMs, toMs, cause }];
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

const DELIVERY_RISK_CAUSES: ReadonlySet<TaskDeliveryCause | 'clear'> = new Set([
  'device_not_accepting', 'device_limit', 'device_schedule', 'capacity_limited', 'budget_limited',
  'priority_limited', 'control_failed', 'uncontrolled',
]);
const DELIVERY_REASON = {
  device_limit: 'objective_device_limit',
  device_not_accepting: 'objective_not_accepting_energy',
} as const;
/** A live overlay; the settled allocation continues to own admission and revision metadata. */
export const reportTaskDeliveryStatus = (
  diagnostic: DeferredObjectiveDiagnostic, read: TaskDeliveryReader,
): DeferredObjectiveDiagnostic => {
  if (diagnostic.deadlineAtMs === null || diagnostic.trajectory.kind !== 'resolved') return diagnostic;
  if (diagnostic.trajectory.status === 'satisfied' || diagnostic.trajectory.status === 'invalid') return diagnostic;
  const cause = activeDeliveryCause(read(diagnostic.deviceId, diagnostic.deadlineAtMs));
  if (!DELIVERY_RISK_CAUSES.has(cause)) return diagnostic;
  const reasonCode = cause === 'device_limit' || cause === 'device_not_accepting'
    ? DELIVERY_REASON[cause] : 'objective_delivery_restricted';
  return {
    ...diagnostic,
    trajectory: {
      kind: 'resolved', status: diagnostic.trajectory.status === 'cannot_meet' ? 'cannot_meet' : 'at_risk',
    },
    reasonCode,
  };
};
