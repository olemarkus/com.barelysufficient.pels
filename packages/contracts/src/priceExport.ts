/**
 * Shared price-export contract. The `price_list_updated` trigger card's
 * `prices_json` local token serializes this shape.
 *
 * `today` / `tomorrow` are PELS' adjusted hourly totals (the all-in
 * price you see inside the app — post grid tariff, surcharge, tax,
 * VAT, electricity support, and Norgespris adjustment, depending on
 * configuration), in the configured unit, indexed by local hour.
 *
 * Array length doubles as a DST signal (23 / 24 / 25 entries). When a
 * source publishes data sparsely (allowed for the Flow and Homey
 * schemes), the missing hour slots are `null` so later prices do not
 * shift left and per-hour lookups stay correct.
 *
 * `tomorrow` is `[]` when day-ahead prices have not been published.
 */
export type PriceExportV1 = {
  today: (number | null)[];
  tomorrow: (number | null)[];
  unit: string;
};
