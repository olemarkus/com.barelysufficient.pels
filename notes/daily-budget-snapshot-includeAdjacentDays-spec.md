# Daily-Budget Snapshot — `includeAdjacentDays` Spec

## Problem

The runtime cache returned by `DailyBudgetService.getSnapshot()` loses
`tomorrowKey` (and `yesterdayKey`) shortly after it has been populated.

Concretely: any caller that just wants "the current daily-budget UI payload"
gets a snapshot whose `days` map only contains today, even when tomorrow's
spot prices and a tomorrow preview are available. This breaks anything that
needs to reason past local midnight — most importantly the deferred-objective
policy horizon.

### Observed symptom (latest run logs, branch `feat-deadline-active-plan-persistence`)

- 80 consecutive `deferred_objective_unknown` events for the temperature
  objective on "Connected 300", reason `objective_missing_price_horizon`,
  `horizonBucketCount: 0`, deadline `08:00` (rolls to next day).
- The new "active deadline plan" surface reports it is waiting for tomorrow's
  prices even though `combined_prices` already contains tomorrow.
- The four `Daily budget: plan debug` lines emitted at startup show 24 valid
  hourly prices for both `today` and `tomorrow`, so the source data is fine —
  the data is being dropped on the way to the consumer.

## Root cause

In `lib/dailyBudget/dailyBudgetService.ts`:

- `setDaySnapshot(snapshot, nowMs, includeAdjacentDays = false)` (l.500)
  rebuilds `this.snapshot` from scratch on every call. When
  `includeAdjacentDays` is `false`, it writes:

  ```ts
  this.snapshot = {
    days: { [todayKey]: snapshot },
    todayKey,
    tomorrowKey: null,
    yesterdayKey: null,
  };
  ```

  i.e. it actively *erases* whatever tomorrow/yesterday data was previously
  cached.

- `updateState(params)` (l.200) defaults `includeAdjacentDays` to `false` and
  then calls `setDaySnapshot(update.snapshot, nowMs, includeAdjacentDays)`
  (l.238).

- The two callers that *do* opt in are `getUiPayload` (l.413) and
  `recomputeTodayPlan` (l.426). Everything else clobbers the snapshot:

  | Call site | `includeAdjacentDays` |
  |---|---|
  | `appPowerSampleIngest.updateDailyBudgetAndRecordCapForApp` (l.139) | not passed |
  | `appLifecycleHelpers.ts:139` (startup wiring) | not passed |
  | `dailyBudgetService.getPeriodicStatusFields` (l.368) | not passed |
  | `dailyBudgetService.getUiPayload` (l.413) | **true** |
  | `dailyBudgetService.recomputeTodayPlan` (l.426) | **true** |

- Power samples drive the first row roughly every ten seconds in
  `homey_energy` mode (faster on flow-sourced power). So even if the user
  opens the settings UI and `getUiPayload` populates today+tomorrow, the very
  next power sample resets the cache to today-only.

- `DailyBudgetUpdateStateOptions` in
  `lib/dailyBudget/dailyBudgetTypes.ts:124` does not even expose
  `includeAdjacentDays`, so the power-sample call site cannot opt in today.

The runtime plan builder consumes the cached snapshot via
`PlanBuilder.dailyBudgetSnapshot` (`lib/plan/planBuilder.ts:106`) →
`appInit.ts:81` → `dailyBudgetService.getSnapshot()`. When tomorrow is missing
from `days`, the deferred-objective policy horizon (`coversHorizon` in
`lib/plan/deferredObjectives/policyHorizon.ts:130`) cannot reach a
next-day deadline and bails out with `objective_missing_price_horizon`.

## Goals for the fix

1. Whenever the daily-budget service has reason to believe tomorrow data is
   available (i.e. `combined_prices` or its equivalent has entries past local
   midnight), `getSnapshot()` should return a snapshot whose `days` map
   includes that tomorrow payload, with `tomorrowKey` set accordingly.
2. The cache must not regress: a write triggered by a power sample, periodic
   status, or any other "cheap" update path must not erase tomorrow/yesterday
   data that a previous expensive update already produced.
3. The fix should be cheap on the hot path. Power samples arrive every ~10s;
   recomputing the tomorrow preview on every sample would be wasteful.

## Non-goals

- Reworking how `combined_prices` itself is fetched or stored. The price
  service is fine; only the snapshot caching is at fault.
