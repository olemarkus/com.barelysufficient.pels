# lib/price — Price Inputs

Supplies the price signal that planning layers on top of capacity control: fetches Norwegian spot
prices and grid tariffs (NVE), integrates Homey Energy, flow-fed and Power by the Hour prices,
combines them into hourly totals, and classifies hours into price levels. A pure input producer —
no shed decisions.

**A price source publishes periods; this module hands out hours, and the level asks for now.** A
period is an hour on the Norwegian spot feed and on owner-fed Flow prices, and a quarter-hour on a
Homey Energy zone that has moved to the 15-minute market or on Power by the Hour's `dap15` driver
(`FlowPricePeriod.durationMinutes`, stored with every period). Two series come out of that, and which one a consumer gets is decided here:

- `getCombinedHourlyPrices()` — whole hours, for everything that reasons in hours: the capacity
  tariff is an hourly peak, the daily budget fills hourly buckets, a smart task claims hours, the
  owner's lowest-price Flow cards count hours. `hourlyPriceProjection.ts` projects the payload
  schemes' periods, duration-weighted so an unevenly covered hour stays honest. The Norwegian
  series is hourly at the source and carries the whole cost stack the money surfaces read, so it is
  served as built rather than round-tripped through a projection that keeps only the price.
- `getCombinedPricePeriods()` — the periods as published, for the one question whose answer is not
  hour-shaped: what the price is **now**. The price level reads it, and the temperature shift, the
  `price_level` trigger and the insights capability follow the level.

The two are separate TYPES, not just separate methods: `CombinedHourlyPrice` carries
`durationMinutes?: never`, so a period series cannot be passed where hours are expected. Without
that, handing 96 quarters to something counting hours compiles clean and miscounts in silence.

No consumer outside this module may assume how long a period lasts, and none should have to ask.
The level follows every period with no damping (owner ruling 2026-09-16): a quarter can sit a fifth
of the whole day's range away from its own hour's average, and a cheap quarter nobody acts on is a
cheap quarter that did not happen. The cost is up to four setpoint writes an hour per price-aware
device, which is accepted.

**A stored price payload keeps its promise to older builds.** `pricesBySlot` has meant one entry
per local hour in every version that ever wrote it, so it still does; sub-hourly periods go in
`pricesByPeriod`, which an older build ignores. Reusing `pricesBySlot` for quarters would have left
a downgraded install reading each hour at its `:00` quarter — a hit on every lookup, so no absence,
no fallback, no log. A persisted field's meaning is fixed at the version that first wrote it.

## Map

- `priceCoordinator.ts` — orchestrates refresh/rotation of the combined-prices store and notifies consumers.
- `powerhourPriceFetch.ts` / `powerhourScheme.ts` — the Power by the Hour source: the app-to-app
  adapter and its classification, then the device choice, the day-payload mirror and the owner-facing
  status. **That app publishes only FUTURE slots**, so today's stored day is merged into rather than
  replaced, and a change of price device drops the days built from the previous one.
- `priceService.ts` — fetching + caching: spot prices, grid tariff (with static fallback), flow/Homey price slots.
- `priceOptimizer.ts` — price-level classification (cheap/normal/expensive), re-applied at each price-period boundary.
- `priceLevelUtils.ts` — what the price is right now: the period in force, the level, the owner-facing line.
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
  (spot/flow/Homey Energy/Power by the Hour) produced them.
- **The Power by the Hour source is the one place a cache READ is load-bearing.** It merges into the
  day it already holds, so two things that are free for every other source are not free here.
  **Rotate before merging** — the merge base has to be the day as the local calendar has it, and
  only `rotateFlowPriceSlots` moves a `tomorrow` payload that has become today into the today slot;
  merging against the raw pair after a midnight rollover writes the app's future-only answer as the
  whole day. And **a read that did not come back is not an empty day** — `readPowerhourCache` tells
  the two apart with `getKeys()`, and an unreadable day is left exactly as it is
  (`PowerhourCachedDay`). Both were live data-loss bugs during review; neither has a symptom before
  the hours are already gone.
- The `price_scheme` union and its read policy live once, outside this module: the union in
  `packages/contracts/src/settingsUiApi.ts`, the policy in
  `packages/shared-domain/src/settings/priceScheme.ts`. Both the runtime and the settings UI read
  those bytes, and they used to parse them separately (`notes/settings-key-ownership.md`).

## Not in this module

- Device control or budget decisions — price awareness is applied in `lib/plan` and `lib/dailyBudget`.
- Settings-UI price rendering (lives in `packages/shared-domain` / `packages/settings-ui`).
