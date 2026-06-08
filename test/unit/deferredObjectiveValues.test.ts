import { describe, expect, it } from 'vitest';

import {
  resolveFinalProgressValue,
  resolveSampleValue,
  resolveStartProgressValue,
  resolveTargetValue,
} from '../../packages/shared-domain/src/deferredObjectiveValues';

// The resolvers coalesce a kind-split (°C vs %) field pair to the single value
// that holds it, so consumers never branch on `objectiveKind` to pick a number.
// The invariant is that at most one column of a pair is non-null per record.
describe('deferredObjectiveValues resolvers', () => {
  describe('resolveTargetValue', () => {
    it('returns the °C column for a temperature record (percent null)', () => {
      expect(resolveTargetValue({ targetTemperatureC: 65, targetPercent: null })).toBe(65);
    });

    it('returns the % column for an EV-SoC record (°C null)', () => {
      expect(resolveTargetValue({ targetTemperatureC: null, targetPercent: 80 })).toBe(80);
    });

    it('returns null when neither column is set', () => {
      expect(resolveTargetValue({ targetTemperatureC: null, targetPercent: null })).toBeNull();
    });

    it('is forward-compatible with a single-column (percent) write for any kind', () => {
      // A future temperature entry that writes only `targetPercent` resolves the
      // same value the legacy `targetTemperatureC` column would have carried.
      expect(resolveTargetValue({ targetTemperatureC: null, targetPercent: 65 })).toBe(65);
    });
  });

  describe('resolveStartProgressValue', () => {
    it('coalesces percent over °C', () => {
      expect(resolveStartProgressValue({ startProgressC: 50, startProgressPercent: null })).toBe(50);
      expect(resolveStartProgressValue({ startProgressC: null, startProgressPercent: 20 })).toBe(20);
      expect(resolveStartProgressValue({ startProgressC: null, startProgressPercent: null })).toBeNull();
    });
  });

  describe('resolveFinalProgressValue', () => {
    it('coalesces percent over °C', () => {
      expect(resolveFinalProgressValue({ finalProgressC: 64, finalProgressPercent: null })).toBe(64);
      expect(resolveFinalProgressValue({ finalProgressC: null, finalProgressPercent: 79 })).toBe(79);
      expect(resolveFinalProgressValue({ finalProgressC: null, finalProgressPercent: null })).toBeNull();
    });
  });

  describe('resolveSampleValue', () => {
    it('coalesces percent over °C', () => {
      expect(resolveSampleValue({ valueC: 55, valuePercent: null })).toBe(55);
      expect(resolveSampleValue({ valueC: null, valuePercent: 42 })).toBe(42);
      expect(resolveSampleValue({ valueC: null, valuePercent: null })).toBeNull();
    });

    it('preserves a zero reading (coalesce uses nullish, not falsy)', () => {
      expect(resolveSampleValue({ valueC: 0, valuePercent: null })).toBe(0);
      expect(resolveSampleValue({ valueC: null, valuePercent: 0 })).toBe(0);
    });
  });
});
