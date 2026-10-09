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
verdicts, surfaced by the 2026-05-22 prod walk.

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

## Slice 2 — shipped (PR #983): reserved-headroom committed floor

Resolution pattern matches the Slice 2 sketch:

- Producer (`taskEvaluationCoordinator.ts` + `policyHorizon.ts`) plans smart tasks in resolved device-priority order (device id breaks ties). Each governing higher task publishes its booked admission-power and useful-energy claims, with admission power capped at the current profile's maximum step. A higher-ranked device outside task control contributes its maximum step across the horizon. The next task receives `reservedHeadroomKw = max(0, planningCeilingKw − grossBackgroundKWh/durationHours − higherPriorityAdmissionPowerKw)` and its hourly useful-energy cap minus non-exempt higher-task kWh (`planningCeilingKw` is `limitKw − marginKw`, the rate the capacity guard actually admits, not the raw tariff ceiling, while Capacity limit is on; the grid import target when that is lower or Capacity limit is off; absent, with no reserved headroom, when no power limit is enabled). This preserves the physical/useful distinction and prevents two tasks from double-booking the same slot while allowing a lower task to fill genuine residual capacity. `grossBackgroundKWh` comes from `plannedGrossUncontrolledKWh` when available, while `plannedUncontrolledKWh` remains the net daily-budget cap input.
- Rescue boundary (`rescueReplan.ts`) resolves `fullyReserved` when both rescue permissions are `always` and every higher-ranked device is represented by a task booking or a maximum-step reserve. A temporarily missing device or ladder cannot supply that maximum, so the lower task keeps its minimum-step floor.
- `horizonPlanner.ts:resolveStepForBucket` consumes the residual forecast and picks the highest active step whose admission power (the step's nameplate) fits that bucket. Min step when a power limit exists but the bucket has no forecast. With no power limit enabled (`DeferredObjectivePowerLimit` `unlimited`) there is no ceiling to verify against and live control admits every rung, so the floor is the top step.
- Under a grid import limit, in a home with no solar production, the ladder itself is cut at the grid import target (`admitUnderPowerLimit`): that limit is instantaneous, so with nothing exporting a rung above it is never let run and the plan books none. A device whose lowest rung is above the target plans nothing (`cannot_meet`, `no_bucket_capacity`). A home with solar production keeps the whole ladder: live admission spends signed net headroom, so export can let such a rung run, and the horizon has no per-hour solar forecast to tell when. Capacity alone is an hourly average and keeps the whole ladder.

The higher-rank reserve is the safety floor. The task may displace lower-ranked controlled load when permitted, but cannot displace a device above it. A governing higher task is accounted for by its timed booking; a plain or satisfied higher device is accounted for at the maximum step PELS knows from its planner profile. The profile is an estimate of possible draw, not a measurement of what the device will use every hour. Top priority is the trivial case with nothing above.

The hard cap stays untouchable: this only changes which deterministic step the producer commits to. Capacity guard still enforces the wall; the per-cycle re-solve + deadline reserve still catch over-promise.

## Climbed-band probe is correctly conservative

A committed multi-step plan whose floor falls short and whose probe at `climbStep` also returns `cannot_meet` is *not* a probe failure — it's the commitment doing its job. Each hour's per-hour kWh cap (`committedHours[i].plannedUsefulEnergyKWh`) is the truth of the commitment; the probe respects that cap rather than second-guessing it, which is exactly the "no silent recovery from a stale commitment" guarantee the probe was designed to preserve. If you want the per-hour ceiling to be higher, the commitment must be made at a higher step — Slice 2's job.

Prod evidence (`/tmp/pels` 2026-05-23, Connected 300, pre-Slice-2 deploy): `cannot_meet`, `floorShortfallCause: time_capacity`, `requestedMinimumStepId: low`, `plannedUsefulEnergyKWh: 8.91` vs needed 10.6, 8 buckets × 1.25 kWh each. This is the *correct* math for a commitment sized at min step — the probe at top step found no extra room because the commitment didn't reserve any. Slice 2 fixes this kind of case at the commitment layer for fully-reserved tasks whose higher-ranked devices have known bookings or maximum-step reserves. Other lower-priority tasks consume the exact residual slot at their active floor.
