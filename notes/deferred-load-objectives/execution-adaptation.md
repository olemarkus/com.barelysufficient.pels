# Execution Adaptation: trajectory rebase + mid-execution price deferral

Status (2026-06-01): **both work items shipped.** WI-1 (trajectory rebase) merged earlier; WI-2
(mid-execution price deferral) ships on top of the **hourly-settle foundation** (the active-plan
recorder now writes once per hour at `:58`, driven by the lifecycle clock), which is what makes
the per-cycle release clean — admission's override is structurally insulated from the
clock-driven recorder. Builds on the active-plan replan policy in
[`README.md`](./README.md) §"Active plan persistence and replan policy".

## Motivating evidence (prod, Connected 300, night of 2026-05-31)

A soft `reach 65 °C by 06:00` objective on a stepped water heater. From the prod logs
(`/tmp/pels/start.main.0a4464c3.stdout.log`):

- The tank started cold (19.8 °C) at the 20:00 local cold-start tick and the device ran
  its full element (~2.87 kW) through the two **`avoid`** (expensive, 86 øre) evening
  hours. Temperature went 19.8 → 53.4 °C across 20:00–22:00 local — **~76 % of the entire
  ~44 °C heating job was delivered in the two most expensive hours**, then the device
  coasted/idled through the cheap (73 øre) overnight hours.
- The displayed "Initial schedule" and "Revised trajectory" series sat at ~28 °C at 22:00
  while measured was ~53–62 °C. Confirmed cause: both series are built by
  `integratePlannedStaircase(plan, startProgress, …)` in
  `packages/shared-domain/src/deferredPlanHistoryChartData.ts`, anchored at
  `entry.startProgressC` (the temperature at *task creation*) plus cumulative booked
  energy. They are never rebased onto measured progress.
- Overnight, with measured at 62–64 °C and status `on_track`, the objective kept emitting
  `requestedMinimumStepId = low` and re-booking ~1 kWh every hour. The device did not
  overheat **only because its own thermostat cut out** (`near_target_idle`, 0 kW draw) —
  PELS leaned on the appliance to stop; its own plan never did.

## Why the device wasn't limited in the expensive hours

The cold-start tick computed `cannot_meet` (`energyNeeded` 19.39 kWh floor / 15.94 kWh
mean vs 13.76 kWh of bucket capacity across the 10 remaining hours). When `unplanned > 0`,
`allocateEnergyToBuckets` fills **every** bucket cheapest-first — including `avoid` ones —
because there is nothing to defer to. So booking (and running) the expensive evening hours
was the correct response *to those inputs*. The waste only appears in hindsight: the device
is fast enough that it reached target well before the deadline, so it did not actually need
the expensive hours.

The objective expresses "run this device" to the planner as a **floor only**
(`requestedMinimumStepId`, derived in `horizonPlanner.resolveCurrentBucketPlan` →
`stepSelection.selectMinimumStepForEnergy`, which returns `null` at ≤ ε energy). There is no
price-aware **ceiling**: whenever capacity headroom exists, the device runs at its full
element power regardless of the hour's price tier. Combined with the cold-start
`cannot_meet`, that put the bulk of the energy in at peak price.

## Governing invariant — no revision hysteresis

The commitment floor (`mergeHoursPreservingCommitment` = `Math.max`) and the `sameHourSchedule`
diff gate exist specifically to stop the active-plan record from churning revisions as
estimates drift (README §"Replan policy"). **Nothing in this note may reintroduce that churn.**
Both work items live entirely in the **advisory per-cycle layer** — control + render. Neither
writes a commitment revision, moves committed hours, or fires `deadline_plan_changed`. The
persisted commitment and its `history[]` stay exactly as stable as they are today.

Concretely: an earlier draft proposed releasing an `avoid` hour by rewriting its committed kWh
to 0 (a downward `measured_deviation` revision). **That is rejected** — it punches a hole in
the floor and is the direct path to revision hysteresis. The release is a **live control-layer
override only** (see work item 2). Two distinct flap concerns, handled separately:

- **Revision flap** (record churns, `deadline_plan_changed` fires, `history[]` fills) —
  *eliminated structurally* by keeping the recorder out of the loop; the commitment never
  changes.
