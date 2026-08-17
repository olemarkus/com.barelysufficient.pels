# Shedding Planner Boundary

Shedding selection belongs in `lib/plan/shedding`; `planDevices.ts` materializes decisions and must not select new shed devices.

Keep this module as the single place that chooses devices for capacity, daily-budget, or hourly-budget shedding. Plan materialization may copy `shedSet`, `shedReasons`, and `shedStepTargets`, but it should not independently set a device to `plannedState: 'shed'` as a new selection decision.

The shedding planner decides what to shed and HOW FAR — for a stepped device, which rung of its own ladder the shed leaves it at. It does not decide how to actuate that: the transport, the command ordering, and the temperature-target projection stay outside. The distinction is what `shedStepTargets` respects — it names a destination the module already priced its decision on, not an instruction to a device.

## Module layout

- `candidates.ts` — the collect loop and the candidate ranking, plus the one cycle-level quantity per-device pricing needs: it hands `deficitKw` down so the stepped builder can rank on the rung a first pick would take.
- `candidateBuilders.ts` — binary + temperature builders, and the two eligibility predicates.
- `steppedCandidates.ts` — every stepped builder, plus the ladder pricing (`resolveSteppedShedLadder`) and the rung choice (`chooseShedRung`) that selection spends against.
- `candidateSkipLog.ts` — why a controlled device did not become a candidate.
- `selection.ts` — the greedy pick over the ranked candidates, and the rung each one is taken at.

## A device may only be selected when limiting it releases power

Every selection site here already enforces it — `buildBinaryCandidate`, `buildTemperatureCandidate`, `buildSteppedCandidate` and `buildPreparedSteppedBinaryOffCandidate` all reject a candidate whose `effectivePower <= 0`, and `buildSwapCandidates` skips `pwr <= 0` the same way. Keep it that way.

Shedding a device already drawing nothing frees nothing, but it still costs a write and then makes the device fight back through restore cooldown and backoff. The one lane that ignored this (`pauseHold.ts`, deleted) turned off ten zero-draw devices in production on 2026-07-31 while 2.48 kW sat available. Needing a device to stay off *pre-emptively* is not a shed decision — express it as an admission term instead (`lib/plan/admission/headroomReserve.ts`).

## …but ask the whole ladder, not just the next rung

The rule above is about the ANSWER, not about how hard you looked for it. For a stepped device the two got conflated: `getSteppedLoadShedTargetStep` returns one rung down, and pricing only that rung made "this rung frees nothing" read as "this device frees nothing".

`resolveSteppedLoadImmediateReliefKw` caps *both* sides of the step delta by the current measurement, so the moment measured draw sits at or below the next rung's admission estimate the delta is exactly zero — for any from-step. A device pinned at `max` and one idling at `low` price identically. Prod 2026-08-05 (`inc_26449fb9`): a water heater's `measure_power` lagged its step-up by ~5 minutes, `max → medium` priced at 0, the heater was never a candidate, and the house sat 526 W over the hard cap for 4.5 minutes while the meter showed it drawing 2.9 kW.

`resolveSteppedShedLadder` (`steppedCandidates.ts`) prices the WHOLE ladder — every reachable step down, gentlest first, each with the relief it releases — and drops the rungs that release nothing. It cannot invent relief: every rung goes through the same `resolveSteppedCandidatePower`, so the deepest rung buys the device's whole reported draw and no more. One constraint on which rungs are offered:

- **Only `turn_off` descends past the adjacent rung.** A `set_step` shed still offers its adjacent rung alone. Lifting that is a separate change; do not fold it in here.

## The rung is chosen when the candidate is SPENT, not when it is built

`chooseShedRung(rungs, neededKw)` answers the gentlest rung whose priced relief covers `neededKw`, and the deepest priced rung when none does. `selectShedDevices` calls it with the deficit still open at that candidate's turn.

It has to be that way round. Every candidate is priced and ranked before the loop spends anything, so a rung fixed at build time is sized against the cycle's OPENING deficit and knows nothing about what earlier picks already covered. Two stepped devices eligible in one cycle is enough: a 3 kW deficit, 2 kW banked by the first, and the second still cut for a full 3 kW — 5 kW shed to close 3. The over-shoot grows with the deficit, and it was masked for as long as a `turn_off` device was delivered as a full cut whatever rung was credited.

The kW compared must be a measured deficit (`deficitKw` and the remainder derived from it), never `needed`, which carries `Number.POSITIVE_INFINITY` as a severity sentinel in an exhausted hour (`ShedCandidateParams`). Fed the sentinel, no rung covers and every stepped `turn_off` candidate collapses to its off rung.

An unconfirmed candidate banks nothing, so everything behind it is sized as though it had not been taken. That is deliberate — the watts have not moved, and covering a deficit on a promise declares a breach closed while it is open — and it errs toward covering the breach rather than under-shedding it.

## The chosen rung is the delivered rung

`shedStepTargets` carries the chosen rung from `selectShedDevices` into materialization, alongside `shedReasons`, and `resolveSteppedLoadDirectShedStepId` returns it unchanged. So credited relief equals delivered relief by construction, and the configured shed behaviour is only the FLOOR — the deepest this cycle may go — read solely as a fallback when no rung was decided.

