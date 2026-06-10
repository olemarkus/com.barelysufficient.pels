# lib/dailyBudget — Daily kWh Soft Budget

Implements the soft daily kWh budget layered on top of the hourly capacity controller: it splits a
configured daily budget into per-hour allocations (price-shaped, learned from observed usage),
tracks actual consumption against the plan, and feeds the resulting hourly soft limits into the
planner (`lib/plan` consumes them via `planBudget.ts` / `planDailyBudgetWindow.ts`).

## Map

- `dailyBudgetService.ts` — entry point: settings, store wiring, and the public snapshot/preview surface.
- `dailyBudgetManager.ts` — core state machine: builds/rebuilds the day plan, computes budget state and deviation.
- `dailyBudgetMath.ts` / `dailyBudgetAllocation.ts` — pure plan math: weights, caps, redistribution.
- `dailyBudgetLearning.ts` / `dailyBudgetObservedStats.ts` — learned hourly profile from the observed-usage window.
- `dailyBudgetSettingsStore.ts` / `dailyBudgetStateStore.ts` — typed persistence boundaries (config vs state blob).

## Invariants

- Governing docs: `docs/daily-budget.md` (model + behaviour) and `docs/daily-budget-weights.md`
  (hour-weight derivation). Read both before changing allocation or learning logic.
- **DST: a local day is 23, 24, or 25 hours.** Bucket logic must use timezone-aware day boundaries
  (`buildLocalDayBuckets` / `getNextLocalDayStartUtcMs` from `lib/utils/dateUtils`), never `24 *
  ONE_HOUR`. DST-sensitive specs belong in the tz lane (`npm run test:unit:tz`).
- Layering (`no-dailyBudget-to-peer` in `.dependency-cruiser.cjs`): may consume `lib/power` and
  `lib/price`; must not import `lib/{plan,device,objectives,observer,executor}`.
- Persistence only via the typed stores; never delete persisted state on one failed/empty SDK read.

## Not in this module

- Choosing *which* devices to shed under budget pressure — that is `lib/plan/shedding`.
- Price fetching or level classification (`lib/price`); the budget only consumes the combined-prices reader.
