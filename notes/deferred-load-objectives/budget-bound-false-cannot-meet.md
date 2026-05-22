# Budget-bound false `cannot_meet` (+ exempt-from-budget not applied)

Status: Prong A (rescue/exempt telemetry) and Prong C (budget-bound vs physical
status classification) shipped. Remaining: route the per-bucket *background
squeeze* copy via a producer-resolved budget-bound flag on the persisted revision
(P1 — the literal "Connected 300" case is de-alarmed but still shows device-side
copy), and the Prong B exempt-not-applied diagnosis (gated on the telemetry / a
live rescue check). Tracked in `TODO.md` P0. Not data-gated like the confidence
(Cause #1) work.

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

## Why it is mislabeled and unrescued

- **Mislabel (Prong C):** the daily-budget cause is detected only on *cumulative*
  exhaustion (`policyHorizon.ts` `isDailyBudgetExhausted`: `perBucketBudgetKWh ≤ ε`
  AND cumulative ≥ daily cap). The `− backgroundKWh` squeeze leaves
  `perBucketBudgetKWh > 0`, so `dailyBudgetExhaustedBucketCount: 0` and the
  surface shows a generic physical "Cannot finish" instead of a budget-attributed
  state.
- **Slice-1 can't rescue it:** `resolveClimbedBandFeasibility` re-allocates at the
  top step on the same budget-capped buckets; the cap is step-independent, so
  climbing adds nothing → stays flat `cannot_meet`, never `at_risk`. Slice-1 only
  helps a step-power shortfall.

## The twist: exempt-from-budget set but not applied (Prong B)

`resolveHorizonPlanWithRescue` (`rescueReplan.ts`) rebuilds the horizon with the
caps lifted (`exemptFromBudget: true`) only when
`objective.rescue?.exemptFromBudget === 'always'`, and the diagnostic path uses it
(`diagnosticsBridge.ts`). With exempt applied the floor would fill multiple buckets
→ `on_track`. The plan stays budget-capped `cannot_meet`, so the planner's
objective is not seeing `exemptFromBudget: 'always'`. Card→settings write
(`flowCards/smartTaskRescueCard.ts`) and planner read (`appInit.ts` via
`DEFERRED_OBJECTIVES_SETTINGS`) look correct in code, so this is likely config
(wrong device / `when ≠ always`) or a load/snapshot drop of `.rescue`. Determine
config-vs-code from the new telemetry (next restart) or a live
`objectivesByDeviceId[...].rescue` check before any fix.

B2: `budgetExemptApplied = rescue === 'always' && isCurrentBucketPlanned`
(`diagnosticsBridge.ts`) — the execution-side exempt self-disarms when the current
bucket is "avoid"/empty. Decide whether that coupling is intended.

## Telemetry (Prong A, landed)

`deferred_objective_horizon_planned` now carries `rescueExemptMode`,
`rescueLimitMode`, `budgetExemptApplied`, `limitLowerPriorityApplied`, so the
config-vs-code question is answerable from prod logs.
