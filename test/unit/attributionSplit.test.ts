import { resolveAttributionSplit } from '../../packages/shared-domain/src/dailyBudget/attributionSplit';

describe('resolveAttributionSplit', () => {
  it('uses both gross buckets directly — managed+background may exceed the net total under solar', () => {
    // net total 5 kWh, but the device meters (gross) show 4 managed + 4 background = 8 kWh;
    // ~3 kWh was self-consumed solar. The split must NOT clamp managed down to the net 5.
    expect(resolveAttributionSplit({ totalNet: 5, controlledGross: 4, uncontrolledGross: 4 }))
      .toEqual({ controlled: 4, uncontrolled: 4 });
  });

  it('moves exempt load from controlled to the background (uncontrolled) side', () => {
    expect(resolveAttributionSplit({ totalNet: 5, controlledGross: 4, uncontrolledGross: 3, exemptGross: 1.5 }))
      .toEqual({ controlled: 2.5, uncontrolled: 4.5 });
  });

  it('treats a non-finite total as zero (no NaN propagation)', () => {
    expect(resolveAttributionSplit({ totalNet: Number.NaN, controlledGross: 2, uncontrolledGross: 1 }))
      .toEqual({ controlled: 2, uncontrolled: 1 });
  });

  it('uses the gross uncontrolled bucket and derives controlled from the net total when controlled is absent', () => {
    expect(resolveAttributionSplit({ totalNet: 4, uncontrolledGross: 1 }))
      .toEqual({ controlled: 3, uncontrolled: 1 });
  });

  it('falls back to the net-clamped derivation for legacy state with only a controlled bucket', () => {
    // No gross uncontrolled bucket -> derive from net total (controlled clamped to total).
    expect(resolveAttributionSplit({ totalNet: 3, controlledGross: 5 }))
      .toEqual({ controlled: 3, uncontrolled: 0 });
    expect(resolveAttributionSplit({ totalNet: 4, controlledGross: 3, exemptGross: 1 }))
      .toEqual({ controlled: 2, uncontrolled: 2 });
  });

  it('returns nulls when neither bucket is present', () => {
    expect(resolveAttributionSplit({ totalNet: 5 }))
      .toEqual({ controlled: null, uncontrolled: null });
  });

  it('floors a negative net total to zero and never returns negatives', () => {
    // Heavy export: net total reported negative. Gross background is still real.
    expect(resolveAttributionSplit({ totalNet: -2, uncontrolledGross: 1, controlledGross: 2 }))
      .toEqual({ controlled: 2, uncontrolled: 1 });
  });
});
