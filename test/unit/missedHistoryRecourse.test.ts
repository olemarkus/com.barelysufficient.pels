import { resolveMissedHistoryCarHint, resolveMissedHistoryRecourse } from '../../packages/shared-domain/src/deadlineLabels';
import type { TaskDeliveryExplanation } from '../../packages/contracts/src/taskDelivery';

const recorded = (
  cause: 'budget_limited' | 'device_not_accepting' | 'device_limit' | 'device_schedule',
): Extract<TaskDeliveryExplanation, { kind: 'recorded' }> => ({
  kind: 'recorded', primary: { kind: 'blocked', cause }, contributors: [], intervals: [],
});

describe('resolveMissedHistoryRecourse', () => {
  it.each(['met', 'abandoned', 'replaced'] as const)('returns null for %s entries', (outcome) => {
    expect(resolveMissedHistoryRecourse({
      outcome, deviceId: 'dev_x', deliveryExplanation: recorded('budget_limited'),
    })).toBeNull();
  });

  it('routes a recorded final budget blocker to Budget without a device deep link', () => {
    const recourse = resolveMissedHistoryRecourse({
      outcome: 'missed', deviceId: 'dev_water_heater', deliveryExplanation: recorded('budget_limited'),
    });
    expect(recourse).toEqual({ label: 'Lower daily budget', targetTab: 'budget' });
    expect(recourse?.deviceId).toBeUndefined();
  });

  it('routes the final device blocker to its device despite an earlier budget restriction', () => {
    const recourse = resolveMissedHistoryRecourse({
      outcome: 'missed', deviceId: 'dev_water_heater',
      deliveryExplanation: { ...recorded('device_not_accepting'), contributors: ['budget_limited'] },
    });
    expect(recourse).toEqual({
      label: 'Review device', targetTab: 'overview', deviceId: 'dev_water_heater',
    });
  });

  // No PELS setting changes the car: the cause sentence names the car, the
  // widget carries the car-side action, and no button points at PELS settings.
  it.each([
    ['device_limit', 'Raise the car’s charge limit to reach the target.'],
    ['device_schedule', 'Turn off the car’s own charging schedule or smart charging.'],
  ] as const)('offers no PELS recourse for a run the car held back (%s)', (cause, hint) => {
    const entry = { outcome: 'missed' as const, deviceId: 'ev', deliveryExplanation: recorded(cause) };
    expect(resolveMissedHistoryRecourse(entry)).toBeNull();
    expect(resolveMissedHistoryCarHint(entry)).toBe(hint);
  });

  it('keeps device review, and no car hint, for a device that stopped taking power', () => {
    const entry = { outcome: 'missed' as const, deviceId: 'dev', deliveryExplanation: recorded('device_not_accepting') };
    expect(resolveMissedHistoryRecourse(entry)?.label).toBe('Review device');
    expect(resolveMissedHistoryCarHint(entry)).toBeNull();
  });

  it('offers general review for legacy entries without inventing a budget cause', () => {
    expect(resolveMissedHistoryRecourse({
      outcome: 'missed', deviceId: 'dev_water_heater', deliveryExplanation: { kind: 'legacy_unrecorded' },
    })).toEqual({ label: 'Review device', targetTab: 'overview', deviceId: 'dev_water_heater' });
  });
});
