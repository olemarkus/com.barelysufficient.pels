/**
 * Coverage for the chunk-4 producer addition in `lib/device/deviceResidualKw.ts`:
 *
 *  - `resolveResidualKwRestore` collapses the legacy
 *    `isSteppedLoadDevice + getSteppedLoadRestoreStep` chain in
 *    `lib/plan/restore/accounting.ts:resolveRestorePower` into a single
 *    `{ kw, source }` pair, computed at the producer seam before the
 *    restore-admission logic runs.
 *
 * The behaviour-preservation guarantees live in the integration suite via
 * `planRestoreBackoff` / `planRestoreSwap` and the dedicated cascade parity
 * test in `restoreAccountingParity.test.ts`; this file pins the producer's
 * internal decision tree directly so future chunks can refactor the helper
 * safely. The load-bearing asymmetry pinned here:
 *
 *   - stepped + observed-on with positive `planningPowerKw` → `'planning'`.
 *   - stepped + observed-off (or no positive planning kW) with non-zero
 *     restore step → `'stepped'`, value driven by the lowest-active step.
 *   - stepped + no usable step / no positive planning kW → falls through to
 *     the wiring layer's `getRestoreDrawKw` fallback (`source` ∈ `{measured,
 *     expected, planning, configured, fallback}`).
 *   - non-stepped → falls through to the wiring layer's `getRestoreDrawKw`
 *     fallback directly.
 */
import { describe, expect, it } from 'vitest';
import { resolveResidualKwRestore } from '../../lib/device/deviceResidualKw';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const steppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const allZeroProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'standby', planningPowerW: 0 },
  ],
};

const fallback = (kw: number, source: 'measured' | 'expected' | 'planning' | 'configured' | 'fallback' = 'fallback') => ({
  kw,
  source,
});

describe('resolveResidualKwRestore — non-stepped device', () => {
  it('returns the wiring layer\'s restoreFallback unchanged', () => {
    const result = resolveResidualKwRestore({ restoreFallback: fallback(1.4, 'measured') });
    expect(result).toEqual({ kw: 1.4, source: 'measured' });
  });

  it('preserves the EV / generic fallback for a device with no observed draw', () => {
    const result = resolveResidualKwRestore({ restoreFallback: fallback(1.38, 'fallback') });
    expect(result).toEqual({ kw: 1.38, source: 'fallback' });
  });
});

describe('resolveResidualKwRestore — stepped device, observed-on with planning kW', () => {
  it('uses the live planningPowerKw with source=planning', () => {
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: steppedProfile,
        currentStateIsOff: false,
        planningPowerKw: 2.5,
      },
      restoreFallback: fallback(99, 'measured'),
    });
    expect(result).toEqual({ kw: 2.5, source: 'planning' });
  });

  it('falls back to the stepped restore step when planningPowerKw is 0', () => {
    // Mirrors the legacy guard `planningPowerKw > 0`: a stepped device that
    // is observed-on but has no positive planning kW resolves through the
    // lowest-active step instead.
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: steppedProfile,
        currentStateIsOff: false,
        planningPowerKw: 0,
      },
      restoreFallback: fallback(99, 'measured'),
    });
    expect(result).toEqual({ kw: 1.25, source: 'stepped' });
  });
});

describe('resolveResidualKwRestore — stepped device, observed-off', () => {
  it('uses the lowest active step with source=stepped', () => {
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: steppedProfile,
        currentStateIsOff: true,
        planningPowerKw: 2.5,
      },
      restoreFallback: fallback(99, 'measured'),
    });
    expect(result).toEqual({ kw: 1.25, source: 'stepped' });
  });

  it('ignores planningPowerKw entirely when observed-off (path-2 dominates over path-1)', () => {
    // The legacy `dev.currentState !== 'off'` guard means an off device must
    // not pick up the live planning kW from a mid-cycle observation.
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: steppedProfile,
        currentStateIsOff: true,
        planningPowerKw: 2.999,
      },
      restoreFallback: fallback(99, 'measured'),
    });
    expect(result.source).toBe('stepped');
    expect(result.kw).toBeCloseTo(1.25, 6);
  });
});

describe('resolveResidualKwRestore — stepped device with no usable step', () => {
  it('falls through to restoreFallback when every step has planningPowerW=0', () => {
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: allZeroProfile,
        currentStateIsOff: true,
      },
      restoreFallback: fallback(1, 'fallback'),
    });
    expect(result).toEqual({ kw: 1, source: 'fallback' });
  });

  it('falls through to restoreFallback when stepped+observed-off and planningPowerKw is missing AND restore step is zero', () => {
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: allZeroProfile,
        currentStateIsOff: false,
        planningPowerKw: 0,
      },
      restoreFallback: fallback(1.38, 'fallback'),
    });
    expect(result).toEqual({ kw: 1.38, source: 'fallback' });
  });
});

describe('resolveResidualKwRestore — selectedStepId absent (Homey transient miss)', () => {
  it('still returns a deterministic stepped restore step from the profile shape alone', () => {
    // selectedStepId is not an input to the restore residual (unlike shed),
    // so a transient SDK miss does not change the answer: stepped+off uses
    // the lowest-active step from the profile regardless.
    const result = resolveResidualKwRestore({
      steppedLoad: {
        profile: steppedProfile,
        currentStateIsOff: true,
      },
      restoreFallback: fallback(99, 'measured'),
    });
    expect(result).toEqual({ kw: 1.25, source: 'stepped' });
  });
});
