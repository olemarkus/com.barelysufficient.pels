# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## Entry Bar

**Every entry must be actionable.** An entry earns its place only if someone picking it up cold
could start today and know when it is finished. Every entry names three things:

1. **Where** — the file, function, or user-visible surface that is wrong.
2. **What changes** — the change to make, or the choice to rule on with its options written out.
3. **When it is done** — the observable result that closes the line.

P3 additionally states a **hypothesis**, **why it is needed**, and the **persona**
(`notes/personas.md`) it serves. An item that cannot name all three is a maintainability or
cosmetic chore: do it in passing or drop it.

These are not actionable. Resolve it now or delete it — do not park it here:

- **Open questions.** "Why did X happen?" is an investigation, not work. Investigate it and record
  the finding (in `notes/`, or as an entry that names the fix), or drop it.
- **Work waiting on outside evidence.** If it cannot start until production logs, a measurement, a
  vendor answer, or a user report arrives, the entry waits with the work. "Blocked on X" belongs in
  a PR description or a conversation. Waiting on *another entry here*, or on a code shape this repo
  controls, is different — that is sequenced work and it stays.
- **Undecided product calls.** "Decide whether X" is not work. Rule on it, then write the entry for
  what the ruling implies — or let it go.
- **Manual spot-checks.** "Verify it at 320 px", "check it on a real phone" — do the check, then
  file what it found. An unperformed look is not a backlog item.
- **Bare observations.** A design smell or a preference with no proposed change has no
  done-condition, and it will read later as a decided plan.
- **Speculative capability.** A feature whose shape is still a guess is a hypothetical plan.
- **Guards for problems that do not exist yet.** "No current bug", "benign today", "unreachable
  today" — if nothing is wrong now, the entry is a constraint on some future change, not work.
  Say so where that change will happen. An entry that argues the current shape is *sound* has
  already answered itself.
- **Completed work.** Delete it; git history and tests are the audit trail. Never leave `- [x]`.

Guidance that is genuinely durable — a constraint the next contributor must respect rather than a
change someone will make — belongs in the `AGENTS.md` or the code it governs, not here.

*Phantom-design items removed (2026-05-31 m3-critic merit pass): the
"Electricity-prices two-select contrast" and "inconsistent active-vs-history chart
styling" items were written against UI that no longer exists — there are zero
`md-outlined-select` in shipped markup (every select is the token-bound dark-themed
`md-filled-select`, and migrating would break `segmentedControl.ts`), and both
smart-task charts already share the palette tokens and are deliberately different
chart types, not two languages for one chart. Do not re-raise from the stale
live-walk screenshots.*

## Priority Rubric

- **P0:** v1 / next-release blocker: release-blocking correctness, control-integrity, startup,
  validation, or data-loss issue that can affect current runtime behavior without another feature
  or broad refactor landing first. Also includes first-impression visual coherence that would
  cost user trust on the v1 release — token sanity, hero / typography consistency, primitive
  consolidation, and chart palette alignment — because the redesigned UI is the user's first
  contact with v1. Only P0 items are required before the v1 release.
- **P1:** next patch-release correctness, data-integrity, first-impression UI polish, and
  supported UX work after v1: bounded planner/executor risks, settings writes that can corrupt
  persisted state, supported-width UI breakage, confusing visible wording, or missing validation
  around commandable device contracts.
- **P2:** later / future product, observability, documentation, and maintainability work where
  current behavior is usable or has a workaround, but the gap increases support cost or slows
  future work.
- **P3:** future capability, optional hardening, or exploratory cleanup with no current correctness
  or supportability pressure.

The redesigned Settings UI is expected to be many users' first exposure to the new UI direction.
P1 UI items should prioritize a pleasant surprise: compact, calm, coherent, and clear enough that
users trust the redesign immediately, while still keeping non-P0 polish out of the v1 release gate.

## P0 Release Blockers

