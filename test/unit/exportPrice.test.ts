import { describe, expect, it } from 'vitest';
import {
  EXPORT_PRICE_DISABLED,
  resolveExportPriceInclVat,
} from '../../lib/price/exportPrice';

describe('resolveExportPriceInclVat', () => {
  it('returns undefined when disabled', () => {
    expect(resolveExportPriceInclVat({
      spotPriceExVat: 50,
      vatMultiplier: 1.25,
      config: EXPORT_PRICE_DISABLED,
    })).toBeUndefined();
  });

  it('fixed tariff (factor 0) ignores the spot entirely', () => {
    const price = resolveExportPriceInclVat({
      spotPriceExVat: 50,
      vatMultiplier: 1.25,
      config: { enabled: true, spotFactorPercent: 0, fixedInclVat: 8 },
    });
    expect(price).toBe(8);
  });

  it('fixed tariff works with no isolatable spot (flow/homey: spot undefined)', () => {
    const price = resolveExportPriceInclVat({
      config: { enabled: true, spotFactorPercent: 0, fixedInclVat: 12 },
    });
    expect(price).toBe(12);
  });

  it('spot-linked (NO plusskunde): VAT-grossed spot × factor + fixed', () => {
    // spotIncVat = 40 * 1.25 = 50; × 90% = 45; + 0
    const price = resolveExportPriceInclVat({
      spotPriceExVat: 40,
      vatMultiplier: 1.25,
      config: { enabled: true, spotFactorPercent: 90, fixedInclVat: 0 },
    });
    expect(price).toBeCloseTo(45, 6);
  });

  it('allows a negative result (terugleverkosten / pay-to-export)', () => {
    // factor 0, fixed = -15 (a per-kWh feed-in fee) ⇒ you pay to export
    const price = resolveExportPriceInclVat({
      config: { enabled: true, spotFactorPercent: 0, fixedInclVat: -15 },
    });
    expect(price).toBe(-15);

    // spot-linked during a negative-spot hour also goes negative
    const negSpot = resolveExportPriceInclVat({
      spotPriceExVat: -20,
      vatMultiplier: 1.25,
      config: { enabled: true, spotFactorPercent: 100, fixedInclVat: 0 },
    });
    expect(negSpot).toBeCloseTo(-25, 6);
  });

  it('returns undefined when spot-linked but the spot price is unavailable', () => {
    // factor != 0 needs a real spot; a missing/non-finite spot must not silently
    // collapse to the fixed component alone (it would emit a misleading price).
    expect(resolveExportPriceInclVat({
      config: { enabled: true, spotFactorPercent: 90, fixedInclVat: 5 },
    })).toBeUndefined();
    expect(resolveExportPriceInclVat({
      spotPriceExVat: Number.NaN,
      vatMultiplier: 1.25,
      config: { enabled: true, spotFactorPercent: 90, fixedInclVat: 5 },
    })).toBeUndefined();
  });

  it('returns undefined (not Infinity) when the result is non-finite', () => {
    // An absurd finite factor overflowing to Infinity must not be attached to the
    // in-memory entry (it would then be dropped by the finite-only persist guard,
    // desyncing the live and stored seams).
    const price = resolveExportPriceInclVat({
      spotPriceExVat: 1e308,
      vatMultiplier: 10,
      config: { enabled: true, spotFactorPercent: Number.MAX_VALUE, fixedInclVat: 0 },
    });
    expect(price).toBeUndefined();
  });

  it('falls back to safe numerics on non-finite config/inputs', () => {
    const price = resolveExportPriceInclVat({
      spotPriceExVat: Number.NaN,
      vatMultiplier: Number.NaN,
      config: { enabled: true, spotFactorPercent: Number.NaN, fixedInclVat: 7 },
    });
    // spot term collapses to 0 (factor→0, spot→0, vat→1); only the fixed term survives
    expect(price).toBe(7);
  });
});
