// Unit coverage for the adjacent-days re-seed signature
// (`computeAdjacentDaysSeedSignature`) — specifically the planning-price
// (`budgetPrice`) fingerprint suffix. The upgrade-safety contract: an entry
// without a budgetPrice, or whose budgetPrice equals the total, fingerprints
// EXACTLY as before (no one-time re-seed churn for existing users), while a
// diverging planning price changes the signature so a PV-forecast-driven
// planning-price change re-seeds tomorrow/yesterday allocations.
import { describe, expect, it } from 'vitest';
import { computeAdjacentDaysSeedSignature } from '../../lib/dailyBudget/dailyBudgetSnapshotState';
import type { CombinedPriceEntry } from '../../lib/dailyBudget/dailyBudgetPrices';

const TODAY_KEY = '2026-06-01';
const START_A = '2026-06-01T00:00:00.000Z';
const START_B = '2026-06-01T01:00:00.000Z';

const signature = (entries: CombinedPriceEntry[]): string => (
  computeAdjacentDaysSeedSignature(TODAY_KEY, { prices: entries })
);

describe('computeAdjacentDaysSeedSignature — planning-price suffix', () => {
  const baseEntries: CombinedPriceEntry[] = [
    { startsAt: START_A, total: 100, isCheap: true, isExpensive: false },
    { startsAt: START_B, total: 200, isCheap: false, isExpensive: false },
  ];

  it('pins the historical format when no entry carries a budgetPrice', () => {
    expect(signature(baseEntries)).toBe(
      `${TODAY_KEY}|2|${START_A}|${START_B}|C100;N200;`,
    );
  });

  it('is unchanged when budgetPrice equals total (no upgrade churn)', () => {
    const equal = baseEntries.map((entry) => ({ ...entry, budgetPrice: entry.total }));
    expect(signature(equal)).toBe(signature(baseEntries));
  });

  it('is unchanged when budgetPrice is present but non-finite (junk never re-seeds)', () => {
    const junk = [{ ...baseEntries[0], budgetPrice: Number.NaN }, baseEntries[1]];
    expect(signature(junk)).toBe(signature(baseEntries));
  });

  it('changes when a finite budgetPrice diverges from total', () => {
    const diverged = [{ ...baseEntries[0], budgetPrice: 12.5 }, baseEntries[1]];
    expect(signature(diverged)).toBe(
      `${TODAY_KEY}|2|${START_A}|${START_B}|C100:12.5;N200;`,
    );
    expect(signature(diverged)).not.toBe(signature(baseEntries));
  });

  it('changes again when the diverging budgetPrice moves (forecast update re-seeds)', () => {
    const first = [{ ...baseEntries[0], budgetPrice: 12.5 }, baseEntries[1]];
    const second = [{ ...baseEntries[0], budgetPrice: -3 }, baseEntries[1]];
    expect(signature(first)).not.toBe(signature(second));
  });
});
