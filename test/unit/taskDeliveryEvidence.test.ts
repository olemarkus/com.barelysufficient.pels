import { describe, expect, it } from 'vitest';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { inactiveTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives/types';
import { partialDouble } from '../helpers/partialDouble';
import {
  EMPTY_DELIVERY_EVIDENCE, MAX_DELIVERY_INTERVALS, activeDeliveryCause, observeTaskDelivery, reportTaskDeliveryStatus,
  resolveTaskDeliveryFacts, type TaskDeliveryFacts,
} from '../../lib/objectives/deferredObjectives/deliveryEvidence';
import type { TaskDeliveryCause, TaskDeliveryEvidence } from '../../packages/contracts/src/taskDelivery';
const MINUTE = 60000;
const permitted: TaskDeliveryFacts = {
  obligation: 'claimed', control: { kind: 'permitted' }, observation: { kind: 'not_drawing' },
  progress: { kind: 'known', value: 0 }, deviceConstraint: { kind: 'none' }, schedule: 'fits',
};
const tick = (facts: TaskDeliveryFacts = permitted) => {
  const first = observeTaskDelivery(EMPTY_DELIVERY_EVIDENCE, facts, 0, 0);
  return observeTaskDelivery(first, facts, 15 * MINUTE, 15 * MINUTE);
};
describe('device-neutral delivery evidence', () => {
  it('confirms a mechanical thermostat or EV cutoff only during claimed permitted delivery', () => {
    const state = tick();
    expect(activeDeliveryCause(state)).toBe('device_not_accepting');
  });
  it.each(['deferred', 'satisfied'] as const)('does not penalize %s delivery', (obligation) => {
    const state = tick({ ...permitted, obligation });
    expect(activeDeliveryCause(state)).toBe('clear');
  });
  it('reports pending control during restoration', () => {
    const state = tick({ ...permitted, control: { kind: 'pending' } });
    expect(activeDeliveryCause(state)).toBe('control_pending');
  });
  it('uses actual capacity restrictions even on a device still drawing', () => {
    const state = tick({ ...permitted, control: { kind: 'restricted', cause: 'capacity_limited' }, observation: { kind: 'drawing', kw: 1 } });
    expect(activeDeliveryCause(state)).toBe('capacity_limited');
  });
  it('uses confirmed limit evidence without waiting for a generic cutoff', () => {
    const state = tick({ ...permitted, deviceConstraint: { kind: 'limit_reached' } });
    expect(activeDeliveryCause(state)).toBe('device_limit');
  });
  it('keeps an applied restriction primary when a device also has a limit', () => {
    const state = tick({ ...permitted, deviceConstraint: { kind: 'limit_reached' },
      control: { kind: 'restricted', cause: 'capacity_limited' } });
    expect(activeDeliveryCause(state)).toBe('capacity_limited');
  });
  it('clears a blocker on resumed draw and records it only as an earlier contributor', () => {
    const state = observeTaskDelivery(tick(), { ...permitted, observation: { kind: 'drawing', kw: 2 } }, 16 * MINUTE, MINUTE);
    expect(activeDeliveryCause(state)).toBe('clear');
    expect(state.explanation).toMatchObject({ contributors: ['device_not_accepting'] });
  });
  it('distinguishes missing measurements from a cutoff', () => {
    const state = tick({ ...permitted, observation: { kind: 'unavailable' } });
    expect(activeDeliveryCause(state)).toBe('observation_unavailable');
  });
  it('keeps mixed causes in chronological intervals and final expiry retains the last blocker', () => {
    const limited = tick({ ...permitted, control: { kind: 'restricted', cause: 'budget_limited' } });
    const stopped = observeTaskDelivery(limited, permitted, 16 * MINUTE, MINUTE);
    const confirmed = observeTaskDelivery(stopped, permitted, 31 * MINUTE, 15 * MINUTE);
    expect(activeDeliveryCause(confirmed)).toBe('device_not_accepting');
    expect(confirmed.explanation).toMatchObject({ contributors: ['budget_limited'] });
    expect(observeTaskDelivery(confirmed, { ...permitted, obligation: 'expired' }, 32 * MINUTE, MINUTE)).toEqual(confirmed);
  });
});


it.each(['planned_with_margin', 'target_cannot_be_met', 'estimate_uncertain'] as const)(
  'keeps delivery facts independent of reporting reasons and cross-unit values (%s)',
  (reportedReason) => {
    const plan = partialDouble<DeferredObjectiveHorizonPlan>({
      currentHourClaim: 'claimed', statusDetail: 'target_cannot_be_met',
    });
    const evaluation = {
      ...inactiveTaskEvaluation('charger-energy-task', 3_600_000, 3),
      progress: { kind: 'known' as const, value: 2, direction: 'increasing' as const },
      completion: { kind: 'unmet' as const }, planning: { kind: 'allocated' as const, plan },
    };
    const report = partialDouble<DeferredObjectiveDiagnostic>({
      evaluation, currentDrawKw: 0, reasonCode: reportedReason,
      trajectory: { kind: 'resolved', status: 'on_track' },
      currentValue: 70, targetValue: 80, reachableTargetValue: 70,
    });
    const facts = resolveTaskDeliveryFacts(report, { kind: 'permitted' }, true, { kind: 'none' }, 0);
    const otherReport = { ...report, reasonCode: 'planned_with_margin' as const,
      currentValue: 0, targetValue: 45, reachableTargetValue: 45 };
    expect(resolveTaskDeliveryFacts(otherReport, { kind: 'permitted' }, true, { kind: 'none' }, 0)).toEqual(facts);
    expect(facts.schedule).toBe('rate_insufficient');
    expect(activeDeliveryCause(observeTaskDelivery(EMPTY_DELIVERY_EVIDENCE, facts, 0, 0)))
      .toBe('rate_insufficient');
    expect(activeDeliveryCause(observeTaskDelivery(EMPTY_DELIVERY_EVIDENCE,
      { ...facts, deviceConstraint: { kind: 'limit_reached' } }, 0, 0))).toBe('device_limit');
  },
);

describe('bounded delivery intervals', () => {
  it('keeps only the newest intervals while every cause stays a contributor', () => {
    const causes: TaskDeliveryCause[] = ['capacity_limited', 'control_pending'];
    let state: TaskDeliveryEvidence = EMPTY_DELIVERY_EVIDENCE;
    // A shed/settle flip every minute for five hours: one interval per flip.
    for (let minute = 0; minute <= 300; minute += 1) {
      const cause = causes[minute % 2]!;
      state = observeTaskDelivery(state, { ...permitted, control: { kind: 'restricted', cause } }, minute * MINUTE, MINUTE);
    }
    expect(state.explanation.kind).toBe('recorded');
    if (state.explanation.kind !== 'recorded') return;
    expect(state.explanation.intervals).toHaveLength(MAX_DELIVERY_INTERVALS);
    expect(state.explanation.intervals.at(-1)).toMatchObject({ toMs: 300 * MINUTE });
    expect(state.explanation.contributors).toEqual(['capacity_limited', 'control_pending']);
  });

  it('trims an older, longer persisted list on its next append', () => {
    const legacy: TaskDeliveryEvidence = {
      explanation: {
        kind: 'recorded', primary: { kind: 'blocked', cause: 'budget_limited' }, contributors: ['budget_limited'],
        intervals: Array.from({ length: MAX_DELIVERY_INTERVALS * 3 }, (_, index) => ({
          fromMs: index * 2 * MINUTE, toMs: (index * 2 + 1) * MINUTE, cause: 'budget_limited' as const,
        })),
      },
      nonDelivery: { kind: 'none' },
    };
    const next = observeTaskDelivery(legacy, permitted, 1000 * MINUTE, MINUTE);
    expect(next.explanation.kind === 'recorded' && next.explanation.intervals.length).toBe(MAX_DELIVERY_INTERVALS);
  });
});

describe('live status overlay', () => {
  const diagnostic = partialDouble<DeferredObjectiveDiagnostic>({
    deviceId: 'dev', deadlineAtMs: 3_600_000, reasonCode: 'planned_with_margin',
    trajectory: { kind: 'resolved', status: 'on_track' },
  });
  const blocked = (cause: TaskDeliveryCause): TaskDeliveryEvidence => ({
    explanation: { kind: 'recorded', primary: { kind: 'blocked', cause }, contributors: [], intervals: [] },
    nonDelivery: { kind: 'none' },
  });

  // Planner decisions and transient executor facts: the horizon plan owns them,
  // and overlaying them flipped the status on every shed/settle cycle.
  it.each([
    'capacity_limited', 'budget_limited', 'priority_limited', 'control_pending', 'control_failed', 'uncontrolled',
    'observation_unavailable', 'rate_insufficient',
  ] as const)('leaves an on-track task alone while %s holds delivery', (cause) => {
    expect(reportTaskDeliveryStatus(diagnostic, () => blocked(cause))).toBe(diagnostic);
  });

  it.each([
    ['device_not_accepting', 'objective_not_accepting_energy'],
    ['device_limit', 'objective_device_limit'],
    ['device_schedule', 'objective_device_schedule'],
  ] as const)('downgrades on a confirmed device-side %s with its own reason', (cause, reasonCode) => {
    expect(reportTaskDeliveryStatus(diagnostic, () => blocked(cause))).toMatchObject({
      trajectory: { kind: 'resolved', status: 'at_risk' }, reasonCode,
    });
  });
});
