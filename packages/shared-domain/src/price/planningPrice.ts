// Planning price (`budgetPrice ?? total`) — the browser-safe resolution rule
// shared by every DISPLAY surface that must follow what the schedulers plan
// against (the smart-task timeline, the Budget hourly price curve, the
// plan_budget widget). It mirrors the runtime `resolvePlanningPrice` in
// `lib/price/budgetPrice.ts`, but lives here because the settings UI and the
// widgets must not import runtime backend code (architecture boundary). The
// two copies are kept intentionally in sync; consolidation across the boundary
// is not allowed (see AGENTS.md → "Accept code duplication if consolidation
// would violate an architectural boundary").
//
// Money/receipt figures MUST NOT use this — those stay on the import `total`
// so a receipt reconciles to the bill (see `notes/ui-terminology.md`
// § "Solar and export price vocabulary").

/**
 * The planning price for one hour: the finite `budgetPrice` (the derived
 * export/import blend the producer wrote for a prosumer) when present, else the
 * import `total`. An absent OR non-finite `budgetPrice` (no export configured,
 * or a junk persisted value) falls back to `total`, so a non-prosumer is
 * byte-identical to planning on `total`. Never clamped — a `<= 0` planning
 * price is legal (self-consuming surplus can be cheaper than free).
 */
export const resolvePlanningPrice = (
  budgetPrice: number | undefined,
  totalPrice: number,
): number => (
  typeof budgetPrice === 'number' && Number.isFinite(budgetPrice) ? budgetPrice : totalPrice
);

/**
 * True when a prosumer's planning price for this hour diverges from the import
 * price by a VISIBLE amount — `budgetPrice` is present, finite, and differs from
 * `total` by more than half a displayed cent once scaled through the price
 * `divisor` (øre→kr ÷100; flow/homey ÷1). Prices render at two decimals, so a
 * difference below this rounds to the same displayed string; gating on the raw
 * value would let a thin-surplus hour flip the "using your solar" note (and the
 * chart overlay) on with no visible price change. The threshold matches the
 * sub-half-cent snap in `formatScaledPriceValue`, so the note never appears
 * without a change the user can actually see. A non-prosumer (no/junk
 * `budgetPrice`) or an exact-equal planning price is well under the threshold,
 * so it sees nothing new (byte-identical).
 */
// Half of the last displayed decimal (prices render at 2 dp, so a displayed
// "cent" is 0.01 in display units); a raw difference under `0.005 * divisor`
// rounds to the same 2-decimal string.
const DISPLAY_HALF_CENT = 0.005;
export const planningPriceDivergesFromImport = (
  budgetPrice: number | undefined,
  totalPrice: number,
  divisor: number,
): boolean => {
  // Gate BOTH prices finite before the threshold compare: a non-finite import
  // total (junk persisted value) would otherwise make `Math.abs(… − NaN)` NaN,
  // and `NaN > threshold` is false only by luck of IEEE semantics — express the
  // boundary explicitly. `Number.isFinite` is the global (no `lib/**` import;
  // shared-domain must stay browser-safe).
  if (typeof budgetPrice !== 'number' || !Number.isFinite(budgetPrice)) return false;
  if (!Number.isFinite(totalPrice)) return false;
  const rawThreshold = DISPLAY_HALF_CENT * Math.max(1, divisor);
  return Math.abs(budgetPrice - totalPrice) > rawThreshold;
};

// Reason line attached to a planning-price figure that diverges from the import
// price, and the "Export price" row/label. Registered in
// `notes/ui-terminology.md` § "Solar and export price vocabulary" — keep these
// strings in lockstep with that note.
export const PLANNING_PRICE_REASON_LINE = 'using your solar';
export const EXPORT_PRICE_LABEL = 'Export price';
