// Can this home's solar-surplus pool ever open? The predicate that decides
// whether a device may carry the standing `surplusOnly` posture at all — and
// therefore whether a wrong answer leaves a dump load held OFF forever.
//
// Both disjuncts are load-bearing, and the table below is the argument for
// keeping them: neither alone admits every home that genuinely has surplus.
// What counts as "the feed has expressed export" is the latch's question
// (`test/unit/signedExportLatch.test.ts`).
import { describe, expect, it } from 'vitest';
import { resolveSurplusPoolReachable } from '../../lib/power/surplusPoolReachable';

describe('resolveSurplusPoolReachable', () => {
  it('is false with neither expressed export nor a contributing estimator', () => {
    // The flow home whose Flow predates signed watts: solar on the roof, net
    // never negative, estimator dormant. Nothing can ever open the pool.
    expect(resolveSurplusPoolReachable({
      feedExport: 'none',
      curtailmentCanContribute: false,
    })).toBe(false);
  });

  it('is true on expressed export alone, with no estimator contribution', () => {
    expect(resolveSurplusPoolReachable({
      feedExport: 'expressed',
      curtailmentCanContribute: false,
    })).toBe(true);
  });

  it('is true on a contributing estimator alone — the zero-export home', () => {
    // A zero-export inverter throttles so net pins ~0 and measured export never
    // appears. Gating on export alone would hold this home's dump load off
    // forever, which is the exact population the estimator exists to serve.
    expect(resolveSurplusPoolReachable({
      feedExport: 'none',
      curtailmentCanContribute: true,
    })).toBe(true);
  });

  it('fails closed on an unreadable export bit rather than reading it as "never exported"', () => {
    // After a history reset the stored bit may be the only evidence left. A
    // false would strip the posture and let the restore lane run the dump load
    // from the grid; a true only holds it off until the next read, which the
    // latch retries.
    expect(resolveSurplusPoolReachable({
      feedExport: 'unreadable',
      curtailmentCanContribute: false,
    })).toBe(true);
  });
});
