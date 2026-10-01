import { describe, expect, it } from 'vitest';
import {
  resolveSmartTaskCurrentValue,
  resolveSmartTaskDefaultGoal,
  resolveSmartTaskDeviceKind,
  resolveSmartTaskGoalBounds,
  supportsSmartTaskKind,
} from '../../packages/shared-domain/src/smartTaskDeviceKind';
import { formatSmartTaskDeadlineLong } from '../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import type { TargetCapabilitySnapshot } from '../../packages/contracts/src/types';
import type { SmartTaskDeviceLike } from '../../packages/shared-domain/src/smartTaskDeviceKind';

// The two identity facts are REQUIRED on the device; a fixture that does not
// state them describes a device that is neither a charger nor switchable.
const smartTaskDevice = <T extends Partial<SmartTaskDeviceLike>>(
  fields: T & Pick<SmartTaskDeviceLike, 'targets'>,
): T & SmartTaskDeviceLike => ({ isEvCharger: false, binaryControllable: false, ...fields });

describe('resolveSmartTaskDeviceKind', () => {
  it('classifies an EV charger as ev_soc even when it also has a target', () => {
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({
      targets: [],
      isEvCharger: true,
      temperature: { currentTemperature: 1, target: { value: 1 } },
    }))).toBe('ev_soc');
  });

  it('classifies only a device with a complete temperature observation as temperature', () => {
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({
      targets: [],
      temperature: { currentTemperature: 18, target: { value: 20, min: 5, max: 30 } },
    }))).toBe('temperature');
    // No observation, no temperature task: the facet is the only evidence read.
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({ targets: [] }))).toBeNull();
  });

  it('returns null for an ineligible on/off device', () => {
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({ targets: [] }))).toBeNull();
  });

  it('rejects temperature tasks when PELS temperature control is disabled', () => {
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({
      targets: [],
      temperature: { currentTemperature: 18, target: { value: 20 } },
      temperatureControlDisabled: true,
    }))).toBeNull();
  });

  it('rejects temperature tasks while following manual targets', () => {
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({ targets: [],
      temperature: { currentTemperature: 18, target: { value: 20 } }, temperatureAdjustmentsDisabled: true })))
      .toBeNull();
  });

  it('keeps EV tasks eligible when an EV also carries the temperature marker', () => {
    expect(resolveSmartTaskDeviceKind(smartTaskDevice({
      targets: [],
      isEvCharger: true,
      temperatureControlDisabled: true,
    }))).toBe('ev_soc');
  });
});

describe('energy tasks: pure on/off devices', () => {
  // A relay switching a water heater: an on/off axis and nothing else.
  const relay = smartTaskDevice({ binaryControllable: true, targets: [] as TargetCapabilitySnapshot[] });
  const livePower = { measuredPowerKw: 0, measuredPowerIsDirectMeasurement: true };

  it('gives a pure on/off device the energy kind, and only that one', () => {
    expect(resolveSmartTaskDeviceKind(relay)).toBe('energy');
  });

  it.each([
    // The producer folds the charger class and an `evcharger_charging` axis into
    // one `isEvCharger`, so a charger by its charging axis alone is this same row.
    ['an EV charger', { ...relay, isEvCharger: true }, 'ev_soc'],
    ['a device with a temperature target', { ...relay, targets: [{ id: 'target_temperature', unit: '°C' }] }, null],
    // Read off the observed facet now, which also makes it a temperature task.
    ['a temperature device', { ...relay, temperature: { currentTemperature: 18, target: { value: 20 } } }, 'temperature'],
    ['a stepped load', { ...relay, steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: 2000 }] } }, null],
    ['a device with no on/off axis', { ...relay, binaryControllable: false }, null],
  ])('does not give %s the energy kind', (_label, device, kind) => {
    expect(resolveSmartTaskDeviceKind(device)).toBe(kind);
  });

  it('lets an energy task be created only on a device with a live power reading', () => {
    expect(supportsSmartTaskKind({ ...relay, ...livePower }, 'energy')).toBe(true);
    // A rate derived from a cumulative meter lingers after the relay switches off.
    expect(supportsSmartTaskKind({ ...relay, measuredPowerKw: 2, measuredPowerIsDirectMeasurement: false }, 'energy'))
      .toBe(false);
    expect(supportsSmartTaskKind(relay, 'energy')).toBe(false);
    expect(supportsSmartTaskKind({ ...relay, ...livePower }, 'temperature')).toBe(false);
  });

  it('asks nothing of metering for the other kinds', () => {
    expect(supportsSmartTaskKind(smartTaskDevice({ targets: [], isEvCharger: true }), 'ev_soc')).toBe(true);
  });
});

describe('resolveSmartTaskGoalBounds', () => {
  it('returns a 1..100 % battery range for ev_soc', () => {
    expect(resolveSmartTaskGoalBounds(smartTaskDevice({ targets: [], isEvCharger: true }), 'ev_soc')).toEqual({
      unit: '%', min: 1, max: 100, step: 1,
    });
  });

  it('pulls temperature bounds from the device target', () => {
    expect(resolveSmartTaskGoalBounds(smartTaskDevice({
      targets: [],
      temperature: { currentTemperature: 18, target: { value: 20, min: 10, max: 80, step: 0.5 } },
    }), 'temperature')).toEqual({
      unit: '°C', min: 10, max: 80, step: 0.5,
    });
  });

  it('falls back to a thermostat range when the target has no bounds', () => {
    expect(resolveSmartTaskGoalBounds(smartTaskDevice({
      targets: [],
      temperature: { currentTemperature: 18, target: { value: 20 } },
    }), 'temperature')).toEqual({
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
    expect(resolveSmartTaskCurrentValue(smartTaskDevice({
      targets: [],
      temperature: { currentTemperature: 48, target: { value: 50 } },
    }), 'temperature')).toBe(48);
  });

  // Built through the producer's own fixture rather than a hand-written literal:
  // the structural slice this helper takes used to accept any object, so a
  // literal kept compiling after the raw reading moved under `report` and every
  // EV charger silently seeded from `null`.
  it('reads the raw reported percentage for ev_soc', () => {
    expect(resolveSmartTaskCurrentValue(
      smartTaskDevice({ targets: [], isEvCharger: true, stateOfCharge: stateOfChargeFixture({ percent: 42 }) }),
      'ev_soc',
    )).toBe(42);
  });

  it('returns null when no reading is present', () => {
    expect(resolveSmartTaskCurrentValue(smartTaskDevice({ targets: [] }), 'temperature')).toBeNull();
    expect(resolveSmartTaskCurrentValue(smartTaskDevice({ targets: [] }), 'ev_soc')).toBeNull();
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
