# lib/price — Price Inputs

Supplies the price signal that planning layers on top of capacity control: fetches Norwegian spot
prices and grid tariffs (NVE), integrates Homey Energy and flow-fed prices, combines them into
hourly totals, and classifies hours into price levels. A pure input producer — no shed decisions.

## Map

- `priceCoordinator.ts` — orchestrates refresh/rotation of the combined-prices store and notifies consumers.
- `priceService.ts` — fetching + caching: spot prices, grid tariff (with static fallback), flow/Homey price slots.
- `priceOptimizer.ts` — price-level classification (cheap/normal/expensive) over combined hourly prices.
- `combinedPricesReader.ts` / `priceStore.ts` — typed read boundary for the persisted combined-prices store + its pure derivations.
- `priceDataStore.ts` / `priceOptimizationSettingsStore.ts` — typed producer-side persistence boundaries.
- `nettleieFallbackData.generated.ts` — **generated** (`npm run build:nettleie-fallback`); never edit by hand.

## Invariants

- Leaf module (`no-price-to-peer` in `.dependency-cruiser.cjs`): consumed by plan and dailyBudget;
  must not import `lib/{device,power,plan,dailyBudget,objectives,observer,executor}`.
- All cached price-data persistence goes through the typed stores (`priceDataStore.ts`, the
  combined-prices store) — no ad-hoc `settings.set` of price payloads. The
  `combinedPricesReader.ts` docblock is the house-style reference for these store boundaries:
  domain declares the typed interface, the `setup/` adapter owns the SDK read and migrations.
- Consumers receive resolved flat values (prices, levels); they never branch on which source
  (spot/flow/Homey Energy) produced them.

## Not in this module

- Device control or budget decisions — price awareness is applied in `lib/plan` and `lib/dailyBudget`.
- Settings-UI price rendering (lives in `packages/shared-domain` / `packages/settings-ui`).
