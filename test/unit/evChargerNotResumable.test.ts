import { describe, expect, it } from 'vitest';
import {
  isEvChargerNotResumable,
  isEvChargerNotResumableForDevice,
} from '../../packages/shared-domain/src/commandableNow';
import {
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_WIDGET_STATUS_LABELS,
  deadlineLabels,
  resolveEvCardStateLine,
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

describe('resolveEvCardStateLine — connected-but-not-resumable charger (C1)', () => {
  const formatTime = (ms: number): string => `T${ms}`;

  it('surfaces a distinct not_resumable state line', () => {
    expect(resolveEvCardStateLine({
      hours: [], nowMs: 0, isPlugOutPaused: false, isNotResumable: true, formatTime,
    })).toEqual({ kind: 'not_resumable', text: 'Charging won’t resume — check the charger' });
  });

  it('not-resumable wins over planned hours (the schedule can\'t run)', () => {
    const line = resolveEvCardStateLine({
      hours: [{ startsAtMs: 0 }],
      nowMs: 0,
      isPlugOutPaused: false,
      isNotResumable: true,
      formatTime,
    });
    expect(line.kind).toBe('not_resumable');
  });

  it('falls back to the existing branches when not-resumable is absent', () => {
    expect(resolveEvCardStateLine({
      hours: [], nowMs: 0, isPlugOutPaused: true, isNotResumable: false, formatTime,
    }).kind).toBe('plug_out_paused');
    expect(resolveEvCardStateLine({
      hours: [], nowMs: 0, isPlugOutPaused: false, formatTime,
    }).kind).toBe('none');
  });
});

describe('EV pending hero — charger_not_resumable (C2)', () => {
  const ctx = { deviceId: 'dev', deviceName: 'Connected 300', deadlineTime: '07:00' };

  it('renders a charger-focused hero distinct from the unplugged copy', () => {
    const notResumable = deadlineLabels('ev_soc').pendingHeroByReason.charger_not_resumable(ctx);
    const unplugged = deadlineLabels('ev_soc').pendingHeroByReason.invalid_session(ctx);
    expect(notResumable.headline).toBe('Charging won’t resume');
    expect(notResumable.recourse).toBeNull();
    expect(notResumable.headlineReason).not.toBeNull();
    // Must NOT be the "plug in" copy — the car is connected.
    expect(notResumable.headline).not.toBe(unplugged.headline);
  });
});
