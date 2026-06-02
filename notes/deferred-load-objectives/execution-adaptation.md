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
  (60–300 s) plus the stable committed-rate milestone and conservative unit deadband in work item 2.

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

Back the device off the current hour when it is **already at/above this hour's planned trajectory
milestone** (in the objective's own unit) **and** a later hour is genuinely cheaper. The plan stays
built in energy (feedforward); the per-hour back-off is a **feedback term closed on the measured
physical unit**, so it self-corrects for rate error in both directions. Shipped as a
producer-resolved flag + the same per-cycle admission release:

- The producer resolves a trajectory gate `aheadOfHourMilestone` (`isAheadOfHourMilestone`,
  `trajectoryMilestone.ts`), computed in `diagnosticsBridge.ts` where the RAW measured value and
  the committed rate live (the planner sees neither).
- The horizon planner combines it with a relative raw-price test to set `priceDeferralEligible`
  (`resolvePriceDeferralEligible`, `horizonPlanner.ts`).
- The decoration controller's admission reads the flag (`isReleasedCurrentHour`, `admission.ts`)
  and idles the device this cycle (ev_pause / shed_release / plain idle by device kind),
  reusing the existing release posture. No executor change — limiting is "request nothing."

**Why degrees, not kWh (and not the `avoid` band).** The earlier shipped gate decided in energy
(routed through the drifting learned rate) and triggered on the absolute `avoid` price band. Both
were wrong: (1) for a storage device with stochastic hot-water draw-off the kWh-fed view is *blind
to energy leaving the tank*, and the learned rate (`rateConfidence` pinned `low` all night) is the
least reliable quantity to route the decision through; (2) the `avoid` band can't express "X%
cheaper" (it's a within-horizon normalized rank) and never fires on a smoothly-sloping curve.
Comparing the measured unit against a stable plan milestone, and prices by raw ratio, fixes both.

**Why it stays clean (the foundation made it so):** admission runs on the **decoration
controller's** diagnostics (power cycle); the recorder runs on the **emitter's separate**
diagnostics (clock, settles once per hour at `:58`). The flag lives only on the admission path, so
it **structurally** never reaches the recorder. The device's idling (no progress) is what re-books
the cheaper hours at the next `:58` settle — one honest revision, not churn.

### Release test (evaluated each cycle)

1. **Trajectory gate — buffered energy still needed vs the committed future hours.** The committed
   plan's end-of-this-hour milestone is reached when the buffered energy still needed is already
   covered by the energy the LATER committed hours will deliver:

   `energyNeededKWh ≤ futureCommittedKWh × (1 − MILESTONE_AHEAD_MARGIN)`   (margin ~2%)

   Both sides are the SAME buffered-energy currency: `energyNeededKWh` is the buffered floor
   (`mean + k·SE` from `integrateBands`) for the current measured `remainingUnits` — recomputed
   every cycle from the RAW reading, so a draw-off raises it and re-engages heating —
   and `futureCommittedKWh` is what the committed plan booked for the hours after the current one,
   also sized at the buffered rate. This is the unit-trajectory comparison expressed in energy:
   **buffered-to-buffered, with NO division by a learned rate**, so there is no mean-vs-buffered
   bias (an earlier draft divided committed energy by the committed *mean* rate while the energy
   was *booked* at the buffered rate — that over-deferred ~2× for the low-confidence devices this
   feature targets). `futureCommittedKWh` is frozen within the hour (settled at `:58`), so it is the
   stable reference: capacity arbitration jerking the mid-hour trajectory around cannot chatter it,
   and a rate drift between commit and now only shifts the comparison in the safe direction.
2. **Relative-price gate.** A later, **non-reserve** hour must be cheaper than the current hour by
   more than `PRICE_DEFERRAL_MARGIN` (~5%), tested on the **raw price ratio**
   (`later ≤ current × (1 − margin)`). Pure ratio ⇒ unit-invariant across currencies (the price
   series carries no currency at this layer). Requires `current price > 0` (free/negative current →
   heat now). Deadline-reserve hours are excluded so we never defer into the reserve; a negative
   later price naturally satisfies the inequality (heat when paid). The current hour must still
   carry booked energy (else it is already idle — nothing to defer).

**Self-feasibility (why the old residual re-allocation is gone).** Being at/above this hour's
milestone means we are on a trajectory that was itself built to meet the deadline, so coasting this
hour cannot by itself cause a miss. The "safer to heat early" bias is double-protected: we never
defer when behind the milestone, and only defer when a later hour is *meaningfully* cheaper.

### No commitment rewrite — release is a live override (preserves the floor)

The release does **not** touch the persisted commitment. The committed current hour stays
booked as a **fallback**; the release is a per-cycle override in the control layer that, when
the test passes, idles the device this cycle.

- **Insertion point:** the live `DeferredObjectiveHorizonPlan` that admission consumes. The
  recorder's committed hours, `sameHourSchedule`, and `history[]` are **insulated** — they keep
  observing the committed allocation, so no `schedule_revised` / `deadline_plan_changed` /
  `measured_deviation` revision is ever written.
- The `Math.max` floor invariant is therefore **preserved, not carved out**. If a draw-off later
  pulls measured below the milestone (`remainingUnits` grows past the future-committed units), the
  same live test simply stops overriding and the still-committed fallback hour runs — no revision
  in either direction.
- **Watch-out:** the override must not reach the recorder's hour-set. Apply it on the admission
  input while the recorder still observes the committed plan.

### Timing

- The release is evaluated per cycle and is reversible, so it can fire as soon as the test
  passes, subject to the deadband and actuator cooldowns below.
- **Future hours are never proactively dropped.** They stay committed as fallbacks and are
  suppressed live only when each *becomes* current and the milestone+price test passes then. This
  avoids a forward-commitment rewrite (revision hysteresis) and is more correct: the gate is
  re-tested against fresh measured progress at each hour rather than guessed ahead.

### Guards

1. **Buffered-to-buffered, conservative margin.** Both sides of the milestone are buffered energy,
   so there is no rate division and no mean-vs-buffered bias. A small relative `MILESTONE_AHEAD_MARGIN`
   (~2%, rate-free) requires being clearly ahead before releasing — biasing toward heating
   ("early is safer") and absorbing threshold jitter; the shed/restore cooldowns (60–300 s) backstop
   any residual control flap. A rate drift between commit and now only shifts the comparison toward
   keeping the device running (safe).
2. **Relative price, not an absolute band or knob.** `PRICE_DEFERRAL_MARGIN` (~5%) on the raw
   price ratio; near-equal hours keep the safer earlier slot. A flat curve never beats the margin,
   so it never fires. No absolute price floor — that would be currency-unsafe (the series is
   unit-blind at this layer); the `current > 0` sign guard handles the free/negative case.
3. **Stateless flag — no revision flap by construction.** The recorder is insulated; the
   actuator-level shed/restore cooldowns (60–300 s) are the backstop against control flap (the
   stateless flag deliberately carries no two-sided latch).
4. **No committed future energy.** No commitment, or only the current/past hours are booked →
   `futureCommittedKWh = 0` → not ahead → never defer (keep heating).
5. **Headroom already respected.** Allocation honors each bucket's `reservedHeadroomKw` forecast,
   so the cheaper hours it would defer into already account for physical room.

### No separate "over-run the cheap hour" rule

The symmetric idea (over-run a cheap hour to retire an expensive future bucket) is not needed:
with no price ceiling the device already runs freely at full power in cheap/uncontended hours,
and the per-hour release above retires each expensive hour as it arrives.

### Tests

- `trajectoryMilestone.test.ts`: ahead when the later committed hours cover the buffered need;
  not ahead when they don't; honours a draw-off (higher `energyNeededKWh` → not ahead); the
  conservative ahead-margin boundary; no committed future energy → false; non-finite/negative
  `energyNeededKWh` → false; excludes the current clock hour from the future sum (mid-hour
  `nowMs`); 25-hour DST day.
- `deferredObjectiveHorizon.test.ts`: flags when ahead + a later hour beats the 5% margin;
  not when not ahead; not when no later hour beats the margin; not into the deadline-reserve hour;
  not when current price ≤ 0; flags on a negative later price; not when the current hour carries
  no booked energy.
- `deferredObjectiveAdmission.unit.test.ts` (unchanged): the consumer path still idles /
  shed_releases / ev_pauses on the flag — the regression guard that the recorder stays insulated
  and the admission contract is intact.

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

Work item 2 acts on the **committed plan's** trajectory and is conservative by construction — it
only releases when the measured value is at/above this hour's committed milestone (ahead by the
deadband). So it is **correct without resolving how pessimistic the cold-start `cannot_meet`
was**: a pessimistic plan books more committed energy, which raises the per-hour milestone, so
item 2 releases less often, never unsafely.

Deferred question (revisit after the two work items land): whether the ~1.25–1.67 kWh/hour
bucket cap on the motivating night came from the booked `low` step (`step.usefulPowerKw` —
capacity *underestimated* vs the real ~2.87 kW element → false `cannot_meet`) or from the
`reservedHeadroomKw` hard-cap headroom forecast (`policyHorizon.ts` — genuine ~1.3 kW/hour
scarcity). That fork only affects how *often* item 2 can release (a less pessimistic
feasibility model would free more expensive hours), not its correctness. Resolving it later
means reading the bucket `usefulEnergyCapacityKWh` breakdown / the `policyHorizon` headroom
forecast on prod.
