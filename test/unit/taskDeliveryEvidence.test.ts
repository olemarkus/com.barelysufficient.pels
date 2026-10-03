import { describe, expect, it } from 'vitest';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { inactiveTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives/types';
import { partialDouble } from '../helpers/partialDouble';
import { EMPTY_DELIVERY_EVIDENCE, activeDeliveryCause, observeTaskDelivery, suppressTaskDeliveryReservation, resolveTaskDeliveryFacts, type TaskDeliveryFacts } from '../../lib/objectives/deferredObjectives/deliveryEvidence';
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
    expect(suppressTaskDeliveryReservation(state)).toBe(true);
  });
  it.each(['deferred', 'satisfied'] as const)('does not penalize %s delivery', (obligation) => {
    const state = tick({ ...permitted, obligation });
    expect(activeDeliveryCause(state)).toBe('clear');
    expect(suppressTaskDeliveryReservation(state)).toBe(false);
  });
  it('does not suppress reservations during restoration', () => {
    const state = tick({ ...permitted, control: { kind: 'pending' } });
    expect(activeDeliveryCause(state)).toBe('control_pending');
    expect(suppressTaskDeliveryReservation(state)).toBe(false);
  });
  it('uses actual capacity restrictions even on a device still drawing', () => {
    const state = tick({ ...permitted, control: { kind: 'restricted', cause: 'capacity_limited' }, observation: { kind: 'drawing', kw: 1 } });
    expect(activeDeliveryCause(state)).toBe('capacity_limited');
    expect(suppressTaskDeliveryReservation(state)).toBe(false);
  });
  it('uses confirmed limit evidence without waiting for a generic cutoff', () => {
    const state = tick({ ...permitted, deviceConstraint: { kind: 'limit_reached' } });
    expect(activeDeliveryCause(state)).toBe('device_limit');
  });
  it('keeps an applied restriction primary when a device also has a limit', () => {
    const state = tick({ ...permitted, deviceConstraint: { kind: 'limit_reached' },
      control: { kind: 'restricted', cause: 'capacity_limited' } });
    expect(activeDeliveryCause(state)).toBe('capacity_limited');
    expect(suppressTaskDeliveryReservation(state)).toBe(false);
  });
  it('clears a blocker on resumed draw and records it only as an earlier contributor', () => {
    const state = observeTaskDelivery(tick(), { ...permitted, observation: { kind: 'drawing', kw: 2 } }, 16 * MINUTE, MINUTE);
    expect(activeDeliveryCause(state)).toBe('clear');
    expect(suppressTaskDeliveryReservation(state)).toBe(false);
    expect(state.explanation).toMatchObject({ contributors: ['device_not_accepting'] });
  });
  it('distinguishes missing measurements from a cutoff', () => {
    const state = tick({ ...permitted, observation: { kind: 'unavailable' } });
    expect(activeDeliveryCause(state)).toBe('observation_unavailable');
    expect(suppressTaskDeliveryReservation(state)).toBe(false);
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