*(prior closures shipped on the v2.9 train via PRs #975, #977, #978, #980,
#982, #983; surviving follow-ups demoted to P1/P2.)*

The 2026-07-25 release-review cleanup closed the prior set: it partitioned realtime reconcile
work by home, finite-gated saved meter-area limits, and corrected the Main-meter setup guide.
Remaining multi-meter work is tracked as P1/P2/P3 follow-up below.

*"Drift detection reads device state from the plan layer" closed 2026-08-21 across four PRs: the
plan-to-plan predicate was proved settle-only and sealed behind an AST guard; the commanded axis
and the device's rung attestation moved to `lib/executor` / `lib/observer`; drift now reads the
observation from the observer and the command state from the executor's own stores, qualified by
the observation revision the plan was built from; and `observedBinaryState` split into
`observedBinaryAxis` and `observedEffectiveOn`, one meaning each on every construction path.*

## P1 Correctness, Data Integrity, and Supported UX

- [ ] **The restore cooldown's base window does not reach the measured restore-latency tail.**
      With the pending-restore reservation removed (2026-08-28), `RESTORE_COOLDOWN_MS = 60 s`
      (`lib/plan/planConstants.ts`) is the only thing pacing a second restore behind a first.
      Measured against 62 EV-charger turn-ons in the 2026-08-11→13 production log, the load appears
      in whole-home draw at p50 19.7 s, **p90 129.7 s, max 250.0 s**, and never at all in 2 cases.
      So the base window covers the median and not the tail: on a slow start PELS can admit a
      second device against a reading that does not yet contain the first one's load. The backoff
      ladder reaches 5 min and would bracket the whole distribution, but it is keyed on instability,
      not on restore latency, so it does not arm for this.
      Note what is NOT the fix: reserving headroom until the load is seen. That was the removed
      mechanism, and it cannot work — the whole-home meter is a sum, so a heater switching off as a
      charger starts hides the load completely (`notes/state-management/actuation-clocks-and-settle.md`
      § "The rule this leaves behind"). Any evidence-based release must read the DEVICE, never the
      main meter. Done when the cooldown that gates a second restore is sized from this
      distribution, with the sizing argument written down and an SDK-boundary e2e that fails at the
      old window. Measurements from 2026-08-13; re-scoped onto the cooldown 2026-08-28. [P1]
*v2.9.0 closeout and v2.8.x release-review follow-ups. These are safe for
patch releases, not release blockers; each item carries its own source/date.
(The v2.8.0 card-title rename landed in PR #934.)*
      **Conflicts with the per-device restore-stamp entry below:** that one proposes scoping
      `state.lastRestoreMs` to the actuating device, which removes the cross-device pacing this
      entry is sizing. Rule on both together; a per-device stamp needs a carve-out preserving
      some cross-device gate or this exposure becomes unbounded.

- [ ] **Solar-surplus reachability is derived from RESETTABLE accounting, so "Reset usage history"
      can drop a dump load's surplus posture.** `resolveSurplusPoolReachable`
      (`packages/shared-domain/src/solar/surplusPoolReachable.ts`) reads its export half from the
      tracker's export families, and `resetSettingsUiPowerStatsForApp`
      (`setup/settingsUiAppRuntime.ts:312 (the reset fn), clearing exportBuckets/exportDailyTotals at :338-340`) clears `exportDailyTotals` outright and prunes
      `exportBuckets` to the current hour. A signed-net Flow home whose owner resets usage history
      outside an exporting hour therefore loses both disjuncts (the curtailment estimator is dormant
      on flow), the opted-in dump load loses its `surplusOnly` stamp, and the generic managed-binary
      restore lane starts running it from the grid. It re-arms on the next negative sample, so this
      is not the permanent trap the posture gate exists to prevent — but on a home whose dump-load
      draw exceeds its PV surplus, the load itself can keep net non-negative and hold the evidence
      shut. The same shape makes the predicate lapse on 30-day/365-day retention pruning after a long
      export-free stretch. Fix: persist the feed's proven signed-export CAPABILITY separately from
      the accounting history, exactly as the curtailment half now persists its armed latch
      (`CurtailmentPersistedHoldState.armed`) — a monotone bit that a history reset and a retention
      prune both leave alone. Source: Codex P1 on PR #2012, verified against the reset path.
      *Persona:* prosumer on the flow source who has opted a dump load into solar surplus.
      Absorbed from the merged restore-lane item: once released, the dump load rejoins the
      generic managed-binary restore and can be run from the grid, so the marker must survive the
      reset AND suppress generic restore candidacy. Neither half closes the harm alone.

- [ ] **Sparse Flow reports mint solar production and export across the gap between them.**
      `accrueSolarSample` (`lib/power/trackerSolar.ts`) integrates the PREVIOUS held generation
      across the whole interval to the next sample, and `MAX_SOLAR_ACCRUAL_GAP_MS` is 60 min — so
      it never trips on a realistic Flow cadence. On the `homey_energy` source the 10 s poll keeps
      the interval short and the error negligible; on `flow` the sample interval is whatever the
      user's Flow emits. A home reporting on change with a dead band can go 30 minutes between
      reports: 7 kW at 12:00, production collapses at 12:01, next report 12:30 → ~3.5 kWh of
      production accrued that never happened, with the matching error in exported kWh. Both
      numbers are user-visible on the Usage tab's Solar card and priced by the money lines.
      Surfaced by Codex (P1) and `pels-runtime-reality` independently on PR #1997, which gives the
      flow source production parity; the same accrual already backs EXPORT for shipped flow users,
      so the two candidate fixes are not free: accrue on the generation clock (the companion poll's
      own 10 s cadence, `lib/power/sources/generationPoll.ts`) rather than the net-sample clock, or
      tighten the gap ceiling — which changes export accounting for homes already running on flow.
      Persona: the prosumer on the flow source reading the Solar card (`notes/personas.md`).

- [ ] **The editor client still revokes a standing limit-only grant on any permission toggle.**
      `applyPermissionGate` (`packages/settings-ui/src/ui/smartTaskEdit.ts:342-348`) forces
      `limitLowerPriorityDevices: false` whenever `exemptFromBudget` is unchecked, on ANY
      permission toggle — so with a Flow-granted limit-only task, toggling e.g. pause on flips
      the limit toggle off (disabled, so it can't be re-checked), and Save sends an explicit
      revoke that `buildCandidateRescue` applies before the server's standing-grant protection
      (the 2026-08-02 P0 fix) can see it. Same user promise, adjacent journey (permission-edit
      instead of goal-edit). The client gate's justification comment ("the server drops that
      grant when it isn't paired") is no longer true for standing grants; drop the stale
      justification with the fix, and update the checked-but-disabled
      `SMART_TASK_LIMIT_NEEDS_BUDGET_HINT` copy (`DeadlinePlan.tsx:1379-1388`) that tells the
      user a working grant is unusable. Source: 2026-08-02 release review, Fix-A adversarial
      pass. [P1]
- [ ] **The weather budget-correction sentence can contradict the numbers on its own card.**
      `composeBudgetLimitingReason` (`packages/shared-domain/src/weatherInsightCopy.ts:148`)
      appends "N kWh of that covers days that ran past your budget", anchoring "that" to the raw
      raise — a number the card never shows. With Suggested 48 / Your budget 45, the only visible
      raise is 3 kWh, so a 6.4 kWh component reads as bigger than the whole; production hits this
      whenever accumulated pressure exceeds suggested − current. Anchor the sentence to a number
      on the card ("N kWh of the suggestion covers days that ran past your budget"). Source:
      2026-08-02 release review (v2.19.3..origin/main), pels-ux-fit rendered walk. [P1]
- [ ] **The "no electricity meters" empty state never renders — a meter-less home gets a silent
      empty picker.** `refreshMeterDevices` (`packages/settings-ui/src/ui/homesSettings.ts:337`)
      assigns `meterDevices` only when `meters.length > 0`, so `metersLoaded` stays false for a
      genuinely meter-less home and the rewritten `HOMES_NO_METER_DEVICES` copy is unreachable in
      exactly the state it was written for. Distinguish "loaded empty" from "fetch failed": assign
      `[]` on a successful read, keep last-good only on error. Source: 2026-08-02 release review,
      pels-ux-fit rendered walk (rendered proof captured). [P1]
- [ ] **Disabling temperature control on a currently-limited thermostat strands the shed
      setpoint.** The command fence (`setup/appInit/buildDeviceActuator.ts`) refuses every setpoint
      write once the toggle is on — including the restore/terminal-release write-back —
      and `toPlanDevice` strips the target axis, so a thermostat shed to its floor (e.g. 12 °C)
      stays there indefinitely with nothing warning the owner; the UI blocks the flip only for an
      active smart task (`temperatureControlDisabled.ts:83-90`), not for an active setpoint shed.
      Either write the mode target back once before fencing, or show a warning line on the toggle
      while the device is limited via setpoint. docs/technical.md documents "does not change the
      target", so this is a UX/safety follow-up, not a contract break. Source: 2026-08-02 release
      review, settings-UI logic pass. [P1]
- [ ] **A genuine learned-rate gap mid-commitment still strips a committed task to `unknown`.**
      Same shape as the fixed step-ladder gap one short-circuit earlier: in
      `buildDiagnosticWithPolicyHorizon`, a `profileEnergy.reasonCode` (e.g. a real
      `objective_missing_charge_rate` from a lost/unconfident learned rate) returns `unknown`
      before the frozen fallback is consulted, so a committed task would lose its budget
      exemption/boost/floor exactly like the 2026-08-01 incident — via the rate lane instead of
      the step lane. Not yet observed in prod (the 2026-08-01 rate never degraded). Serving frozen
      here needs `energyNeededKWh` handling in `buildFrozenHorizonPlan` (shortfall display and the
      legacy milestone fallback consume it); the unit-milestone comparison itself is rate-free, so
      commitments with stamped `plannedUnitMilestone` could be served with a degraded/absent
      energy estimate. Do it as its own change with its own SDK-boundary e2e. Source: 2026-08-02
      task-6 fix review. [P2]

- [ ] **A smart task reports `on_track` while its current planned bucket goes undelivered.**
      Prod 2026-08-01, water heater "Connected 300": the frozen horizon booked 1.183 kWh into the
      current bucket, the device was restore-blocked the whole hour (shed, 0 W, tank temperature
      falling 22.2 → 18.8 °C against a 65 °C / 06:00 deadline), and every
      `deferred_objective_horizon_planned` log still read `status: "on_track",
      reasonCode: "planned_with_margin"` with `energyExpectedKWh < energyNeededKWh`. The status
      derives from the planned horizon, not from delivery against it, so an execution stall is
      invisible until the deadline math finally tips into `Cannot finish`. Surface bucket
      non-delivery (planned useful energy vs delivered) in the status/reason so the widget alert
      fires while there is still time to act — this is the "trajectory visible for the skeptic"
      gap on the smart-task lane. Found during the 2026-08-01 budget-hold copy investigation.

- [ ] **A timestamp-less reconnect anchors nothing, so a replugged charger keeps a retired level.**
      `resolveReconnectAtMs` (`lib/device/transport/stateOfCharge.ts`) deliberately requires REAL
      evidence: a connected observation carrying no `lastUpdated` cannot anchor the new session, so
      the pending invalidation stands and the reading stays retired — and `measure_battery` is
      change-only, so an idle charger cannot republish to clear it. Substituting the refresh time was
      implemented and then reverted on PR #1897, because a full refresh can carry a cached connected
      state older than a newer realtime plug-out (`snapshotRefresh.ts` parses the pull before merging
      retained fresher observations) and a fabricated future `sessionStartedAtMs` cannot be undone by
      reapplying that plug-out — trading a retired reading for a session anchored to the wrong car. A
      correct fix needs the refresh path to distinguish cached from fresh connected evidence, not a
      timestamp substitution at this seam. Now that the session is the ONLY thing that retires a
      level (the 40-minute age gate is gone), this is the single remaining way a connected charger
      can be left without one. **It is not the only way a task reads as having no progress, and it
      was NOT the cause of the 2026-08-19/20 prod stalls** — the car was never plugged in, and the
      precondition that should have said so was dead code (fixed 2026-08-22). Check for
      `objective_invalid_session` in the logs before reaching for this entry. Raised by Codex on PR #1897, 2026-07-27; narrowed 2026-08-08 when the
      age gate was deleted. Persona: EV owner who replugs and sees the smart task refuse to plan;
      hypothesis: a task that never plans is indistinguishable from one that was never scheduled. [P1]

*The bulk of the P1 backlog shipped in the 2026-06-03 reconciliation train (PRs #1450–#1461):
insights mode-options coalescing, headroom over-cap overage, the history-detail title/link fixes,
deviceOverview canonical-string routing, the flow-reported / pendingBinaryCommands /
stepped-restore-wrapper / stepped-swap-completion refactors, the settings.test.ts flake, the
plan_budget truncation, the starvation confirm-sheet sub-parts, and the shared widget runtime.
What remains open is below.*

- [ ] **Homes UI: explain cached rows that stay locked after a refresh failure.**
      A failed `/ui_homes` refresh preserves the last-good rows and correctly disables mutations, but
      the ready/list view gives no visible reason its Add/Edit/Remove controls remain unavailable.
      Show a compact stale-refresh warning beside the preserved rows. Source: release review of the
      multi-meter GA train, 2026-07-24.

- [ ] **Restore actuation re-stamps the GLOBAL `state.lastRestoreMs`.**
      `recordRestoreActuation` (`lib/executor/planExecutor.ts` ~210) sets both the per-device
      `lastDeviceRestoreMs[id]` and the global `state.lastRestoreMs`, and `restore/timing.ts` ~47
      derives `inRestoreCooldown` from the global one. So any device's restore attempt pushes out
      the restore gate for every device that is observed OFF (an active-step device reads its own
      per-device stamp instead — `restore/steppedRestoreGates.ts` ~67). One device retrying on a
      cadence therefore delays other devices' resumes. The 2.17.5 stepped binary-restore gate
      (`hasStableSteppedLoadBinaryRestoreActuation`) is rate-limited per device specifically to
      keep its worst case at the same cadence as an ordinary restore rather than per rebuild
      cycle, but the underlying global/per-device mismatch is still there. Fix by making the
      restore cooldown per-device throughout, or by scoping the global stamp to the device that
      actuated. Source: prod log review + adversarial review, 2026-07-25; re-confirmed while
      shipping 2.17.5. [P1]
      **Conflicts with the restore-cooldown-window entry above:** that one treats the global
      stamp as the only cross-device pacing and argues 60 s is already too short. Do not scope
      the stamp per-device without replacing that gate.

- [ ] **The exempt-draw PROJECTION reaches a persisted energy bucket.**
      `setup/powerSamplePipeline.ts` passes `sumBudgetExemptProjectedUsageKw` as
      `sumBudgetExemptUsage`, which `lib/power/sampleIngest.ts` integrates into
      `exemptBuckets` — a persisted kWh figure read by `dailyBudgetState`,
      `dailyBudgetObservedStats`, `dailyBudgetLearning` and
      `planDailyBudgetWindow`. The projection deliberately substitutes
      `getHighestKnownPowerKw` (nameplate) for an observed-OFF exempt device,
      which is right for the daily-pace CONTROL threshold (`planBuilder`'s
      `computeDailySoftLimit`) and wrong for an energy integral —
      `notes/safe-pace-two-constraints.md` says exactly this: the projected value
      is "correct for the control threshold and wrong for anything rendering
      current load". Fix is one line (`sumBudgetExemptMeasuredUsageKw` on the
      sample path), but it changes persisted daily-budget accounting for existing
      users mid-day, so it wants its own change with a migration thought through.
      Source: adversarial review of the measured-draw collapse, 2026-08-08. [P1]
      **Do this before the budget-pressure exempt-kWh entry:** that fix reads the very
      `exemptBuckets` integral this projection contaminates.

- [ ] **A device that vanishes mid-overshoot is attributed to background load.**
      `hasUndiffablePlausibleContributor` (`lib/plan/planBuilderOvershoot.ts`)
      iterates the CURRENT device map only, so a managed device present in the
      previous plan and absent from this one cannot block a confident verdict, and
      its rise lands in `background_load_dominant` rather than
      `attribution_inputs_incomplete`. Newcomer/baseline cases cover APPEARANCE,
      not disappearance. Fix: also scan `previousDevicesById` for ids missing from
      the current map. Source: adversarial review of the measured-draw collapse,
      2026-08-08. [P2]

- [ ] **`restorePreparedStepId` is declared and never assigned.** The field is on
      `setup/appDeviceControlSteppedState.ts` and on the legacy field shapes in
      `lib/plan/planSteppedLoadState.ts`, but nothing in `lib/**` or `setup/**` ever writes it, so
      `normalizeSteppedLoadStepStateFromLegacyFields` never takes its override branch and
      `restorePreparation` is always derived from the observation. Either wire a producer or drop
      the field and the branch, and check whether `restorePreparation` still earns its place on
      `NormalizedSteppedLoadStepState` afterwards — its only remaining reader is
      `serializeLegacyStepFields`, which round-trips it straight back out. Done when no declared
      step field lacks a writer. (The `suppressed_flow` arm, `SuppressedFlowStepInput`,
      `SuppressedFlowRestorePreparationPolicy` and the age-gated suppressed branch this item used
      to cover are gone — they were a freshness call inside `lib/plan`.) Source: adversarial
      review, 2026-07-25. [P2]

- [ ] **A shed device waiting out a restore gate can carry no gate reason, so it defaults to
      `capacity`.** `buildBaseReason` (`lib/plan/planReasons.ts` ~42) ends with
      `?? { code: capacity }` for a device that is planned `shed`, was not shed THIS cycle, and
      whose own reason normalized away. That default is required — `SHED_REASON_RULES`
      (`lib/plan/planReasonsValidation.ts`) is an allow-list of limit-shaped codes and a shed
      device must carry one — but it fires in windows where no limit is binding at all. Prod
      2026-07-25: a charger shed during a 10 s overshoot read `capacity` on 5 cycles while the
      house sat at 1.4 kW against a 5.4 kW pace; it was really waiting out `cooldown_shedding` →
      `meter_settling` → `restore_need`, all of which DO set their own reasons on the cycles they
      cover. So the real defect is the gap: the restore path does not always attach a gate reason,
      and the default then speaks for it. Fix is to close that gap (audit which restore-gate paths
      leave the reason unset), NOT to loosen the default — an attempt to return `none` when nothing
      binds broke 6 integration tests precisely because it violated the allow-list. The card no
      longer *says* "Limited by the hard cap" for the unknown case (the held fallback was split off
      from `PLAN_STATE_CAPACITY_STATUS` in the same PR), but a genuine `capacity` reason on a device
      no limit is holding is still wrong. (Softened 2026-08-02: `finalizeCeilingReason` now
      attaches the per-cycle admission gap to that default — when nothing binds, admission passes
      and the card shows the bare waiting line rather than a phantom number — but the wrong CODE
      still reaches diagnostics/starvation classification.) Source: prod investigation + test
      suite, 2026-07-25. [P2]

- [ ] **The docs define safe pace as "hard cap minus safety margin", which is wrong.**
      `docs/glossary.md` ("Safe pace") and `docs/how-pels-decides.md` (~line 55) both state the
      safe pace *is* the cap minus the margin. It is not: the capacity pace is a burst rate,
      `remainingKWh / remainingHours` capped by the end-of-hour drain ceiling
      (`computeDynamicSoftLimit`, `lib/plan/planBudget.ts`), which legitimately sits *above* cap-minus-margin for most of
      an under-used hour. `notes/ui-terminology.md` § "Safe pace, hard cap, and safety margin"
      and `docs/technical.md` already say this correctly, and the glossary entry contradicts its
      own next sentence ("a moving target, not a fixed limit"). Cap-minus-margin is the
      *sustainable* rate and is the right frame only for the Advanced page's "safe pace starts
      each hour at" preview. Persona: first-time user reading the glossary link from the hero
      tooltip. Source: safe-pace definition audit (2026-07-26).

### P1 — targeted refactors (deferred)

*Concrete, bounded changes to specific named surfaces (not structural re-splits — those stay P2).*

## P2 Product, Observability, and Maintainability

- [ ] **A silent meter AREA has no staleness indication — the no-readings banner speaks only for
      Main.** The banner (`packages/shared-domain/src/powerReadingsBanner.ts`, fed by the
      deliberately Main-only `getPowerReadModel` in `packages/settings-ui/src/ui/power.ts`) is the
      one staleness surface after the freshness chip's removal, and before that removal a silent
      area still surfaced through the scoped hero's chip. Decide whose scope the global banner
      speaks for: either feed it from the ACTIVE home scope's tracker timestamp (scoped read
      carries it), or add a per-area arm to the banner copy. Done when silencing an area's meter
      for >60 s shows a user-visible indication while Main stays fresh, pinned by a UI test.
      Sharper since 2026-09-02: past the shed timeout the scoped hero renders NOTHING for an
      unmeasured cycle (`PlanHero.tsx`, owner ruling — no computed figure is drawn), so a silent
      area now shows only `Limited` cards under no banner and no hero; the banner arm is the
      only surface left to carry that state.

- [ ] **The zone tree is refetched on every snapshot refresh — 538 Homey round-trips per 12 h for
      an answer that changed zero times — and the obvious fix (a refresh interval) is unsafe as
      written.** `refreshZoneTreeCache` (`lib/device/transport/snapshotRefresh.ts`) fetches
      `manager/zones/zone` at the tail of every `refreshSnapshot`, roughly every 80 s. In the
      sampled production window every one of the 538 answers was `zonesTotal: 29,
      droppedEntries: 0`.

      An interval alone reintroduces a correctness window, which is why the one added in PR #2252
      was taken back out. Once ANY tree has committed, the multi-home actuation fence is open, and
      `zoneAncestryPath` treats a zoneId missing from the cached tree the same as a broken parent
      chain: `resolveDeviceHome` answers `{ homeId: MAIN_HOME_ID, source: 'fallback' }`
      (`lib/home/membership.ts`, pinned by `test/unit/homeMembership.test.ts` "an unknown device
      zone resolves to main"). So a device moved into a zone the stale tree has never seen is
      planned and actuated by Main against the wrong meter for the length of the interval. Homey
      publishes no zone event to correct it — the SDK ships no zones manager, and the realtime
      feed subscribes only `homey:manager:devices` — so nothing shortens that window on its own.

      **Where:** `refreshZoneTreeCache` in `lib/device/transport/snapshotRefresh.ts`,
      `ZoneTreeCache` in `lib/device/transport/zoneTreeCache.ts`, and the fallback arm of
      `resolveDeviceHome` in `lib/home/membership.ts`.

      **What changes — rule on one of these:**
      (a) *Make staleness self-correcting, then add the interval.* Mark the cache due when a
      `device.update` reports a zoneId absent from the tree. `notifyDeviceZoneChangeContained`
      (`lib/device/transport/deviceUpdateHandling.ts`) already computes the zone delta and holds
      `ctx.zoneTreeCache`, so this needs no new plumbing and no `lib/device` → `lib/home` edge.
      Covers a device moving into a new zone; does NOT cover a zone reparented with no device
      moving, because no device's `zoneId` changes then.
      (b) *Make staleness harmless, then add the interval.* Hold an unknown-zone device out of
      actuation instead of falling back to Main. Removes the wrong-meter window by construction,
      at the cost of not actuating a device whose zone cannot be resolved — which is the posture
      already taken before the first commit, extended to a zone the tree does not know.
      (c) *Accept the cost.* Keep the fetch on every refresh and close this entry.

      **When it is done:** zone fetches per 12 h are down by at least an order of magnitude, and a
      test drives a device into a zone the cached tree has never seen and asserts it is never
      planned by the wrong home. Source: Codex P1 on PR #2252, 2026-08-31.

- [ ] **The "Charge on solar surplus" toggle disappears when a charger is switched to an EV
      target-power preset, and stays hidden until the next device refetch.** The settings-UI gate
      reads a snapshot field the mode switch has just deleted, so it hides a control the runtime
      would still honour — the runtime/UI mirror drift the gate's own docblock exists to prevent.

      **Where:** `isSurplusTrackingDeviceShape`
      (`packages/settings-ui/src/ui/deviceDetail/solarSurplusTracking.ts`) gates on
      `hasUsableSteppedLoadLadder(device.steppedLoadProfile)`. Switching to a preset routes through
      `applyLocalDeviceControlProfile(deviceId, null)`
      (`packages/settings-ui/src/ui/deviceControlProfiles.ts`), which deletes the local
      `steppedLoadProfile`; the target-power write that follows does not repopulate it, and the
      re-render (`refreshSharedDeviceViews` / `refreshOpenDeviceDetail`) reads that same local
      object. The runtime meanwhile derives the ladder from the target-power capability
      (`buildTargetPowerLadderSteps`), so it still stamps the posture.

      **What changes:** gate on the effective control model rather than the raw snapshot field.
      `getEffectiveControlModel` (`deviceControlProfiles.ts`) already answers `stepped_load` for a
      stored target-power config with `enabled !== false`. Rule on whether the usable-ladder check
      still has to run against the preset's derived ladder, or whether
      `getEffectiveControlModel(device) === 'stepped_load'` is the whole gate.

      **Done when:** switching a managed charger to an EV target-power preset leaves **Charge on
      solar surplus** visible without reopening the page, pinned in
      `packages/settings-ui/test/deviceDetailSurplusTrackingGate.test.ts`.

- [ ] **The executor classifies a transport exception to decide whether a write was unacknowledged
      — the actuator seam should hand it that answer already resolved.** Both dispatch paths catch
      the raw throw and ask `isHomeyRequestTimeout` themselves:
      `dispatchBinaryControlDecision` (`lib/executor/binaryControlDispatch.ts`) and
      `executeSteppedLoadCommand` (`lib/executor/steppedLoadExecutorCommand.ts`). That is a control
      layer inspecting error provenance to reconstruct a fact the transport already knew, which is
      the shape root `AGENTS.md` § "Clean and trusted interfaces between layers" forbids. The
      predicate's home in `lib/utils/errorUtils.ts` is correct and not the issue — the caller is.

      **Where:** `ActuatorOutcome` (`lib/actuator/deviceCommand.ts`) and `applyBinary` / `applyStep`
      (`lib/actuator/deviceActuator.ts`), which today let the exception pass straight through.

      **What changes:** add an unacknowledged member to `ActuatorOutcome` (e.g.
      `{ requested: true; acknowledged: false }`) and make the actuator the single place that calls
      `isHomeyRequestTimeout`, carrying the transport through. Fold
      `SteppedLoadStepRequestResult`'s `flow_trigger_timeout` into the same vocabulary so one
      outcome has one name. `no-actuator-to-peer` permits `lib/actuator → lib/utils` as the config
      stands, so no boundary change is needed.

      **Done when:** `grep -rn isHomeyRequestTimeout lib/executor/` is empty and both executor
      `catch` blocks handle only definite failures — pinned by the existing stepped and binary
      outcome-unknown tests.

- [ ] **A stall promotion is unattributable in the logs: nothing records the verdict or setpoint
      that armed it.** `maybePromoteOnStall` (`lib/objectives/deferredObjectives/planHistory.ts`)
      and `resolveStallReportedStatus` (`.../diagnosticsBridge.ts`) both act on
      `StallEvidence`, and a promotion latches the run `satisfied` for good —
      `computeMergedMetState` freezes it and `recordNonPlannableTick` excludes stall reasons from
      the re-open path. The classifier logs only *transitions*
      (`device_near_target_idle_started` / `_cleared`), so the per-cycle verdict the gate actually
      read is never written anywhere. `deferred_objective_horizon_planned` carries the resulting
      `status` / `reasonCode` but not its cause.

      This blocked a real investigation on 2026-08-24: a Connected 300 run reported
      `satisfied` / `objective_stalled_near_target` at 40.6 °C against a 65 °C target with 7.25 kWh
      still booked, and the logs could not say which verdict and setpoint produced it — the last
      classifier transition was five hours earlier and pointed the other way (`unresponsive`).

      **Where:** the stall gate call sites above; the `deferred_objective_horizon_planned` payload
      in `diagnosticsBridge.ts`.

      **What changes:** emit the evidence the gate consumed — `classification` and
      `classifiedAgainstTargetValue` alongside the objective's `targetValue` — either as fields on
      the existing horizon-planned event or as a dedicated event at the promotion site. Log it on
      the promotion, not on every cycle; a latch that fires once deserves one line.

      **Done when:** a `satisfied` / `objective_stalled_*` status in a production log can be traced
      to the verdict and setpoint that produced it without re-deriving them from device writes,
      pinned by a test asserting the fields appear when a promotion fires.

- [ ] **The restore-cooldown branch marks nothing during an overshoot, so a sub-deadband deficit
      still resumes an already-limited device with no admission check.**
      In `applyRestorePlan` the `inRestoreCooldown` branch derives its hold from
      `resolveCapacityRestoreBlockReason`, which returns `null` on `activeOvershoot` ("the caller's
      own reason stands") — and in that branch there is no caller reason. The branch then returns
      without marking anything, so every off device stays `plannedState: 'keep'` and the executor
      turns it on. Reaching it needs `sheddingActive === false` while headroom is negative, which
      after the 2026-08-16 latch fix means exactly one state: a deficit below
      `SOFT_OVERSHOOT_DEADBAND_KW` (50 W) still inside its 20 s `SOFT_OVERSHOOT_PERSIST_MS` window,
      with the global restore cooldown running and nothing else holding. The deficit is tiny; the
      resume is not — nothing sizes it against available power, so a 2 kW load can come back on the
      strength of a 40 W deficit. Pre-dates the shed grace (`actionable` was equally false for a
      sub-deadband deficit before it). Fix direction: the branch should fall back to
      `markOffDevicesStayOff` rather than returning empty-handed, or the ladder should stop treating
      "a caller reason exists" as a given. Found 2026-08-16 while fixing the shed-grace restore-all;
      the invariant it violates is in `lib/plan/shedding/AGENTS.md` § "Declining to shed is not
      deciding there is no overshoot". [P2]

- [ ] **`stateOfCharge` rides the plan device undeclared, and the objectives layer depends on it.**
      `PlanInputDeviceBase` states "No `evBoost` / `stateOfCharge` / `temperatureBoost`"
      (`packages/planner-types/src/planInputDevice.ts`), and `toPlanDevice` does not declare the
      field — but it reaches every plan device anyway on the `...deviceFields` spread, invisible
      to tsc because `withSteppedDiscriminant<TBase extends object>` infers from the literal. That
      is not dead weight: `ObjectiveDeviceInput` reads `device.stateOfCharge?.level`
      (`lib/objectives/deferredObjectives/diagnosticProgress.ts`), and its own docblock describes
      the plan device as the carrier. Stripping it — attempted 2026-08-16 on the review's advice
      that it had no live consumer — turned every EV smart task's progress into
      `objective_progress_stale` and broke four `evDevices.integration` cases plus the deferred
      release intent. Reverted. The contract and the runtime disagree, and today only a test run
      says which is right. Fix: declare the field on the type the objectives layer actually
      consumes and correct the base-type comment, so the dependency is stated rather than
      accidental. Same shape of hole as `evChargingState` — and THAT half is closed (2026-08-22):
      the documented-as-forwarded plug-state was not merely undeclared, it was stripped, so the two
      `lib/objectives` reads guarded by it were dead code. In production an unplugged charger was
      reported as `objective_progress_stale` (a reading problem) for whole task windows, and
      `objective_invalid_session` had never been emitted once. The field and its false comment are
      gone; the layer reads the producer-resolved `objectiveSessionInactive` (REQUIRED on
      `PlanInputDevice`), NOT `commandableNow` — see the "Pick the producer bit that answers YOUR
      question" rule in `lib/objectives/AGENTS.md`. That raises the severity of the half still open here:
      it is not tidiness, it is the same silent-strip failure mode with a live consumer. [P1]

- [ ] **A temperature device shed during a facet-miss cycle is turned off instead of set back.**
      `buildInitialPlanDevices` (`lib/plan/planDevices.ts`) only consults `deps.getShedBehavior`
      for stepped or temperature devices, so in the one cycle a device plans as `onoff` its shed
      behavior falls to the default `{ action: 'turn_off' }`. If the shed decision lands in
      exactly that cycle, a device configured for setpoint-lowering is switched off instead:
      capacity-safe (over-shed), comfort-affecting, self-correcting on the next refresh.
      Pre-existing since the observer-side atomic facet landed (#2103) — the capability list is
      stripped with the facet, so `supportsTemperatureBoostDevice` already answered false. Fix
      is to resolve the configured behavior from the device's stored configuration rather than
      its live modality. Found 2026-08-14. [P2]

- [ ] **Split the three meanings collapsed into `progressCurrentValue`'s `undefined`.**
      `lib/objectives/deferredObjectives/diagnosticFields.ts` returns `number | undefined`, and
      the `undefined` means three different things: `generic_energy` has no band dimension (a
      structural fact — degrading to the global mean is correct), progress is untrustworthy
      (`progress.reasonCode` set: stale sensor, missing device), and the measurement is simply
      absent. `integrateBands` treats all three alike, so cases 2 and 3 currently produce a
      plausible-looking `remainingUnits × globalMean` energy figure derived from progress the
      producer already declared untrustworthy. Return a discriminated result and let only the
      first case degrade; the other two belong in the existing all-null "unavailable" arm of
      `DeferredObjectiveEnergyResolution`. Deliberately NOT done alongside the miss-attribution
      fix: it changes planner behaviour (objectives that get an estimate today would report
      `objective_missing_capacity`), so it wants its own PR and its own SDK-boundary e2e.
      Split out 2026-08-12. [P2]

- [ ] **Name the daily budget when it is a contributing cause of a smart-task miss, not only the
      sole one.** `resolveStatus` reaches `limited_by_daily_budget` only when lifting the per-bucket
      cap would close the gap outright (`resolveBudgetBoundFeasibility`). A plan whose floor was
      squeezed by the soft budget but that misses for a compounding reason lands on
      `target_cannot_be_met` → `floorShortfallCause: 'time_capacity'`, so the surface says
      "Cannot finish" with no mention of the budget and no route to the "may go over daily budget"
      permission that would actually help. The producer already has both numbers to resolve the
      contributing-cause signal (the capped allocation and the uncapped probe), so this is a flat
      boolean onto the diagnostic + persisted revision plus the copy branch — deliberately NOT a
      change to the primary status, which stays honest about whether the target is reachable at all.
      Note that `notes/deferred-load-objectives/budget-bound-false-cannot-meet.md` claims a P1 for
      this is tracked here; it was not, hence this entry. Files:
      `lib/objectives/deferredObjectives/horizonPlanner.ts`, `.../floorShortfallCause.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`. Source: 2026-08-09 investigation of an EV smart
      task reporting `time_capacity` while every hour of its plan was budget-shaped. [P2]
      **Sequence against the reserved-headroom entry below:** it argues budget-flavoured
      statuses already appear too optimistically because `reservedHeadroomKw` is built from the
      raw hard cap. Naming the budget more often without that fix widens the surface it calls
      dishonest.

- [ ] **`reservedHeadroomKw` is built from the RAW hard cap, while the live guard sheds against
      `limitKw − marginKw`.** `getHardCapKw: () => ctx.capacitySettings.limitKw`
      (`setup/homeRuntime/homeScope.ts`, `setup/appInit/deferredObjectiveLifecycle.ts`) feeds
      `policyHorizon.resolveReservedHeadroomKw`, but the planner paces against
      `capacityPaceKw`, derived from `hourlyAllowanceKWh = max(0, limitKw − marginKw)`
      (`resolveUsableCapacityKw`). So the forecast is one safety margin more generous than what
      the runtime will admit. That was tolerable while the value was only a kWh ceiling; it now also
      SELECTS the rung the feasibility probes test, so any rung sitting in the
      `(limitKw − marginKw, limitKw]` band is probed as reachable when the guard will never admit
      it. Direction is optimistic-only and the probes are classification-only, so the failure mode
      is a status label — `at_risk` / `limited_by_daily_budget` where `cannot_meet` was honest,
      offering a budget remedy that will not actually free the device. Fixing it means subtracting
      the margin at both wirings, which also tightens `resolveStepForBucket`'s committed floor
      promotion — hence its own change rather than a rider. Source: pels-layering-guardian on
      PR #2061. [P2]

- [ ] **Latch `currentHourClaim` for the hour instead of recomputing it through the whole `:58`
      window.** `isPastHourSettleMark` is true from `:58:00` to `:59:59`, so the fresh allocator —
      and with it the claim — runs on every cycle in that window (~12 in `homey_energy` mode, more
      and irregular under `power_source = flow`). The two-clock design says a control decision moves
      only at the settle; this is the one seam where it can move repeatedly within one. The
      asymmetry is what makes it worth closing: `released` fires a lifecycle release with no
      cooldown gate, while `unclaimed` can only re-admit through the 60-300 s restore cooldown, so
      an alternation is not symmetric churn. Resolve the claim once on the first fresh pass at/after
      the mark and reuse it for the rest of the window, the way `cheaperHourAhead` is stamped once
      at the booking revision. Also covers the no-commitment case, where no frozen fallback exists
      and the fresh path runs every cycle for the whole hour. Source: pels-runtime-reality on
      PR #2059. [P2]

- [ ] **Nothing in CI ever inspects the packaged tree that actually ships.** `npm run validate` is
      `homey app validate && npm run package:check`, and `homey app validate` calls
      `preprocess({ copyAppProductionDependencies: app instanceof AppPython })` — false for a Node
      app — so `.homeybuild/` is rebuilt *without* `node_modules`
      (`/usr/lib/node_modules/homey/lib/App.js:862-894`, `bin/cmds/app/validate.mjs:28-32`;
      `preprocess` wipes the directory at App.js:874, so an earlier `npm run build` tree does not
      survive either). Every node_modules-dependent assertion in
      `scripts/check-homey-packaging.mjs` — the pruned-package loop, the sourcemap/`.d.ts` survivor
      guard, the 18 MB ceiling — therefore never runs in CI
      (`.github/workflows/test.yml:61-77`); they now self-report as NOT EVALUATED rather than
      passing silently. `homey app build` runs the same `preprocess()` with production dependencies
      and no network or device, so inserting it before `package:check` makes all three enforceable.
      Done when those three assertions execute in CI instead of reporting NOT EVALUATED. The cost to
      weigh while doing it: a second full `preprocess` (each re-runs `npm run build`) validating only
      at level `debug`, so this adds CI minutes rather than swapping them. Source: 2026-08-07
      build-size audit, adversarial pass on PR #2006. [P2]

- [ ] **A `turn_off` stepped device whose profile has no zero-power step can never be fully turned
      off.** `getSteppedLoadOffStep` returns null for such a profile and
      `getSteppedLoadLowestStep` then answers the lowest ACTIVE step, so both the shed ladder
      (`buildSteppedShedDescentTargets`) and materialization
      (`resolveSteppedLoadDirectShedStepId`) bottom out at a step that still draws. If a stale
      measurement makes every active-step delta price at zero, the device is skipped entirely even
      though it exposes a writable `onoff` and turning it off would release its measured draw.
      Pre-existing — the pre-descent code reached the same outcome — and NOT fixed by routing to
      `buildPreparedSteppedBinaryOffCandidate`, whose precondition
      (`targetStep?.id === device.selectedStepId`) cannot hold while the device sits above its
      lowest step. The real fix is a binary-off terminal on the ladder for a `turn_off` device
      whose profile lacks an off step. Narrow: every profile PELS generates (native Høiax wiring,
      EV target-power) carries an explicit `off` step, so this needs a hand-configured profile.
      Source: Codex review of PR #1996, 2026-08-06. [P2]

- [ ] **The sustained hard-cap card's in-app hint omits the flow-source reporting requirement.**
      With `power_source = flow` and samples arriving less often than once a minute, every
      sustained run ends `evidence_stale` (`setup/capacityShortfallAlertDispatch.ts:366`, 60 s
      freshness bound), so thresholds of 120–600 s silently never fire during a genuine breach.
      docs/flow-cards.md documents the once-a-minute requirement; the card hint does not. Either
      add the caveat to the compose hint, or have the guard republish a heartbeat candidate while
      the condition stays evidenced with a fresh-by-flow-standards sample. Source: 2026-08-02
      release review, pels-runtime-reality + budget/alerts adversarial pass. [P2]
- [ ] **The immediate hard-cap alert burns its once-per-incident shot on a rejected delivery.**
      `setup/capacityShortfallAlertDispatch.ts:240-242,270-280` latches `deliveredIncidentId`
      before `fire()` resolves, so an SDK-rejected trigger is never retried for that incident even
      though candidates keep republishing; the sustained lane already re-serves on rejection.
      Pre-existing parity with the retired hold, not a regression. Don't latch when `fire()`
      resolves `rejected`. Source: 2026-08-02 release review, pels-runtime-reality. [P2]
- [ ] **The signal-driven shortfall paths log a hard-cap incident with no capacity evidence.**
      `lib/plan/rebuildScheduler/signalDriven.ts` passes `buildNullCapacityStateSummary()` into
      `checkShortfall` at both sites that can reach `enterShortfall`, so
      `hard_cap_shortfall_detected` emits `summarySource: null` and every count/power field
      `null`. Until `refactor/capacity-guard-strip` the guard filled this in itself from
      `capacityStateSummaryProvider`, which both factories wired to
      `buildPlanCapacityStateSummary(planService.getLatestPlanSnapshot(), ...)`; removing the
      provider made the omission visible rather than causing it, since a caller that passed no
      summary always meant to pass one. The worse of the two is the
      `skipWhileShortfallUnrecoverable` branch, which exists precisely because the plan is
      unwinnable — the incident where an operator most needs
      `remainingActionableControlledLoad` and the managed/background split. The caller already
      holds the data: `setup/powerSamplePipeline.ts` builds `latestPlanSummary` from the same
      snapshot a few lines above and does not pass it down. Thread it through; the planner path
      (`lib/plan/admission/sheddingGuard.ts`) already builds a real summary and is the model.

- [ ] **Smart-task permission presentation: locked row hides its description; read-only row sits
      in "What PELS has learned".** While "May limit lower-priority devices" is gated off, its
      description is replaced by "Turn on 'May go over daily budget' to use this." so the owner
      can't learn what it does before granting the prerequisite (show both lines). On the task
      detail, the granted-permissions row renders inside the learned-inputs card; a permission is
      a setting, not something learned — move it beside the task inputs. Source: 2026-08-02
      release review, pels-ux-fit. [P2]
- [ ] **Activity log: collapse resume/turn-off alternation bursts.**
      *Persona:* owner reading the log after a windy evening.
      *Hypothesis:* consecutive-identical entries now collapse, but an A/B/A/B resume-vs-turn-off
      alternation within minutes still renders as 2N cards that read as malfunction; a paired
      collapse ("Tried to resume 5× in 4 min — not enough power") would tell the story in one row.
      Source: 2026-08-08 walk, pels-ux-fit finding 11 (remainder). Files:
      `packages/settings-ui/src/ui/views/DeviceLogView.tsx`. [P2]
- [ ] **A price-adjusted target gets no reason line on the hero or card.**
      *Persona:* owner seeing hero "target 25 °C" above a Home-mode row saying 21 °C during a
      cheap hour.
      *Hypothesis:* the solar lift has its explaining line ("Raised to use your solar power",
      `planTemperatureCardText.ts`) but the cheap-hour boost / expensive-hour reduction has no
      sibling, so the owner must reconstruct hero = mode + price delta themselves. A symmetric
      line ("Raised for cheap hours" / "Lowered for expensive hours"), sourced from the plan's
      price-adjust fact whenever plannedTarget diverges from the active mode target, closes the
      gap. Source: 2026-08-09 post-merge review, pels-ux-fit. [P2]
- [ ] **Car card opens with an instruction there is nothing to act on.**
      *Persona:* EV-charger owner with no car app installed.
      *Hypothesis:* "Tick the cars that charge here…" renders directly above "No cars found" —
      a dead imperative; suppressing the intro (or ordering the empty-state line first) when the
      list is empty lets the empty state carry the card. Files:
      `deviceDetail/carAssociation.ts`. Source: 2026-08-09 post-merge review, pels-ux-fit +
      pels-m3-critic. [P3]
- [ ] **`formatHoursBeforeDeadline` rounds the safety margin in the flattering direction.**
      `packages/shared-domain/src/deadlineLabels.ts:2510`: "projected ready ≈ 18:00, 2 hours
      before the deadline" against a 19:40 deadline overstates a 1 h 40 min margin via
      `Math.round`; this release's shortfall resolver ceils for exactly the opposite reason.
      Floor the hours or render "1 h 40 min". Source: 2026-08-02 release review, pels-ux-fit. [P2]
- [ ] **docs/weather-insight.md still says auto-apply "replaces" the budget each day.** Since
      8ec444cd8 auto-apply is asymmetric: it skips `would_lower_while_limiting`, so it will not
      lower a budget the home has been running past. Add the one-line caveat to the
      "Auto-applying the suggested budget" section. Source: 2026-08-02 release review, docs
      freshness pass. [P2]
- [ ] **Eleven device-detail captures are committed but referenced by no docs page.**
      `docs/public/screenshots/device-detail/` holds fourteen images; only
      `mw-thermostat-heatpump-full` (`docs/configuration.md`) and the two `solar-surplus-*`
      (`docs/solar.md`) are used. `held-hero`, `diagnostics-open`, `setup-expanded`,
      `thermostat-top`, `stepped-zaptec`, `shedding-with-temperature`, and the five remaining
      `mw-*-full` variants are referenced only by the capture specs that produce them (plus one
      citation in a `style.css:5418` comment), as is `docs/screenshots/deadline-plan/320.png`.
      Either wire them into the pages they were shot for or stop capturing them — right now they
      cost a refresh every time the device page moves and pay nothing back. Source: 2026-08-10
      docs/screenshot freshness pass. [P2]
- [ ] **A satisfied ON-axis thermostat still reads "Running · 0.0 kW".** The satisfied-idle
      refinement (2026-08-01) covers only target-only devices (`currentState 'not_applicable'`);
      a binary temperature device that is on, at/above target, and drawing nothing keeps the
      "Running" word — and after the fix it sits directly beside a corrected Idle card, making
      the remaining self-contradiction MORE conspicuous (pels-ux-fit top recommendation on
      PR #1955). Extend `isSatisfiedTargetOnlyDevice`'s satisfied semantics to on-like temperature
      devices (same lowered-setpoint and pending-command guards), or explicitly rule the 'on' case
      out in `notes/ui-terminology.md`. *Persona:* Overview reader with a mixed thermostat fleet.
      *Hypothesis:* same trust damage as the target-only case, narrower trigger (device must
      report 'on' while satisfied). Source: pels-ux-fit on PR #1955, 2026-08-02. [P2]

- [ ] **A meter that jitters *and* lags still reads as evidence that a shed achieved nothing.**
      `resolveSameMeasurementSheddingDecision` now holds a shed from deepening while the whole-home
      reading is byte-identical to the one the last shed was decided on
      (`UNCHANGED_READING_SHED_HOLD_MS`). Exact equality is deliberate — it is the signature of a
      re-delivered aggregate — but it means a meter that moves a watt or two while still not
      reflecting the shed (4351 → 4348 with the ~1.08 kW relief unaccounted) slips through and the
      planner cuts deeper than the real deficit needs. The complete fix splits across two layers:
      recognising a re-delivered or lagging aggregate is a meter question and belongs in
      `lib/power`, which owns the reading; comparing the realised drop against the relief actually
      credited for the devices shed last cycle is shed bookkeeping and stays in the planner, which
      is the only layer holding `lastShedPlanShedIds` and the credited figures. Do not push the
      second half into `lib/power` — it cannot see them. Field case: 2026-08-01, hard cap 3.0 kW, total 4.351 kW; #4 shed at
      11:03:44 credited ≥1.81 kW but realised ~1.08 kW; the 11:03:54 repeat then took both #2 and
      the user's #1. Persona: the owner who ranked their priority list and expects #1 to survive;
      hypothesis: "PELS ignores my priorities" when it is really over-cutting on a reading that
      has not yet reflected the shed. [P2]

- [ ] **The unchanged-reading shed hold freezes shed membership, not shed depth, so a stepped device
      still deepens one notch per held cycle.** `holdSheddingAtLastDecision` re-asserts the decided
      devices into `shedSet`, but `PlanEngineState` carries only their ids (`lastShedPlanShedIds`),
      so each held cycle re-prices the ladder from wherever the device now sits and re-chooses a
      rung against the same unchanged deficit. An EV charger on `set_step` shed behaviour at 16 A
      therefore walks 10 A → 6 A → lowest active step across a 30 s hold, on readings the module
      itself has declared to be non-evidence. Bounded (it leaves the candidate set at the lowest active step)
      and not a regression versus the pre-hold behaviour, which stepped it down on those same cycles
      — but it means the incident class is only closed for binary devices, and priority-ranked
      stepped loads are exactly what users notice. Fix needs the hold to carry the decided target
      step, not just membership. Persona: the owner who ranked an EV charger below their heating.
      Source: `pels-runtime-reality` on the unchanged-reading-hold PR. [P2]
- [ ] **A budget-axis restore rejection is attributed as capacity pressure when
      `softLimitSource` is 'capacity'.** With an off exempt device projecting, the binding source
      can read 'capacity' (`budgetPaceKw + projectedExempt > capacityPace`) while the per-axis
      ledger rejects a non-exempt candidate on the MEASURED budget axis
      (`budgetPaceKw + measuredExempt < capacityPace`). `budgetReleasableHeadroomHold` derives
      from the binding source, so the hold keeps the numeric headroom framing and the budget
      rescue is not offered even though the budget is the axis doing the work. Fix direction:
      re-key hold attribution per axis at the rejection site (the ledger knows which axis bound),
      not off the collapsed binding source — the same catch-up the reason fold got for exempt
      candidates. *Persona:* daily-budget home with an off exempt charger and held thermostats.
      *Hypothesis:* needs projected>measured AND the projection large enough to flip the argmin;
      display-only harm (wrong framing, missing rescue offer). Source: Codex review on PR #1956 +
      pels-layering-guardian corner (b), 2026-08-02. [P2]
      Absorbed from the merged admission item, the same flag's opposite face: it is also a
      false POSITIVE. Where capacity sits between the budget pace and the candidate's restore
      need (capacity pace 5 kW, draw 4 kW, daily pace 4.5 kW, need 1.2 kW), the held-back
      widget offers "Let it run now" and the release still leaves the restore blocked, so the
      owner is handed a dead lever. Deriving attribution per axis at the rejection site closes
      both faces.

- [ ] **A budget-bound "Waiting to increase" step-up hold still speaks the headroom axis.** The
      `insufficientHeadroom` → `dailyBudget` re-attribution in `normalizeShedReasons` only touches
      `plannedState === 'shed'` devices, but a stepped device running at a reduced step with a
      blocked step-up carries the same reason on a `keep` device (`KEEP_REASON_RULES` allows it;
      `dailyBudget` is not an allowed keep reason today). Under a daily-bound pace its card reads
      "Waiting to increase — X kW more needed" when the truth is budget pacing. Fix needs a
      keep+`dailyBudget` validation pair plus a card line for "running at a reduced step because of
      today's budget". *Persona:* daily-budget user with a stepped water heater/EV mid-hour.
      *Hypothesis:* rarer than the shed case and the number becomes honest once the shortfall fix
      lands, so the wrong axis label is the remaining harm. Source: 2026-08-01 budget-hold copy
      investigation. [P2]

- [ ] **A reserve-blocked hold is attributed to the wrong counting cause when the restore lane
      did not run.**
      *Persona:* owner (`notes/personas.md`) opening device detail on a device that is held
      back, to find out what is holding it.
      *Hypothesis:* both routes into a startup-reservation hold now COUNT toward the held-back
      clock — the 2026-08-08 ruling is that the clock runs whenever PELS turned the device off,
      and a reservation is PELS holding it for a higher-priority device. What still differs is
      the attributed cause. When the restore/hold lane evaluated the device it sets the
      `reservedForStart` code and the cause reads `reserved_for_start` ("Waiting so X can
      start"). When it did not (fresh shed, over-pace, cooldown), `finalizeCeilingReason`
      leaves the ceiling code in place and the cause reads `capacity` /
      `insufficient_headroom` ("Waiting for available power") — which tells the owner to free
      power for a hold no amount of freed power lifts.
      *Why it's needed:* the card copy for both routes was unified 2026-08-07 (the holder's
      name rides along as a display field), so the CARD is honest either way; device-detail
      diagnostics still are not, and that is where an owner goes when the card is not enough.
      *Why it was not fixed with the copy:* the honest code, `reservedForStart`, is in
      `RESTORE_ADMISSION_HOLD_REASON_CODES` and builds no actuation intent. Minting it at
      reason normalization would cancel an in-flight shed command's retry while the device
      keeps drawing inside the reserved block —
      `test/integration/planHeadroomReserve.test.ts` § "keeps asserting the floor while the
      shed has not materialized" is the guard. Fix direction: thread an
      `observedAtShedFloor`-equivalent into `finalizeCeilingReason` (the setpoint lane grew one
      in `planReasonsHoldDecisions.ts` § `isObservedAtShedFloor` on 2026-08-08, so binary and
      stepped devices still need theirs) and apply the same guarded rewrite the restore lane
      already does.
      *Scope note:* `HEADROOM_RESERVE_MAX_MS` is 15 minutes and the held-back entry delay is
      also 15 minutes, so a maximally long reservation now sits exactly on the boundary —
      worth confirming against prod telemetry before tuning either constant.
      Source: bare "Waiting to resume" path audit, 2026-08-07; rewritten 2026-08-08 after the
      held-back clock ruling falsified the original premise (both lanes paused/counted
      differently; now both count). [P2]
      Includes the re-arm half: a reservation that lapses mid-window can never re-arm even if the
      blocking load disappears, because only a genuine start clears the stamp. Allow re-arm after
      a cool-off, or key the lapse to the planned bucket.

- [ ] **Four shed-device reason codes have no starvation classification at all.**
      *Persona:* owner (`notes/personas.md`) reading device detail on a held-back device.
      *Hypothesis:* `neutralStartupHold`, `startupStabilization`, `capacityControlOff` and
      `shedInvariant` appear in neither the counting nor the pausing table in
      `lib/planContract/planDecisionSemantics.ts`, so a `plannedState: 'shed'` device carrying
      one falls through to `unknown_suppression_reason` and device detail literally reads
      "Service reason unknown". The 2026-08-08 ruling (the clock runs whenever PELS turned the
      device off) argues `neutralStartupHold` and `shedInvariant` should COUNT with their own
      causes; `capacityControlOff` is the owner's own switch and should pause.
      *Why it's needed:* "Service reason unknown" is the one string in that view that tells the
      owner nothing, and it is reachable today. Pre-existing — neither introduced nor worsened
      by the ruling. Source: starvation-rule change, 2026-08-08. [P3]

- [ ] **Two user-visible need figures still use the deflated restore need.**
      *Persona:* owner (`notes/personas.md`) reading how much more power a device needs.
      *Hypothesis:* `maybeApplyShortfallReason` and `buildRestoreShortfallReason` build their
      numbers from bare `computeBaseRestoreNeed`, so they carry the same understatement the
      ceiling-shortfall path had before 2026-08-08 — the recent-shed inflation
      (`applyRecentShedInflation`, 1.15× or +0.15 kW within five minutes of a shed) is missing.
      A device shed minutes ago is told it needs less than the restore gate will actually
      demand.
      *Why it's needed:* the owner acts on that number — freeing exactly the stated amount and
      finding the device still will not resume is the failure mode the ceiling path was fixed
      to avoid. Fix direction: call the shared helper, as `resolveCeilingShortfall` now does.
      Source: planner timer-hold + shortfall-need fix, 2026-08-08. [P2]

- [ ] **Device-detail diagnostics hardcodes 12 status strings that duplicate or contradict
      shared-domain.**
      *Persona:* owner (`notes/personas.md`) comparing a device card against that device's
      detail view.
      *Hypothesis:* `packages/settings-ui/src/ui/deviceDetail/diagnostics.ts` inlines its own
      `STARVATION_REASON_LABELS` copy rather than importing the shared-domain vocabulary. Some
      entries are verbatim duplicates; others actively disagree for the same reason code —
      `'Waiting before retrying'` vs shared-domain's `'Waiting to resume — Ns'`,
      `'Daily budget is limiting service'` vs `'Limited by today's daily budget'`,
      `'Waiting for higher-priority device'` vs `'Making room for higher-priority device'`.
      Three entries render the planner-jargon phrase "No active service block".
      *Why it's needed:* the card and the detail view describe the same state in different
      words, and `notes/ui-terminology.md` makes shared-domain the single home for user-visible
      copy so runtime logs and UI cannot drift. Pre-existing since May 2026. Source: starvation
      classification work, 2026-08-08. [P3]

- [ ] **Three EV car-link membership gaps that keep the probe blind to a car.** All three leave a
      car unobserved rather than mis-observed, so they cap what the probe can measure without
      corrupting anything. (a) *Cars initially missing a readable plug state are never retained.* A class `car` device
      whose `ev_charging_state` is absent/malformed on the first authoritative fetch is not tracked
      at all, so it gets no realtime subscription and no place in targeted reads, and
      `noteCapabilityUpdate` only accepts already-tracked cars — a later valid value cannot recover
      it until a full refresh or restart. (b) *Targeted misses ignore `failedIds`.* A by-id read
      failure is classified separately by the fetch layer but that never reaches the probe's miss
      counter, so three flaky reads (post-actuation and stuck-command refreshes come in bursts)
      permanently forget a still-present car; it should use the same count-plus-wall-clock grace as
      `mergeTargetedRefreshSnapshot`. (c) *Cars created after startup are undiscoverable.* Periodic
      refreshes are targeted and the live-feed handler ignores `device.create`, so a car app
      installed later is invisible until a full refresh or restart. Persona: anyone installing a car
      app after PELS; hypothesis: "the probe logged nothing" reads as "detection failed" rather than
      "it never saw the device". Source: Codex round 9 on PR #1895. [P2]

- [ ] **"Leave off until turned on again": sub-home plan paths are not driven by hold changes.**
      One remaining gap, multi-home-only: the hold store is shared across homes but the plan
      paths are not, so a sub-home keeps a stale `inactive/external_off_hold` plan until an
      unrelated sample or rebuild reaches it (which in flow mode can be a long wait). The
      `respect_external_off_devices` settings handler (`lib/utils/settingsHandlers.ts`) rebuilds
      only main after `releaseDeOptedHolds()`, ignoring the returned device ids. Fix: use the
      released ids to rebuild each owning home, the way `TEMPERATURE_CONTROL_DISABLED_DEVICES`
      fans out. (Realtime settlement now routes to the owning bundle in
      `setup/appObservedControlStateRuntime.ts`, and observations no longer trigger rebuilds, so
      the two gaps once listed beside this one are gone.) Single-home installs — the overwhelming
      majority — are unaffected.

- [ ] **Area rules refuse on save instead of guiding in the editor.** The name-length cap, the
      reserved "Main home" name, the eight-area cap, and the whole-home-meter requirement are
      enforced at the `ui_homes_save` seam and surface as a toast after a round trip; only
      non-emptiness and uniqueness are pre-checked inline by `validateSubHomeDraft`. The editor
      should carry a `maxlength` on the name input, an inline error for the reserved name, a
      disabled "Add meter area" button at the cap, and an inline main-meter refusal from the
      `shouldPromptMainHomeMeter` predicate `homesSettings.ts` already evaluates for the notice.
      Held out of the enforcing PR because `SubHomeDraftError` and `HomesSettingsSection.tsx` were
      owned by a concurrent branch; the server rules were deliberately scoped to the entry being
      written so `validateDraftName` can absorb them unchanged (the two validators
      this shares a fix with). Persona: owner who types a long or reserved name and only learns on
      save. Source: multi-home finishing train, area-config invariants PR. [P2]

- [ ] **A one-meter home can cycle between two meter-area refusals with no diagnosis.** An area needs
      its own meter and the Main home needs its own, so a home whose Homey Energy report lists a
      single meter cannot use meter areas at all. Today it discovers that by bouncing: saving an area
      refuses with `main_meter_required`, and assigning that one meter to the Main home makes the area
      editor refuse inline with "'Main home' already uses this meter". The rules are each correct; what is missing is the
      one line that says the home has no second meter to split. Detect "no report meter is assignable
      to the Main home" on the Multiple meters page and say so. Related to the empty-meter-list hint
      item above. Persona: owner with a single HAN meter who tries to add a rental. Source: multi-home
      finishing train, area-config invariants PR. [P2]
- [ ] **`runtimePackaging` contract-import detector false-positives on prose.** The regex in
      `test/integration/runtimePackaging.test.ts` is not line-anchored, so the bare word "import"
      inside a docblock matches and `[\s\S]*?` runs on into the next real declaration — flagging a
      pure `import type` as a value import. Hit while adding `lib/device/evCarLinkWiring.ts`
      (2026-07-26); worked around by rewording the comment. Anchor the pattern to a line start so
      the guard stops depending on comment wording. Left out of that PR to avoid loosening a
      packaging guard in the same change that needed it to pass. [P2]

- [ ] **Limits & safety: converge the Main-home form onto the native `.pels-input` field language (U-track).**
      *Persona:* multi-home owner who switches the shell's home scope bar between the Main home and a meter
      area. *Hypothesis:* U3 added the per-home editor using native `.pels-input` + unit-in-label ("Hard cap
      (kW)"), which follows the canonical form-styling + ui-terminology rules and matches the U1 homes editor;
      the legacy Main-home static form (`#settings-limits-form`) still uses `md-filled-text-field` with an
      in-field `suffix-text="kW"`, so flipping the scope morphs the identical two inputs (filled↔outlined,
      unit relocates). Kept out of U3 to preserve byte-identical Main behavior. Migrate the Main form to the
      native primitive (the design-system-unification direction) so both scopes read as one control. Source:
      pels-m3-critic review of the U3 per-home Limits surface, 2026-07-20.

- [ ] **Homes UI: warn when a sub-home's selected meter is also a managed+controllable device (U-track).**
      *Persona:* multi-home owner who picks a metering smart-plug as a sub-home meter and also leaves it
      managed. *Hypothesis:* while Homey Energy is the active power source, the runtime now carves every
      configured meter out of every home's plan input + pipeline snapshot and rechecks the source-device set
      at the final actuator seam, so it can never be shed/oscillated — but nothing tells the user their meter
      won't be controlled. Add a
      homes-settings validation warning ("this device is this home's meter; it won't be managed") mirroring
      the observe-only carve-out messaging. Source: R7b own-meter-shed audit, 2026-07-19.

- [ ] **Smart-task diagnostics: distinguish an active meter source from a missing device before its deadline.**
      *Persona:* owner who selects a device with an existing smart task as an electricity meter.
      *Hypothesis:* the source-filtered lifecycle device set omits the meter, so the still-enabled task
      reports `objective_missing_device` until deadline handling safely disarms it without a command.
      The reason-bearing durable-exclusion seam this asked for now exists —
      `ResolveObjectiveDeviceExclusion` (`lib/objectives/deferredObjectives/deviceExclusion.ts`), resolved
      by `resolveSmartTaskDeviceExclusion` (`setup/appInit/smartTaskHomeScope.ts`) and already carrying
      `sub_home` and `unmanaged`. What remains: add a `meter_source` arm with its own diagnostic code and
      copy, and answer it from that resolver, so status/history explain the task's real scope before it
      ends. P2. Source: runtime-reality review of PR #1873, 2026-07-23.
      The same third arm answers the auto-demoted case: a device `applyFalseOverrides`
      (`setup/appDeviceSupport.ts:92`) demoted for being power-incapable currently points the
      owner at a Managed toggle that is disabled. Done when both causes resolve to their own
      reason code and copy.

- [ ] **"Clear device settings" leaves the device's smart task behind, now visible as a paused card.**
      *Persona:* owner who removes a device from Homey and then purges its PELS settings. *Hypothesis:*
      `advancedDeviceDataPurge.ts` deletes the device's `managed_devices` entry but not its
      `deferred_objective.<id>` key, so the task survives with no owner and no device. Before the
      un-managed pause this read as `objective_missing_device`; now it reads "Paused — not managed"
      with a recourse pointing at a switch for a device that may no longer exist — the resolver cannot
      tell a purged device from an un-managed one, because PELS has no cheap presence oracle for a
      device its managed filter already dropped from the runtime snapshot. Fix at the source: have the
      purge clear the objective through the same device-scoped clear op the settings-UI cancel uses
      (`cancelDeferredObjectiveForContext`). Done when purging a device with a smart task leaves no
      `deferred_objective.<id>` key and no card on the Smart tasks list. P3. Source: correctness lens
      on the un-managed pause PR, 2026-08-23.
      Also enumerate `respect_external_off_devices` here: a device known only through that map
      is never offered by `resolveUnknownDeviceIdsFromSettings`, so "Clear unknown devices"
      cannot reach it either.

- [ ] **Smart-task preview keeps a missing committed task reserved after the live grace expires.**
      *Persona:* owner previewing a lower-priority task after a higher task's device has stayed
      unavailable for more than an hour. *Hypothesis:* lifecycle and planner decoration own
      stateful `PriorityAllocationTracker`s and release the missing task after
      `ELIGIBILITY_ABANDON_GRACE_MS`, while preview calls the batch diagnostics without a tracker;
      its active-plan fallback therefore remains reservation-eligible until the commitment is
      otherwise cleared. The preview is conservative and cannot actuate, but can understate the
      candidate's feasible schedule after the live controller has moved on. Expose a read-only
      grace classification from a clock-owned in-memory roster (never persist the derived order),
      then add a post-grace preview-parity regression. P2. Source: pels-runtime-reality review of
      the relative-priority PR, 2026-08-08.

- [ ] **Surface "your step flow is not answering" on the device detail.** *Persona:* flow-backed stepped-device
      owner (EV charger) whose `desired_stepped_load_changed` flow is missing, mistargeted, or not reporting back.
      *Hypothesis:* when a flow step command goes stale repeatedly (`stepCommandStatus:'stale'`,
      `stepCommandRetryCount` climbing), the UI shows only generic "Waiting to increase — Ns" cooldown copy —
      the prod 2026-07-05 deadlock was only diagnosable from raw logs. A device-detail status row (and/or
      settings hub chip) like "Step command not confirmed — check the flow that reports the step back" after
      N consecutive stale commands names the real remedy.
      *Why:* the failure mode is a *user wiring* gap with an actionable fix; today it presents as PELS
      mysteriously never resuming. Note the sibling trust cost: a flow that *confirms but lies* (reports the
      step without applying it) is bounded only by whole-home overshoot detection + the terminal direct
      `evcharger_charging=false` write, and that window stretches under `power_source = flow`'s irregular
      sampling. Files: `lib/plan/deviceOverviewLog.ts` / overview status writer,
      `packages/shared-domain/src/deviceOverviewStrings.ts`, `notes/ui-terminology.md` (new status copy).
*Hard-cap trajectory rekey follow-ups (2026-07-06 review findings; the rekey itself — "Above hard
cap" keyed to projected hourly energy instead of instantaneous kW — shipped with its P0/P1s fixed).*

*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups. The solar gross/net
split follow-ups from this batch are fixed by the solar-accounting follow-up; remaining open items continue below.*

- [ ] **Hero idle line contradicts the zero-managed empty state.** "Quiet hour. Nothing to do."
      renders 100 px above "No managed devices." — PELS claims an assessed-calm home while
      managing nothing. Suppress or reword the idle line when the plan carries zero devices.
      Also verify the Overview smart-task row is genuinely unreachable alongside an empty
      device list (`PlanOverview.tsx` renders both without cross-gating; a task on a
      just-unmanaged device may compose a live contradiction). Persona: brand-new owner on
      first open; hypothesis: a reassuring verdict over an unconfigured state teaches the user
      to distrust the hero. Source: pels-m3-critic on the onboarding-links PR (2026-07-19). [P2]

- [ ] **Simulation banner leads the fresh-install stack.** On a fresh install the first
      viewport is two stacked warning banners, and the top one offers "Turn off simulation" —
      the one action a user with zero configuration should not take first. Demote or suppress
      the simulation banner while the fresh-install condition holds (no persisted power source
      and no managed devices) so the setup call-to-action leads. Persona: brand-new owner on
      first open; hypothesis: the most prominent CTA should match the most urgent task.
      Source: pels-ux-fit on the onboarding-links PR (2026-07-19). [P2]

- [ ] **Power source select shows "Flow card" while unset and never explains the Flow.** On the
      Limits & safety page the unset select is indistinguishable from a made choice, and no
      copy on the journey says a Flow with the report-power action card must exist. Worse: the
      preselected "Flow card" cannot be *confirmed* — picking the already-displayed option
      fires no change event, so `power_source` stays unset and the banner keeps asking (Codex
      P2 on PR #1856). Add a "Not set" placeholder while `power_source` is unset (md-select
      `displayText` sentinel idiom) — which also makes choosing Flow a real value change that
      persists — and a one-line per-source hint under the select. Persona: brand-new owner
      following "Choose power source"; hypothesis: naming the unset state and the Flow
      requirement closes the last gap between the link and a working setup. Source:
      pels-ux-fit + Codex review (2026-07-19). [P2]

- [ ] **Duplicate `#plan-empty` ids (static first-paint + Preact render).** Both nodes coexist
      in the document; the onboarding e2e works around it with a visibility filter. Rename the
      static placeholder's id or drop it once the redesign surface owns first paint. Source:
      pels-ux-fit (2026-07-19). [P2]

- [ ] **Settings-UI structural consolidation train (deferred by the 2026-07 coherence review).**
      A designed, not-yet-executed train that unwinds the two-rendering-paradigms mess within the
      approved map `notes/settings-ui-semantic-map.md`. Order: shared Preact primitives in
      `src/ui/views/components/` — `Chip` (absorb `views/chipModifier.ts`, `usageHero.ts`
      `CHIP_TONE_CLASSES`, `BudgetOverview.tsx` `deltaChipClass`; canonical tone set, migrate `ok`→
      `good`, then drop the CSS alias) → `SegmentedControl` (extract `ToggleGroup` from
      `BudgetOverview.tsx` + the roving-tabindex keyboard model from `segmentedControl.ts`) →
      `Card` (fix the `budget-redesign-card` misuse in `DeadlinePlan.tsx` and `WeatherInsight.tsx`) → `Hero` (the four Preact
      heroes; unblocks future hero-content work) → `DeviceRow` scaffold (from
      `PriceAwareDevicesView.tsx`) — then imperative→Preact migrations: Usage hero (kills the last
      static-HTML hero in `index.html`) → Usage day view (deletes `createToggleGroup`, segmented
      impl 2/3) → Devices list (converges `buildRedesignDeviceRow`, rides the toggle-ring-contrast
      P2) → device-detail overlay slice-by-slice (Power-limiting slice first: rehome the hidden
      `md-filled-select` state store in `deviceDetail/shedBehavior.ts` + `index.html`, deleting
      `segmentedControl.ts`, segmented impl 3/3) → Modes (Sortable.js needs an imperative island) →
      Advanced. Plus a boot.ts quick win: replace the `budget-adjust`/`budget-weather` virtual-
      target if-chains with a declarative map. One surface/primitive per PR, screenshot-gated on
      convergence. Persona: contributor velocity + Set-and-forget owner (visual coherence);
      hypothesis: three segmented impls / two device rows / per-file chip vocab is where per-page
      drift keeps re-entering. [P2, structural]

- [ ] **Solar export price — migrate the smart-task *preview* price reader onto the planning price.**
      The export-price model, the derived `budgetPrice`, its planning consumers (daily-budget
      shaping/allocation, smart-task horizons, price levels, cheapest-hours — all `budgetPrice ?? total`,
      money/receipt surfaces deliberately staying on `total`), the export-price settings section, the
      Budget-tab "Export price now" subline, AND the planning-price DISPLAY surfaces (smart-task schedule
      chart/readout/caption, Budget hourly-plan curve + `using your solar` note, `plan_budget` widget
      curve + projected-cost estimate, Electricity "Right now" export row + reason line) all SHIPPED —
      byte-identical to today for a non-prosumer, money/receipt figures kept on `total`. The one consumer
      left on the import price is the smart-task **preview** reader
      (`buildDeferredObjectivePolicyWindowPrices` / `...PolicyBucketPrices` in
      `lib/objectives/deferredObjectives/policyHorizon.ts`): it still sources `buckets.price` (total-based)
      from the daily-budget snapshot, so the create-task widget's preview curve/cost can disagree with the
      planning-price allocation for prosumers. Fold it onto the planning price (matching the horizon allocator).
      *Persona:* prosumer (Norwegian plusskunde, or NL post-saldering) self-consuming solar. *P2.*

- [ ] **Give the `daily_budget_state` boot read an abandon-grace window.**
      `setup/dailyBudgetStateAdapter.ts` is a bare `settings.get`/`settings.set` pair — no
      abandon-grace, no persist guard, unlike the calibration and EV car-link stores that
      `notes/persisted-settings-state.md` documents. One transient junk or `undefined` boot read
      fails the guard in `DailyBudgetManager.loadState`, leaving the manager at `{}`;
      `DailyBudgetService.loadState` then records that empty-derived export as the policy's
      `lastPersistedStateJson`, and the first `updateState` writes it over a day of learned
      profile and plan state — unthrottled, because `lastPersistMs === 0` short-circuits the
      throttle on the first call. The same shape was already fixed for `pv_forecast_state`, and the
      same fix: treat an empty or malformed boot read as suspect for a grace window (or require a
      confirming read) before the first destructive persist. *Done when* a boot whose
      `daily_budget_state` read returns junk or `undefined` leaves the persisted key intact
      until a confirming read, proven by an adapter-boundary test. *Persona:* any owner on a
      Homey Pro that restarts under memory pressure. *Hypothesis:* the SDK read failures that
      motivated the other stores' grace windows hit this key too; the loss is a day of budget
      learning rather than 90 days of history, which is why it has gone unnoticed.

- [ ] **Generation-guard the rescue-gate state commit in `loadStarvationRescuableDevices`.** `overviewRescueGate`
      now guards the *repaint* after a gate refresh, but the controller's
      `state.starvationRescuableDeviceIds = new Set(ids)` (`packages/settings-ui/src/ui/starvationRescue.ts`) still
      commits whichever overlapping `/ui_starvation_rescue_devices` response lands last. Two `plan_updated` events
      while Overview is visible can let an older response overwrite the set after a newer one, so a later live/power
      tick repaints the latest plan against a stale global set — briefly hiding a valid "Let it run now" chip or
      showing one that should have gone. Fix: a monotonic generation token captured before the await, committed only
      if still latest (mirror the repaint guard). Persona: Optimiser watching a budget-held device on Overview;
      hypothesis: a chip that flickers on/off across plan updates reads as a bug. P2 edge (needs overlapping gate
      loads; self-corrects on the next refresh). Same family: the chip's on-arm preview response
      (`BudgetExemptChip` in `PlanDeviceCards.tsx`) can also land late and overwrite cleared/re-armed state, so a
      stale `deadlineAtMs`/label could be shown or reused on a later confirm — guard it the same way. Source: codex +
      coderabbit on #1736, 2026-06-17.

- [ ] **The budget-pressure overshoot compares whole-home kWh against a budget that paces on non-exempt energy.**
      `measuredBudgetOvershootKwh` (`packages/shared-domain/src/energySignature/budgetPressure.ts`) computes
      `kwhTotal - appliedBudgetKwh`, but `kwhTotal` is metered whole-home consumption while the daily-budget
      controller deliberately subtracts budget-exempt usage before pacing (`dailyBudgetState.ts`:
      "Budget control ignores exempt load, but reporting stays on real metered usage"). On a home with exempt
      devices, their energy is counted as a budget overrun even when non-exempt usage stayed inside the budget,
      so the loop can grow on a day that never actually ran out. Bounded by the per-day step cap and the
      prediction-relative ceiling, and inert on a home with no exemptions configured — which is why it is not
      being fixed in the PR that introduced it. Fix: carry the day's non-exempt (budget-counted) kWh on the
      record and measure against that. Persona: an owner with a "Get power now" exemption or an always-on
      exempt device; hypothesis: their suggested budget drifts up for energy the budget was never governing.
      Source: copilot on #1957, 2026-08-02. P2.

- [ ] **Two producers answer "what daily budget is applied".** `DailyBudgetService.getAppliedBudgetKwh()` (added
      for the budget-pressure loop) and `resolveDailyBudgetKwh(ctx)` in
      `setup/appInit/weatherAdvisorReadoutAssembler.ts` implement identical policy (enabled → finite → `> 0` →
      value, else absent) from two different sources: the service's in-memory settings and raw `homey.settings`.
      They can disagree in the window between a settings write and the service's `loadSettings()`, and the weather
      card would then show one number while the pressure loop measured against another. The service is the
      correctly-layered producer; delete the setup-local copy and widen the assembler's `Pick<AppContext, …>` to
      include `dailyBudgetService`. Persona: an owner who just changed their budget and reloads the Budget page;
      hypothesis: "Your daily budget" reads the old value for one refresh. P2.

*Chart-overhaul train review follow-ups (2026-06-11, PRs #1677–#1681). Non-blocking.*

- [ ] **Disambiguate the smart-task schedule chart's two kinds of dimmed bar.** With the
      one-hue-two-states encoding, a bar is dimmed both when it is outside the task's allowed
      window (e.g. the in-progress "Now" bar, before the 15:00 start) and when it is inside the
      window but too expensive to pick — same styling, two meanings. Either distinguish "outside
      window / not yet allowed" from "available but too expensive", or exclude the pre-start Now
      bar from the pickable set so "not picked" only ever means too-expensive. Persona: Optimiser
      reading a dimmed cheapest Now bar. Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`
      (schedule bar item styling), `packages/settings-ui/src/ui/deadlinePlanTimeline.ts`. Source:
      pels-m3-critic + pels-ux-fit on the data-viz palette PR, 2026-07-02. [UX P2]
      Absorbed from the merged reason-clause item: an in-window, affordable hour that simply was
      not needed still has no stated why, which the same producer-resolved clause would answer.

- [ ] **Add the "pause lower-priority devices" toggle to the create-smart-task widget.** The
      `pauseLowerPriorityDevices` rescue permission ships with a Flow entry (`allow_smart_task_rescue`)
      and full runtime behaviour (`lib/plan/admission/headroomReserve.ts` — it reserves power so the
      task can start sooner), but the create-smart-task widget
      (`widgets/create_smart_task/src/public/render.ts` + `src/api.ts`) still offers only the budget +
      limit toggles, so it can't be set at creation time from the widget. Add the third (ungated)
      toggle for parity, mapping to `'always'` like the others. Copy must not say anything is turned
      off — see `notes/ui-terminology.md`. Persona: Orchestrator. Needs
      pels-ux-fit + pels-m3-critic + a Playwright screenshot pass (mobile 480 px). Source:
      pause-lower-priority feature, 2026-07-01.

- [ ] **Bound the startup reservation on time spent HOLDING, not wall-clock since first sighting.**
      `resolveCycleHeadroomReserves` runs at the top of `applyRestorePlan` (`lib/plan/restore/index.ts`),
      so `HEADROOM_RESERVE_MAX_MS` burns during every window in which the reserve enforces nothing:
      `guardInShortfall`, active overshoot, shed cooldown (60 s), restore
      cooldown (60–300 s), startup stabilization. *Hypothesis:* a capacity-tight hour with three
      shed/restore cycles can consume most of the 15 minutes without the reserve ever holding a
      device back; the home then calms, a real contiguous block appears, and the reserve has already
      lapsed — the exact out-competition the feature exists to stop. Worse in `power_source = flow`,
      where a 20-minute sample gap can consume the entire window in one go. Fix: advance the clock
      only on the `armed` outcome, or record held-cycles rather than a start timestamp. *Persona:*
      owner with an EV charger on a smart task in a busy home. Source: pels-runtime-reality on
      preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **Rename the smart-task extra-permission clause away from "pause".**
      `SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices`
      (`packages/shared-domain/src/deadlineLabels.ts`) still reads `May pause lower-priority devices`
      while the permission now reserves power and pauses nothing. The Flow dropdown label was already
      changed to `reserve power so this task can start sooner`; this clause was deferred because it is
      baked into the committed `widgets/starvation_rescue` and `widgets/create_smart_task` bundles and
      is a shared-domain string, so renaming shifts log breadcrumbs too. Rename to
      `May reserve power to start sooner`, rebuild + commit both widget bundles, and note the log
      change in the PR body. *Persona:* Orchestrator reading the task page. Source:
      pels-copy-and-terminology on preemptive-power-reservation, 2026-08-01. *P2*

*Smart-task controller extraction (2026-05-30 → PR-E #1338): COMPLETE. The planner knows nothing
about smart tasks — `no-plan-to-smarttasks` is `error` and green. Design of record:
`notes/state-management/deferred-objective-lifecycle-carveout.md`. The items below are
non-blocking follow-ups.*

- [ ] **Seven setup files still hold runtime state, above the boundaries `arch:check` enforces.**
      `setup/` constructs and connects and holds nothing (`setup/AGENTS.md` § "No state"), enforced
      by `scripts/check-setup-stateless.mjs`. Seven files predate the rule and sit in
      `scripts/setup-stateless-allowlist.txt`, which budgets each a declaration count (35
      declarations; 21 files / 104 at the guard's introduction). **Two of the seven files will never
      move** — `powerSamplePipeline.ts` and `appSnapshotHelpers.ts` are orchestrators whose imports
      close every domain destination. Their STATE can still move, so this entry's done-condition
      stands; see the two entries below. Each is a component in the wrong directory, and each
      migration is the same shape: move the state **and the rules that read it** into the domain
      module that owns the concept, as a leaf that takes flat injected getters for anything outside
      its own module (the `no-weather-to-peer` pattern — "a leaf collector fed flat getters from
      setup wiring"); setup keeps only the construction that binds them. The peer DAG is the
      constraint that decides each destination: `lib/home` is a declared pure leaf, yet
      `setup/homeMembership.ts` imports `lib/device/transport/managerFetch` and
      `lib/observer/observedStateEvents` today, so those inputs must arrive injected or move to
      `packages/contracts`. Lanes, in the order they should land:
      (a) power — DONE except `powerSamplePipeline.ts`, whose file stays in `setup/` but whose
      state does not (see the entry below);
      (b) solar — DONE;
      (c) device — `targetPowerProbeScheduler.ts` and `appFlowBacked.ts` are DONE (`lib/device/`).
      `appDeviceSupport.ts` still holds a module-level `Set` and imports
      `lib/plan/planTemperatureDevice`, which `no-device-to-peer-except-power` forbids, so that type
      guard has to be resolved before it can follow. `appSnapshotHelpers.ts` and
      `appNativeWiring.ts` each have their own entry below;
      (d) home — `homeSampledMeterIdentity.ts` is DONE, as `lib/power/sampledMeterIdentity.ts`:
      the fact it holds is about the sample the TRACKER serves, and it imports nothing but the
      freshness constant its expiry derives from. `homeMainMeterAuthority.ts` cannot follow it and
      cannot go to `lib/home` either — see the entry below.
      `homeRuntime/homeModeOwnershipTransfer.ts` is DONE, as
      `lib/home/modeOwnershipTransfer.ts`. `homeMembership.ts` (15 of the lane's declarations) and
      `homeRuntime/homeRuntimeRegistry.ts` (8) still want `lib/home/`, which `no-home-to-peer`
      makes a pure leaf, so their `lib/device`, `lib/observer` and `lib/app/appContext` inputs must
      arrive as injected values first;
      (e) composition root and leftovers — DONE. `appServiceWiring.ts`'s late-bound service handles
      are `PelsApp` fields reached through getter/setter pairs (the `AppNativeWiring` shape), its
      membership teardown is a `TeardownRegistry` key, and the prepared-reconcile fence is
      constructed by `app.ts`. The background teardown handles are an injected
      `TeardownRegistry` (`lib/utils/`), the dump counter is `lib/diagnostics/deviceDumpId.ts`, and
      the scheduler telemetry observer moved to `lib/plan/rebuildScheduler/` rather than
      `lib/logging/` as this entry used to say — it names `RebuildIntent` and
      `PowerSampleRebuildState`, so putting it in `lib/logging` would have made a foundation module
      depend on `lib/plan`. Each lane is behaviour-preserving: a move plus an injection change, with
      `npm run arch:check` as the gate on the destination. Done when
      `scripts/setup-stateless-allowlist.txt` no longer exists and `npm run setup:stateless` passes
      without it. Found 2026-08-29. [P2]

- [ ] **`lib/power/persistedHomeTracker.ts` passes five parameter bags.**
      Its five functions (`writeFreshnessReset`, `restoreTrackerState`,
      `preparePersistedHomeTrackerForMeter`, `resetPersistedHomeTrackerFreshnessInSettings`,
      `beginPersistedHomeTrackerFreshnessResetInSettings`) each take an inline object of
      `{ settings, homeId | trackerKey, state?, meterIdentity?, onFailure }` and destructure it back
      into loose values on the first line — the signature the param-bundle rule names (root
      `AGENTS.md`). They predate the rule and travelled unchanged when the module moved out of
      `setup/homeRuntime/`, so the ratchet's total is unmoved at 1096 bundles across 408 files; what changed is that
      they now sit in a domain module, where the concept they are circling is visible. There IS a
      domain object here — one home's persisted tracker: its settings port and its key — and every
      one of the five is about exactly that. Introduce it, pass it, and the remaining arguments are
      honest scalars. Done when `lib/power/persistedHomeTracker.ts` has no line in
      `scripts/param-bundle-allowlist.txt` and the three `setup/homeRuntime` callers pass the named
      object. Source: Codex review of PR #2263, 2026-09-01. [P2]

- [ ] **`schedulePlanRebuild` is still rebuilt per sample, because it closes over the request.**
      The other three seams `recordPowerSampleForApp` reaches back through are now bound once
      (`PowerSamplePipeline`'s readonly arrow properties). The fourth cannot be, as it stands: its
      body calls `publishResolvedHomeMeter(request)` — the sampled-meter ownership fence — so a
      boot-bound closure would have no identity to publish. Give it a typed argument carrying the
      watts and the meter identity the ingest just admitted, so the identity, the watts and their
      timestamp still move as ONE admitted operation and a superseded request drops its identity
      claim with its watts. Two things to get right: the argument is a named domain value, not the
      whole request spread through the seam; and `planConvergenceActive`, `planUnactionable` and
      `skipWhileShortfallUnrecoverable` currently resolve BEFORE the ingest and would move to call
      time, which is the anti-storm throttle — the one a persistent zero-allowance shortfall once
      drove until the cpuwarn watchdog killed the app. Pin the current read-ordering with a test
      before moving them. Done when the seam takes a named argument, all four callbacks are bound at
      construction, and `runPowerSample` builds no closures per sample. Found 2026-09-01. [P2]

- [ ] **`setup/appNativeWiring.ts`'s re-entrancy latch is the last of the three coalescers.**
      `nativeWiringDecisionInFlight` (1 declaration) looks like the single-flight loop the other two
      now share (`lib/utils/singleFlightLoop.ts`), but its policy is different on purpose: an overlapping
      `applyNativeWiringAutoDecisions` is DROPPED, not queued, because a periodic re-query has no
      urgency and a queued re-run would cost a second detection pass plus a possible plan rebuild.
      Giving `createSingleFlightLoop` a drop mode would be a flag parameter on a concurrency
      primitive — the wrong trade. The file's real blocker is different anyway: it names
      `SnapshotWarmupGate` and `PlanService` types and imports `setup/flowConflictProbe`, so
      `no-device-to-peer-except-power` bars `lib/device` until those arrive as flat injected
      callbacks. Done when `AppNativeWiring` takes `awaitSnapshotWarmup` and `rebuildPlanFromCache`
      as callbacks, the conflict probe is injected or moved, the component lives in `lib/device`,
      and its allowlist line is gone. Found 2026-09-01. [P2]

- [ ] **`setup/homeMainMeterAuthority.ts` straddles two leaf modules, so neither will take it.**
      Seven declarations — an edge-trigger log latch per warning, the last-resolved meter and
      source, and a fence-episode flag. It needs `findMainMeterCollision` and `SubHomeConfig` (a
      VALUE import from `lib/home`) and `ConfiguredPowerSourceRead` (`lib/power`). `lib/home` is a
      declared pure leaf, so it may not name the power type; `no-power-to-peer-except-objectives`
      bars `lib/power` from naming the home ones. Type-only imports are invisible to the cruiser
      (`tsPreCompilationDeps` is unset), so either direction would pass `arch:check` — do NOT take
      that route: it exploits the blind spot the `arch:grep` guard exists to close for `lib/plan`.
      The honest options are to reduce the power-source read at the seam, so the authority takes
      `'homey_energy' | 'flow' | 'unavailable'` and the CALLER owns the suspect-read logging (its
      `powerSourceUnavailableLogged` edge latch is what makes that non-trivial today); or to move
      the meter-collision rule to wherever the authority lands. Done when the file has no line in
      `scripts/setup-stateless-allowlist.txt` and `arch:check` passes without a type-only edge
      standing in for a real one. Found 2026-09-01. [P2]

- [ ] **`loadFlowReportedCapabilities` is the one unclean read on `DevicePersistencePort`.**
      `lib/device/devicePersistencePort.ts` declares six calls; `loadLearnedPeaks` and
      `loadExpectedPowerOverrides` answer `resolved | unavailable`, but
      `loadFlowReportedCapabilities` returns a plain `FlowReportedCapabilitiesByDevice` and
      collapses "never written", "malformed" and "genuinely empty" into the same empty record.
      `SettingsRepository.loadFlowReportedCapabilities` is also the only one of the three not
      wrapped against a throwing `settings.get`, so a thrown read escapes rather than classifying.
      The cost is visible at the consumer:
      `FlowBackedDeviceState.loadFlowReportedCapabilities` carries a keep-what-we-hold heuristic for
      an empty parse, which reads exactly like the redundant hedge root `AGENTS.md` tells reviewers
      to delete — and deleting it restores a wipe-on-transient-miss bug. Promote the read to a
      `FlowReportedCapabilitiesRead` discriminated union built from the same key-list evidence the
      other two use, then delete the heuristic and its
      `flow_capabilities_load_empty_parse_keeping_existing` warning. Done when the port's three
      reads all answer a discriminated result, the heuristic is gone, and a spec covers
      unwritten / malformed / throwing / genuinely-empty as four distinct outcomes. Source:
      adversarial review of the device lane, 2026-09-01. [P2]

## P3 Future and Exploratory Work

- [ ] **A sub-home meter area under `power_source = flow` renders nothing, forever.**
      `routeMeterReadings` (`setup/homeRuntime/homeRuntimeRegistry.ts`) drops every reading unless
      the source is `homey_energy`, and a sub-home pipeline has no other sample entry — so its
      tracker never latches a sample, `hasPowerMeasurement` stays false, `PowerMeasurementGate` never opens, and no
      plan (and therefore no `pels_status:<homeId>` blob) is ever written for that area. Actuation
      is already correctly withheld (`resolveEffectiveDryRun` forces dry-run when the source is
      unauthorized), so nothing unsafe happens; the gap is that the per-home Limits/Overview
      surface has nothing to render and says nothing about why. Note this contradicts the intent
      recorded at `setup/homeRuntime/homeCapacityBundleApi.ts` ("the ready-edge is DECOUPLED from
      sample arrival ... so it works in flow mode"). Per the 2026-08-16 ruling a meterless home is
      unmanageable and correctly gets no plan, so the fix is a surface that SAYS so, not a
      fabricated plan. *Hypothesis:* an owner who adds a meter area while on the flow source sees a
      permanently blank card and reads it as PELS being broken. *Persona:* the multi-home owner
      mid-setup. [P2]

- [ ] **A switched-off EV charger's reason line may restate its own state word.**
      With signal-2 gating (2026-08-04), a charger the owner switched off renders the state word
      `Off` above the reason line `Not charging` — close to saying the same thing twice, the failure
      mode that retired `Turned off by PELS`. It clearly earns the slot on the case that motivated
      the gate (state word `Manual`, where nothing else names the plug state), so the fix is
      conditional, not a revert: suppress `resolveSteppedEvExceptionLabel`'s idle label when the
      display state word is already `Off`. Persona: owner glancing at a charger they unplugged from
      the app. *Hypothesis:* the pair reads as padding at `Off` and as information at `Manual`, so
      gating on the state word keeps the informative case without the echo. Source: 2026-08-04
      `pels-copy-and-terminology` pass on the signal-2 change. [P3]
- [ ] **Extend the growth-only principle from the area cap to root disjointness.** The area cap now
      bounds GROWTH, so a config already over it can still be renamed or re-metered
      (`setup/homeMeterOwnership.ts`; the rule itself is `lib/home/homeConfig.ts`). The root-overlap rule one line below it still evaluates
      `findNestedSubHomeRoots` over the WHOLE composed list, so a persisted config containing one
      overlapping pair refuses every upsert, including a rename of a third, unrelated area. Reachable
      the same way the over-cap config is: `isPlausibleHomesConfigBlob` validates shapes, unique
      homeIds and unique meters but NOT zone overlap, so such a blob classifies `'present'` and flows
      straight into the check. Strictly worse for the user than the cap case was, because it returns
      bare `invalid`, which renders "Couldn't save changes — try again" and names no remedy. The right
      axis is not "did the list grow" but "does the UPSERTED entry participate in an overlap", which
      is why it was left out of the growth-only fix. Persona: owner whose config predates the seam's
      rules, or was written outside the UI. *Hypothesis:* every save is refused with copy that names
      nothing, and the only escape (delete an area) is not something the message suggests. Source:
      multi-home finishing train, area-config invariants PR review. [P3]

- [ ] **A smart task and "match solar surplus" cannot combine on one device — the task wins outright.**
      `runSurplusPass` (`lib/plan/planBuilderSurplus.ts:74-79`) drops every device in
      `admittedDeviceIds` from BOTH the allocator and the hold, so a charger with a soft deadline
      stops tracking surplus entirely for the whole life of the task — including the sunny hours
      long before the deadline bites, which is exactly when the owner wanted solar-only charging.
      The settings UI mirrors it by disabling the toggle outright. What changes: let a device whose
      deferred objective is `enforcement: 'soft'` and whose deadline is not yet pressing keep its
      surplus ceiling, and hand the task priority only once its own admission says it must charge
      to make the deadline (the horizon planner already computes that boundary). Options if that
      proves too fine-grained: a per-task "prefer solar" flag, or leaving the current all-or-nothing
      and saying so in the toggle copy instead. Done when a charger with a soft deadline tomorrow
      morning charges only on surplus through a sunny afternoon, then takes grid power overnight to
      make the deadline. *Persona:* prosumer with PV + EV (`notes/personas.md` — the Smart tasks row
      names this as the remaining gap). *Hypothesis:* the two features were built independently and
      the exclusion is a precedence shortcut, not a considered product ruling; combining them is the
      shape owners actually ask for ("leave it plugged in, use the sun, but be full by 07:00").
      *Why:* without it "charge on solar surplus" and "be charged by X" are mutually exclusive, and
      an owner who wants both must pick one. *P2 (from the surplus-tracking train, 2026-08-26).*

- [ ] **Weather: a location-aware hint when MET can't be reached for lack of geolocation.**
      *Persona:* Orchestrator (`notes/personas.md`) who turned the feature on but never set the
      hub's location, so the forecast silently runs on recent days.
      *Hypothesis:* the no-geolocation case is currently folded into the generic `recent_days` copy
      (`Forecast unavailable — showing what recent weather suggests.`), which doesn't name the one
      fix the owner controls — setting the Homey hub location — so a fixable miss reads as an
      unexplained fallback.
      *Why it's needed:* a no-location-specific source line (e.g. naming the Homey location setting)
      would turn a permanent silent fallback into a one-tap fix. Out of scope for the picker-removal
      PR (would need a producer-resolved no-geolocation `forecastStatus` arm + copy). Source: PR 2
      MET UI-cleanup scope decision, 2026-06-14.

- [ ] **A rescue on the lowest-priority device can grant nothing and still report success.**
      *Persona:* Optimiser (`notes/personas.md`) who taps `Let it run now` on a held-back device.
      *Hypothesis:* now that the rescue is offered on both axes, a device that is capacity-held AND
      bottom-priority AND binary can end up with an empty effective grant:
      `gateCandidateExtraPermissions` (`setup/appSmartTaskApi.ts`) drops `limitLowerPriorityDevices`
      for binary devices, `pauseLowerPriorityDevices` has nothing below it to pause, and
      `exemptFromBudget` is inert when the budget is not what binds. The user confirms, gets the
      `Power on the way` flash, nothing changes — and the device is now un-rescuable because it has a
      smart task.
      *Why it's needed:* a money-action confirm that provably cannot help is the one thing the rescue
      confirm sheet exists to prevent. Fix direction: compute the effective grant set server-side
      before the confirm and surface an honest "this will not free power for this device" state, or
      fall through to `rescueDoneQueued` framing. Source: adversarial review, 2026-08-04.

- [ ] **A Flow granting a permission mid-edit is silently reverted on Save.**
      *Persona:* Orchestrator following the documented pattern in `docs/smart-tasks.md` — pair
      "Smart task time is running low" with "status is At risk" so a Flow grants the permission late —
      who happens to have the task page open when it fires.
      *Hypothesis:* `baselinePermissions` is captured once at open time
      (`buildSmartTaskEditProps` → `openSmartTaskEditor`) and later boot refreshes rebuild the
      context without re-seeding the open draft, by design so a background refresh can't overwrite
      what the user is typing. The save then states the complete desired set, so it reverts the
      Flow's grant with no conflict detection. The deadline got an echo-and-revalidate guard
      (`baselineDeadlineAtMs` → `resolveSmartTaskWriteDeadline` → `deadline_passed`); permissions
      got none. Narrow — it needs the Flow to fire inside an open editor session — but the docs
      actively recommend the Flow pattern that triggers it.
      *Why it's needed:* last-write-wins on a permission the user never saw contradicts the rule the
      rest of this lane keeps (the editor only changes what it showed you).
      *If fixed:* echo the baseline permissions on the write and reject on mismatch, the same shape
      the deadline uses — not a silent re-seed, which would move a toggle under the user's finger.
      Files: `packages/settings-ui/src/ui/smartTaskEdit.ts`, `setup/settingsUiSmartTaskApi.ts`.
      Source: pels-runtime-reality on editable smart-task permissions, 2026-08-02. *P2*

- [ ] **The create widget's `preserve` write drops standing permissions it didn't name.**
      *Persona:* any user who granted a permission by Flow and later re-creates the task from the
      **New smart task** widget with a different toggle on.
      *Hypothesis:* `upsertObjectiveForDevice`'s `preserve` is a WHOLE-OBJECT fallback — it fires
      only when `entry.rescue === undefined` (`lib/objectives/deferredObjectives/objectiveWrite.ts`)
      — so a create that grants any ONE permission makes `rescue` defined and silently clears the
      rest. The settings-UI edit lane no longer has this hole (it merges per key in
      `buildCandidateRescue` and writes `'replace'`), but the widget lane passes no standing set and
      still relies on the whole-object fallback. Pre-existing; not introduced by the editable-
      permissions work, which is why it was not fixed there.
      *Why it's needed:* one lane keeps the "a permission you didn't mention survives" promise and
      the other doesn't, from the same helper.
      *If fixed:* thread the device's standing rescue into `widgets/create_smart_task/src/api.ts`'s
      `buildValidSmartTaskCandidate` call and write `'replace'`, exactly as the edit lane does; this
      regenerates the widget bundle. Interacts with the create-screen standing-permissions item
      above — do them together. Files: `widgets/create_smart_task/src/api.ts`,
      `lib/objectives/deferredObjectives/objectiveWrite.ts`. Source: pels-layering-guardian on
      editable smart-task permissions, 2026-08-02. *P2*
      Absorbed from the merged create-screen item: the widget's toggle set must also reflect the
      device's standing permissions rather than only the three it names, and it is missing the
      reserve-power toggle the settings UI already offers.

*Smart-task failure-investigation & live UX — the underserved Optimiser and the
Failing-scenario (acute/recovering) visitors (`notes/personas.md`).*

- [ ] **Create Smart tasks directly from the Smart tasks page.**
      *Persona:* Set-and-forget owner / Optimiser who is already on the Smart tasks page.
      *Hypothesis:* the aggregate Smart tasks page can inspect, edit, and cancel tasks but its
      first-run state sends the user to a Flow or dashboard widget to create one. A `New smart
      task` action using the existing candidate picker, goal bounds, preview, and device-scoped
      write path makes the surface complete without introducing another persistence lane.
      *Why it's needed:* creation is an ordinary Smart-task operation and should not require
      leaving the canonical task surface. Keep the dashboard widget as a convenient second route;
      both surfaces must share contracts and producer-resolved validation.
      Design: `notes/smart-task-ui/README.md`.
      Files: `setup/settingsUiSmartTaskApi.ts`, `packages/contracts/src/smartTaskEdit.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/settings-ui/src/ui/views/DeadlinesList.tsx`, creation controller/view code shared
      with or adapted from `widgets/create_smart_task/`.

*EV charging — the Optimiser / EV commuter (`notes/personas.md`).*

*Demoted from P2 (2026-06-03 scrutiny pass) — real product / future-capability work with a
persona but no current support-cost pressure; reframed to the P3 bar.*

- [ ] **Support a kWh target on the EV deadline flow card.**
      *Persona:* EV commuter whose charger doesn't report SoC.
      *Hypothesis:* the `ev_soc` variant accepts only `targetPercent`; a kWh target is the one EV path
      that needs no SoC observation/freshness at all, so accepting `targetEnergyKwh` broadens supported
      chargers and removes a fragile dependency.
      *Why:* widens device support for the EV persona. Design: `notes/ev-ready-by/README.md`. Files:
      `packages/contracts/src/deferredObjectiveSettings.ts`, `flowCards/deadlineObjectiveCards.ts`,
      `lib/objectives/deferredObjectives/diagnosticsBridge.ts`,
      `.homeycompose/flow/actions/set_ev_charge_deadline.json`.
- [ ] **Smart-task edit lane: don't reattach a stale draft to a NEW task on the same device.**
      *Persona:* Owner whose task ended (or was cleared via Flow) while the editor sat open, then created a new task on the same device.
      *Hypothesis:* `buildSmartTaskEditProps` reattaches the module-scope editor snapshot by deviceId alone; a later task on the same device inherits the old draft's stale baselines. Guard the reattach on the context still matching the live entry (e.g. `snapshot.context.baselineDeadlineAtMs === entry.deadlineAtMs`) so a replaced task renders the editor closed. Source: Codex review on PR #1843 (2026-07-06). Files: `packages/settings-ui/src/ui/deadlinePlanMount.ts`, `packages/settings-ui/src/ui/smartTaskEdit.ts`.
- [ ] **Usage footer promises a Main-only reset under area scope.** "Reset usage history lives under
      Settings → Advanced" resets Main's tracker; a per-home reset through the bundle's persistence
      API is not built. Either scope the footer copy per home or build the per-home reset (route it
      through the bundle's persistence API, never a raw suffixed settings write — it collides with
      `HomeTrackerPersistenceController`'s echo-suppression latch). Persona: meter-area owner
      wanting a clean slate for one rental unit. *Hypothesis:* the owner follows the footer, resets
      the wrong home's history, and loses Main's data without clearing the area's. Files:
      `packages/settings-ui/src/ui/power.ts` (footer), `setup/homeRuntime/` (persistence API).
      Source: multi-home finishing train, per-home Usage PR. [P3]

