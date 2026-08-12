// Unit tests for the branded smart-task energy quantities and the single
// revision resolver they are constructed through.
//
// These types exist to make one specific class of bug a compile error: the
// quantities are all `number`, several were `number | null`, and `??` between
// any two of them typechecked — so a chain of such fallbacks silently swapped a
// remainder for a plan total. See `energyQuantities.ts`.
import {
  asDeliveredEnergyKWh,
  asPlannedFloorEnergyKWh,
  asRemainingEnergyKWh,
  resolveRemainingEnergyKWh,
  type PlannedFloorEnergyKWh,
  type RemainingEnergyKWh,
} from '../../packages/shared-domain/src/energyQuantities';

describe('energy quantity constructors', () => {
  it('rejects non-positive and non-finite comparison bases', () => {
    // A zero or NaN basis is never a usable denominator for "did the executor
    // deliver what this run needed?", so it is rejected rather than clamped.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '5']) {
      expect(asRemainingEnergyKWh(bad)).toBeNull();
      expect(asPlannedFloorEnergyKWh(bad)).toBeNull();
    }
    expect(asRemainingEnergyKWh(21.69)).toBe(21.69);
    expect(asPlannedFloorEnergyKWh(5)).toBe(5);
  });

  it('admits zero delivered energy, which is a real observation', () => {
    // Unlike a comparison basis, "delivered nothing" is meaningful — it is what
    // drives the `no_delivery` attribution.
    expect(asDeliveredEnergyKWh(0)).toBe(0);
    expect(asDeliveredEnergyKWh(11.84)).toBe(11.84);
    expect(asDeliveredEnergyKWh(-0.5)).toBeNull();
    expect(asDeliveredEnergyKWh(Number.NaN)).toBeNull();
  });
});

describe('resolveRemainingEnergyKWh', () => {
  it('resolves an absent energyExpectedKWh to energyNeededKWh, not to unknown', () => {
    // The contract persists `energyExpectedKWh` only when it DIFFERS from
    // `energyNeededKWh`, so absence encodes equality. That omission is a
    // byte-stability optimisation and is lossless — and it is the ORDINARY
    // shape, because `bufferedRate` collapses to the mean whenever the sample
    // count is below the buffer threshold or sigma is zero.
    expect(resolveRemainingEnergyKWh({ energyNeededKWh: 20 })).toBe(20);
    expect(resolveRemainingEnergyKWh({ energyNeededKWh: 24.14, energyExpectedKWh: 21.69 })).toBe(21.69);
  });

  it('answers null for a satisfied objective rather than a zero basis', () => {
    // `energyNeededKWh` is 0 once the target is met. Resolving that to a usable
    // basis would both divide against zero downstream AND — because
    // `hasValidMissAttributionFields` requires `energyExpectedKWh > 0` — get the
    // whole history entry dropped on the next load if it were ever persisted.
    expect(resolveRemainingEnergyKWh({ energyNeededKWh: 0 })).toBeNull();
    expect(resolveRemainingEnergyKWh(null)).toBeNull();
    expect(resolveRemainingEnergyKWh(undefined)).toBeNull();
  });
});

describe('energy quantity brands (compile-time)', () => {
  it('does not let one energy quantity stand in for another', () => {
    const remaining = asRemainingEnergyKWh(21.69);
    const floor = asPlannedFloorEnergyKWh(5);
    if (remaining === null || floor === null) throw new Error('fixture');

    const takesFloor = (value: PlannedFloorEnergyKWh): number => value;
    const takesRemaining = (value: RemainingEnergyKWh): number => value;

    // The exact swap that shipped the wrong postmortem: a remainder used where
    // a plan total was meant. Before the brands this compiled silently.
    // @ts-expect-error a remainder is not a planned floor
    takesFloor(remaining);
    // @ts-expect-error a planned floor is not a remainder
    takesRemaining(floor);

    // The right way round still compiles, and the brands erase at runtime so a
    // branded value serializes byte-identically into the released v4 schema.
    expect(takesFloor(floor)).toBe(5);
    expect(takesRemaining(remaining)).toBe(21.69);
    expect(JSON.stringify({ remaining })).toBe('{"remaining":21.69}');
  });
});
