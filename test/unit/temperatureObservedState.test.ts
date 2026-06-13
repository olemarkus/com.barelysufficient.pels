import { describe, expect, it } from 'vitest';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import type { TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';

// Probe-widened fixture: the base snapshot type omits `currentTemperature` (that
// is the contract under test), so the fixture builds the owner-side widened
// shape the guard narrows from. Fully typed (no cast) so the compiler validates
// the fixture against the same shape the guard narrows.
const snap = (
  over: Partial<TargetDeviceSnapshot & TemperatureObservedProbe>,
): TargetDeviceSnapshot & TemperatureObservedProbe => ({
  id: 'd1',
  name: 'D',
  targets: [],
  ...over,
});

describe('hasObservedTemperature', () => {
  it('is true when a temperature reading is present', () => {
    expect(hasObservedTemperature(snap({ currentTemperature: 21 }))).toBe(true);
  });

  it('is true regardless of device kind (presence-only, unlike isEvObserved)', () => {
    // A non-temperature `deviceType` device can carry a `measure_temperature`
    // reading; the guard must NOT reject a present reading on kind grounds.
    expect(hasObservedTemperature(snap({ deviceType: 'onoff', currentTemperature: 19.5 }))).toBe(true);
  });

  it('is false when there is no reading', () => {
    expect(hasObservedTemperature(snap({ deviceType: 'temperature' }))).toBe(false);
    expect(hasObservedTemperature(snap({ currentTemperature: undefined }))).toBe(false);
    // The type forbids `null`, but the guard also rejects one that crosses the
    // Homey SDK / JSON boundary at runtime — cast to reach that path.
    expect(hasObservedTemperature(snap({ currentTemperature: null as unknown as number }))).toBe(false);
  });

  it('narrows currentTemperature to a non-undefined number', () => {
    const s = snap({ currentTemperature: 18.5 });
    if (hasObservedTemperature(s)) {
      // Compile-time: `s.currentTemperature` is `number` (not `number | undefined`).
      const known: number = s.currentTemperature;
      expect(known).toBe(18.5);
    } else {
      throw new Error('expected hasObservedTemperature to narrow');
    }
  });
});
