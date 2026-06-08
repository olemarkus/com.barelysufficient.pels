// One epoch-hour-floored price-curve entry sourced from the price layer
// (`combined_prices` / `CombinedPricesV2`). The deferred-objective allocation
// horizon's price + grid signal is built from an ascending, deduped array of
// these. Lives in @pels/planner-types — a flat, dependency-free contract — so
// the leafward `lib/objectives` subsystem can consume the price horizon without
// importing the `lib/price` peer (the producer in `lib/price` builds it).
export type PriceHorizonEntry = {
  startMs: number;
  price: number;
};
