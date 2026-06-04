import { resolveMissedHistoryRecourse } from '../../packages/shared-domain/src/deadlineLabels';

// Producer-side resolution: history-detail hero just renders these payloads.
// These tests pin the two-branch contract so the consumer never has to
// re-derive `targetTab` / `deviceId` / label from entry shape.

describe('resolveMissedHistoryRecourse', () => {
  it('returns null when the entry did not miss', () => {
    expect(resolveMissedHistoryRecourse({
      outcome: 'met',
      dailyBudgetExhausted: false,
      deviceId: 'dev_x',
    })).toBeNull();
    expect(resolveMissedHistoryRecourse({
      outcome: 'abandoned',
      dailyBudgetExhausted: false,
      deviceId: 'dev_x',
    })).toBeNull();
    expect(resolveMissedHistoryRecourse({
      outcome: 'replaced',
      dailyBudgetExhausted: false,
      deviceId: 'dev_x',
    })).toBeNull();
    expect(resolveMissedHistoryRecourse({
      outcome: 'unknown',
      dailyBudgetExhausted: false,
      deviceId: 'dev_x',
    })).toBeNull();
  });

  it('budget-exhausted missed run lands on the Budget tab and carries no deviceId deep link', () => {
    const recourse = resolveMissedHistoryRecourse({
      outcome: 'missed',
      dailyBudgetExhausted: true,
      deviceId: 'dev_water_heater',
    });
    expect(recourse).toEqual({ label: 'Lower daily budget', targetTab: 'budget' });
    // Budget recourse is tab-only — the user manages the daily budget at
    // the app level, not on a specific device, so no overlay deep link.
    expect(recourse?.deviceId).toBeUndefined();
  });

  it('shortfall missed run threads the entry deviceId so the click can open the device-settings overlay', () => {
    const recourse = resolveMissedHistoryRecourse({
      outcome: 'missed',
      dailyBudgetExhausted: false,
      deviceId: 'dev_water_heater',
    });
    expect(recourse).toEqual({
      label: 'Review device',
      targetTab: 'overview',
      deviceId: 'dev_water_heater',
    });
  });
});
