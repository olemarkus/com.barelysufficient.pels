// Browser-safe helpers for reasoning about the price-unit label the runtime
// exposes (`PriceService.getPriceUnitLabel()`). That label is a per-kWh RATE
// label whose exact form depends on the active scheme:
//   - Nordpool/Norway:  "øre/kWh"
//   - Homey Energy:      the SDK currency string (e.g. "NOK", "EUR", or a
//                        already-rate-shaped "kr/kWh")
//   - Flow / fallback:   "price units"
//
// A RATE label (money-per-kWh) is the right unit for a per-kWh price, but the
// WRONG unit for a *total* amount (Σ kWh × price). `priceRateLabelToAmountUnit`
// converts a rate label into the bare money/amount unit that pairs with a total
// cost, so a UI never renders a total as "42 øre/kWh".

// Matches a trailing per-energy suffix ("/kWh") with tolerant spacing and case,
// e.g. "øre/kWh", "kr / kWh", "EUR/KWH". Capturing group 1 is the money unit.
const PER_KWH_RATE_SUFFIX = /^(.*?)\s*\/\s*kwh\s*$/i;

/**
 * Derive the total-amount (money) unit from a price-RATE label.
 *
 * The runtime's `getPriceUnitLabel()` returns a per-kWh rate label; a total
 * cost (Σ bucket kWh × bucket price) must be labelled with the money unit only,
 * not the rate. This strips a trailing `/kWh` (whitespace/case tolerant) and
 * returns the remaining money unit (`"øre/kWh"` → `"øre"`, `"kr/kWh"` → `"kr"`).
 *
 * Labels that carry no `/kWh` suffix are already amount-shaped (a bare currency
 * like `"NOK"`, or the neutral `"price units"` fallback) and are returned
 * unchanged. Empty/whitespace-only results fall back to the trimmed input so a
 * malformed label like `"/kWh"` never yields an empty unit.
 */
export const priceRateLabelToAmountUnit = (rateLabel: string): string => {
  const match = PER_KWH_RATE_SUFFIX.exec(rateLabel);
  if (!match) return rateLabel.trim();
  const moneyUnit = match[1]!.trim();
  return moneyUnit.length > 0 ? moneyUnit : rateLabel.trim();
};