It did not use to be. Materialization recomputed the step from the device alone and answered the off step for every `turn_off` device, so the chosen rung decided **candidacy and nothing else**: a `turn_off` shed shipped as a full cut whatever rung the deficit was credited against. That made under-shedding invisible — 15 of 70 trim decisions on one production charger (11–17 Aug) chose a rung smaller than the deficit, worst case 3.77 kW answered with a 1.01 kW rung — and the full cut over-covered it every time.

Two consequences to keep straight:

- **`turn_off` no longer implies a full cut**, so the decided end state, not the behaviour, is what downstream reads: `resolvePlannedShedTargetKind` answers `step` for a device parked at an active rung, `resolveSteppedLoadTransition` enters `full_shed_to_off` only for the `binary_off` end state, and the executor converges on that kind (`lib/executor/AGENTS.md`).
- **The ranking keys must not depend on the chosen rung**, since the rung is not known until spend time. `effectivePower` is therefore the device's deepest priced relief — everything limiting it can free — and `preemptiveStepDown` asks `chooseShedRung` against the cycle's OPENING deficit: "if this candidate went first, would it still be running?". For a first pick that is not an approximation, it is the question. Do not loosen it to "has any lower rung at all": that ranks a device ahead of the owner's priority order on the strength of a reduction it will not take — a 1 kW stepped load against a 3 kW deficit sorts first, finds no covering rung, takes its off rung anyway, and the binary load the owner ranked as sheddable-first is shed as well.

A descent that lands on the off step is a full turn-off, and `sortCandidates` is explicit that those follow normal priority ordering — marking one preemptive would jump the queue past devices the owner ranked as sheddable first.

Selection stops on the deficit and on nothing else (`selection.ts`): the relief of the candidate just taken is banked before the loop asks again. It used to break right after a preemptive step-down, which — while the rung was unsized — ended a cycle on a step-down worth a fraction of the deficit with the breach still open and nothing else limited.

## A skip must be reviewable

Candidate gathering has a dozen exits that drop a device. Each one records a reason through `candidateSkipLog.ts`, rolled up into one `plan_shed_candidates_skipped` event per cycle and counted onto `OvershootStats`. Do not add a bare `continue` / `return null` to the collect loop or the builders without a reason code.

This exists because the counters in `hard_cap_shortfall_detected` cannot answer the question: `blockedByCooldownDevices`, `blockedByPenaltyDevices` and `blockedByInvariantDevices` are all RESTORE-side holds (`lib/planContract/planDecisionSemantics.ts`). All three read zero through the incident above, which made "nothing was blocking" look like a finding when the truth was "the one device that mattered was never a candidate". Devices that are not controllable at all are out of scope rather than skipped, and are deliberately not recorded — matching `controlledDevices` in the capacity summary.

## An unchanged reading is not new evidence

Whole-home power lags the switch: the meter aggregate (and the 10 s `homey_energy` poll behind it) can repeat the pre-shed watts for a poll or two after a device is confirmed off. A repeat is a re-delivery of the reading the last shed was already decided on, so `resolveSameMeasurementSheddingDecision` refuses to deepen on it for a short hold (`UNCHANGED_READING_SHED_HOLD_MS`, `overshoot.ts`) — otherwise the planner cuts into devices the user ranked higher for a deficit the previous shed already covered. Equality is exact so that any real movement, in either direction, is still acted on at full speed, and the hold releases early if the deficit itself grows (a tightened soft limit is a new question, not a re-delivered answer). Do not remove the hold to make shedding "more responsive": the deficit it protects against is imaginary.

A held cycle re-asserts the shed this module itself decided (`lastShedPlanShedIds`) and adds nothing. It must never re-derive that set from the FINAL plan's shed set (`lastPlannedShedIds`), which carries holds merged in after this module ran; handing one of those a capacity shed reason mislabels it and clamps unrelated stepped loads. Its window is anchored on `lastShedPlanAtMs`, not the overshoot mitigation clock, because `PlanBuilder` runs shedding *before* `OvershootTracker.updateOvershootState` nulls that clock on overshoot entry.

## Declining to shed is not deciding there is no overshoot

`buildSheddingPlan` takes both halves of the soft-overshoot decision (`SheddingOvershootInput`). `shedActionable` gates SELECTION — may this cycle choose devices. `actionable` gates the shedding-active LATCH through `updateGuardState`. Never collapse them back into one flag.

The whole restore side stands down while headroom is negative, on the assumption that this module has already said what stays limited: `resolveOffDeviceReason` returns the caller's own reason on `activeOvershoot`, `resolveCapacityRestoreBlockReason` returns `null`, and `applyRestorePlan` reaches its stay-off marking through `sheddingActive`. So a cycle that both selects nothing *and* leaves the latch off has nothing at all holding a device that is already off — it materializes as `keep`, and the executor turns it on. That is the 2026-08-16 restore-all: the shed grace (`resolveShedGraceMs`) deferred a shed, the latch went with it, and five thermostats came back on into a hard-cap crossing. Regression cover: `test/integration/planShedGraceHoldsExistingShed.test.ts`.

The general form: an empty `shedSet` this cycle means "nothing NEW to limit", never "release what is limited". Any future reason to withhold selection has to keep saying the overshoot is real.
