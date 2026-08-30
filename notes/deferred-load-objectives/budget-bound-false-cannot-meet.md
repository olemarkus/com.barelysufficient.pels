# Budget-bound false `cannot_meet` (+ exempt-from-budget not applied)

Status: **all prongs resolved.** Prong A (rescue/exempt telemetry — PR #977) and
Prong C (budget-bound vs physical status classification — PR #978) shipped.
Prong B (exempt-not-applied diagnosis) resolved by prod telemetry 2026-05-23:
Connected 300 events show `rescueExemptMode: "always"`, `rescueLimitMode:
"always"`, `budgetExemptApplied: true`, `limitLowerPriorityApplied: true` — the
planner sees the rescue as designed. The 2026-05-22 symptom was a config-side
state (rescue not yet set or set on a different device), not a wiring bug.
Prong B2 (the `isCurrentBucketPlanned` self-disarm question) confirmed
intentional per the field comment in `diagnosticsBridge.ts:98-101` — the rescue
applies only "while the current bucket is a planned bucket … idle/background
cycles stay normal," matching the `limitLowerPriorityApplied` companion. The
background-squeeze copy-routing follow-up (thread the producer-resolved
budget-bound signal onto the persisted active-plan revision so squeeze-case copy
reads budget-side) is tracked in `TODO.md` as "Name the daily budget when it is a
contributing cause of a smart-task miss" — it had gone missing from `TODO.md` and
was re-filed 2026-08-09.

**Prong E (2026-08-09): the squeeze no longer stands the device down.** A second
consequence of the same mechanism: an hour squeezed to a 0 cap was read by
admission as a deliberate deferral, so the device was commanded off in an hour
nothing physical was withholding. The producer now resolves a flat
`currentHourClaim` that separates an *unclaimed* hour (booked 0 and the task cannot
finish without it — the device stays managed and competes on its own priority) from
a *released* one (booked 0 and the task can finish anyway — stand down as before).
It keys on the very `floorShortfallCause` this note is about: `budget` and
`time_capacity` keep the hour, `step_power` and `estimate` give it up. Only the copy
half above remains open. Design of record:
`notes/deferred-load-objectives/README.md` § "An unbooked hour is not a stand-down".

## Symptom (prod, 2026-05-22, commit `d280c1ed`)

"Connected 300" water heater: 127/127 plans in one session `cannot_meet`,
`plannedUsefulEnergyKWh` pinned at exactly 1.182 (one min-step bucket),
`unplanned` growing — despite ~9 h to the 06:00 deadline, 10–12 kW headroom, and
only ~2.7 kWh needed. `dailyBudgetExhaustedBucketCount: 0`.

## Mechanism: the floor cap is the soft daily budget net of background

The floor allocator skips any bucket whose capacity ≤ ε (the allocate loop in
`bucketAllocation.ts`), and the per-bucket cap is

    maxUsefulEnergyKWh = max(0, perBucketBudgetKWh − backgroundKWh)   (policyHorizon.ts resolveMaxUsefulEnergyKWh)
    perBucketBudgetKWh = allowedCumKWh[i] − allowedCumKWh[i-1]        (daily-budget pacing slice)
    backgroundKWh      = plannedUncontrolledKWh[i]                    (forecast household load)

i.e. the cap is the **soft daily budget net of forecast background load**, not
physical capacity. Once the cumulative budget allowance is mostly consumed by
forecast background, the late "preferred" hours get ~0 room, so only one bucket
had room → 1.182 placed, ~1.5 abandoned → `cannot_meet`.
`resolveBucketStepCapacityKWh = min(step.usefulPowerKw × hours, cap)`, so the cap
bounds **every step equally**.

> **Names since this was written.** `perBucketBudgetKWh` is now `controlledShareKWh`
> on `BudgetOverlay` (`policyHorizon.ts`), and `isDailyBudgetExhausted` is gone with
> the classifier described under Prong C — see the resolution note under that prong.

## Why it is mislabeled and unrescued

- **Mislabel (Prong C) — since resolved.** At the time, the daily-budget cause was
  detected only on *cumulative* exhaustion (`policyHorizon.ts` `isDailyBudgetExhausted`:
  `perBucketBudgetKWh ≤ ε` AND cumulative ≥ daily cap). The `− backgroundKWh` squeeze
  leaves `perBucketBudgetKWh > 0`, so `dailyBudgetExhaustedBucketCount: 0` and the
  surface showed a generic physical "Cannot finish" instead of a budget-attributed
  state. That classifier no longer exists: attribution now runs through
  `resolveBudgetBoundFeasibility` → `budgetBound` (`horizonPlanner.ts`), which asks
  whether the soft daily budget is the ONLY binding constraint rather than whether the
  day total is spent, and `dailyBudgetExhaustedBucketCount` is retired — nothing writes
  it, and it is accepted on read only for history persisted by an older build
  (`planHistorySettings.ts`).
- **Slice-1 can't rescue it:** `resolveClimbedBandFeasibility` re-allocates at the
  top step on the same budget-capped buckets; the cap is step-independent, so
  climbing adds nothing → stays flat `cannot_meet`, never `at_risk`. Slice-1 only
  helps a step-power shortfall.

## Prong B resolution (2026-05-23)

The 2026-05-22 symptom (plan stays budget-capped despite exempt-from-budget set)
turned out to be **config-side, not a wiring bug.** Prod telemetry from PR #977
the next day shows `rescueExemptMode: "always"`, `budgetExemptApplied: true` on
Connected 300 — the planner sees and applies the rescue as designed.
`resolveHorizonPlanWithRescue` (`rescueReplan.ts`) rebuilds the horizon with
caps lifted only when `objective.rescue?.exemptFromBudget === 'always'`; the
2026-05-22 trace simply caught the rescue before it had been set to that mode
(or on the wrong device). No code fix needed.

**B2 (the `isCurrentBucketPlanned` self-disarm question):** confirmed
**intentional** per the field comment at `diagnosticsBridge.ts:98-101`:
> True only while the current bucket is a planned bucket for a smart task whose
> "exempt from budget" rescue permission is active. Admission consumes this
> flat flag … idle/background cycles stay normal.

The `limitLowerPriorityApplied` companion carries the same intent. Rescue
applies during planner-scheduled hours; during planner-avoided hours the soft
budget binds normally. Closed, no action needed.

## Telemetry (Prong A, landed)

`deferred_objective_horizon_planned` now carries `rescueExemptMode`,
`rescueLimitMode`, `budgetExemptApplied`, `limitLowerPriorityApplied`, so the
config-vs-code question is answerable from prod logs.

## Prong D: daily budget DISABLED also zero-capped allocation (fixed)

A distinct cause of the same `cannot_meet` symptom, found while building the
boost SDK-boundary e2e (`deferredObjectiveBoostNoBudgetStepUpE2E.test.ts`): when
the user has the daily budget **disabled**, `dailyBudgetService.getSnapshot()`
still returns a snapshot with `budget.enabled: false` but an all-zero
`allowedCumKWh`. `policyHorizon.ts` nulled `dailyBudgetKWh` when disabled (so the
*exhaustion* classifier stayed off) but still computed
`perBucketBudgetKWh = allowedCumKWh[i] − allowedCumKWh[i-1] = 0`, so
`resolveMaxUsefulEnergyKWh = max(0, 0 − 0) = 0` — capping **every** bucket to
zero useful energy. A non-exempt (plain) smart task therefore booked nothing and
reported `cannot_meet` whenever daily budget was off — the opposite of the
"no daily budget ⇒ the hourly hard cap is the only constraint" contract. Boost /
exempt tasks dodged it (`exemptFromBudget` lifts the cap via
`resolveMaxUsefulEnergyKWh`), so it only bit ordinary tasks.

Fix: `collectDayBudgetOverlays` now contributes **no overlay** for a day whose
`budget.enabled === false`, so each bucket falls through to `NO_BUDGET_OVERLAY`
(`perBucketBudgetKWh: null` ⇒ no cap; `backgroundKWh: 0` ⇒ `reservedHeadroomKw`
falls back to the full hard cap). The enabled-but-exhausted path
(`isDailyBudgetExhausted`, since retired — see Prong C above) was untouched.
Guarded by the "plain task allocates with daily budget OFF" case in the boost e2e.

### Terminology aside: `rescue` is a misnomer

The two extra-permission fields (`exemptFromBudget`, `limitLowerPriorityDevices`)
live under `objective.rescue` but are **standing** permissions — their value is
literally `'always'`, and they apply on every planned cycle, not as a one-shot
rescue. The name is a holdover from the starvation "Get power now" lane where the
pair was first introduced. The persisted key is intentionally left as-is
(renaming would break persisted state + the contract for a naming cleanup).
