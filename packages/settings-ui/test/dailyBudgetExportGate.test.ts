import { describe, expect, it } from 'vitest';
import { gateExportPriceRows } from '../src/ui/dailyBudget.ts';
import type { CombinedPriceRow } from '../src/ui/combinedPrices.ts';

// The Budget hourly-chart planning-price overlay and the "Export price now"
// subline are fed from `combined_prices`, which keeps carrying budgetPrice /
// exportPrice for up to an hour after a user disables export pricing. The gate
// must follow the live setting, not the stale rows.
describe('gateExportPriceRows — Budget overlay export gate', () => {
  const rows: CombinedPriceRow[] = [
    { startsAt: '2026-07-02T03:00:00Z', total: 100, budgetPrice: 10, exportPrice: -5 },
    { startsAt: '2026-07-02T04:00:00Z', total: 90, budgetPrice: 90 },
  ];

  it('passes rows through reference-identical when export pricing is enabled', () => {
    expect(gateExportPriceRows(rows, true)).toBe(rows);
  });

  it('drops budgetPrice and exportPrice from every row when export pricing is off', () => {
    const gated = gateExportPriceRows(rows, false);
    expect(gated).toHaveLength(2);
    for (const row of gated) {
      expect(row.budgetPrice).toBeUndefined();
      expect(row.exportPrice).toBeUndefined();
    }
    // The import price the money surfaces read is preserved untouched.
    expect(gated[0].total).toBe(100);
    expect(gated[1].total).toBe(90);
  });
});
