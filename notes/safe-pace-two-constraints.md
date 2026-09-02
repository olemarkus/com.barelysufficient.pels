# Safe pace is two constraints, not one

Contributor-facing note on the safe-pace model. The naming table and the
"what ships today" sections are design-of-record; the "proposed model" and
"Overview hero" sections are forward design with a revisit trigger at the end.

Code: `lib/plan/planBudget.ts`, `lib/plan/planBuilder.ts`, `lib/plan/planContext.ts`,
`lib/power/capacityModel.ts`, `lib/power/lastTotalPower.ts`.
Sibling note: `notes/end-of-hour-mode.md` (the capacity pace's drain ceiling).
User-facing description: `docs/technical.md` ("Dynamic Hourly Safe Pace").

## Canonical names

The governing rule for this area: **one concept, one canonical name throughout the
code, one owner of the data point.** Everything below is written in these terms.

| Concept | Canonical name | Axis | Owner | Scope |
|---|---|---|---|---|
| Configured grid-tariff ceiling | `hardCapKw` | fixed | capacity settings | per home |
| Buffer below the ceiling | `safetyMarginKw` | fixed | capacity settings | per home |
| `hardCapKw - safetyMarginKw`, as the hour's energy allowance | `hourlyAllowanceKWh` | import | capacity settings | per home |
| The same value as the steady rate that spends it | `sustainableRateKw` | import | capacity settings | per home |
| Dynamic hourly threshold derived from the allowance and the time left | `capacityPaceKw` | import | `lib/plan/planBudget.ts` | per home |
| Exempt draw including projected power for observed-off devices | `projectedExemptKw` | import | `lib/plan/planUsage.ts` | per home |
| Exempt draw from measured readings only | `measuredExemptKw` | import | `lib/plan/planUsage.ts` | per home |
| Daily-budget threshold on the load that counts toward the budget | `budgetPaceKw` | **non-exempt** | `lib/plan/planBudget.ts` | **main only** |
| `budgetPaceKw` re-expressed on the import axis by adding exempt draw | `budgetPaceImportKw` | import | `lib/plan/planBuilder.ts` | **main only** |
| `min(capacityPaceKw, budgetPaceImportKw)`: the threshold the planner acts on | `bindingPaceKw` | import | `lib/plan/planBuilder.ts` | per home |

### Arriving here from a code comment

This note is the definition of record for the names above, and the producers point
at it. Most of them still use a local name, so find your row here before reading
the table above — otherwise a reader landing from `allowedKw` has to guess which
quantity they are holding.

This table is **transitional and is the convergence checklist**. A row loses its
"name in code" entry when that rename lands; when the column is empty, the
canonical names are the names in the code and this subsection can be deleted. Do
not coin a new local name for a quantity that already has a canonical one — rename
toward the table instead, and where a rename is too large for the change in hand,
leave the local name and add the pointer.

Rows are anchored on **symbol names, not line numbers**, deliberately: this file's
line-number citations went stale twice in one week, so anything meant to stay
followable is keyed to something `grep` can still find after the next refactor.

| Canonical name | Name in code today | Producer |
|---|---|---|
| `hardCapKw` | `limitKw`, `capacitySettings.limitKw` | capacity settings |
| `safetyMarginKw` | `marginKw` | capacity settings |
| `hourlyAllowanceKWh` | `netBudgetKWh`, `hourBudgetKWh`, `budgetKWh` | `resolveUsableCapacityKw` |
| `sustainableRateKw` | same value as the row above, read as a rate; the canonical identifier exists only as a local inside `computeDynamicSoftLimit` | `resolveUsableCapacityKw` |
| `capacityPaceKw` | `allowedKw`, `capacitySoftLimit`; *(landed at the consumers, in the rebuild scheduler, and in every log field)* | `computeDynamicSoftLimit` |
| `projectedExemptKw` | *(landed)* | `sumBudgetExemptProjectedUsageKw` |
| `measuredExemptKw` | *(landed as a sum, not yet as a published scalar)* | `sumBudgetExemptMeasuredUsageKw` |
| `budgetPaceKw` | *(landed)* | `computeDailyUsageSoftLimit` |
| `budgetPaceImportKw` | `dailySoftLimitKw`, `dailySoftLimit` | `PlanBuilder.computeDailySoftLimit` |
| `bindingPaceKw` | `softLimit` (context), `softLimitKw` (meta/contract) | `PlanBuilder` |

**The overload is closed.** `softLimit` used to name two quantities at once:
`capacityPaceKw` wherever a consumer logged it as `softLimitKw`, and `bindingPaceKw` on
`PlanContext` and `plan.meta`. The first set is renamed — `periodicStatus` now logs
`capacityPaceKw`/`capacityHeadroomKw`, the rebuild scheduler threads `capacityPaceKw`
(with `pendingCapacityPaceKw` / `lastCapacityPaceKw` in its state), and
`headroom_for_device_checked` names the field it always carried. What is left of
`softLimit` — `PlanContext.softLimit` and `plan.meta.softLimitKw` — means
`bindingPaceKw` and nothing else, so the name is now merely *unconverged*, not
ambiguous. Renaming it is a wire-and-fixture rename with no defect behind it; do it
when something else is already touching those fields, not on its own.

One qualification on the table above, since the admission-scoped slice of § "Proposed
model" has now shipped: `bindingPaceKw` is described there as "the threshold the
planner acts on", which is no longer the whole story. It still drives shedding and the
display tick, but **restore admission is per-axis** — an exempt candidate reads
`capacityHeadroomKw`, a non-exempt one reads
`min(capacityHeadroomKw, budgetHeadroomKw)`, where the budget axis is built from the
measured exempt sum so an off exempt device reserves nothing on it. The
should-plan-restores gate is per-axis-aware too: `bindingPaceKw` still gates the full
restore pass (via the shedding latch), but a budget-driven latch no longer blocks
exempt candidates — `shouldPlanBudgetExemptRestores` opens a restricted lane
(`applyBudgetExemptRestorePass`, capacity-axis only, no swap, no batching) so a
boosted exempt charger is not pinned at its lowest step by background draw exceeding
an exhausted daily pace (prod 2026-08-03). Deliberate tradeoff: an admitted exempt
device's draw can make capacity the binding axis and keep the latch — and the
non-exempt holds — alive longer; that is the boost/exemption priority working as
intended, not a spiral (the lane closes as soon as the source flips to `capacity`).

`hardCapKw` is a partial exception: the name is already in wide use across
`lib/objectives/deferredObjectives/**`, the settings UI, and
`homeScope.getHardCapKw()`, so adopting it in the capacity and plan paths is a
rename onto a name the codebase already carries rather than a new coinage.
`safetyMarginKw` is **not** in the same position — it appears only in the settings
UI, so that half is a genuinely new name everywhere else.

### The rest of the model

`hourlyAllowanceKWh` and `sustainableRateKw` are the same number with different
dimensions: kWh over the hour, and the kW that spends it evenly. One owner, two
named readings, because `computeDynamicSoftLimit` subtracts it as energy
(`remainingKWh = allowance - usedKWh`) while it multiplies the same value as a rate
(`drainCeilingKw = sustainableRateKw * exp(...)`). A single `...KWh` name that gets
multiplied as kW is exactly the ambiguity this table exists to remove. Note that
`notes/units.md` prefers integer watts internally with kW only at the UI boundary;
this family is float kW today, and moving it is a wider change than this note
scopes, so the names above describe the current dimension honestly rather than
pre-empting that migration.

`hourlyAllowanceKWh` is settings all the way down: a pure function of two settings
values with no runtime state. It belongs to whoever owns `capacitySettings` and
should be handed out as a resolved value, exactly like `homeScope.getHardCapKw()`
already does for the cap itself. No consumer should ever perform the subtraction, including
the settings UI, which should receive it through the contract rather than
recomputing it in the browser.

**"One owner" means one per scope, not one process-wide.** Every home bundle
constructs its own `planEngine`, and that engine's `PlanBuilder.computeDynamicSoftLimit`
is the home's only `capacityPaceKw` producer
(`setup/homeRuntime/createHomeCapacityBundle.ts`), so the per-home rows above
have one owner *within a home scope* and N instances across a multi-home install.
The budget rows are different: sub-home bundles are constructed with
`getDailyBudgetSnapshot: () => null` (`createHomeCapacityBundle.ts`), matching
`notes/multi-home-model.md:129`, which makes the daily budget deliberately
main-only. So a sub-home has no `budgetPaceKw` at all.

Two consequences worth stating, because they are invisible from the table alone:

- On a sub-home, `computeDailySoftLimit` returns null, so
  `bindingPaceKw == capacityPaceKw` always and `softLimitSource` can never be
  `'daily'`. Everything below about the argmin, the `'both'` value, and the
  budget-vs-capacity tension is **main-only**.
- Nothing mixes a per-home quantity with a global one. `min(capacityPaceKw,
  budgetPaceImportKw)` is only ever evaluated on main, where both operands are
  main's. That is worth preserving explicitly if the budget ever becomes
  per-meter.

Two axes, named so no expression silently mixes them:

- **`P_import`** is net grid import. It is what the meter reads, what the tariff
  bills, and what every import-axis threshold above is compared against.
- **`P_nonExemptControl = P_import - projectedExemptKw`** is what control compares
  against `budgetPaceKw`.
- **`P_nonExemptMeasured = P_import - measuredExemptKw`** is what the Overview
  renders.

There are two exempt sums and therefore two non-exempt quantities, and they must
carry distinct names down to the contract field. `sumBudgetExemptProjectedUsageKw`
returns the **projected** value: for an observed-off device
`resolveBudgetExemptProjectedKw` (`lib/plan/planUsage.ts`) falls through to
`getHighestKnownPowerKw`, so a parked charger contributes its configured power. That projection is correct for the
control threshold and wrong for anything rendering current load, and the two can
differ by several kW. A single `exemptKw` or a single `P_nonExempt` that "lands
twice with different inputs" would rebuild exactly the ambiguity this table
exists to remove: a `plan.meta` consumer could not tell whether the field includes
hypothetical off-device load. Where this note says `P_nonExempt` without a suffix,
the statement holds for both.

**`P_nonExempt` is signed, for the same reason `P_import` is.** `P_import` is not
floored anywhere on the power path (`recordPowerSample` latches whatever finite value
arrives on `PowerTrackerState.lastPowerW`, and `resolveLastTotalPowerKw` hands it out
signed and unfloored), so it
goes negative while exporting and `headroom = bindingPaceKw - P_import` correctly
grows. `P_nonExempt` is the exact analogue on the budget axis and gets the same
treatment. Substituting `P_import = grossConsumption - solar` and
`grossConsumption = projectedExemptKw + nonExemptGross`:

```text
P_nonExempt = P_import - <exempt sum> = nonExemptGross - solar
```

Negative means solar more than covers the non-exempt load, which is real
information, not an error state. Whatever the surfaces do with a negative
`P_import` they should do with a negative `P_nonExempt`.

Do **not** clamp it at zero. A floor here would be locally plausible and would
break the deficit identity in § "Proposed model": with `capacityPaceKw = 20`,
`budgetPaceKw = 5`, exempt draw 7 kW, `P_import = 2`, today's `bindingPaceKw` is 12
and headroom is 10 kW, but a clamped `P_nonExempt` yields a deficit of `-5` and so
only 5 kW of headroom, delaying restores that need 6 to 10 kW. Unclamped, the two
agree at 10 kW.

The subtraction encodes that **solar is allocated to non-exempt load first**. That
is a choice (pro-rata is the alternative) and it is the one generous to the budget,
consistent with what an exemption is for: an exempt device must not cause the
budget to shed other things.

The *energy* axis performs the same subtraction but does floor it.
`resolveDailySoftLimitBucket` (`lib/plan/planDailyBudgetWindow.ts:80-84`) reduces
to `max(0, meteredUsedKWh - exemptUsedKWh)`. That asymmetry is deliberate rather
than drift: instantaneous power is a signed rate and can legitimately point
backwards, while cumulative billed usage cannot, which is the same reason
`planHourContext.ts:21-22` floors the hourly bucket ("Billed usage can't be
negative"). Keep the floor on the kWh axis and off the kW axis.

The user-facing labels are unchanged and are governed by `notes/ui-terminology.md`:
**Safe pace now** renders `bindingPaceKw`, **Hard cap** renders `hardCapKw`, and
the Advanced page's "safe pace starts each hour at" renders `hourlyAllowanceKWh`
read as a rate. Those three labels map to three different quantities, which is
correct, but it is the reason the internal names have to be unambiguous.

### Why the table is a change, not a description

The names above are the target. Today the code still violates two legs of the rule, and one of those only in part.

**One name, four concepts — resolved.** `softLimit` used to mean `bindingPaceKw` in
`planContext` and `capacityPaceKw` almost everywhere else. Both halves are now closed:
the silent substitution first (no site can return a *different quantity* because
something was unwired), and then the overload (every site that carried
`capacityPaceKw` now says so).

`capacityGuard.getSoftLimit()` used to return `capacityPaceKw` with a provider wired
and `hourlyAllowanceKWh` without one, and `lib/executor/shortfallExecutor.ts` fell back
to `hardCapKw` when it could not obtain a guard at all. Both conditions are now
unreachable: the guard holds no limits and no providers, `AppContext.capacityGuard` is
non-optional, and each site below is handed a producer-resolved `capacityPaceKw` from
`computeDynamicSoftLimit`.

| Site | What it receives today |
|---|---|
| `lib/executor/shortfallExecutor.ts` | `capacityPaceKw` (`getCapacityPaceKw`) |
| `lib/diagnostics/periodicStatus.ts` | `capacityPaceKw` (`capacityPaceKw` param) |
| `lib/plan/rebuildScheduler/signalDriven.ts` | `capacityPaceKw` (`capacityPaceKw` param) |
| `flowCards/headroomAndEvSocCards.ts` | `capacityPaceKw` (`deps.getCapacityPaceKw`) |

This satisfies the root `AGENTS.md` rule — unavailability must surface as an explicit
state, not as a plausible default — by removing the unavailability rather than
modelling it, so the fail-closed caller contract this section used to specify was never
needed. Keep it that way: do not reintroduce a pace accessor that can answer with a
substitute.

The consumers take the parameter as `capacityPaceKw` and now log it under that name
too. `PlanContext.softLimit` and `plan.meta.softLimitKw` still spell `bindingPaceKw`
the old way, but they are the only survivors and they agree with each other, so no
reader can be handed the wrong quantity by trusting the name.

**One concept, one implementation — resolved.** `hardCapKw - safetyMarginKw` was
recomputed inline at up to six sites besides the nominal owner. The subtraction now
exists exactly once, in `packages/shared-domain/src/capacityAllowance.ts`
(`usableCapacityKw`); `resolveUsableCapacityKw` (`lib/power/capacityModel.ts`) is still
the runtime owner and delegates to it, and `lib/power/sampleIngest.ts` asks the owner
instead of recomputing `hourBudgetKWh`.

An earlier draft of this section said the settings UI should simply receive the
resolved value through the contract, "because only one side computes". That is wrong for
**all three** settings-UI sites, and it is the reason the arithmetic sits in
shared-domain rather than in `lib/power`. Each one renders the pace from values the
runtime owner has never seen:

| Site | Reads |
|---|---|
| `reactionKwLabel` (`homeLimits.ts`) | `editor.hardCapValue` — unsaved meter-area form text, parsed mid-keystroke |
| `BudgetAdjustView` (`views/BudgetOverview.tsx`) | `adjust.hardCapKw`, built at `budgetRedesign.ts` from `Number.parseFloat(settingsCapacityLimitInput?.value)` — the live DOM input, which is why the `Number.isFinite` guard is there |
| `updateCapacityReactionHint` (`capacity.ts`) | the same Main capacity form's `limit`/`margin` |

No contract scalar can answer any of them, because the number exists nowhere but in the
input box. Everything derived from *persisted* settings still goes through the runtime
owner — that half of the rule stands — but "the UI never computes" was too strong, and a
rule stated too strongly is how a duplicate gets re-added later with a good excuse.

That is not hypothetical: the first pass at this converted `homeLimits.ts` and
`BudgetOverview.tsx`, declared the subtraction to exist "exactly once", and left
`capacity.ts` inline — a site whose sweep the grep missed because it spells its operands
`limit`/`margin`. Three surfaces render one sentence; all three now go through the
helper.

`BudgetOverview.tsx`'s local was renamed `hourStartPaceKw` to match the sentence it
renders ("safe pace starts each hour at") rather than restating the helper's name.

**One concept, two names — resolved.** `resolveCapacitySoftLimitKw` was an alias of
`resolveUsableCapacityKw` that returned `hourlyAllowanceKWh` while its name promised
`capacityPaceKw`. It is deleted; `resolveUsableCapacityKw` is the only name for the
quantity, and the mismatch it enabled — `lib/diagnostics/periodicStatus.ts` filing
`capacityPaceKw` under `softLimitKw` — is renamed away with the overload leg above.

**No name at all — resolved.** `budgetPaceKw` used to be an unnamed intermediate
inside `computeDailySoftLimit`, with only the rebased `budgetPaceImportKw` reaching
`PlanContext` and `plan.meta` as `dailySoftLimitKw`, so nothing downstream could
obtain the pace that applies to the non-exempt house. It is now returned by name
alongside `projectedExemptKw` and published on both `PlanContext` and `plan.meta`.

All four legs of the naming rule are now closed. What the sections below still describe
as open is a different thing: the *model* — one rebased `min()` where two predicates
belong — not the names it is written in.

## Two constraints with different subjects

PELS paces against two independent things, and they do not measure the same load:

| Constraint | Subject (what counts) | Window | End-of-hour drain | Computed by |
|---|---|---|---|---|
| `capacityPaceKw` | All of `P_import`, with no per-device carve-out: managed devices, budget-exempt devices, and background usage all count, but only to the extent they are drawn from the grid | the current clock hour | **yes** | `computeDynamicSoftLimit` (`lib/plan/planBudget.ts`), off `powerTracker.buckets[key]` |
| `budgetPaceKw` | `P_nonExempt`: everything *except* budget-exempt devices | the current bucket of the daily plan, not the whole day | **no**, deliberately | `computeDailyUsageSoftLimit` (`lib/plan/planBudget.ts`), off `resolveDailySoftLimitBucket` (`resolveDailySoftLimitBucket`) |

### Only one of the two paces drains at the hour boundary

`capacityPaceKw` is `min(burstRate, sustainableRateKw * e^(minutesRemaining / TAU))`
(`computeDynamicSoftLimit`, TAU 4 min), so it collapses toward
`sustainableRateKw` over the last minutes of the hour. `budgetPaceKw` applies no
such ceiling, on purpose: "Daily budget is a soft constraint, never apply
end-of-hour capping. Only the hourly hard cap needs EOH protection"
(`computeDailyUsageSoftLimit`). See `notes/end-of-hour-mode.md` for why the drain exists.

**"Safe pace now" does account for the drain**, because `bindingPaceKw` is a
`min()` and the drained `capacityPaceKw` is one of its operands. The budget side
lacking a drain can only ever make the binding pace *lower*, never bypass the
ceiling. That is the reassuring half of the answer. Three consequences are less
obvious:

- **The source can hand over to `'capacity'` near `:00`, but only sometimes.**
  `capacityPaceKw` decays toward `sustainableRateKw` while `budgetPaceImportKw`
  holds its level, so a hand-over happens exactly when `budgetPaceImportKw` sits
  *above* the decaying capacity pace near the boundary. It does not happen when the
  daily pace is well below the sustainable rate: a 2 kW daily pace against an 8 kW
  sustainable rate stays daily-bound straight through `:00`. So this is a
  conditional transition on tight-capacity hours, not a guaranteed hourly one. It
  is still worth designing for, because when it does fire it moves everything
  downstream of `softLimitSource` at once (the reason copy, `resolveLimitReason`,
  the starvation cause attribution, and the startup stabilization gate at
  `lib/plan/restore/index.ts:55`), and unlike the open hysteresis item it is a real
  transition rather than epsilon jitter.
- **The drain is why the fallbacks had to go rather than be tidied.** `capacityGuard.ts`,
  `signalDriven.ts` and `periodicStatus.ts` used to fall back to `sustainableRateKw` and
  `shortfallExecutor.ts` to `hardCapKw`; neither decays, so an unwired provider did not
  merely substitute a different quantity, it substituted one that could never wind down
  at the boundary — defeating exactly what the drain is for. All four sites now receive a
  producer-resolved `capacityPaceKw`, which carries the drain by construction. Any future
  accessor that can answer with a non-decaying substitute reintroduces this.
- **The drain is only applied when a plan is rebuilt, and both sources do rebuild.**
  There is no hour-boundary tick in `lib/plan/rebuildScheduler/**`, but none is
  needed. Under `power_source = homey_energy` the 10 s poll
  (`lib/power/sources/homeyEnergyPoll.ts:5`) drives rebuilds. Under
  `power_source = flow`, `FlowPowerSampleFreshnessClock.runTick` requests a
  `flow_power_sample_hold` rebuild every 10 s for as long as the last sample is
  fresh and reschedules itself (`lib/power/flowPowerSampleFreshnessClock.ts:128-132`,
  `216-224`), so the wind-down is recomputed without new Flow events. Past 60 s of
  silence the same clock moves the sample to stale-hold and then fail-closed, and
  actuating a drain off stale power would be wrong anyway. Do not add a
  boundary timer here; the freshness policy already owns this window.

**`capacityPaceKw` is not `hardCapKw`.** It budgets `hourlyAllowanceKWh` over the
time left in the hour, so its instantaneous value legitimately exceeds the
configured ceiling in an under-used hour (`notes/ui-terminology.md` § "Safe pace,
hard cap, and safety margin"). Crossing it is not crossing the tariff ceiling.
Keep the two apart in any control or UI work that follows this note; the predicate
below is named `overCapacityPace` for the same reason.

The capacity constraint is physical in origin: it protects the grid tariff step,
so a device exempted from the daily budget is still subject to it. That asymmetry
is deliberate and correct. "Get power now" buys a device relief from *today's
budget*, never from the capacity side.

**`P_import` is net grid import, not appliance draw.** This matters on solar homes
and is easy to get wrong. `recordPowerSampleForApp` derives `grossConsumptionW =
net + generation`, but that gross value "feeds ONLY the managed/unmanaged split
attribution, never the hard-cap import path or the billed-kWh total bucket, which
both stay on the net `currentPowerW`" (`lib/power/sampleIngest.ts:113-123`,
restated at `lib/power/tracker.ts:430-435`). So the hourly bucket and the capacity
guard are net import, which is right: the tariff meters the grid, and self-consumed
PV is not billed.

Per-device power (`controlledKw`, and both exempt sums) is gross draw at the appliance,
bounded by `grossConsumptionW`. Under solar self-consumption the device sums can
exceed `P_import`, which is exactly when `P_nonExempt` goes negative. That is the
axis behaving correctly, not mixing.

Note the window on the second row. `resolveDailySoftLimitWindow`
(`lib/plan/planDailyBudgetWindow.ts:137-147`) spans `bucketStartIso` to
`nextBucketStartIso` (defaulting to one hour), so `remainingKWh / remainingHours`
in `computeDailyUsageSoftLimit` paces the *current bucket's* share of the daily
plan. It is not a whole-day burst rate. Both paces run on roughly hourly windows;
the difference that matters is which load each one counts, not the horizon.

Exempt netting happens at `lib/plan/planDailyBudgetWindow.ts:80-84`: the bucket's
`usedKWh` is `meteredUsedKWh - exemptUsedKWh`. (`lib/dailyBudget/dailyBudgetState.ts:139-147`
performs the same subtraction for the daily-budget state and UI view; that is a
parallel path, not the one the planner paces on.)

The exempt device set is the same on both axes: `sumBudgetExemptProjectedUsageKw`
(`lib/plan/planUsage.ts`) gates the energy accrual at `lib/power/sampleIngest.ts`
and the power term at `lib/plan/planBuilder.ts`. Feeding the PROJECTED sum to the
energy accrual is a known defect — it books an off exempt device's nameplate into
a persisted kWh bucket — tracked in `TODO.md`.

The gap is that the energy side materialises `P_nonExempt`'s kWh equivalent as the
bucket's `usedKWh`, while the power side never materialises `P_nonExempt` at all.
It computes only the rebased *threshold* `budgetPaceKw + exemptKw`, and
`P_import > budgetPaceKw + exemptKw` is exactly `P_nonExempt > budgetPaceKw`, so
the control comparison is correct today. What is missing is the quantity itself,
which is why nothing downstream, including the hero, can show the user what is
actually being measured against their budget.

This is where `projectedExemptKw` and `measuredExemptKw` diverge (see § "Canonical
names"). The threshold must use the projected sum; anything rendering current load
must use the measured one. Materialising a single `P_nonExempt` for both would
reintroduce the ambiguity.

## What ships today: one scalar via a rebase

`planBuilder.buildContextAndShedding` (`lib/plan/planBuilder.ts:309-312`) collapses
the two constraints into a single threshold on `P_import`:

```text
budgetPaceImportKw = budgetPaceKw + exemptKw          // planBuilder.ts:528-539
bindingPaceKw      = min(capacityPaceKw, budgetPaceImportKw)
```

The `+ exemptKw` term moves the budget pace from the `P_nonExempt` axis to the
`P_import` axis, so `min()` compares like with like and
`headroom = bindingPaceKw - P_import` is a valid shedding deficit. The arithmetic
is sound. What it costs is that `bindingPaceKw` is the number every display
surface shows, and it now moves with exempt draw.

`capacityPaceKw` is genuinely un-rebased, so `capacityBreached` (evaluated against
it) is an honest capacity-pace predicate. Only the budget side goes through the
rebase.

## Where the rebase costs us

**1. The displayed number moves for a non-budget reason.** `plan.meta.softLimitKw`
carries `bindingPaceKw` and is what every display surface reads (settings UI hero
via `softLimitKw`, widget and insights device via `hourlyLimitKw`). When a 7 kW
exempt load starts, "Safe pace now" jumps by 7 kW while the tooltip still reads
"slowed to stay within today's budget; daily pacing is the tighter constraint
right now" (`packages/shared-domain/src/planHeroTooltips.ts:24-28`). The budget did
not get looser. The number and its explanation contradict each other.

**2. Exempt draw is coupled to every other device's shed threshold.**
`projectedExemptKw` tracks the live reading while the device is on, so as an exempt
EV tapers from 7 kW to 2 kW the
effective pace for the rest of the house tightens by 5 kW over a few minutes with
no budget change behind it. Against the 60 s shed cooldown that is a control
question, not only a display one.

**3. Unresolved exempt draw silently becomes zero exempt draw.**
`sumBudgetExemptProjectedUsageKw` returns `null` when exempt devices exist but none
report power, and `planBuilder.ts:534` coerces that with `?? 0`. With two exempt
devices and one reporting it returns a *partial* sum with no signal at all.
`budgetPaceImportKw` then collapses to `budgetPaceKw` while `P_import` still
includes the exempt device's draw, mixing the two axes by exactly that draw and
shedding non-exempt devices for a missing reading. Same boundary-rule violation as
the unwired-provider fallbacks above, in a different place.

**4. The rebase steers `softLimitSource`, which is load-bearing elsewhere.**
`resolveSoftLimitSource` (`lib/plan/planBuilder.ts:522-526`) compares
`capacityPaceKw` against `budgetPaceImportKw`, so a large exempt load pushes the
budget number up and biases the source toward `'capacity'`.

It is tempting to conclude that this strips the exemption's shedding protection,
since `'capacity'` satisfies the `limitSource !== 'daily'` clause at
`lib/plan/shedding/candidates.ts:110` and `lib/plan/planRemainingSheddableLoad.ts:243`.
In the ordinary case it does not, and the reasoning is worth recording so nobody
"fixes" it twice: whenever the source is `'capacity'`, `bindingPaceKw ==
capacityPaceKw`, so `headroom < 0` implies `P_import > capacityPaceKw`, which makes
`capacityBreached` true and admits the exempt device by that clause anyway.

**But the two clauses are not equivalent in general.** Two branches force
`headroom = -1` while `P_import > capacityPaceKw` is false or unknowable, so
shedding runs with `overCapacityPace` false. They must be handled **differently**,
and conflating them is a trap:

- **An unmeasured cycle.** Since 2026-08-16 the planner is not told *why* a
  headroom is what it is: `lib/power` owns the meter and answers
  `headroomKw(limitKw)` with a number, forcing −1 once the sample has aged past
  the shed timeout and holding at 0 before that (`lib/power/powerCycleReading.ts`).
  The one thing the planner may know is `powerIsMeasured` — measured or the
  producer's hold, never which stale state produced it. The source stays
  `context.softLimitSource`. If that is `'capacity'`, the `limitSource !== 'daily'`
  clause admits budget-exempt candidates today, so keying candidacy on a bare
  `overCapacityPace` would reject them and a fail-closed meter would stop shedding
  exactly the devices it most needs to. This branch needs an explicit
  forced-breach term.
- **Exhausted hour.** The opposite. `buildSheddingPlan.ts:103` deliberately
  overrides the source to `'daily'` (`candidateLimitSource = hourlyBudgetExhausted
  ? 'daily' : context.softLimitSource`) precisely so exempt devices stay
  protected, and `test/integration/planShedding.test.ts:3424-3488` pins that only
  non-exempt devices are selected even when the context source is capacity. Adding
  this branch to a forced-breach term would let `shedAllCandidates` shed "Get power
  now" devices, which is a behaviour change, not a preservation.

So the rule is: carry the forced-breach term into the predicate, and leave the
exhausted-hour override exactly where it is. Note what the rule may NOT be
written as any more — "carry `stale_fail_closed` into the predicate", its
original wording. That name does not exist inside `lib/plan`, by design: a
planner branch on a freshness label is the provenance branch the root
`AGENTS.md` forbids, and it was how four control paths came to re-derive
"is power observable" for themselves, each slightly differently.

What the rebase does steer is everything else `softLimitSource` feeds: the reason
copy (`lib/plan/planReasons.ts`), the hero tick's source label and tooltip,
`resolveLimitReason`, and the starvation cause attribution. Those read a source
string whose value depends on an exempt device's instantaneous draw. That is a
legibility and stability problem, not a shedding-safety one.

## Proposed model: separate the control predicates from the display threshold

Evaluate each constraint on its own axis:

```text
overCapacityPace = P_import     > capacityPaceKw
overBudgetPace   = P_nonExempt  > budgetPaceKw
deficitKw        = max(P_import - capacityPaceKw, P_nonExempt - budgetPaceKw)
```

**`deficitKw` is not an available name.** It already means the shortfall deficit
across `lib/executor` and `lib/plan/rebuildScheduler` (`handleShortfall(deficitKw)`,
`onTightNoopHardCapBreach`), so introducing a second meaning in the same layer would
recreate the exact `softLimit` failure this note exists to remove. Pick a distinct
name for the two-predicate quantity — or rename the shortfall one first — before
writing the identifier anywhere. The admission-scoped slice that shipped avoided
this by naming its axes `capacityHeadroomKw` and `budgetHeadroomKw`.

`deficitKw` is algebraically identical to today's `P_import - bindingPaceKw`: the
subtraction distributes over `min`, and neither form clamps. It is a re-expression,
not a behaviour change.

**Be precise about what it buys, because it is less than it looks.** It does not
make control exempt-independent. `P_nonExemptControl` contains `projectedExemptKw`, the two forms
are identical, and when an exempt EV tapers, `P_import` falls by the same amount
and the subtraction cancels in both. What the re-expression buys is **provenance**:
the planner can say which constraint bound and by how much, instead of deriving
that from a source string that was itself computed from a collapsed scalar. That
is worth having, for the reason copy and the starvation attribution in particular,
but it is a legibility win, not a decoupling one.

The identity covers the deficit only. `buildPlanContext` layers two overrides on
top of the collapsed scalar, and a re-expression has to carry both: an unmeasured
cycle past the shed timeout resolves `headroomRaw = -1` inside `lib/power`, and
`hourlyBudgetExhausted && bindingPaceKw <= 0 && measuredAtOrBelowKw(0.01)` forces
`headroom = -1` so an exhausted hour still sheds when the meter reads ~0. The
second one is MEASURED now — it used to test the raw cached total, which survives
a dropout.

### The display threshold stays rebased, and that is not fixable by renaming

This is the sharpest limit on what the re-expression buys, so state it plainly.
`bindingPaceKw` is a single tick on a `P_import` axis, and any such tick is
`min(capacityPaceKw, budgetPaceKw + exemptKw)` **by construction**. Its value and
its source label therefore move with exempt draw no matter how they are computed.

A raw `argmin` over the two paces is not an alternative, because they are on
different axes: with `capacityPaceKw = 8`, `budgetPaceKw = 5`, `exemptKw = 7`, the
raw argmin says `daily`, but `budgetPaceImportKw` is 12, so the 8 kW tick actually
drawn is capacity-derived. The only correct comparison is the common-axis one,
which is what `resolveSoftLimitSource` already does.

So the split is:

- **Control** (shed sizing, exempt candidacy) reads `overCapacityPace` /
  `overBudgetPace`. This is *not* exempt-independent: `P_nonExemptControl` contains
  `projectedExemptKw`, so a resolved exempt draw stays a required control input. What
  changes is that each constraint is evaluated on its own axis and reports its own
  deficit, so the planner knows which one bound.
- **Display source** (`softLimitSource`) stays the common-axis argmin over
  `capacityPaceKw` and `budgetPaceImportKw`, and stays exempt-coupled. It answers
  "which pace is setting the tick", which is always defined, including when
  neither predicate has fired. It must not grow a `'none'` variant: below both
  paces the hero still draws a tick and still owes the user a source for it.
- **Consumers that want "is the non-exempt house over budget"** must read
  `overBudgetPace` rather than infer it from the source string. The reason copy and
  the starvation cause attribution infer it today.
- **The hero** is where the coupling gets *shown* rather than removed. That is the
  carve-out geometry below, and it is the real fix for symptom 1.

Given the argmin stays common-axis, let `'both'` mean the two common-axis
thresholds agree within `SOFT_LIMIT_EPSILON`.

**Introducing `'both'` is not a display-only change.** `softLimitSource` is read as
a control input in at least one place: `lib/plan/restore/index.ts:55` gates startup
stabilization on `context.softLimitSource === 'capacity'`, so a `'both'` value in
the epsilon band would disable that gate and permit restores during the startup
window. Either update every source consumer, or keep a `capacityActive` predicate
separate from the display source and let the runtime gates read that. Audit the
consumers before adding the third value; the reason copy, `resolveLimitReason`, and
the starvation attribution are the others.

`'both'` also does **not** dissolve the open hysteresis item on
`resolveSoftLimitSource`: the resolver is still stateless, so a difference
oscillating across the epsilon boundary still alternates `capacity` / `both` /
`daily` between rebuilds, and every source-dependent surface (tooltip, reason line,
the "Let it run now" rescue affordance) still flickers. Real hysteresis needs
retained state or separate enter/exit thresholds. That item stays open and
orthogonal.

The existing `'both'` tooltip copy ("both capacity and daily pacing are
constraining PELS right now", `SAFE_PACE_TOOLTIP_BY_SOURCE`) reads in the *breach*
sense, so adopting the argmin reading means rewording it. Take that through
`notes/ui-terminology.md`.

Two further consequences:

- `softLimitSource` can finally emit `'both'`. The value is already defined in the
  contract (`packages/contracts/src/settingsUiApi.ts:156`), in the tooltip map
  (`packages/shared-domain/src/planHeroTooltips.ts:24`), and in
  `notes/ui-terminology.md`, but `resolveSoftLimitSource` can only ever return
  `'capacity'` or `'daily'`, so that copy is unreachable today.

  Do not build a second fold for it. `resolveLimitReason`
  (`lib/plan/pelsStatus.ts:265-291`) already computes a three-way
  `'none' | 'hourly' | 'daily' | 'both'` for the separate `limitReason` field on
  PelsStatus, the insights device, and `packages/shared-domain/src/homeLimitsStatus.ts`,
  and it does return `'both'`. It derives that from `softLimitSource` plus shed
  state and headroom sign, which is a downstream proxy for exactly the breach
  predicates above. Feed it the real predicates rather than leaving it to
  re-derive them, and re-check its `'none'` handling once `softLimitSource` carries
  `'both'` in the argmin sense.
- Exempt shed candidacy could key off `overCapacityPace` instead of the
  `limitSource !== 'daily' || capacityBreached` pair, but only with the caveat in
  item 4: the two are equivalent in the ordinary case and **not** in the exhausted
  hour, where `overCapacityPace` is false while shedding must still run. The predicate
  has to be `overCapacityPace || hourlyBudgetExhausted`, with the exhausted hour carried
  explicitly. (The other forced branch — the silent meter — is gone since 2026-09-02:
  that pass no longer runs this predicate at all, it is its own path that sheds every
  candidate, `lib/plan/planBuilderSilentMeter.ts`.)

The `?? 0` in item 3 is independent of this and should be fixed first: the producer
needs to return an "exempt draw unresolved" state that the planner handles
explicitly rather than defaulting to zero.

## What this means for the Overview hero

The hero power bar's x-axis is `P_import`, and it carries one pace tick
(`bindingPaceKw`) plus the `hardCapKw` tick. As established above, a single tick
on that axis is necessarily the rebased expression, so the hero cannot show an
exempt-independent budget pace by computing it differently. The shipped first
slice therefore explains the rebase textually; any later geometry has to show the
projected/measured difference explicitly.

Deferred direction: **make the rebase visible as geometry.** The bar already
renders `[managed][background][free]` (`notes/overview-hero-spec.md`). A future
treatment could pull budget-exempt devices out as a leading sub-segment of
managed:

```text
[ exempt ][ managed ][ background ][ free .......... ]
          ^                     ^              ^
   budget pace measured    Safe pace now    Hard cap
   from this edge
```

If control and display used the same exempt sum, drawing the budget tick at
`exemptKw + budgetPaceKw` would make the segment to the right of the exempt slab
read directly against `budgetPaceKw`. They do not reliably use the same sum:
control may reserve projected power for an observed-off device while the bar
shows measured load. The geometry is therefore deferred rather than treated as a
direct rendering of `overBudgetPace`.

**Feed the slab `measuredExemptKw`, not `projectedExemptKw`.** The value
`computeDailySoftLimit` uses is the projected one: `resolveBudgetExemptProjectedKw`
falls through to `getHighestKnownPowerKw` for an observed-off device, so an off
charger contributes its configured power. The hero's managed and background segments are defined as
current load (`notes/overview-hero-spec.md:158-164`), so painting a slab from the
projected value would show kilowatts the device is not drawing, and in the solar
case could paint the entire bar as exempt. The geometry needs a measured-only
exempt sum carried alongside the projected one; control keeps the projection.

**Negative `P_nonExempt` needs a treatment, not a clamp.** When solar more than
covers the non-exempt load the segment right of the slab goes negative, the same
way `P_import` does on export. The hero has to answer both cases consistently, and
the honest reading is a genuinely good thing to tell someone: nothing is counting
against today's budget right now. Whatever the bar does with export it should do
here. Take wording through `notes/ui-terminology.md`, and check what the bar
currently does at negative `P_import` first, since that treatment may not exist
yet either.

Two supporting changes:

- **The first slice is textual composition.** When the budget constraint binds
  and the projected allowance is non-zero, the hero names both the raw
  `budgetPaceKw` and the exact `projectedExemptKw` add-back already used by
  control. This makes the rebased marker explainable without claiming that a
  projected reservation is measured load. The plan payload carries both values;
  `meta.dailySoftLimitKw` remains their rebased sum.
- **Do not present "available power" as capacity-only for an exempt device.** The
  exemption buys immunity from daily-budget *shedding* (`shedding/candidates.ts`),
  and — since the per-axis restore-admission change (2026-08-01,
  `lib/plan/restore/headroomLedger.ts`) — an exempt restore candidate is admitted
  against the CAPACITY axis, so it is no longer held by the budget-derived
  binding pace. Non-exempt candidates must additionally fit the budget pace with
  a MEASURED exempt sum, so they cannot spend headroom that exists only as an off
  exempt device's projection.

  **But do not repeat that comment's stated reason.** It says the add-back is the
  exempt device's live draw, "zero while it is off". That is not what the code
  does. An observed-off exempt device falls through
  `resolveBudgetExemptProjectedKw` to `getHighestKnownPowerKw`: the highest of
  measured / expected / planning / configured power. So `budgetPaceImportKw`
  **already projects an off exempt device's expected draw**, and the add-back is
  only zero when nothing is known about the device's power at all. (There is a
  `plannedState === 'shed'` arm ahead of the projection — it returns the device's
  ACTUAL draw rather than projecting configured demand — but
  `computeDailySoftLimit` sums over `PlanInputDevice[]`, which carries no
  `plannedState`, so it cannot fire on that path.)

  The practical consequence: a proposal to "project the candidate's expected draw
  into the exempt add-back" so exempt devices become capacity-bound for restore
  would **double-count**, because the projection is already there. This is the same
  fallback the open P1 item on observed-off usage attribution is about.

Rejected: two permanently visible pace ticks. Three ticks at 320 px, with the
`hardCapKw` tick already mandatory, for a state most homes never enter.

Deferred: carve-out geometry. The visible bar remains measured whole-home load,
while `projectedExemptKw` can include expected power for an observed-off device.
A measured slab therefore cannot honestly encode the current control predicate.
Keep the first slice textual until the projected/measured delta has an explicit
visual treatment.

## What remains: materialise `P_nonExempt`, in `lib/power`

`P_nonExempt = P_import - exemptKw`, unclamped, is settled (see § "Canonical
names"). The open work is that nothing computes it as a value — only as an
implicit term inside the rebased threshold. Until it exists as a named quantity:

- No surface can show the user what is being measured against their budget, so
  the textual composition can explain the "Safe pace now" jump but cannot render
  the current non-exempt load.
- The reason copy and the starvation cause attribution keep inferring budget
  pressure from `softLimitSource` instead of reading `overBudgetPace`.
- The negative case (solar more than covering the non-exempt load) is invisible
  everywhere, despite being a good thing to tell someone.

**It belongs to `lib/power`, not to the planner** — this was tried the other way
first and the attempt is what settled it. A draft published
`plan.meta.nonExemptMeasuredKw`, resolved in `planBuilderMeta` as
`power.measuredTotalKw === null ? null : measuredTotalKw - measuredExemptKw`.
That `=== null` is the planner deciding what a doubtful meter reading means,
which is exactly what this file's own § "Canonical names" and the `PlanContext`
doc forbid: *`lib/power` owns the meter, so it decides what a doubtful reading
means and answers in kW.* The nullable was the symptom; the layering was the
defect. Two further facts point the same way:

- Both ingredients already live in `lib/power`. `sampleIngest` computes the
  exempt sum through its injected `sumBudgetExemptUsage` and records
  `exemptPowerW` into the tracker's `exemptBuckets`. The planner subtracting a
  device-list sum from a meter reading is a re-derivation.
- The settings UI already has a power-owned channel, `SettingsUiPowerPayload`
  (read via `getPowerReadModel()`, the same one the capacity scalars use). A
  meter-derived figure belongs there, next to the freshness a consumer needs to
  interpret it — not on the plan snapshot, where its absence would encode
  freshness a second time and implicitly.

That last point matters more than it looks. `measured` is true only inside the
60 s `fresh` band (`POWER_SAMPLE_STALE_THRESHOLD_MS`), and the measurement gate
is a once-ever latch, not a freshness gate — so plans keep building right through
`stale_hold`. Under `power_source = flow`, where a gap between events is ordinary
cadence rather than a fault, a plan-side nullable would be absent most of the
time while `totalKw` showed a held value beside it.

It needs to land twice, with different exempt sums: the daily-pace add-back uses
the projected `sumBudgetExemptProjectedUsageKw`, while the measured-only
`sumBudgetExemptMeasuredUsageKw` feeds the restore-admission budget axis
(`PlanContext.budgetHeadroomKw` — a control input, so a non-exempt restore cannot
spend an off exempt device's projection) and, eventually, the hero's display
value (§ "Overview hero").

The alternative policy, allocating solar pro-rata across exempt and non-exempt
load instead of to non-exempt first, was considered and rejected: it would let an
exempt device consume solar that then pushes the budget down on everything else,
which is the opposite of what an exemption is for. Record that here so it is not
relitigated.

## Unresolved consequences of the projected/measured split

Splitting `projectedExemptKw` from `measuredExemptKw` removed one ambiguity and
exposed three questions it had been hiding. None is settled; do not treat the
sections above as answering them.

- **The physical reading of a negative value holds only for the measured
  quantity.** `P_nonExemptMeasured < 0` genuinely means solar covers the
  non-exempt load. `P_nonExemptControl < 0` does not: with no solar, 2 kW import
  and an off charger projected at 7 kW, control computes -5 kW purely from
  reserved hypothetical power. The interpretation earlier in this note applies to
  the measured value; the projected one is only the algebraic term that preserves
  current control behaviour.
- **The hero cannot render the control predicate with a measured slab.** With an
  off charger configured at 7 kW, zero measured draw, 6 kW import and a 5 kW
  budget pace, control rebases its threshold to 12 kW and is not over budget,
  while a measured slab with the tick at 5 kW says the opposite. Putting the
  projected 7 kW into the tick instead disconnects the tick from the visible slab
  edge. So the carve-out geometry does *not* directly render `overBudgetPace` once
  the slab is measured-only. Either the display needs its own stated semantics or
  the projected/measured delta has to be visualised.
- **Whether the observed-off projection is right for control is not settled
  here.** The open TODO item on observed-off usage attribution deliberately leaves
  the choice open between attributing the restore step and attributing zero with a
  separate restore reservation. An off exempt charger projected at 7 kW against
  8 kW of real non-exempt import and a 5 kW budget pace yields a control value of
  1 kW and suppresses daily shedding. Calling the projection "right for control"
  pre-empts that decision; resolve the attribution item first, or keep restore
  reservation separate from live budget accounting.

## Revisit trigger

Revisit when any of these lands or is reported:

- A support report that the textual composition still does not explain a
  "Safe pace now" jump without a settings or budget change.
- Work on the deferred-objective rescue or "Get power now" surface, which is what
  makes exempt load common enough for the hero treatment to pay for itself.
- Any change to `resolveSoftLimitSource`, since the argmin reading of `'both'` and
  the hysteresis item both land there.
- Any new accessor that hands out a capacity pace with a fallback of its own. Deleting
  `capacityGuard.getSoftLimit()` is what closed the two-quantities defect; a
  reintroduced one reopens it.
