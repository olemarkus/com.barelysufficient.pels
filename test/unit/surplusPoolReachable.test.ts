// Can this home's solar-surplus pool ever open? The predicate that decides
// whether a device may carry the standing `surplusOnly` posture at all — and
// therefore whether a wrong answer leaves a dump load held OFF forever.
//
// Both disjuncts are load-bearing, and the table below is the argument for
// keeping them: neither alone admits every home that genuinely has surplus.
import { describe, expect, it } from 'vitest';
import { resolveSurplusPoolReachable } from '../../packages/shared-domain/src/solar/surplusPoolReachable';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';

const trackerWithExport = (kWh: number): PowerTrackerState => ({
  exportDailyTotals: { '2026-08-05': kWh },
} as PowerTrackerState);

describe('resolveSurplusPoolReachable', () => {
  it('is false with neither export history nor a contributing estimator', () => {
    // The flow home whose Flow predates signed watts: solar on the roof, net
    // never negative, estimator dormant. Nothing can ever open the pool.
    expect(resolveSurplusPoolReachable({
      tracker: trackerWithExport(0),
      curtailmentCanContribute: false,
    })).toBe(false);
  });

  it('is true on recorded export alone, with no estimator contribution', () => {
    expect(resolveSurplusPoolReachable({
      tracker: trackerWithExport(4),
      curtailmentCanContribute: false,
    })).toBe(true);
  });

  it('is true on a contributing estimator alone — the zero-export home', () => {
    // A zero-export inverter throttles so net pins ~0 and measured export never
    // appears. Gating on export alone would hold this home's dump load off
    // forever, which is the exact population the estimator exists to serve.
    expect(resolveSurplusPoolReachable({
      tracker: trackerWithExport(0),
      curtailmentCanContribute: true,
    })).toBe(true);
  });

  it('is true on ANY recorded export, well below the export-price materiality floor', () => {
    // The bar is "can the feed express export at all", which one negative sample
    // settles. Using the 1 kWh floor here would blank the posture for the first
    // ~20 minutes of a home's first sunny afternoon — exactly when the owner is
    // watching to see whether the toggle they just flipped does anything.
    expect(resolveSurplusPoolReachable({
      tracker: trackerWithExport(0.02),
      curtailmentCanContribute: false,
    })).toBe(true);
  });

  it('is false on an absent tracker rather than throwing', () => {
    // Absence resolves to the SAFE answer: an unstamped device runs, a wrongly
    // stamped one is trapped.
    expect(resolveSurplusPoolReachable({
      tracker: null,
      curtailmentCanContribute: false,
    })).toBe(false);
  });
});
