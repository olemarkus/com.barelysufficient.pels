import { describe, expect, it } from 'vitest';
import { readObservedTemperatureState } from '../../lib/observer/observedDeviceStateProjection';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import type { TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';

// Probe-widened fixture: the base snapshot type omits `currentTemperature` (that
// is the contract under test), so the fixture builds the owner-side widened
// shape the guard narrows from. Fully typed (no cast) so the compiler validates
// the fixture against the same shape the guard narrows.
const snap = (
  over: Partial<TargetDeviceSnapshot & TemperatureObservedProbe>,
): TargetDeviceSnapshot & TemperatureObservedProbe => ({ expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'd1',
  name: 'D',
  targets: [],
  ...over,
  available: over.available ?? true,
});

const temperature = (currentTemperature: number, targetValue = 20) => ({
  currentTemperature,
  target: { id: 'target_temperature' as const, value: targetValue, unit: '°C' },
});

describe('hasObservedTemperature', () => {
  it('is true when the complete temperature facet is present', () => {
    expect(hasObservedTemperature(snap({ temperature: temperature(21) }))).toBe(true);
  });

  it('does not reinterpret the legacy deviceType tag', () => {
    expect(hasObservedTemperature(snap({ deviceType: 'onoff', temperature: temperature(19.5) }))).toBe(true);
  });

  it('is false when there is no temperature facet', () => {
    expect(hasObservedTemperature(snap({ deviceType: 'temperature' }))).toBe(false);
    expect(hasObservedTemperature(snap({ temperature: undefined }))).toBe(false);
  });

  it('narrows both values to required finite-number contracts', () => {
    const s = snap({ temperature: temperature(18.5, 22) });
    if (hasObservedTemperature(s)) {
      const current: number = s.temperature.currentTemperature;
      const target: number = s.temperature.target.value;
      expect({ current, target }).toEqual({ current: 18.5, target: 22 });
    } else {
      throw new Error('expected hasObservedTemperature to narrow');
    }
  });
});

describe('readObservedTemperatureState', () => {
  it('represents both a missing device and a non-temperature device as null', () => {
    expect(readObservedTemperatureState(undefined)).toBeNull();
    expect(readObservedTemperatureState(snap({}))).toBeNull();
  });

  it('returns both required values from an admitted temperature facet', () => {
    expect(readObservedTemperatureState(snap({ temperature: temperature(18.5, 22) }))).toEqual({
      currentTemperature: 18.5,
      currentTarget: 22,
    });
  });
});
