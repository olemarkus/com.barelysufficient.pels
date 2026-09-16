# lib/price — Price Inputs

Supplies the price signal that planning layers on top of capacity control: fetches Norwegian spot
prices and grid tariffs (NVE), integrates Homey Energy and flow-fed prices, combines them into
hourly totals, and classifies hours into price levels. A pure input producer — no shed decisions.

**A price source publishes periods; this module hands out hours.** A period is an hour on the
Norwegian spot feed and on owner-fed Flow prices, and a quarter-hour on a Homey Energy zone that has
moved to the 15-minute market (`FlowPricePeriod.durationMinutes`, stored with every period). The
hour is what the rest of PELS reasons in — the capacity tariff is an hourly peak, the daily budget
fills hourly buckets, a smart task claims hours, the owner's lowest-price Flow cards count hours —
so `getCombinedHourlyPrices()` projects periods onto hours here, in the producer
(`hourlyPriceProjection.ts`, duration-weighted so an unevenly covered hour stays honest). No
consumer outside this module may assume how long a period lasts, and none should have to ask.

**A stored price payload keeps its promise to older builds.** `pricesBySlot` has meant one entry
per local hour in every version that ever wrote it, so it still does; sub-hourly periods go in
`pricesByPeriod`, which an older build ignores. Reusing `pricesBySlot` for quarters would have left
a downgraded install reading each hour at its `:00` quarter — a hit on every lookup, so no absence,
no fallback, no log. A persisted field's meaning is fixed at the version that first wrote it.

## Map

- `priceCoordinator.ts` — orchestrates refresh/rotation of the combined-prices store and notifies consumers.
- `priceService.ts` — fetching + caching: spot prices, grid tariff (with static fallback), flow/Homey price slots.
- `priceOptimizer.ts` — price-level classification (cheap/normal/expensive) over combined hourly prices.
- `hourlyPriceProjection.ts` — the period → hour projection every hour-shaped consumer is served through.
- `combinedPricesReader.ts` / `priceStore.ts` — typed read boundary for the persisted combined-prices store + its pure derivations.
- `priceDataStore.ts` / `priceOptimizationSettingsStore.ts` — typed producer-side persistence boundaries.
- `nettleieFallbackData.generated.ts` — **generated** (`npm run build:nettleie-fallback`); never edit by hand.

## Invariants

- Leaf module (`no-price-to-peer` in `.dependency-cruiser.cjs`): consumed by plan and dailyBudget;
  must not import `lib/{device,power,plan,dailyBudget,objectives,observer,executor}`.
- All cached price-data persistence goes through the typed stores (`priceDataStore.ts`, the
  combined-prices store) — no ad-hoc `settings.set` of price payloads. The
  `combinedPricesReader.ts` docblock is the house-style reference for these store boundaries:
  the module declares the typed interface AND owns the SDK read and migrations, reading through a
  `SettingsPort` that `setup/` hands it.
- Consumers receive resolved flat values (prices, levels); they never branch on which source
  (spot/flow/Homey Energy) produced them.

## Not in this module

- Device control or budget decisions — price awareness is applied in `lib/plan` and `lib/dailyBudget`.
- Settings-UI price rendering (lives in `packages/shared-domain` / `packages/settings-ui`).
