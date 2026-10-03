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
