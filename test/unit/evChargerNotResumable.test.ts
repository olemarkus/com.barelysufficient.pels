import { describe, expect, it } from 'vitest';
import {
  isEvChargerNotResumable,
  isEvChargerNotResumableForDevice,
} from '../../packages/shared-domain/src/commandableNow';
import {
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_WIDGET_STATUS_LABELS,
  resolveSmartTaskListStatus,
} from '../../packages/shared-domain/src/deadlineLabels';

describe('isEvChargerNotResumable', () => {
  it('is true only for the connected-but-not-resumable plugged_in state', () => {
    expect(isEvChargerNotResumable('plugged_in')).toBe(true);
    expect(isEvChargerNotResumableForDevice({ evChargingState: 'plugged_in' })).toBe(true);
  });

  it('is false for the resumable / charging / unplugged states', () => {
    for (const state of ['plugged_in_paused', 'plugged_in_charging', 'plugged_out', 'plugged_in_discharging', undefined]) {
      expect(isEvChargerNotResumable(state)).toBe(false);
    }
  });
});

describe('resolveSmartTaskListStatus — connected-but-not-resumable charger', () => {
  const base = { pending: false, pendingReason: undefined, firstActionAtMs: null, nowMs: 0 } as const;

  it('maps objective_charger_not_resumable to paused_not_resumable, overriding an on_track plan', () => {
    expect(resolveSmartTaskListStatus({
      ...base,
      diagnosticReasonCode: 'objective_charger_not_resumable',
      planStatus: 'on_track',
    })).toBe('paused_not_resumable');
  });

  it('keeps the unplugged case distinct', () => {
    expect(resolveSmartTaskListStatus({
      ...base,
      diagnosticReasonCode: 'objective_invalid_session',
      planStatus: 'on_track',
    })).toBe('paused_unplugged');
  });

  it('exposes the approved chip / widget copy', () => {
    expect(SMART_TASK_LIST_STATUS_LABELS.paused_not_resumable).toBe('Paused — can’t resume');
    expect(SMART_TASK_WIDGET_STATUS_LABELS.paused_not_resumable).toBe('Can’t resume');
  });
});
