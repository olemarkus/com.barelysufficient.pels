import { describe, expect, it } from 'vitest';
import {
  resolveSmartTaskCurrentValue,
  resolveSmartTaskDefaultGoal,
  resolveSmartTaskDeviceKind,
  resolveSmartTaskGoalBounds,
} from '../../packages/shared-domain/src/smartTaskDeviceKind';
import { formatSmartTaskDeadlineLong } from '../../packages/shared-domain/src/smartTaskDeadlineFormat';

describe('resolveSmartTaskDeviceKind', () => {
  it('classifies an EV charger as ev_soc even when it also has a target', () => {
    expect(resolveSmartTaskDeviceKind({ deviceClass: 'evcharger', targets: [{ value: 1 }] })).toBe('ev_soc');
  });

  it('classifies a temperature device type as temperature', () => {
    expect(resolveSmartTaskDeviceKind({ deviceType: 'temperature', targets: [] })).toBe('temperature');
  });

  it('classifies any device with a settable target as temperature', () => {
    expect(resolveSmartTaskDeviceKind({ targets: [{ value: 20, min: 5, max: 30 }] })).toBe('temperature');
  });

  it('returns null for an ineligible on/off device', () => {
    expect(resolveSmartTaskDeviceKind({ deviceType: 'onoff', targets: [] })).toBeNull();
  });
});

describe('resolveSmartTaskGoalBounds', () => {
  it('returns a 1..100 % battery range for ev_soc', () => {
    expect(resolveSmartTaskGoalBounds({ deviceClass: 'evcharger' }, 'ev_soc')).toEqual({
      unit: '%', min: 1, max: 100, step: 1,
    });
  });

  it('pulls temperature bounds from the device target', () => {
    expect(resolveSmartTaskGoalBounds({ targets: [{ value: 20, min: 10, max: 80, step: 0.5 }] }, 'temperature')).toEqual({
      unit: '°C', min: 10, max: 80, step: 0.5,
    });
  });

  it('falls back to a thermostat range when the target has no bounds', () => {
    expect(resolveSmartTaskGoalBounds({ targets: [{ value: 20 }] }, 'temperature')).toEqual({
      unit: '°C', min: 5, max: 95, step: 0.5,
    });
  });
});

describe('resolveSmartTaskDefaultGoal', () => {
  const evBounds = { unit: '%' as const, min: 1, max: 100, step: 1 };
  const tempBounds = { unit: '°C' as const, min: 5, max: 95, step: 0.5 };

  it('seeds EV at the 80% common-case when current is below it', () => {
    expect(resolveSmartTaskDefaultGoal({ kind: 'ev_soc', bounds: evBounds, currentValue: 42 })).toBe(80);
  });

  it('never seeds below the current reading', () => {
    expect(resolveSmartTaskDefaultGoal({ kind: 'ev_soc', bounds: evBounds, currentValue: 90 })).toBe(90);
  });

  it('seeds temperature at the 60 °C common-case with no reading', () => {
    expect(resolveSmartTaskDefaultGoal({ kind: 'temperature', bounds: tempBounds, currentValue: null })).toBe(60);
  });

  it('clamps the seed into the device bounds', () => {
    const lowMax = { unit: '°C' as const, min: 5, max: 40, step: 0.5 };
    expect(resolveSmartTaskDefaultGoal({ kind: 'temperature', bounds: lowMax, currentValue: null })).toBe(40);
  });
});

describe('resolveSmartTaskCurrentValue', () => {
  it('reads currentTemperature for temperature', () => {
    expect(resolveSmartTaskCurrentValue({ currentTemperature: 48 }, 'temperature')).toBe(48);
  });

  it('reads stateOfCharge.percent for ev_soc', () => {
    expect(resolveSmartTaskCurrentValue({ stateOfCharge: { percent: 42 } }, 'ev_soc')).toBe(42);
  });

  it('returns null when no reading is present', () => {
    expect(resolveSmartTaskCurrentValue({}, 'temperature')).toBeNull();
    expect(resolveSmartTaskCurrentValue({}, 'ev_soc')).toBeNull();
  });
});

describe('formatSmartTaskDeadlineLong', () => {
  const TZ = 'Europe/Oslo';
  const now = Date.UTC(2026, 0, 1, 10, 0, 0); // 11:00 Oslo (winter)

  it('labels a same-day deadline as Today HH:MM', () => {
    const ms = Date.UTC(2026, 0, 1, 15, 0, 0); // 16:00 Oslo
    expect(formatSmartTaskDeadlineLong(ms, now, TZ)).toBe('Today 16:00');
  });

  it('labels a next-day deadline as Tomorrow HH:MM', () => {
    const ms = Date.UTC(2026, 0, 2, 6, 0, 0); // 07:00 Oslo next day
    expect(formatSmartTaskDeadlineLong(ms, now, TZ)).toBe('Tomorrow 07:00');
  });
});
