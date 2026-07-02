/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest';
import {
  planningPriceDivergesFromImport,
  resolvePlanningPrice,
} from '../../packages/shared-domain/src/price/planningPrice';

describe('resolvePlanningPrice', () => {
  test('returns the finite budgetPrice, else the import total (byte-identical fallback)', () => {
    expect(resolvePlanningPrice(20, 100)).toBe(20);
    expect(resolvePlanningPrice(undefined, 100)).toBe(100);
    expect(resolvePlanningPrice(Number.NaN, 100)).toBe(100);
    expect(resolvePlanningPrice(Number.POSITIVE_INFINITY, 100)).toBe(100);
    // A <= 0 planning price is legal and not clamped.
    expect(resolvePlanningPrice(-3, 100)).toBe(-3);
  });
});

describe('planningPriceDivergesFromImport — display resolution', () => {
  const ORE = 100; // øre→kr divisor: threshold = 0.005 * 100 = 0.5 raw øre.

  test('no divergence when budgetPrice is absent, junk, or exactly equal', () => {
    expect(planningPriceDivergesFromImport(undefined, 100, ORE)).toBe(false);
    expect(planningPriceDivergesFromImport(Number.NaN, 100, ORE)).toBe(false);
    expect(planningPriceDivergesFromImport(100, 100, ORE)).toBe(false);
  });

  test('no divergence when the import total is non-finite (boundary gate)', () => {
    expect(planningPriceDivergesFromImport(20, Number.NaN, ORE)).toBe(false);
    expect(planningPriceDivergesFromImport(20, Number.POSITIVE_INFINITY, ORE)).toBe(false);
  });

  test('a sub-half-cent raw difference does NOT diverge (rounds to the same display)', () => {
    // 0.4 øre < 0.5 øre threshold → renders identically after ÷100 → no note.
    expect(planningPriceDivergesFromImport(100.4, 100, ORE)).toBe(false);
    expect(planningPriceDivergesFromImport(99.6, 100, ORE)).toBe(false);
  });

  test('a visible difference diverges', () => {
    // 21 øre difference (0.21 kr displayed) is plainly visible.
    expect(planningPriceDivergesFromImport(79, 100, ORE)).toBe(true);
  });

  test('threshold scales with the divisor (flow/homey ÷1)', () => {
    // divisor 1: threshold 0.005. A 0.004 raw diff is invisible; 0.02 diverges.
    expect(planningPriceDivergesFromImport(1.004, 1, 1)).toBe(false);
    expect(planningPriceDivergesFromImport(1.02, 1, 1)).toBe(true);
  });
});