- **Control flap** (device toggles on/off) — bounded by the existing shed/restore cooldowns
  (60–300 s) plus the conservative-estimate and sticky guards in work item 2.

## Work item 1 — Rebase the revised trajectory onto measured progress — DONE

**Scope: display-only, post-finalization history-detail chart.** The live active-plan chart
(`packages/settings-ui/src/ui/deadlinePlan.ts`) is a *separate* builder and already
measured-anchored — it back-calculates `startProgress` from `current − delivered × rate` and
projects forward from there. The live control path is also measured-correct
(`resolveProfileEnergy` uses `remainingUnits = target − measured`). The "climbing from 20 °C"
defect was only in the post-finalization **"Progress history"** chart
(`packages/shared-domain/src/deferredPlanHistoryChartData.ts`).

**The defect.** `composeTrajectoryData` → `integratePlannedStaircase(plan, startProgress, …)`
built *both* planned series from `startProgress = entry.startProgressC` (task-start temp) plus
cumulative booked energy. For a mid-run replan that meant the "Revised trajectory" re-climbed
from the start temperature even though the device was already near target when the revision was
computed.

**The fix (shipped in this PR).**
- The **revised trajectory** (`finalPlan`) re-anchors at the measured progress at the
  revision's `revisedAtMs` and the staircase is drawn forward from there — hours that fully
  elapsed before the anchor are dropped (they're already in the observed line). Helper:
  `buildRevisedStaircase`. The anchor value comes from `observedValueAt`, which **interpolates**
  between the samples bracketing `revisedAtMs`: the recorder keeps only one progress sample per
  hour, so a mid-hour revision rarely has a sample exactly at `revisedAtMs`, and interpolating
  recovers an accurate anchor instead of snapping to the stale prior-hour reading.
- **Coverage-aware straddling hour (the tricky part).** A hour can be either a full-hour
  commitment *floor* (whole-hour energy) or an already-*trimmed* current hour whose stored
  `plannedKWh` is only the post-`nowMs` remainder (`buildHoursFromHorizonPlan` trims the current
  bucket's start to `nowMs`). The chart cannot tell these apart from `{startsAtMs, plannedKWh}`
  alone, so we persist the disambiguator: a new optional `coversFromMs` on
  `DeferredObjectiveActivePlanHourV1` (contract), set by `buildHoursFromHorizonPlan` when the
  earliest folded bucket starts after the hour boundary. The chart prorates each straddling hour
  over its **covered span** `[coverStart, hourEnd]` (`coverStart = coversFromMs ?? startsAtMs`):
  a full-hour floor is prorated by the post-anchor fraction of the whole hour; a trimmed hour
  whose trim point is at/after the anchor is added **whole** (prorating it would double-trim); a
  trimmed hour carried forward with a trim point *before* the anchor (an earlier same-hour
  revision's floor) is prorated over its covered span, dropping the pre-anchor sliver.
  `mergeHoursPreservingCommitment` carries the winning entry's coverage so a full-hour floor that
  wins the `Math.max` clears a stale trimmed `coversFromMs`. `coversFromMs` survives into the
  history snapshot via the existing `{ ...hour }` copy; `sameHourSchedule` ignores it (no
  revision churn). This touches **persisted state** (active-plan / history snapshot) but is
  back-compatible: legacy entries without the field read as full-hour (today's behavior).
- The **Initial schedule** (`originalPlan`) stays anchored at `startProgressC` — the
  original-intent reference, unchanged.
- The recorded `startProgress` is seeded as the first interpolation bracket, so a replan in the
  task's first hour (whose seeded start sample the recorder may have overwritten) still
  interpolates from start. The revised staircase falls back to the fully start-anchored plan only
  when the revision is at/before the window start (no real replan) — so brand-new runs render
  exactly as before.
- Producer-side per `feedback_layering_resolution_in_producer`: the re-anchoring + coverage
  resolution live in the producer layers; the settings-UI consumes flat points and never
  branches on the anchor or `coversFromMs`.

**Tests (added).** `deferredPlanHistoryChartData`: a late revision re-anchors the revised line
at the measured value (not `startProgressC`); the anchor is interpolated when no sample lands at
`revisedAtMs`; a straddling full-hour floor is prorated; a straddling *trimmed* hour
(`coversFromMs`) is added whole; a trimmed hour carried forward with `coversFromMs` *before* the
anchor is prorated over its covered span; the no-observed-sample, revision-at-start, and
no-`originalPlan` fallback cases stay start-anchored. `activePlanSchedule`:
`buildHoursFromHorizonPlan` records `coversFromMs` for a trimmed current hour, and the merge
clears it when a full-hour floor wins / keeps it for a fresh trimmed hour. The existing
identical-staircase / replan overlay cases still hold.

## Work item 2 — Mid-execution price deferral (limit when a cheaper hour can do it) — DONE

Stop drawing real power in an `avoid` hour when the remaining work fits in cheaper hours by the
deadline. Shipped as a producer-resolved flag + a per-cycle admission release:

- The horizon planner resolves a live `priceDeferralEligible` flag
  (`resolvePriceDeferralEligible`, `horizonPlanner.ts`) — true when the current hour is an
  `avoid` bucket carrying booked energy AND a fresh re-allocation of the buffered-floor residual
  over the remaining (cheaper, non-`avoid`) hours alone lands `on_track`.
- The decoration controller's admission reads the flag (`isReleasedCurrentHour`, `admission.ts`)
  and idles the device this cycle (ev_pause / shed_release / plain idle by device kind),
  reusing the existing release posture. No executor change — limiting is "request nothing."

**Why it's clean now (the foundation made it so):** the original sketch below worried the
per-cycle release would churn the recorder. On the hourly-settle foundation it can't: admission
runs on the **decoration controller's** diagnostics (power cycle); the recorder runs on the
**emitter's separate** diagnostics (clock, settles once per hour at `:58`). The release override
lives only on the admission path, so it **structurally** never reaches the recorder. The device's
idling (no progress) is what re-books the cheaper hours at the next `:58` settle — one honest
revision, not churn.

### Release test (evaluated each cycle, only while `currentBucket.preference === 'avoid'`)

1. **Conservative residual.** Take `energyNeededKWh` — the buffered floor (`mean + k·SE` from
   `integrateBands`), **not** the mean — for `remainingUnits = target − measured`.
2. **Re-allocate over future hours only.** Run a fresh `allocateEnergyToBuckets` over the
   **non-current** buckets with that residual (current `avoid` hour excluded).
3. **Check status.** Apply `resolveStatus`. Release iff it returns `on_track`
   (`unplanned ≤ ε ∧ !usesDeadlineReserve ∧ (soft ⇒ !usesPolicyAvoid)`). Otherwise keep
   running — we genuinely need this hour. (`planned_using_policy_avoid` is literally "we are
   only `at_risk` because we are leaning on an `avoid` hour" — its *absence* after excluding
   the current hour is the release signal.)

### No commitment rewrite — release is a live override (preserves the floor)

The release does **not** touch the persisted commitment. The committed `avoid` hour stays
booked as a **fallback**; the release is a per-cycle override in the control layer that, when
the test passes, makes the current `avoid` hour's *effective* contribution 0 →
`requestedMinimumStepId` null → admission decides `idle` (device kept off this cycle).

- **Insertion point:** the live `DeferredObjectiveHorizonPlan` that admission consumes (after
  `resolveCurrentBucketPlan`). The recorder's committed hours, `sameHourSchedule`, and
  `history[]` are **insulated** — they keep observing the committed allocation, so no
  `schedule_revised` / `deadline_plan_changed` / `measured_deviation` revision is ever written.
- The `Math.max` floor invariant is therefore **preserved, not carved out**. If the cheaper
  hours later fall short (measured drifts down, residual no longer fits), the same live test
  simply stops overriding and the still-committed fallback hour runs — no revision in either
  direction.
- **Watch-out:** the override must not reach the recorder's hour-set. A current-hour
  `plannedKWh → 0` that `buildHoursFromHorizonPlan` would *drop* must not propagate to the
  recorder, or it re-creates the exact revision churn we're avoiding. Apply the override on the
  admission input while the recorder still observes the committed plan.

### Timing

- The release is evaluated per cycle and is reversible, so it can fire as soon as the test
  passes (even early in the hour), subject to the sticky guard below.
- **Future `avoid` hours are never proactively dropped.** They stay committed as fallbacks and
  are suppressed live only when each *becomes* current and the test passes then. This avoids a
  forward-commitment rewrite (revision hysteresis) and is also more correct: feasibility is
  re-tested against fresh measured progress at each hour rather than guessed ahead.

### Guards

1. **Conservative estimate.** Release on the buffered floor, never the mean. `rateConfidence`
   was pinned `low` all night; releasing on the optimistic mean risks deferring into a miss.
2. **Price gap via banding, not a tuned threshold.** No `minDiff` knob shipped. The release
   only fires off an `avoid`-banded current hour and only when the residual re-allocates onto
   hours that are *not* `avoid` (and not the deadline reserve) — for soft AND hard alike. The
   band boundary is the price gap; a flat curve does not band hours as `avoid`, so it never fires.
3. **No explicit stickiness — stable by construction.** Within an `avoid` hour the flag is
   stable (preference is constant, the committed floor is constant, and idling makes no progress
   so the residual doesn't shrink), so it doesn't flap. The actuator-level shed/restore cooldowns
   (60–300 s) are the backstop against any residual control flap; a separate sticky latch would be
   redundant state. (Revision flap is a non-issue — the recorder is insulated by construction; see
   above.)
4. **Headroom already respected.** The re-allocation honors each bucket's `reservedHeadroomKw`
   forecast (`resolveBucketStepCapacityKWh`), so it won't defer into hours with no physical room.

### No separate "over-run the cheap hour" rule

The symmetric idea (over-run a cheap hour to retire an expensive future bucket) is not needed:
with no price ceiling the device already runs freely at full power in cheap/uncontended hours,
and the per-hour release above retires each `avoid` hour as it arrives. The two together pull
energy toward cheap hours without a dedicated over-run mechanism.

### Tests

- Releases when ahead and cheaper hours suffice; **does not** release when the residual still
  needs the `avoid` hour (device keeps running).
- Respects the conservative floor — no release that the buffered estimate says would miss.
- **No commitment revision is written** across a full release → drift → re-engage cycle; the
  active-plan `history[]` length is unchanged and `deadline_plan_changed` does not fire. (This
  is the regression guard for the governing invariant.)
- A released current hour does not propagate a `plannedKWh → 0` into the recorder's hour-set.
- Honors the min-price-gap on a flat curve (no release, no control flap).

## Explicit non-goal — near-target / "safely ahead" release

Do **not** add a release/limit triggered purely by being near target or ahead of plan.
A water heater at/near its setpoint draws ~0 W on its own (`near_target_idle`), and its
internal thermostat prevents overshoot, so leaving the objective nominally "on" (requesting
`low`) near target is free and safe. The only time limiting matters is when the device would
draw **real power** in an expensive hour — which work item 2 already covers. A satiation-based
release would add control churn for no benefit and is not pursued.

(The strict `>= target` satiation check in `planHistoryInProgressState.diagnosticProgressAtTarget`
and the `near_target_idle → 'stalled' → met` classification stay as-is.)

## Deferred — feasibility / throughput accuracy (not in these two work items)

Work item 2 acts on the **existing** feasibility verdict (`resolveStatus` over the current
allocation) and is conservative by construction — it only releases when the existing test says
the residual fits future non-`avoid` hours `on_track`. So it is **correct without resolving how
pessimistic the cold-start `cannot_meet` was**: a pessimistic verdict simply means item 2
releases less often, never that it releases unsafely.

Deferred question (revisit after the two work items land): whether the ~1.25–1.67 kWh/hour
bucket cap on the motivating night came from the booked `low` step (`step.usefulPowerKw` —
capacity *underestimated* vs the real ~2.87 kW element → false `cannot_meet`) or from the
`reservedHeadroomKw` hard-cap headroom forecast (`policyHorizon.ts` — genuine ~1.3 kW/hour
scarcity). That fork only affects how *often* item 2 can release (a less pessimistic
feasibility model would free more expensive hours), not its correctness. Resolving it later
means reading the bucket `usefulEnergyCapacityKWh` breakdown / the `policyHorizon` headroom
forecast on prod.
