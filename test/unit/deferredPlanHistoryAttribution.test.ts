import { describe, expect, it } from 'vitest';
import { formatRefinedMissCause, resolveDeferredPlanHistoryMissAttribution } from '../../packages/shared-domain/src/deferredPlanHistoryAttribution';
import type { TaskDeliveryCause, TaskDeliveryExplanation } from '../../packages/contracts/src/taskDelivery';

const entry = (deliveryExplanation: TaskDeliveryExplanation, deliveredKWh = 0) => ({
  outcome: 'missed' as const, deliveryExplanation, deliveredKWh, originalPlan: null, finalPlan: null,
});
const blocked = (cause: TaskDeliveryCause, contributors: TaskDeliveryCause[] = []): TaskDeliveryExplanation => ({
  kind: 'recorded', primary: { kind: 'blocked', cause }, contributors, intervals: [],
});
describe('recorded smart-task miss attribution', () => {
  it.each([0, 1, 19, 20, 100])('never infers capacity from %s kWh delivered', (delivered) => {
    const run = entry({ kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [] }, delivered);
    expect(resolveDeferredPlanHistoryMissAttribution(run).cause).toBe('delivery_unfulfilled');
  });
  it.each(['capacity_limited', 'budget_limited', 'priority_limited', 'device_limit', 'device_not_accepting',
    'control_pending', 'control_failed', 'observation_unavailable', 'progress_unavailable',
    'rate_insufficient', 'estimate_uncertain', 'uncontrolled'] as const)('uses recorded %s evidence', (cause) => {
    expect(resolveDeferredPlanHistoryMissAttribution(entry(blocked(cause), 100)).cause).toBe(cause);
  });
  it('explains a final device cutoff alongside earlier capacity pressure', () => {
    const run = entry(blocked('device_limit', ['capacity_limited', 'device_limit']));
    expect(resolveDeferredPlanHistoryMissAttribution(run).cause).toBe('device_limit');
    expect(formatRefinedMissCause(run)).toBe('The device has its own limit below the requested target. Earlier: Power-limit control held delivery back.');
  });
  it('marks older runs as missing evidence rather than reattributing their measurements', () => {
    expect(resolveDeferredPlanHistoryMissAttribution(entry({ kind: 'legacy_unrecorded' }, 19)).cause).toBe('legacy_unrecorded');
  });
  it.each(['met', 'abandoned', 'replaced'] as const)('does not attribute a %s outcome', (outcome) => {
    expect(formatRefinedMissCause({ ...entry(blocked('capacity_limited')), outcome })).toBeNull();
  });
});

describe('logged planned total', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DEADLINE_MS = Date.UTC(2026, 9, 2, 5, 0, 0);
  const clear: TaskDeliveryExplanation = { kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [] };
  // The final revision of a run re-planned hourly: one hour, shrunk to its
  // last two minutes.
  const finalPlan = {
    hours: [{ startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 0.03, coversFromMs: DEADLINE_MS - 2 * 60_000 }],
    energyNeededKWh: 0.03,
    planStatus: 'cannot_meet' as const,
    revisedAtMs: DEADLINE_MS - 2 * 60_000,
  };

  // Regression, prod 2026-10-01/02: an overnight EV run logged plannedKWh 0.03
  // because hourly re-plans had dropped every elapsed hour from the final
  // revision. The sum includes energy re-booked after a short hour; it is
  // telemetry and never compared with delivery.
  it('sums each hour\'s booking at its start, not the final revision\'s remainder', () => {
    const run = {
      ...entry(clear, 9.1),
      finalPlan,
      hourStartBookings: [
        { atMs: DEADLINE_MS - 4 * HOUR_MS, bookedKWh: 3.2 },
        { atMs: DEADLINE_MS - 3 * HOUR_MS, bookedKWh: 0 },
        { atMs: DEADLINE_MS - 2 * HOUR_MS, bookedKWh: 3.4 },
        { atMs: DEADLINE_MS - HOUR_MS, bookedKWh: 2.9 },
      ],
    };
    expect(resolveDeferredPlanHistoryMissAttribution(run).plannedKWh).toBeCloseTo(9.5);
  });

  it('keeps reading the final revision\'s hours for an entry recorded before hour-start bookings', () => {
    expect(resolveDeferredPlanHistoryMissAttribution({ ...entry(clear), finalPlan }).plannedKWh).toBeCloseTo(0.03);
  });

  it('reports no planned total when no plan was recorded', () => {
    expect(resolveDeferredPlanHistoryMissAttribution(entry(clear)).plannedKWh).toBeNull();
  });
});
