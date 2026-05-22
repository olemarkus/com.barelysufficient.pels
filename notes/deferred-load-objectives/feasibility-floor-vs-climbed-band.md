# Feasibility: floor commitment vs climbed-band classification

How the deferred-objective horizon planner decides `on_track` / `at_risk` /
`cannot_meet` for a stepped device, and why the *commitment* and the
*feasibility verdict* are deliberately sized off different step powers.

## The problem this addresses

The planner commits energy against the **lowest non-zero step**
(`activeSteps[0]` in `horizonPlanner.ts`). That is correct for the commitment:
the min step is the only level guaranteed for the full hour — higher steps
depend on transient headroom and can be denied mid-bucket
(`hard-cap-is-physical`).

But the same min-step number was also driving the **status verdict**: any
energy the floor allocation could not place became `unplannedUsefulEnergyKWh`,
and `resolveStatus` reported a flat `cannot_meet`. Meanwhile the executor
opportunistically climbs to higher steps whenever capacity allows, so the device
very often finishes anyway. The result was chronic false `Cannot finish`
verdicts (see the P0 in `TODO.md`, surfaced by the 2026-05-22 prod walk).

The fix must **not** plan against the max step — that trades a false
`cannot_meet` for a false `on_track`, because peak steps are not guaranteed.

## Slice 1 — shipped: climbed-band classification (PR for this branch)

Two numbers, not one:

- **floor** — min-step allocation. Unchanged. Drives the commitment, the
  committed-replan path, and every `plannedBuckets` figure.
- **climbed band** — a *classification-only* probe at the highest active step.

When the floor allocation leaves energy unplanned, `resolveClimbedBandFeasibility`
re-runs the allocator at `activeSteps[last]` **in the same commitment mode** as
the floor pass (committed vs fresh). The result feeds only `resolveStatus`:

| floor fits? | climbs to fit? | status | detail |
|---|---|---|---|
| yes | — | `on_track` / reserve / policy | (unchanged) |
| no | yes | `at_risk` | `feasible_above_floor` |
| no | no | `cannot_meet` | `target_cannot_be_met` |

Key properties:

- **Commitment never moves.** The probe result is discarded except for the
  status label, so `hard-cap-is-physical` holds — we still only *plan* the
  guaranteed floor.
- **No silent recovery.** The probe mirrors the commitment mode, so an active
  commitment with zero committed hours (a previously stored `cannot_meet` plan)
  has an empty committed map → the climbed probe also allocates nothing → stays
  `cannot_meet`. The probe must never re-run the fresh optimizer for a committed
  objective.
- **Single-step devices** (EV chargers, `activeSteps.length === 1`, or all steps
  equal power) cannot climb, so they skip the probe and keep the floor verdict.

User copy keys off `status`, so `at_risk` already renders "At risk" — no new copy
strings. `feasible_above_floor` flows to diagnostics `reasonCode` via the
existing `HorizonPlan['statusDetail']` union.

`feasible_above_floor` is the first `at_risk` verdict that can co-occur with an
empty floor schedule (reserve/policy at-risk always plan buckets). The
notification gate (`activePlanSchedule.ts` `shouldFireNotification`) therefore
treats an empty-schedule collapse under `at_risk` as a "plan blew up" event and
fires, the same as `cannot_meet`/`invalid` — otherwise the warning these
objectives previously emitted while `cannot_meet` would silently disappear.

### What Slice 1 does NOT fix

- Cause #1 of the P0 (volatile, low-confidence learned `kWhPerUnit` from rejected
  profile samples) is independent and untouched.
- A **committed** objective whose floor falls short stays conservative: the
  committed allocator caps each hour at the floor-committed kWh, so the climbed
  probe shows no extra feasibility there. Refining "executor climbs *within*
  committed hours, so a committed hour over-delivers past its floor kWh" changes
  committed semantics and is deferred (Slice 2 territory).

## Slice 2 — deferred design: reserved-headroom committed floor

The open question (raised in design discussion, **not implemented**): when an
objective is exempt from the daily budget **and** holds the
`limit_lower_priority` rescue permission, the higher step is *as guaranteed as
the min step* — both rest on "we can clear competitors up to the hard cap; only
non-sheddable load can deny us." In that case the committed floor arguably should
*rise* to the highest step the reserved headroom guarantees, not stay at min.

Why it is deferred, not built:

1. **No data path.** The horizon planner has no model of physical capacity
   headroom. `policyHorizon.ts:27-30,55-56` models the *soft daily-budget*
   per-bucket allowance only; physical capacity is enforced downstream at
   admission / the capacity guard and never flows up. A committed higher floor
   needs the producer to resolve a *forecast of reserved headroom across the
   horizon* (cap − non-sheddable − higher-priority), including a non-sheddable
   load forecast — a real cross-layer change governed by the
   resolution-in-producer rule.
2. **Revisits PR #944.** That PR deliberately left `horizonPlanner` untouched
   ("under-promise, over-deliver"; boost delivers the higher run at runtime).
   The discarded `guaranteedKw` approach there failed because it assumed headroom
   and used the burst-rate soft limit (exceeding the hard cap). A correct Slice 2
   must *verify* headroom, not assume it — otherwise it repeats that mistake.
3. **Recovery backstop exists.** A higher committed floor that occasionally slips
   is not catastrophic: the horizon re-solves every cycle (`resolveReplanReason`)
   and re-allocates remaining energy across remaining hours, the deadline reserve
   hour flips to `at_risk` with warning runway, and the rescue lane escalates.
   This is what would make an aggressive-but-headroom-verified floor safe — but
   it is the justification for Slice 2, not a substitute for the missing headroom
   forecast.

Sketch if pursued: producer (capacity/observer layer) resolves a flat
`reservedHeadroomKwByBucket` onto the horizon input; `resolveAllocation`'s floor
step becomes "highest active step whose `usefulPowerKw` fits the bucket's
reserved headroom" instead of always `activeSteps[0]`; min-step remains the floor
for unreserved objectives. The `feasible_above_floor` band from Slice 1 still
covers the genuinely-uncertain middle.
