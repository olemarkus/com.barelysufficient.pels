import {
  resolveObservedDrawKw,
  resolveObservedDrawKwWithNameplate,
} from '../../lib/plan/restore/observedDraw';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';

// The two restore-gap draw helpers replace the inline `Math.max(0, dev.measuredPowerKw ?? 0)`
// and `Math.max(0, dev.measuredPowerKw ?? dev.powerKw ?? 0)` reads. These tests pin the
// absence/clamp/finiteness contract — including the NaN-safety the old `??` chains lacked.

const dev = (overrides: Partial<Pick<DevicePlanDevice, 'measuredPowerKw' | 'powerKw'>>) =>
  overrides as Pick<DevicePlanDevice, 'measuredPowerKw' | 'powerKw'>;

describe('resolveObservedDrawKw', () => {
  it('returns the finite measured draw', () => {
    expect(resolveObservedDrawKw(dev({ measuredPowerKw: 2.4 }))).toBe(2.4);
  });

  it('treats a measured zero as a real reading (0 kW), not absence', () => {
    expect(resolveObservedDrawKw(dev({ measuredPowerKw: 0 }))).toBe(0);
  });

  it('clamps a negative measured value to zero', () => {
    expect(resolveObservedDrawKw(dev({ measuredPowerKw: -1.5 }))).toBe(0);
  });

  it('defaults to 0 when there is no measured reading', () => {
    expect(resolveObservedDrawKw(dev({}))).toBe(0);
  });

  it('drops a non-finite measured value to 0 (the `?? 0` NaN-blind spot)', () => {
    expect(resolveObservedDrawKw(dev({ measuredPowerKw: Number.NaN }))).toBe(0);
    expect(resolveObservedDrawKw(dev({ measuredPowerKw: Number.POSITIVE_INFINITY }))).toBe(0);
  });
});

describe('resolveObservedDrawKwWithNameplate', () => {
  it('prefers the finite measured draw over the nameplate', () => {
    expect(resolveObservedDrawKwWithNameplate(dev({ measuredPowerKw: 3.1, powerKw: 5 }))).toBe(3.1);
  });

  it('falls back to the nameplate powerKw when no measured reading', () => {
    expect(resolveObservedDrawKwWithNameplate(dev({ powerKw: 5 }))).toBe(5);
  });

  it('clamps a negative nameplate to zero', () => {
    expect(resolveObservedDrawKwWithNameplate(dev({ powerKw: -2 }))).toBe(0);
  });

  it('defaults to 0 when neither field is present', () => {
    expect(resolveObservedDrawKwWithNameplate(dev({}))).toBe(0);
  });

  it('falls back to a finite nameplate when the measured value is non-finite (the core `??`-chain fix)', () => {
    // The exact divergence: old `measuredPowerKw ?? powerKw ?? 0` returned NaN here
    // (`??` doesn't substitute on NaN, so the finite nameplate was unreachable);
    // the finite-gated helper now reaches the nameplate.
    expect(resolveObservedDrawKwWithNameplate(dev({ measuredPowerKw: Number.NaN, powerKw: 5 }))).toBe(5);
  });

  it('drops a non-finite nameplate to 0 (old `measuredPowerKw ?? powerKw ?? 0` would propagate NaN)', () => {
    expect(resolveObservedDrawKwWithNameplate(dev({ powerKw: Number.NaN }))).toBe(0);
    expect(resolveObservedDrawKwWithNameplate(dev({ measuredPowerKw: Number.NaN, powerKw: Number.NaN }))).toBe(0);
  });
});