- Changing the public shape of `DailyBudgetUiPayload`. Callers that already
  read `tomorrowKey`/`yesterdayKey` should continue to work unchanged.
- Touching `dailyBudgetPreview` / `previewModelSettings` semantics — those
  paths already build their own self-contained payloads.

## Resolution

Implemented by adding lazy adjacent-day re-seeding to the hot path in
`DailyBudgetService.setDaySnapshot`. After `composeHotPathDailyBudgetSnapshot`
runs, when the cached `tomorrowKey` is missing the service computes a price
signature from the current `combined_prices` (`lastFetched` + entry count +
first and last `startsAt` + today's date key) and runs the full
`rebuildSnapshotWithAdjacentDays` only when the signature differs from the
last attempt. So:

- Fresh start: signature changes from the initial `null` → seed runs once.
- Steady state with unchanged prices: signature matches → no extra cost on
  power samples.
- User reloads prices (or Nordpool publishes tomorrow): `lastFetched` and the
  entry count change → next hot-path tick re-seeds tomorrow.
- Date rollover: `todayKey` is part of the signature → re-seed runs once on
  rollover.

The original suggested approaches are kept below for historical reference.

## Suggested approaches (historical, not prescriptive)

Two reasonable shapes — pick one that fits the call-site reality:

**A. Make adjacent-day caching the default and refresh lazily.**

- Default `includeAdjacentDays` to `true` in `setDaySnapshot`.
- Cache `tomorrowSnapshot` / `yesterdaySnapshot` by date key on the service so
  that hot-path `updateState` calls can reuse them without recomputing.
- Invalidate the cached tomorrow when `combined_prices` changes, when the
  date key for "tomorrow" rolls forward, or after a TTL. Keep the existing
  expensive recompute on `getUiPayload` / `recomputeTodayPlan`.
- Expose `includeAdjacentDays` on `DailyBudgetUpdateStateOptions` only if a
  caller explicitly wants to *skip* the cheap reuse (probably no-one does).

**B. Stop rebuilding `this.snapshot` from scratch on hot-path updates.**

- On hot-path `updateState` calls, only replace `this.snapshot.days[todayKey]`
  and `this.snapshot.todayKey`. Leave existing `tomorrowKey` / `yesterdayKey`
  entries alone unless the date keys themselves have rolled over (in which
  case stale entries should be evicted, not silently retained).
- Keep `getUiPayload` / `recomputeTodayPlan` as the only paths that
  *recompute* tomorrow/yesterday previews.

Either way: the contract should be "if the service has ever seen tomorrow,
`getSnapshot()` keeps returning it until the date rolls over or the
underlying data goes away."

## Acceptance checks

- After a fresh start with `combined_prices` populated for today and
  tomorrow, every `getSnapshot()` call (including those triggered between
  power samples) returns a payload with both `todayKey` and a non-null
  `tomorrowKey`, and `days` containing both day payloads.
- `policyHorizon.coversHorizon` succeeds for a `temperature` objective with
  `deadlineLocalTime` rolling into the next day, given the same fixture.
- Unit coverage in `test/lib/dailyBudget/` exercises the snapshot survival
  across a sequence of `updateState({ ...power-sample options })` calls
  interleaved with the date rollover at local midnight (and a DST boundary if
  cheap to add) — no manual `getUiPayload` between samples.
- `npm run ci:checks` and `npm run test:unit` green; no new ESLint or
  dependency-cruiser warnings.

## References

- `lib/dailyBudget/dailyBudgetService.ts` — `updateState`, `setDaySnapshot`,
  `getSnapshot`, `getUiPayload`, `recomputeTodayPlan`.
- `lib/dailyBudget/dailyBudgetTypes.ts` — `DailyBudgetUpdateStateOptions`,
  `DailyBudgetUiPayload`.
- `lib/app/appPowerSampleIngest.ts` — hot-path consumer.
- `lib/app/appInit.ts:81` — `getDailyBudgetSnapshot` wiring.
- `lib/plan/planBuilder.ts:106` — runtime read site.
- `lib/plan/deferredObjectives/policyHorizon.ts` — first observable failure
  mode (`objective_missing_price_horizon`).
- Latest reproduction log:
  `/tmp/pels/start.feat-deadline-active-plan-persistence.stdout.log` (80×
  `deferred_objective_unknown` for Connected 300).
