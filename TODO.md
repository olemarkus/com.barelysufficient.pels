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

- [ ] **The pending-restore reservation runs on one fixed clock against a 20 s-to-never distribution.**
      `PENDING_RESTORE_WINDOW_MS = 3 min` (`lib/plan/planConstants.ts`) reserves headroom for a
      device that has been restored but has not yet drawn. Its own comment gives a thermostat
      rationale ("Elements typically fire within 1-2 minutes"). Measured against 62 EV-charger
      turn-ons in the 2026-08-11→13 production log, the load appears in whole-home draw at p50
      19.7 s, p90 129.7 s, **max 250.0 s**, and never at all in 2 cases. One fixed window is wrong
      at both ends:
      **(a) under-hold** — 250 s exceeds the 180 s window, so on the slowest starts the reserve
      expires before the load lands and PELS can admit another device into headroom that is about
      to be consumed;
      **(b) over-hold** — the reserve re-arms per restore attempt, so a car that will never draw
      compounds: 5 charger-only reservation episodes ran past 180 s, the longest 689 s, each
      holding 1.38 kW back from other devices.
      The confirm half is already measurement-driven and works (`PENDING_RESTORE_CONFIRMED_FRACTION
      = 0.5` releases at p50 ~20 s); the gap is the negative case — nothing releases the reserve
      when measurement shows the device is not going to draw, and nothing stops the re-arm. Wants
      its own design and its own SDK-boundary e2e because it changes admission behaviour. Note the
      two failure modes need different fixes. Found 2026-08-13. [P1]
- [ ] **A restored EV charger draws at its reset limit until the step command lands.**
      On restore the executor writes the binary on and the step ~0.1 s later, but the charger
      applies the step 14-30 s later (`stepped_load_command_requested` →
      `stepped_feedback_confirmed`: p50 14.1 s, p90 27.4 s, n=192). In that gap it reports step
      `32a` instead of the commanded `6a` — 12 of the 14 `32a` reports in the 2026-08-11→13
      production log followed a `6a` command issued 1-18 s earlier (the other 2 were a deliberate
      ladder climb to `32a`). Measured draw during the overshoot is **5.5-6.3 kW, not the step's
      nominal 7.36 kW**; treat `parsedPowerW` as the step's configured rating, never as evidence of
      draw. Exposure is bounded by the charger's 30 s post-command report, and in the five episodes
      that provoked a response PELS force-stopped it after 4.7-21.4 s (logged relief 3.592 and
      5.552 kW). The other nine resolved to `6a` at the next report with nothing reacting, so their
      true duration is unmeasurable — anywhere from ~0 to 30 s. All four hard-cap breaches
      (9.42 / 8.69 / 7.24 / 6.86 kW) sit in the five-episode group. Collateral matters as much as the
      overshoot: in 08-11 20:05 the water heater was stepped down and switched off *before* the
      charger was, and in 08-12 02:49 two thermostats went off alongside — the charger's overshoot
      is paid for by other rooms. 8 of 53 ON periods lasted under two minutes (shortest 8 s), which
      is most of the charger's on/off flapping (peak 13 commands in one hour). `lib/executor/AGENTS.md`
      already records why the post-activation `force` reassert exists — activation resets the
      device-side step limit — so the reassert is sent; the gap is that the vendor takes tens of
      seconds to honour it. Candidate directions: admit the restore against the device's
      worst-case activation draw rather than the requested step, or hold the shed decision for a
      restore-settling window matched to the observed step-apply latency. Needs the activation
      attribution fix (shipped alongside this entry) first, so the backoff ladder can learn.
      Found 2026-08-13. [P1]
*v2.9.0 closeout and v2.8.x release-review follow-ups. These are safe for
patch releases, not release blockers; each item carries its own source/date.
(The v2.8.0 card-title rename landed in PR #934.)*

- [ ] **A native `target_power` charger can no longer reach an off-ladder configured maximum.**
      `buildEvTargetPowerCandidateProfile` now stops at the highest real rung under `config.max`
      (PR #2027 — the cap is a ceiling, not a rung), so a 25 A cap tops out at `24a` and a
      three-phase cap authored as the marketing "11 kW" (11000) tops out at `14a` = 9660 W rather
      than the 11040 W `16a` rung. For a current-commanded charger that costs nothing — it only
      ever accepts a whole amp. For a native `target_power` charger it is real: PELS writes WATTS
      there (`resolveNativeSteppedLoadCommand` sends `Math.round(desiredStep.planningPowerW)`), so
      the exact cap used to be commandable and now is only reachable if the device happens to
      report it, since `resolveEvTargetPowerPlannerProfile` probes candidate rungs only. A
      tolerance that snaps the cap up to a near rung was considered and rejected: rung watts are a
      nominal seed (`amps * 230 * phases`) and real per-rung draw is already learned per
      `(deviceId, stepId)` in `devicePowerCalibration.ts`, commonly landing under nominal because
      the car draws less than the charger offers. The honest fix is therefore to compare the cap
      against LEARNED power rather than nominal, not to fudge the nominal. Persona: owner of a
      three-phase charger whose installation limit was authored as a round kW number; hypothesis:
      silently charging at 9.66 kW on an "11 kW" charger, with the max field hidden in the UI for
      EV presets, is invisible and unattributable. Raised by Codex on PR #2027. [P2]

- [ ] **A device with junk `target_power` options still gets that capability stripped, though no
      lane will drive it.** `isTargetPowerSteppedLoadCandidate` keys purely on "`target_power`
      present and setable", so `stripNativeSteppedLoadControlCapabilities` removes it from the
      public capability list even when the reported range yields no ladder and PELS has therefore
      declined stepped control for the device entirely (the no-stepped-control-without-a-ladder
      invariant, `lib/device/AGENTS.md`). Harmless today — nothing downstream reads `target_power`
      off the public list, and the affected device keeps whatever binary/temperature axis it has —
      but it is the one place left where the candidate predicate and the ladder disagree, and the
      warning that fires alongside it (`target_power_contract_violation`) already tells the fuller
      story. Fix is to fold the ladder assessment into the candidate predicate; the risk is that
      the same predicate gates `resolveNativeSteppedLoadCommand` and
      `resolveNativeSteppedLoadReportedStepId`, which run against the SYNTHETIC capability map,
      so it needs a pass over those call sites rather than a one-line edit. Persona: owner of a
      charger whose app publishes a malformed `target_power` range; hypothesis: the capability
      vanishing from PELS's view of the device is confusing when PELS has visibly given up on
      driving it by steps. Raised in self-review of the stepped-ladder invariant change. [P2]

- [ ] **Solar-surplus reachability is derived from RESETTABLE accounting, so "Reset usage history"
      can drop a dump load's surplus posture.** `resolveSurplusPoolReachable`
      (`packages/shared-domain/src/solar/surplusPoolReachable.ts`) reads its export half from the
      tracker's export families, and `resetSettingsUiPowerStatsForApp`
      (`setup/settingsUiAppRuntime.ts:222-225`) clears `exportDailyTotals` outright and prunes
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

- [ ] **A transient `null` makes an explicitly configured Main meter read as Automatic; two
      sibling nullable settings readers have the same destructive fallback.** `settings.get()`
      answers an unset key and some transient misses with `null`, so the `raw === null` return in
      `setup/mainMeterSettings.ts:22-27` bypasses the key-list check and turns a valid explicit Main
      selection into real Automatic authority. The saved ownership remains correct, but the next
      poll can select another physical `cumulative` meter. If that id belongs to an area,
      `homeMainMeterAuthority` correctly fences Main before actuation; a combined/superset meter
      whose id is not an area's configured meter cannot be detected and can still make Main respond
      conservatively to area usage. This is the supported-runtime path formerly misdescribed by a
      separate sampled-fence UI entry — it is a dirty producer, not configured Main/Annex
      ownership confusion.
      `setup/homeRuntime/homeOperatingMode.ts` (`resolveForHome`) has the same early-null shape: its
      suspect ladder (`malformed_key_list` / `empty_key_list` / `missing_existing_key`) is skipped
      and a pinned meter area silently reverts to the global operating mode (different device
      targets, with no production pin-fault log).
      `setup/externalOffHoldAdapter.ts:61` is the same class with no cross-check at all: one bad
      read makes every de-opted device look un-opted, so PELS resumes loads the owner turned off
      by hand.
      **Not a one-liner:** for all three, `null` is *also* a legitimate stored value (Automatic,
      "no pin", cleared map), so key-presence cannot discriminate stored-null from a miss. Needs
      a written-before marker (the pattern `externalOffHoldAdapter` already uses for its own
      state blob) or a counted grace window, decided per key. Same class as the v2.20.0
      temperature-control regression fixed in `readTemperatureControlDisabledDevicesSetting`;
      the rule now lives in `setup/AGENTS.md`. Their unit specs
      (`test/unit/mainMeterSettings.test.ts:14,21,25`) pin `get: () => undefined` exclusively and
      so assert branches the device cannot reach — fix the specs with the readers. Done when a
      real-Homey `get() => null` miss cannot replace any of the three last-good semantic values,
      deliberate stored-null/cleared writes still take effect, and an integration test proves a
      transient Main-meter miss neither fetches nor admits an Automatic whole-home sample.
      Source: 2026-08-02 adversarial review of the temperature-control policy fix. [P1]

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
- [ ] **Simulation banner still towers: Main-scoped above 440 px, single-home at every narrow
      width.** The stacked-banner fix (`packages/settings-ui/public/style.css:5719`) bounds at
      `max-width: 440px` and matches only `#dry-run-banner[data-home-scope="main"]`, so at 480 px
      — the platform's flagship width — the Main-scoped banner reverts to the flex row and towers
      3 short lines, and the base single-home banner still towers 4 word-per-line rows at 320 px.
      It is the first element on every tab whenever simulation is on. Extend the stacked grid to
      the base banner and through 480 px (or shorten the copy), and tighten the
      layout-regressions/dry-run guard caps that currently admit the towers. Source: 2026-08-02
      release review, pels-m3-critic + pels-ux-fit rendered walks. [P1]
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
- [ ] **Limit/pause-lower-priority rescue is silently ineffective during a step-ladder gap.**
      While a committed task is served frozen through a missing step ladder, the decoration still
      grants `forceBoostActive`/`reservesStartupPower`, but a device without a stepped profile
      resolves `boostSupported: false` at the producer (`resolveBoostSupported`), and
      `resolveBoostActive` gates the forced request on that bit — so
      under cap contention the task cannot actually claim power from lower-priority devices while
      the structured log's `limitLowerPriorityApplied`/`pauseLowerPriorityApplied` read true
      (those flags were config echoes before the gap-serve too). Strictly better than pre-fix
      (where the whole decision collapsed to `inactive`), but the honest fix is either a
      persisted capacity claim (carry the commitment's expected step power into the boost/reserve
      lanes) or reporting the two permissions as unavailable during the gap. Both permissions work
      again on their own once the stepped ladder re-resolves after a restart. Source:
      Codex review thread on PR #1962, 2026-08-02. [P2]

- [ ] **Bootstrap step gap reports `objective_missing_charge_rate` even when the rate is present.**
      The steps-empty branch in `buildDiagnosticWithPolicyHorizon` reuses the rate code for a
      ladder problem, which is exactly the ambiguity that delayed the 2026-08-01 diagnosis (the
      logged unknown carried a healthy `kWhPerDegreeC` while claiming a missing charge rate).
      Persona: the maintainer (or log-reading owner) triaging a "Waiting" smart-task hero.
      Hypothesis: a distinct code (e.g. `objective_missing_step_ladder`) makes the two lanes
      distinguishable in one log line and lets the pending-hero copy say "waiting for the device's
      power steps" instead of the misleading learning-state copy; `resolvePendingReason`'s
      thermal mapping (`activePlanRevisionBuild.ts`) must be updated in the same change so the
      hero copy stays correct. Source: adversarial review of fix/committed-task-survives-step-gap,
      2026-08-02. [P3]

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

- [ ] **Nothing tells the owner WHY a scheduled charger is held, and three surfaces each name a
      different wrong reason.** The cooldown half of this incident is FIXED: the re-sheds were real,
      accepted `evcharger_charging=false` writes on essentially every rebuild (321 between 20:55Z
      and 23:43Z in the hotfix run's raw log), each restamping the global instability clock — cause
      established 2026-07-27 and fixed in PR #1904, with the remaining flow-backed class tracked
      separately above. What is left open, and is what this entry is now about, is the REPORTING:
      the hold is real and correct, and no surface says so. Original observation: Prod
      2026-07-26 21:03-21:16Z:
      `Elbillader`, badged "Budget exempt"
      (`PLAN_CARD_BUDGET_EXEMPT_CHIP_LABEL`), took 20 `diagnostics_shed_recorded` /
      `full_shed_to_off` events in 13 minutes, the first six at 21:03:28, 21:04:09, 21:04:48,
      21:05:20, 21:05:48, 21:06:18 and the rest continuing at the same ~35 s cadence to 21:16Z
      — while `plan_debug_summary` read `totalKw 0.85`, `softLimitKw 4.73→4.84`,
      `headroomKw 3.89→3.99`, `softLimitSource daily`, `capacityBreached null`, and NO
      `overshoot_entered` fired at all. Its reason trail carries `limited_by_daily_budget`, so the
      daily-budget path is attributed. **Do not act on that attribution alone** — three separate
      cases in the same session had correct behaviour behind a wrong reason code.

      **The soft limit had ample room, which is why this looked like a shedding bug — it is not.**
      The daily budget had already computed what was affordable: `softLimitKw 4.84` against
      `totalKw 0.85`, i.e. `headroomKw 3.99`. The charger needs 1.38 kW at 6 A, which would have put
      the house near 2.2 kW, under half the limit the budget itself set. That mismatch is what sent
      the investigation into the shedding filters — but the off-write did not come from shedding at
      all (see the release-path paragraph below), and a deferred-objective release is ENTITLED to
      turn the charger off while the soft limit has room, because the schedule, not the pacing
      constraint, is what is holding it. Do not re-open this as a budget/shedding defect; the
      defect here is that nothing SAYS the schedule is the reason.

      **Design rule (owner, 2026-07-26): the daily budget converts into the hourly soft limits and
      nothing else. There is no whole-day budget acting as an additional control input.** So the
      derived `softLimitKw` is the entire authority the daily budget has over shedding, and any shed
      taken past it is a second, undesigned budget reading the same data. That makes this a defect by
      construction rather than a threshold to tune, and it fixes the direction: day-level state may
      inform reporting and Flow triggers, never a shed decision.

      **Ruled out: there is no `exceeded`-driven shed path.** `exceeded` reaches only
      `planDailyBudgetWindow.ts` ~110 (carrier), `planContext.ts` ~13 (type) and
      `planBuilderMeta.ts` ~76 as `dailyBudgetExceeded` — reporting metadata, never a shed decision.
      The daily budget already acts solely through the derived hourly soft limit, exactly as the rule
      above requires. Do not go looking for a second budget to delete; there isn't one.

      **What actually produced the misleading label:** `shedding/selection.ts` ~87-88 attributes
      `PLAN_REASON_CODES.dailyBudget` to ANY shed taken while `limitSource === 'daily' &&
      !capacityBreached`, irrespective of cause. So `limited_by_daily_budget` in the trail says only
      "the daily soft limit was the binding one at the time", not "the daily budget shed this". The
      fourth attribution-vs-behaviour mismatch in one session.

      **The planner discards the remaining fraction of the CURRENT hour, even for an at-risk task
      at the cheapest available price.** Prod 2026-07-26 23:18: the task planned 7 buckets covering
      00:00, 01:00 ... 06:00 — precisely the WHOLE hours left before its 07:00 deadline — and skipped
      the ~42 minutes remaining of 23:00. Meanwhile `price_optimization_completed` reported the
      current hour at **72.96 øre/kWh** while the hero rendered "cheapest hour ahead: 00:00,
      0.73 kr/kWh". NOTE the comparison is not decisive on its own: 0.73 kr is a ROUNDED display
      value, so the raw 00:00 price could be anywhere in ~72.5-73.5 øre and might be marginally
      below 72.96. Confirm against raw prices before quoting this as "now was cheaper". What does
      NOT depend on the rounding: the two hours are within ~1% of each other, so deferring bought
      no meaningful saving either way, and the task status
      was already `at_risk` needing 2.79 kWh. Whether charging immediately would have cost anything
      extra is exactly what the raw price has to settle — do not assume it was free — but at a ~1%
      spread the cost either way is negligible against the risk it would have retired; instead the
      first available slot was declined, which itself feeds the
      `at_risk` verdict. At 1.4-7 kW a discarded 42-minute remainder is 1-5 kWh of the deadline's
      total need. Note the hero's "cheapest hour AHEAD" wording hides this by construction: it
      excludes the current hour, so a curve whose minimum is now reads as though later is better.
      Do NOT chase bucket granularity: `normalizeHorizonBuckets` already clips the leading bucket to
      `nowMs` (`bucketAllocation.ts` ~423 `Math.max(bucket.startMs, nowMs)`), and allocation into that
      shortened bucket is covered by existing tests. `currentBucket: null` therefore means the
      allocator assigned no energy to the partial hour, not that it was unable to. The open question
      is WHY it assigned none — the allocation constraint, an existing commitment, or the price
      comparison that ranked 00:00 above the remaining 42 minutes of 23:00 — and whether `at_risk`
      should force the leading partial bucket to be taken regardless. Persona: owner
      whose at-risk deadline sits idle through the cheapest hour of the night; hypothesis: declining
      the cheapest available energy on a task you have already flagged as at risk is indefensible
      whatever the granularity argument. Source: prod investigation, 2026-07-26. [P1]

      **On the hold itself — correct in shape, wrong in extent; the rest of the defect is reporting.** The task's
      planned buckets were 00:00-07:00 (7 hourly buckets to a 07:00 deadline, 2.79 kWh) and the
      observation was taken at 23:18. The charger was deferred to the cheap overnight hours exactly
      as intended ("cheapest hour ahead 00:00, 0.73 kr/kWh"). `currentBucket: null`,
      `desiredStepId: 'off'`, 20 shed records against 1 off-write, and headroom being ignored are all
      consistent with a deliberate time-based hold, re-recorded each cycle.

      What made this cost an evening of investigation is that NO surface says when the device will
      run. The card said "Limited — will try to resume in Ns if power is available" (power was never
      the blocker, and was in fact abundant), the reason trail said `limited_by_daily_budget` (daily
      merely happened to be the binding soft limit — `shedding/selection.ts` ~87 attributes that code
      to any shed while daily is binding), and the hero said "Holding back 13 devices so the house
      stays under 4.7 kW". Three explanations, none of them the real one, for a schedule PELS had
      already computed and could simply have displayed.

      **The fix is to say when, not why-not.** A device held by a deferred-objective schedule should
      surface its next planned hour ("Charging starts 00:00") on the card and in the hero, and must
      not borrow capacity/cooldown copy that names conditions already satisfied. Persona: owner who
      concluded the app was broken while it was doing exactly the right thing; hypothesis: for a
      deferred device, the next run time is the single most valuable thing on the screen and it is
      absent everywhere. Note for whoever picks this up: four wrong hypotheses were chased here
      (missing `budgetExempt`, an `exceeded`-driven shed path, a shed/restore oscillation, and a
      capacity-headroom contradiction) all because `limited_by_daily_budget` was read as a cause.
      PELS's reason codes did not track its behaviour in ANY of the four. [P1]

      **The exemption IS reaching the planner.** The card rendered the "Budget exempt" chip, which
      `planCardGrammar.ts` ~196 emits only `if (budgetExempt)` (tooltip "Exempt from the daily
      budget"), sourced from the plan device via `settingsOverviewReadModel.ts` ~145. So
      `budgetExempt: true` was on the plan device and the shed happened anyway — this is NOT the
      missing-producer-bit shape of the `commandableNow` drop, and adding `budgetExempt` to the
      debug payload would answer a question already answered.

      No shed path bypassed the filter, and that lead should not be re-chased. `shedding/candidates.ts`
      ~110 and `admission/sheddingGuard.ts` ~147 both gate on
      `limitSource !== 'daily' || capacityBreached || budgetExempt !== true`, and the summary reported
      `softLimitSource: daily` with `capacityBreached: null` — so both correctly excluded the device.
      The off-write did not come from capacity shedding at all: with no bucket for the current hour,
      `deferredObjectives/admission.ts` ~127 returns an idle decision carrying
      `releaseIntent: 'binary_release'` for a binary-controlled device, and the executor acts on that
      independently of either shedding candidate filter. The charger being off is fully explained by
      the deferred-objective release path. What remains defective is the ATTRIBUTION (that release is
      reported as `limited_by_daily_budget`) and the repeated per-rebuild diagnostics below — not the
      shed decision.

      One caveat before treating the hold itself as wrong: the device's smart task reported
      `currentBucket: null` (it does not want the current hour) against a 07:00 deadline with
      "cheapest hour ahead 00:00", so SOME hold here is correct price deferral. The defect is the
      shed being attributed to — and apparently driven by — the daily budget on a device exempt
      from it, not the fact that the charger is off at 23:00. Reproduce with an exempt device,
      `softLimitSource: 'daily'`, `capacityBreached: false`, and no planned bucket for the current
      hour, and assert it is never a shed candidate.

      Separately: "exempt from the daily budget" is the wrong instrument for an EV charger at all —
      it is the largest discretionary load in the house and exemption removes the only thing pacing
      it. A deadline device wants "the deadline may overrun the budget, as late and as cheaply as
      possible", which is a conflict-resolution rule rather than a per-device flag. Adjacent to
      [[project_starvation_rescue_boost_direction]].

      A **re-shed that restarts the cooldown** is a real starvation shape and is worth a guard, but
      do NOT cite this incident's 20 diagnostics as evidence for it: `recordReleaseShedActuation`
      writes those records without stamping the shed or instability clocks, and this run produced
      only ONE accepted write. The evidence for the restamping mechanism is the 321 accepted writes
      in the hotfix run, documented in the entry below. Persona: owner watching a charger badged
      "Budget exempt" that never draws; hypothesis: whichever cause holds, a resetting countdown reads
      as a hung app. Source: prod investigation, 2026-07-26. [P1]

- [ ] **A device card claims "Running" and "Limited — will try to resume" at the same time.**
      Prod screenshot 2026-07-26: `Connected 300` rendered headline **Running**, `0.0 kW`,
      `61.7 °C · target 65 °C`, and reason line **"Limited — will try to resume in 17s if power is
      available"** — three mutually exclusive claims in one card, with the step slider sitting at
      roughly 60 %. The headline renders OBSERVED state (`currentState`) while the reason line
      renders PLANNED intent (`plannedState` + reason code), so during any window where PELS has
      decided `shed` but the device is still observed on, both are individually true and jointly
      nonsense. `Elbillader` reads coherently in the same screenshot only because observed and
      planned happen to agree there. The two lines need to resolve from one state, with
      observed-vs-planned disagreement rendered as a transition ("Turning down…") rather than as
      two competing truths. Persona: owner checking whether the water heater is actually running;
      hypothesis: a self-contradicting card is worse than a vague one, because there is no reading
      of it that is correct. Source: prod screenshot + card-field inspection, 2026-07-26. [P1]

- [ ] **The Overview hero and the device cards never say today's daily budget is used up.** Prod 2026-07-26:
      `budget_recomputed` read `newBudgetKWh 40.91`, `actualKWh 64.07`, `remainingNewKWh -23.16`,
      `exceeded true` — the day was 23 kWh over and that was the binding soft limit for the devices
      the daily-budget path actually held. NOT all 13: `Elbillader` was budget-exempt and was held
      by the deferred-objective `binary_release` path instead, so any warning built from this must
      be scoped to devices genuinely held by the budget rather than repeating the same
      one-size-fits-all attribution this incident is filed against. What the UI showed instead: the hero said "Energy used this hour 0.0 of
      3.2 kWh used · projected 0.80 kWh · Hard cap this hour 5.0 kWh · Holding back 13 devices so
      the house stays under 4.7 kW", and every device card said "Limited — will try to resume in
      Ns if power is available". The hourly framing reads as abundance (nothing used, 3.2 kWh
      allowed) while everything is held, and the 4.7 kW figure is daily-derived but never labelled
      as such. `PLAN_STATE_DAILY_BUDGET_STATUS` ("Limited by today's daily budget") already exists
      and is not reaching these surfaces. Scope note: the Daily budget view is NOT part of this gap —
      `resolveBudgetRemainingLine` already converts a negative `remainingKWh` into
      "23.2 kWh over budget already used" and `BudgetOverview` renders it in that view's hero. The
      confirmed gap is the Overview hero and the device cards, the two surfaces inspected here. Persona: owner who sees an idle house and 13 paused
      devices and concludes PELS is broken; hypothesis: naming the exhausted daily budget is the
      single highest-value line on the screen and it is absent. Source: prod screenshot + log,
      2026-07-26. [P1]

- [ ] **`has_headroom_for_device` answers about a meter-area device with the Main home's guard, and
      mutates Main's cooldown state doing it.**
      *Persona:* multi-meter owner whose annex EV charger asks "is there available power for device?"
      in a Flow before it starts a session. *Hypothesis:* every input the card reads is bound to Main.
      `getHeadroom` and `getCapacityPaceKw` resolve Main's `ctx.powerTracker` and
      `ctx.computeDynamicSoftLimit()` (`setup/appInit/registerAppFlowCards.ts:81-87`), and
      `evaluateHeadroomForDevice` resolves Main's
      plan service (`:117`), so an area device is measured against Main's available power instead of
      its own meter's. The run listener is also not a read: `evaluateHeadroomForDevice(...
      cleanupMissingDevices: true)` writes Main's `PlanEngineState` (headroom-card cooldowns,
      activation penalties, activation-attempt diagnostics, `lib/plan/planHeadroomDevice.ts:82-120`)
      over the FULL unfiltered snapshot, and a `stateChanged` result then requests a Main plan
      rebuild. So asking about an area device perturbs Main's control state. Fix direction: resolve
      the device's owning home and answer from THAT home's tracker and pace, routing any rebuild to that home.
      Deliberately NOT refused or filtered out of the picker: the card takes a device and a device
      already names its home, so it stays in scope and must keep working (owner ruling, 2026-07-26).
      Blocked on the per-home runtime read seam: `HomeRuntimeRegistry` is a private field of
      `AppServiceWiring` and `HomeCapacityBundle` exposes no guard/available-power handle, so fix
      this together with that seam. Files: `flowCards/headroomAndEvSocCards.ts:37-77`,
      `setup/appInit/registerAppFlowCards.ts:81-87,137`,
      `setup/homeRuntime/createHomeCapacityBundle.ts`.
      Source: multi-home finishing train PR 8a, 2026-07-26.

- [ ] **A setpoint-shed temperature device with no mode target stays stranded at its shed setpoint.**
      *Persona:* any owner who never opened the Modes screen and has a managed radiator or panel heater
      (Main home or a meter area). *Hypothesis:* PELS auto-assigns the `set_temperature` shed behaviour
      without user action (`enforceTemperatureWithoutOnOffOvershootBehaviors`,
      `setup/appDeviceSupport.ts`), but the RESTORE ANCHOR is the mode target, which requires user
      action — `seedMissingModeTargets` bails out entirely on an empty `mode_device_targets` blob
      (`setup/appDeviceSupport.ts:466-468`). With no anchor, `resolveTemperatureSeed` falls back to the
      live setpoint, which while shed IS the shed setpoint, so on release `plannedTarget ===
      currentTarget` and the executor drops the write (`lib/executor/executableTargetProjection.ts:37`).
      Reproduced on a Main-home-only install with no meter areas: the shed to 16 C lands and the resume
      never happens in 60 poll cycles. The structural fix is a **pre-shed setpoint memory** captured when
      the shed write goes out and consumed on release, which closes this for every home and every device
      regardless of settings; binding mode targets per home (2026-07-26) only closed the anchored case.
      Source: pels-runtime-reality review of the multi-home finishing train PR 1.

- [ ] **`seedMissingModeTargets` can re-seed a shed setpoint as the permanent anchor.**
      *Persona:* owner who clears a heater's per-mode target, then restarts PELS (or updates the app)
      while that heater is shed. *Hypothesis:* the seeder fills a missing entry from the device's
      *current* setpoint with no shed-state guard, and its "already seeded" fingerprints are in-memory
      only (`setup/appDeviceSupport.ts:370-376,457-484`), so a restart while shed records the shed
      setpoint (e.g. 16 C) as the mode target. PELS then holds the device there indefinitely and reverts
      any manual raise. Before mode targets bound for meter areas this mis-seed was inert for an area
      device; it is now actively enforced. Fix: skip seeding while the device is shed, or seed from the
      pre-shed value. Source: pels-runtime-reality review of the multi-home finishing train PR 1.

- [ ] **Homes UI: explain cached rows that stay locked after a refresh failure.**
      A failed `/ui_homes` refresh preserves the last-good rows and correctly disables mutations, but
      the ready/list view gives no visible reason its Add/Edit/Remove controls remain unavailable.
      Show a compact stale-refresh warning beside the preserved rows. Source: release review of the
      multi-meter GA train, 2026-07-24.

- [ ] **False hard-cap shortfall when a stepped device's shed relief is credited from the step
      model.** With the charger drawing a measured 3.645 kW (house at 7.36 kW), `plan_shed_step_down`
      credited `reliefKw: 1.38` from the commanded step, so the excess never closed and PELS raised
      `hard_cap_shortfall_detected` (`excessW: 1840`, `plannedShedDevices: 1`) while it was in the act
      of turning off a load that covered it several times over. Every device got
      "Manual action needed. Needs X kW, 0.0 kW available."
      (`packages/shared-domain/src/planReasonFormatting.ts` ~304) for ~70 s. Admitting the flow step
      report (2026-07-25) fixes the modelling input for this charger, but the relief credit itself
      still ignores a fresh measured draw on a device that is on and measured. Consider crediting
      shed relief from measured power when the observation is fresh. Source: prod log review
      2026-07-25 06:16:46Z. [P1]

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

- [ ] **The stepped shed-relief fallback gate is inverted.**
      `resolveSteppedCandidatePower` (`lib/plan/planSteppedLoad.ts`) used to take
      the calibrated/nameplate delta when the reading was ABSENT; it now takes it
      when `currentDrawKw <= 0`, i.e. for a device with a genuine measured zero.
      Unreachable today because `buildSteppedCandidate` rejects a zero draw first,
      but if that gate loosens, a device drawing nothing is credited nameplate shed
      relief — the substitution this change removed, re-entering by a back door.
      Fix: return 0 for a zero draw and reserve the fallback for the calibrated
      case. Source: adversarial review of the measured-draw collapse, 2026-08-08. [P2]

- [ ] **An ON exempt device with no reading zeroes the budget axis for everyone else.**
      `sumBudgetExemptMeasuredUsageKw` (`lib/plan/planUsage.ts`) sums
      `currentDrawKw`, and since the measured-draw collapse
      `resolveBudgetExemptProjectedKw` does too for a device that is not observed
      off. A running exempt device that reports nothing therefore contributes to
      the whole-home meter total but 0 to the exempt credit —
      `budgetHeadroomKw` goes deeply negative and every non-exempt restore is
      budget-held for the duration. Conservative (never over-budget) and bounded to
      planned hours, and on the current fleet unreachable because every managed
      device is metered — but it is the same failure mode as the `?? 0` this change
      removed from `computeDailySoftLimit`, moved one layer in. Direction: a
      measured-or-observed-on-projection hybrid for the axis. Persona: boost user
      with an unmetered water heater during planned hours. Source: 2026-08-02
      release review; re-confirmed against the collapse, 2026-08-08. [P3]

- [ ] **A device that vanishes mid-overshoot is attributed to background load.**
      `hasUndiffablePlausibleContributor` (`lib/plan/planBuilderOvershoot.ts`)
      iterates the CURRENT device map only, so a managed device present in the
      previous plan and absent from this one cannot block a confident verdict, and
      its rise lands in `background_load_dominant` rather than
      `attribution_inputs_incomplete`. Newcomer/baseline cases cover APPEARANCE,
      not disappearance. Fix: also scan `previousDevicesById` for ids missing from
      the current map. Source: adversarial review of the measured-draw collapse,
      2026-08-08. [P2]

- [ ] **Retire the `suppressed_flow` step-state machinery.** `lib/plan/planSteppedLoadState.ts`
      still carries the `source: 'suppressed_flow'` arm, `SuppressedFlowStepInput`,
      `SuppressedFlowRestorePreparationPolicy`, and the suppressed branch of
      `resolveRestorePreparation`; `restorePreparedStepId` is declared in
      `setup/appDeviceControlSteppedState.ts` and never read. The only production entry point
      (`serializeLegacyStepFieldsFromEvidence`) never passes those params, so the branch is
      unreachable and only `test/unit/planSteppedLoadState.test.ts` constructs it — which is why
      knip stays green. Its reserved purpose ("suppressed flow feedback may be considered later
      only as explicit restore-preparation evidence") was retired when flow reports became
      admissible on 2026-07-25. Source: adversarial review, 2026-07-25. [P2]

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

- [ ] **"Raising target 6a to 6a".** `formatRestoreNeedUserFacing`
      (`packages/shared-domain/src/planReasonFormatting.ts` ~385-387) renders
      `Raising target ${fromTarget} to ${toTarget}` with no equality guard, and
      `steppedRestoreAdmission.ts` ~69/~88 sets `fromTarget` to the observed step and `toTarget` to
      the restore step — equal whenever the device already sits at the restore target, which became
      the common case once flow step reports were admitted while off (2.17.3). The from/to branch
      also takes precedence over the need/available suffix, so it hides the numbers even when they
      exist. Best fixed together with the entry above: guard on inequality and let the suffix carry
      it. Source: prod investigation 2026-07-25. [P2]

- [ ] **Hero limited-count disagrees with the stepped card's "N devices still limited".** The
      hero counts `stateKind === 'held' || plannedState === 'shed'` (11 on the 2026-07-05 screen,
      including a hold-reason EV that was never shed), while the stepped card's count comes from
      the planner's `countShedDevices` (`lib/plan/restore/coordination.ts`), which counts only
      `plannedState === 'shed'` and skips non-controllable devices (10). Both internally correct,
      visibly off-by-one on one screen. Either feed the card the same held||shed count the hero
      uses, or drop the count from the card copy. Source: overview correctness review
      (2026-07-05).
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

*Concrete, bounded changes to specific named surfaces (not structural re-splits — those stay P2).
The flow-reported / pendingBinaryCommands / stepped-restore-wrapper / stepped-swap-completion /
deviceOverview entries shipped in the 2026-06-03 train; the items below (the first a multi-slice
program) remain deferred.*

- [ ] **One concept, one name, one owner for the pace/limit family.** `softLimit` currently names
      three different quantities depending on call site: `bindingPaceKw` on `PlanContext`,
      `capacityPaceKw` at every consumer that logs it as `softLimitKw`, and
      `budgetPaceImportKw` as `dailySoftLimitKw`. The wiring-dependent half is closed — see (c)
      — so a wiring regression can no longer degrade to a quieter limit; what remains is the
      rename onto one name per quantity. Adopt the
      canonical names in `notes/safe-pace-two-constraints.md` § "Canonical names"
      (`hardCapKw`, `safetyMarginKw`, `hourlyAllowanceKWh`, `sustainableRateKw`, `capacityPaceKw`,
      `budgetPaceKw`, `budgetPaceImportKw`, `bindingPaceKw`) and give each exactly one producer.
      `hourlyAllowanceKWh` and `sustainableRateKw` are one owner with two named readings, since
      `computeDynamicSoftLimit` subtracts it as energy and line 44 multiplies it as a rate. "One owner"
      means one per scope: the capacity rows are per home (each bundle wires its own provider,
      `setup/homeRuntime/createHomeCapacityBundle.ts:406`), the budget rows are main-only
      (sub-homes get `getDailyBudgetSnapshot: () => null`, `createHomeCapacityBundle.ts:291`), so
      a sub-home has no `budgetPaceKw` and its `softLimitSource` can never be `'daily'`. Concrete work:
      (a) collapse the five independent `hardCapKw - safetyMarginKw` computations onto one
      owner — the nominal owner `resolveUsableCapacityKw` (`lib/power/capacityModel.ts`) plus
      four recomputations in `lib/power/sampleIngest.ts`,
      `packages/settings-ui/src/ui/capacity.ts`, `packages/settings-ui/src/ui/homeLimits.ts`,
      and `packages/settings-ui/src/ui/views/BudgetOverview.tsx` (the `lib/power/capacityGuard.ts`
      and `lib/plan/rebuildScheduler/signalDriven.ts` copies went with the guard's soft-limit
      fallback; inventory kept in
      `notes/safe-pace-two-constraints.md` § "One concept, five implementations"). It is a pure function of two
      settings values with no runtime state, so the owner is the capacity-settings owner, and it
      should be handed out already resolved next to the existing `getHardCapKw` accessor
      (`setup/homeRuntime/homeScope.ts`). The settings UI then receives it through the
      contract as data rather than recomputing it, which also sidesteps that it cannot import
      `lib/**`;
      (b) — DONE: `resolveCapacitySoftLimitKw` is deleted and its one caller
      (`lib/diagnostics/periodicStatus.ts`) reads `resolveUsableCapacityKw` directly. The naming
      mismatch it documented survives at that call site only as a stale field name: it files
      `capacityPaceKw` under `softLimitKw`. That is the rename in the preamble, not a missing alias;
      (c) — DONE (2026-08-17, `refactor/capacity-guard-strip`): `capacityGuard.getSoftLimit()`,
      its provider, and the guard's `limitKw`/`softMarginKw` mirror are deleted. Every consumer
      is handed a producer-resolved `capacityPaceKw` from `computeDynamicSoftLimit`, and
      `lib/executor/shortfallExecutor.ts` takes a non-optional guard, so its `hardCapKw`
      fallback is gone too. The unresolved state was removed rather than modelled, so no
      fail-closed caller contract was needed;
      (d) give `budgetPaceKw` a real name and producer instead of leaving it an unnamed
      intermediate inside `computeDailySoftLimit`, so downstream can obtain the pace that applies
      to the non-exempt house;
      (e) materialise `P_nonExempt = P_import - exemptKw` on `PlanContext` and `plan.meta`,
      **unclamped**. The power side only ever has it as an implicit term inside the rebased
      threshold, so nothing downstream can show the user what is actually measured against their
      budget. It equals `nonExemptGross - solar` and goes negative when solar more than covers
      the non-exempt load, which is the exact analogue of `P_import` going negative on export
      (`resolveLastTotalPowerKw` hands it out signed and unfloored). Do not add a floor: it would break the
      deficit identity in the item below (`capacityPaceKw` 20, `budgetPaceKw` 5, `exemptKw` 7,
      `P_import` 2 gives 10 kW headroom today and 5 kW clamped, delaying restores). The kWh axis
      keeps its floor for the separate reason at `lib/plan/planHourContext.ts:21-22`. Ship it as
      **two distinctly named quantities with distinct contract fields**, not one field computed
      two ways: `P_nonExemptControl = P_import - projectedExemptKw` and
      `P_nonExemptMeasured = P_import - measuredExemptKw`. `sumBudgetExemptProjectedUsageKw` returns
      the projected value (`getHighestKnownPowerKw` for observed-off devices), which is right for
      control and wrong for the hero, whose segments are defined as current load
      (`notes/overview-hero-spec.md:158-164`); the two can differ by several kW, so a single name
      would leave a `plan.meta` consumer unable to tell whether hypothetical off-device load is
      included. Do this before the
      two-predicate item below, which is unwriteable while one identifier means four things.
      Touches log event fields and test fixtures, so
      expect churn in `pels-log-review` expectations. Source: safe-pace naming audit (2026-07-26).

- [ ] **Express the soft limit as two predicates instead of one rebased `min()`.** Names below
      are the canonical ones from the naming item above; land that first. `capacityPaceKw` and
      `budgetPaceKw` measure different loads: capacity counts all of `P_import`, the budget
      excludes budget-exempt devices. `planBuilder.ts:309-312` collapses them by rebasing the
      budget pace onto the import axis (`+ exemptKw`) and taking `min()`. Replace with
      `overCapacityPace = P_import > capacityPaceKw`,
      `overBudgetPace = P_nonExempt > budgetPaceKw`, and
      `deficitKw = max(P_import - capacityPaceKw, P_nonExempt - budgetPaceKw)`, with
      `P_nonExempt` unclamped. That deficit is algebraically identical to today's, so shedding
      sizing and shed/restore timing do not change. **What it buys is provenance, not
      decoupling:** `P_nonExempt` contains `exemptKw` and the forms are identical, so control
      does not become exempt-independent; the planner just gains the ability to say which
      constraint bound and by how much, instead of deriving it from a source string computed off
      a collapsed scalar. Three things it must preserve, each a review counterexample:
      (i) the two forced-headroom branches at `lib/plan/planContext.ts:82-91` need *opposite*
      handling. Stale fail-closed sheds while `overCapacityPace` is false and must keep admitting
      exempt candidates, so candidacy needs `overCapacityPace || staleFailClosed`. The
      exhausted-hour branch must NOT join it: `lib/plan/shedding/buildSheddingPlan.ts:103` already
      overrides the source to `'daily'` there specifically to protect exempt devices, pinned by
      `test/integration/planShedding.test.ts:3424-3488`, so folding it into a single
      `forcedBreach` term would let `shedAllCandidates` shed "Get power now" devices; (ii) `softLimitSource` is a control input at
      `lib/plan/restore/index.ts:55`, which gates startup stabilization on `=== 'capacity'`, so
      introducing `'both'` changes restore behaviour unless every consumer is updated or a
      separate `capacityActive` predicate is kept for the runtime gates; (iii) no floor inside
      the deficit, per the naming item above. **Scope
      limit:** it does not make the displayed pace exempt-independent. Any single tick on a
      `P_import` axis is `min(capacityPaceKw, budgetPaceKw + exemptKw)` by construction, so
      `softLimitSource` must stay a common-axis argmin (what `resolveSoftLimitSource` computes
      today) and stays coupled to exempt draw; a raw argmin over the two paces is meaningless
      because they are on different
      axes. Showing that coupling is the P2 hero carve-out's job, not this refactor's. Two
      follow-ons: `'both'` becomes producible (already defined in
      `packages/contracts/src/settingsUiApi.ts:156`, in `SAFE_PACE_TOOLTIP_BY_SOURCE`, and in
      `notes/ui-terminology.md`, but `resolveSoftLimitSource` at `lib/plan/planBuilder.ts:522-526`
      can only return `'capacity'` or `'daily'`, so that copy is unreachable today), meaning the
      two common-axis thresholds agree within `SOFT_LIMIT_EPSILON`, which needs the existing
      `'both'` tooltip reworded out of its current breach reading. Consumers that want "is the
      non-exempt house over budget" must read `overBudgetPace` rather than infer it from the source
      string, as the reason copy and starvation attribution do today. Second follow-on: exempt
      shed candidacy
      (`lib/plan/shedding/candidates.ts:110`, `lib/plan/planRemainingSheddableLoad.ts:243`) keys
      off `overCapacityPace || forcedBreach` instead of
      `limitSource !== 'daily' || capacityBreached`. Behaviour-preserving only with the
      `forcedBreach` term per (i) above; the two clauses coincide in the ordinary case (source
      `'capacity'` plus `headroom < 0` implies `capacityBreached`) but not in the forced
      branches. The value is that candidacy stops depending on a source string an exempt
      device's live draw can move.
      Converge with
      `resolveLimitReason` (`lib/plan/pelsStatus.ts:265-291`) rather than adding a second fold:
      it already returns `'none'|'hourly'|'daily'|'both'` for the `limitReason` field, derived
      from `softLimitSource` plus shed state and headroom sign. Preserve the two `headroom = -1`
      overrides at `lib/plan/planContext.ts:79-92` (stale fail-closed, exhausted-hour), which the
      deficit identity does not cover. Does **not** subsume the P3 hysteresis item on
      `resolveSoftLimitSource` further down: a `'both'` band would keep the resolver stateless,
      so a pace difference oscillating across the epsilon boundary still alternates
      `capacity`/`both`/`daily` between rebuilds and every source-dependent surface still
      flickers. That item stays open and needs retained state or enter/exit thresholds. Note the
      `'both'` member itself was deleted on 2026-08-15 (no producer at any layer), so proposing
      it here now costs re-adding user-facing copy — see that item for the full note. Fix the
      `?? 0` P1 above first. Source: safe-pace model review (2026-07-26); design in
      `notes/safe-pace-two-constraints.md`.

- [ ] **COMMITTED v1.1 (dump-load train, own small PR): manual-on grace for "Run on solar surplus" devices.**
      Reconcile-after-drift corrects an externally-turned-ON surplus-held dump load (the v1 helper copy
      states this contract explicitly). The committed follow-up: suppress the correction for
      `SURPLUS_MANUAL_ON_GRACE_MS = 2 h` from the per-device drift-observed timestamp, so an owner who
      flips their towel dryer on gets their two hours before the posture reclaims it. A restart drops
      the grace (in-memory timestamp) ⇒ held ⇒ off — safe. From the PR-7 cold-tank / manual-override
      ruling (judge 3), 2026-07-01. *Persona:* set-and-forget owner sharing the home with people who use
      the wall switch.

- [ ] **A released "Run on solar surplus" dump load returns to PELS's generic managed-restore, so it does
      not stay off after the toggle is turned off.** When the posture is removed while the device is off,
      `releaseAbandonedSurplusPosture` clears the stale `shedDecidedMs`/`surplusOnlyShedByDevice` stamps
      (correct hygiene), but the device is then a plain managed binary device and PELS's generic restore
      lane runs off managed binary devices under available power — so a former dump load can turn on
      unprompted. This is PRE-EXISTING behaviour (PELS restores off managed binary devices under headroom,
      confirmed independent of `shedDecidedMs` and of this feature; the PR-7 reviewer's shed-recovery
      mechanism is not the actual driver). Honouring "turn the toggle off to take the device back" (keep a
      former dump load's OFF baseline until the user turns it on) needs a managed-restore policy change:
      recognise a device whose baseline is off (dump-load semantics) and exclude it from the generic
      proactive restore — which also touches the engage path (a re-eligible dump load must still restore),
      so it is a deliberate, tested change, not a one-liner. Candidate approach: repurpose
      `surplusOnlyShedByDevice` as a persistent "off-baseline" marker the restore candidacy honours,
      cleared on observed-on / re-engage. *Persona:* owner who opted a pool pump into surplus-only then
      changed their mind. *Hypothesis:* the instant-on after toggle-off reads as PELS ignoring the toggle.
      P2. Source: pels-runtime-reality on PR-7, 2026-07-02.

- [ ] **`surplusOnlyShedByDevice` / `shedDecidedMs` stamps for a surplus-held device that leaves the
      snapshot are not pruned.** `releaseAbandonedSurplusPosture` only clears a device still present in
      `admittedDevices` (posture removed); a device that vanishes from the snapshot while held (removed
      from Homey, or the transport drops it) keeps its stamps until it returns. This matches the
      pre-existing `shedDecidedMs` cleanup profile (no lockstep prune on snapshot departure), and is
      bounded (~a handful of bytes/device, re-cleared on return). Fix: add both stamps to the key set
      `cleanupMissingHeadroomDevices` already sweeps in `lib/plan/planHeadroomState.ts:49-53`, alongside
      `surplusEligibilityByDevice`. Done when a device that leaves the snapshot while surplus-held comes
      back with no stale posture stamps. *Persona:* maintainer. *Hypothesis:* the stamps are harmless
      while they leak, but a device that returns after a long absence is judged against a posture decided
      before it left. P3. Source: pels-runtime-reality on PR-7, 2026-07-02.

- [ ] **A smart-task-governed `surplusOnly` device is excluded from the hold but stays in the allocator
      willing set, so it can reserve export a lower-priority dump load never gets (allocation skew).**
      `resolveSurplusHold` excludes a device with an admitted smart task (`admittedDeviceIds`), but
      `resolveSurplusEligibility` still includes it in the willing set and reserves its `getRestoreDrawKw`
      from the priority-ordered pool. So a high-priority dump load being run by its smart task consumes
      surplus budget that a lower-priority surplus-held dump load would otherwise engage on — the lower
      device stays held even though real export exists. Candidate fix: exclude the same `excludeIds` set
      from the allocator willing set (or credit the smart-task device's own draw as add-back so it does
      not double-reserve). *Persona:* prosumer with two dump loads, one on a smart task. *Hypothesis:*
      rare (needs two surplus dump loads + an active task on the higher one) and only under-uses surplus
      (never over-draws), so low-stakes. P3. Source: pels-runtime-reality on PR-7, 2026-07-02.

## P2 Product, Observability, and Maintainability

- [ ] **Unmanaged picker devices are served from a cached parse, so their observed state is
      up to half an hour stale.** `/ui_devices` merges the managed snapshot with the
      unmanaged-but-eligible picker list, and `withLiveObservedState`
      (`setup/settingsUiApi.ts`) refreshes only the devices the observer projection holds. The
      projection is fed from the committed runtime snapshot
      (`lib/device/transport/snapshotRefresh.ts`), and runtime parsing drops unmanaged devices
      (`lib/device/transport/managerManagedFilter.ts`), so a picker row never has an entry.
      Its availability and control state are whatever the last snapshot rebuild parsed.

      **Where:** `withLiveObservedState` in `setup/settingsUiApi.ts`, the picker reparse in
      `lib/device/transport/snapshotRefresh.ts`.

      **What changes:** rule on whether eligible-but-unmanaged devices get observer coverage.
      Either feed their observations into an observer-owned read model so the same projection
      answers for them, or add a separate live picker-state accessor and refresh from that.
      Doing neither is also a decision — say so where the limit is, and the entry closes.

      **Done when:** a picker-only device whose availability changes between snapshot rebuilds is
      served its current value by `/ui_devices`, pinned by a test alongside the existing
      picker-cached-parse case in `test/integration/settingsUiApi.test.ts`.

      *Found by adversarial review of the live-observed-state change (2026-08-20). Pre-existing
      staleness — that change made managed devices live and left this population behind, rather
      than introducing it.* [P2]

- [ ] **A stepped write that throws records nothing, so the next cycle re-commands with no backoff.**
      `executeSteppedLoadCommand` (`lib/executor/steppedLoadExecutorCommand.ts`) calls
      `recordAcceptedSteppedLoadCommand` — which is what marks the desired step issued — only on the
      success path, after the await. Its `catch` logs `stepped_load_command_failed` and returns
      `false`, writing nothing; `steppedCommandClaim` is released in `finally` but that is an in-cycle
      mutex, not durable state. So a timed-out stepped write leaves `steppedLoadDesiredByDeviceId`
      with no entry, nothing suppresses a re-issue, and PELS re-commands every cycle until the device
      answers. Same end state the binary axis had before the timeout-is-unknown fix, reached by
      omission rather than by clearing — but milder, because a repeated step write does not reset the
      device-side step limit the way a repeated binary activation does.
      The shape to copy is the target axis, which already gets this right:
      `targetExecutor.ts` → `recordFailedPendingTargetCommandAttempt`
      (`lib/plan/planTargetControl.ts`) *writes* an entry with `status: 'temporary_unavailable'` and
      `nextRetryAtMs`, preserving `startedMs`/`pendingMs`, and never deletes. Three axes now have
      three hand-rolled `catch` policies; a shared write-outcome policy is the larger prize but the
      stepped gap is fixable on its own. Found 2026-08-17. [P2]

- [ ] **Two producer-shaped functions are stranded in `lib/plan` with no `lib/plan` callers.**
      `withHeadroomCurrentOn` (`lib/plan/planHeadroomSupport.ts`, its own comment: "the twin of
      `toPlanDevice`") and `resolveSurplusOnlyPosture` (`lib/plan/planSurplusAbsorb.ts`) are called
      only from `setup/**` and `flowCards/**` — verified 2026-08-17, every `lib/` hit is a comment
      mention, not a call. Both take raw transport shapes; `withHeadroomCurrentOn`'s input carries
      `binaryControl`, the field the plan kinds deliberately exclude. They belong next to
      `setup/appInit/toPlanDevice.ts`. The move is legal today: `flowCards/` sits above `setup/`, so
      `no-lib-to-setup` does not block the import. Promoted 2026-08-17 out of the completed
      snapshot-discrimination umbrella; originally found reviewing the modality-containment change. [P2]

- [ ] **The step axis extends stale-trust without a note or a test.**
      `resolveRestoreObservedState` (`lib/plan/restore/devices.ts:53`) reads `selectedStepId` + the
      profile with NO staleness gate, so a stale step-only stepper parked at its off step resolves
      authoritatively to off. That is sound — `selectedStepId` is PELS's latched last-commanded step —
      and consistent with stale-off = trusted-off, but `lib/observer/AGENTS.md` documents that
      invariant for the BINARY axis only (`currentOn`); it says nothing about the step axis, verified
      2026-08-17. *Hypothesis:* a future change to step latching silently flips stale step-only
      restore eligibility with nothing pinning it. *Persona:* an installer with a `target_power` load.
      Add the note to `lib/observer/AGENTS.md` plus an integration test pinning a stale step-only
      stepper's restore/shed classification. Promoted 2026-08-17 out of the completed umbrella. [P2]

- [ ] **Fixture `currentOn` precedence diverges from production (test-only).**
      `resolveFixtureCurrentOn` (`test/utils/planTestUtils.ts:49-54`) lets an explicit `currentState`
      label win over structural (binary + stepped) resolution; production `currentOn` stamping never
      consults the label. Still present as described, verified 2026-08-17. Reordering to resolve
      structurally first is more faithful but cascades: ~31 stepped fixtures express off-ness via
      `currentState` alone with no structural `binaryControl: { on: false }` signal, and flip under the
      reorder. *Hypothesis:* those underspecified fixtures can mask a planner/executor regression where
      production resolves `currentOn` differently than the fixture asserts. *Persona:* a maintainer
      touching stepped shed/restore. Do it as a focused PR: reorder the helper, then give each fixture
      that intends "off" an explicit `binaryControl`. (CodeRabbit #1728.) Promoted 2026-08-17 out of the
      completed umbrella. [P2]

- [ ] **The overshoot delta mixes a measured current total with a baseline that may be stale.**
      `buildOvershootEntryDiagnostics` now takes its current half from `context.measuredDrawKw`
      (a control input, off the context) — but the baseline half, `state.lastPlanTotalKw`, is still
      written from the display bundle's raw `totalKw` in `rememberPlanSnapshot`, because a baseline
      that goes `null` on one stale cycle silently closes restore attribution on the next fresh one
      (pinned by `does not close restore attribution on a stale-hold rebuild with non-negative
      synthetic headroom`). So a delta can be measured-minus-stale, and that delta gates
      `recordActivationSetback` — i.e. a stale baseline can still influence restore admission.
      Fix direction: keep the baseline non-null across a stale cycle without borrowing the display
      total — carry the last MEASURED total forward instead of overwriting it each build, so the
      pair is always measured-minus-measured, and decide explicitly what attribution should do when
      the two are separated by a gap rather than inferring it from whichever total survived. Found
      2026-08-17 fixing the display-to-control edge on PR #2146. [P2]

- [ ] **A measurement-gated home keeps serving the previous run's `pels_status`, and the UI reads
      it as `fresh`.**
      `PlanService.rebuildPlanFromCache` returns before `PlanStatusWriter` when the build gate is
      shut, so nothing rewrites the persisted `pels_status` blob — while `getSettingsUiPower`
      (`setup/settingsUiApi.ts:167`) reads that blob straight out of settings, including
      `powerNowKw`, `headroomKw`, `hasLivePowerSample`, and `powerFreshnessState`. After a restart,
      a `power_source = flow` home whose reporting Flow never fires therefore shows the *last run's*
      watts and available power, labelled `'fresh'`, for as long as it stays unmeasured — the one
      state the gate exists to declare. The gate's own refusal is correct; only the read is
      dishonest. Fix direction: the read is the boundary, so classify it there — have the settings-UI
      power composer resolve to an explicit measurement-unavailable result while the gate is shut,
      rather than passing a stale blob through as a live one. Preserve the stored state (a
      transient gate close must not destroy it, `notes/persisted-settings-state.md`); change only
      what the reader claims about it. Found 2026-08-17 by the Codex reviewer on PR #2145. [P2]

- [ ] **`home_bundle_gated_no_power_sample` is only evaluated when something else happens to ask
      the gate, so the home it describes is the one least likely to emit it.**
      `PowerMeasurementGate.noteShut` checks the elapsed grace inline, so the warning fires only on
      a call to `isOpen()` — i.e. only when some other trigger (price update, settings write, device
      change) drives a rebuild. The freshness heartbeat is not a fallback here: it returns early
      when `lastTimestamp` is absent, which is exactly a never-sampled home, and returns early again
      under `power_source = flow` via `isMeterSourceAuthorized`
      (`setup/homeRuntime/homeCapacityBundleReadiness.ts:253-256`). So a flow-powered home whose
      Flow never fires — the precise case the warning is for — emits it only if an unrelated trigger
      happens to land after the five-minute grace, and never on a quiet install. Fix direction: arm
      a cancellable timer when gating starts so the warning has its own guaranteed recheck, and
      cancel it when the gate opens. Observability only: the gate itself already fails safe by
      refusing to build. Found 2026-08-17 by the Codex reviewer on PR #2145. [P2]

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

- [ ] **20 plan assertions read `plannedTarget` without the temperature discriminant, and
      `mockHomeyInstance.app` is the `any` keeping that invisible.**
      Typing the mock's installed-app slot makes `getLatestPlanSnapshotForTests` return a real
      `DevicePlan | null`, which surfaces 154 errors across 7 specs: ~89 unguarded `plan.devices`
      reads, ~45 possibly-undefined array indexes, and 20 reads of `plannedTarget`. That last
      group is the substantive one — `plannedTarget` is `?: never` on every non-temperature arm
      of `DevicePlanDevice`, so those assertions have been resolving through `any` rather than
      discriminating first (`reference_temperature_discriminant_split`). Fix direction: narrow on
      the temperature facet at each read, then drop the scoped `eslint-disable-next-line
      @typescript-eslint/no-explicit-any` on `app` in `test/mocks/homey.ts`; the block sets
      `reportUnusedDisableDirectives`, so the directive reports itself unused once the reads are
      fixed. Deliberately excluded from the change that found it (PR #2118) because it is
      plan-domain work, not a typing chore. Found 2026-08-16 enabling `no-explicit-any` for the
      mock and unit tiers. [P2]

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
      gone; the layer reads `commandableNow`. That raises the severity of the half still open here:
      it is not tidiness, it is the same silent-strip failure mode with a live consumer. [P1]

- [ ] **`objectiveKind` is write-only on both plan types.**
      Resolved by `resolvePlanObjective` (`setup/appInit/toPlanDevice.ts`), forwarded through
      `producerResolvedDecisionFields` (`lib/plan/planDevicesBase.ts`), declared on both
      `PlanInputDevice` and `DevicePlanDeviceBase` — and read by nobody since `hasStandingDemand`
      replaced the last two consumers (the diagnostics `isEvLikeDevice` gate and the surplus
      dump-load gate). Every smart-task site reads `objective.kind` off its own settings entry or
      `diag.objectiveKind`, never off a plan device. `knip` does not catch a dead type property.
      Leaving a literal `'ev_soc'` on the plan device is a second, equally-available answer to the
      question `hasStandingDemand` now owns. Fix: drop it from `DevicePlanDeviceBase` and the
      forwarding helper. Found 2026-08-16. `objectiveSessionInactive`, the other half of this entry,
      is no longer write-only as of 2026-08-23: it came OFF `DevicePlanDeviceBase` and the
      forwarding helper (the plan OUTPUT genuinely had no reader) and stayed on `PlanInputDevice`,
      now REQUIRED, because the smart-task lane is its real consumer — it had been reading the
      stripped `evChargingState` instead. [P2]

- [ ] **`TrustedTemperatureInput.currentTemperature` kept the optionality its twin just shed.**
      The same change made `TrustedStateOfChargeInput.stateOfCharge` required, with the rationale
      that as an optional field the signature accepted any object at all — so removing the field
      upstream would not break a call site, it would make them all read `undefined` and answer "no
      level" forever. `currentTemperature?: number` in `lib/utils/observationTrust.ts` still has
      exactly that shape, as does `BoostResolveInput.currentTemperature`, decoupled from both
      `temperatureBoost` and `targets`. No reachable failure today — `resolveBoostLevel` gates on
      the target capability and the typed test fixtures get excess-property checks. Fix: co-type
      the temperature source the same way, or record why the asymmetry is deliberate. [P3]

- [ ] **The two boost configs are one config wearing two units.**
      `resolveBoostLevel` (`lib/device/deviceActionProjection.ts`) now treats a tank temperature
      and a car's battery percentage as what they are — one quantity, "how full is this device's
      store", read from whichever capability the device has. The persisted settings have not
      caught up: `ev_boost_settings.boostBelowPercent` and
      `temperature_boost_settings.boostBelowC` are the same field, and the resolver still needs
      two branches purely to name them. Collapsing them to one per-device `boostBelow` (unit
      carried by the source capability, as it already is everywhere downstream) would leave a
      single branch that picks a reading, and would let the settings UI render one control.
      Two smaller things fall out of the same change:
      (a) `enabled` on both config types is a state the runtime can never observe — the
      normalizers (`normalizeEvBoostSettings` / `normalizeTemperatureBoostSettings`) drop every
      entry whose `enabled !== true` or whose floor is non-finite, and every runtime reader
      (`appSettingsHelpers.ts` → `ctx.getEvBoostConfig` / `getTemperatureBoostConfig`) plus the
      settings UI's own state goes through them, so config PRESENCE is already the enablement;
      (b) with that, the `enabled` and finiteness re-checks inside `resolveBoostLevel` are the
      hedging-consumer symptom the clean/trusted-interface rule names, and can go.
      Deferred because it touches the persisted blobs, their back-compat, and the settings-UI
      write path (`deviceDetail/evBoost.ts`, `deviceDetail/temperatureBoost.ts`). Found
      2026-08-16 while consolidating the two boost decisions. [P2]

- [ ] **A single transient temperature-facet miss discards the pending `set_temperature` record.**
      `prunePendingTargetCommandsForPlan` (`lib/plan/planTargetControl.ts`) keys retention on
      `isTemperaturePlanDevice(device)`, so the one cycle in which a device plans as `onoff`
      (facet dropped upstream by a failed/malformed SDK read, before the transport's targeted
      recovery refresh lands) deletes the in-memory pending record. Bounded and fail-safe —
      worst case one duplicate idempotent write after recovery, and a flapping facet loses
      re-issue suppression so the write can repeat once per plan cycle — and unchanged from
      before the atomic-facet propagation (the old predicate evaluated false in the same
      situations). A pending-window-scoped retention (the `planHistory.ts` pattern) would close
      it. Found 2026-08-14 in the atomic-facet review. [P2]
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

- [ ] **`initialEnergyNeededKWh` fabricates `0` when the diagnostic carries no energy.**
      `startRecord` (`planHistoryInProgressState.ts`) writes `diag.energyNeededKWh ?? 0` into a
      field the v4 contract declares REQUIRED, so absence becomes the assertion "this run needed
      0 kWh at start" — the fabricated-zero `lib/AGENTS.md` forbids. Cannot be fixed in place:
      making it optional is a shape change to a released schema, which the repo has no precedent
      or policy for. Needs either a schema-version plan or a producer-side guarantee that the
      field is always resolvable. Found while removing the neighbouring energy fallbacks,
      2026-08-12. [P2]

- [ ] **`parsePlanSnapshot` drops malformed facets silently — the adapter never tells its caller.**
      *Persona:* engineer diagnosing why a stepped device renders as a generic card in production.
      *Hypothesis:* the seam validates the temperature trio, the `steppedLoad` cluster and the EV
      plug-state pair, and drops each WHOLE on junk (2026-08-15, PR #2111). Dropping is the right
      remedy — rejecting the plan would blank every healthy device over one bad field — but it is
      currently silent, so a corrupted `steppedLoad` and a genuinely non-stepped device are
      indistinguishable downstream, and `readOverviewPlan` reports `served` for a response it
      partially discarded. Provenance is erased rather than classified. The fix is NOT to log from
      inside the parser: it is deliberately a leaf module (both `planRedesign` and
      `overviewPlanRead` import it, so it must not pull `homey.ts` into its graph). It should
      RETURN what it dropped and let each caller decide — `realtime.handlePlanUpdated` already
      logs a fully-malformed push via `logSettingsWarn` and is the natural home for a
      partially-degraded one. That is a signature change across every call site, which is why it
      is not folded into the validation PR. Source: Codex review of PR #2111. [P2]
- [ ] **`planningPowerKw` / `selectedStepId` are still flat on the DECORATED device snapshot.**
      The overview half landed 2026-08-15: `DeviceOverviewSnapshot` carries every stepped fact on
      the `steppedLoad` cluster (`planningPowerKw` and `selectedStepId` REQUIRED there), the flat
      `reportedStepId` / `targetStepId` / `desiredStepId` / `steppedLoadProfile` copies are gone,
      and `getDeviceOverviewExpectedPowerKw` reads the cluster with no fallback. That also fixed a
      live divergence — the flat target id skipped `buildOverviewSteppedLoad`'s trimmed-ladder
      correction, so the card, the transition label and the device log disagreed.
      **What remains is `SteppedLoadDecoration` on `DecoratedDeviceSnapshot`
      (`packages/contracts/src/types.ts`)** — a different carrier, and the only one that still
      makes `toPlanDevice` and `decorateSnapshotWithDeviceControl` spend a line each explicitly
      clearing `planningPowerKw`, which is the tell it is on the wrong type. Bigger than the
      overview move: 12 optional fields cleared field-by-field at two sites, with consumers across
      `setup/**` and `packages/settings-ui/src/ui/{deviceControlProfiles,deadlinePlanResolvers,
      deviceDetail/steppedLoadDraft}.ts`.

- [ ] **`isValidPlanDevice` vouches for more than it checks.**
      `setup/settingsUiAppRuntime.ts` narrows `unknown` to `SettingsUiPlanDevice` while inspecting
      only `id`, `name`, `reason` — it now asserts four more required fields it never looks at. The
      source is in-process so there is no live risk; either widen the guard or say so in its
      comment so the next reader does not trust it as a wire-boundary validator.

- [ ] **The Zaptec native-wiring overlay activates per DEVICE, not per missing axis.**
      `applyNativeEvWiringOverlay` synthesizes only the axes a charger is missing, but the
      `controlAdapter.activationEnabled` flag it returns is all-or-nothing — and
      `normalizeNativeEvCapabilityUpdate` keys the legacy remap on that one flag. So a Zaptec that
      natively exposes one official EV capability and not the other has its legacy
      `charging_button` / `charge_mode` / `alarm_generic.car_connected` events remapped onto BOTH
      axes, including the one it already reports natively. The concrete case Codex found — a
      connected alarm collapsing `plugged_in_discharging` to `plugged_in_paused`, making a
      non-commandable V2G session look commandable — is fixed directly in the mapping, but the
      shape that allowed it is still there: any future legacy remap can overwrite a natively
      reported axis. The fix is to record which axes the overlay synthesized and let the
      normalizer remap only those, which means carrying that set on the snapshot (a
      `DeviceControlAdapterSnapshot` change) rather than inferring it. Exposure widened on
      2026-08-09 when `hasOfficialEvChargerCapabilities` began requiring both axes, so
      single-axis chargers now reach the overlay instead of being dropped. Persona: owner of a
      Zaptec whose app exposes one official capability; hypothesis: a V2G session that PELS
      briefly treats as commandable is indistinguishable from a charger refusing to start.
      Source: Codex on PR #2042. [P2]

- [ ] **Retire the last `dailyBudgetExhaustedBucketCount` reader, on the history side.** The
      active-plan half is done: the field is off
      `packages/contracts/src/deferredObjectiveActivePlans.ts`, out of the `activePlanSettings.ts`
      validator, out of `captureRevisionSnapshot`, and every consumer that branched on it
      (`deadlinePlan.ts`, `deadlinePlanHero.ts`, `deadlineLabels.ts`, `activePlanRevisionLog.ts`,
      the smart-tasks widget) now reads `floorShortfallCause: 'budget'` alone. Active plans
      re-settle hourly and are deleted at the deadline, so no live plan could still carry it.
      What remains is the HISTORY side: the optional field on
      `DeferredObjectivePlanHistoryRevisionSnapshot`, its validator in `planHistorySettings.ts`,
      and `snapshotShowsBudgetExhausted` (`packages/shared-domain/src/deferredPlanHistoryShared.ts`),
      read by `deferredPlanHistoryAttribution.ts`, `deferredPlanHistoryPostmortem.ts` and
      `deferredPlanHistory.ts`. That resolver is load-bearing — it censors budget-caused misses
      out of the weather energy-signature fit — and history entries recorded before 2026-08-09
      genuinely carry the count. **Gate this on the entry cap, not on a date:** plan history is a
      30-entry FIFO (`planHistory.ts` `HISTORY_ENTRY_CAP`) with NO age expiry, so a rarely-run
      smart task can hold a pre-cutover entry indefinitely. Source: 2026-08-09 investigation of a
      smart task that skipped the last two hours of an overspent day. [P2]

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

- [ ] **Pin that the daily-budget pace still holds an `unclaimed` smart-task device.** The whole
      justification for `unclaimed` is that the plan layer, not the smart task, decides whether the
      device may run — and by reading, it does: `headroomLedger.availableFor` returns
      `min(capacity, budget)` for a non-exempt device and `shedding/candidates.ts` keeps it a shed
      candidate under a daily-binding limit. Nothing pins it. `smartTaskUnclaimedHourLifecycle`
      cannot: it has no `PlanBuilder`, so it models an unclaimed device as running. Wants a spec
      driving the plan layer with a budget-bound soft limit and an unclaimed device, asserting it is
      held — ideally a true `createApp` SDK-boundary e2e, which would also close the tier gap below.
      Source: pels-runtime-reality and Codex on the unclaimed-hour change, 2026-08-09. [P1]

- [ ] **`feasible_above_floor` credits a climb the runtime often will not allow.**
      `resolveClimbedBandFeasibility` asks "would the booked hours cover the need if the device
      climbed?" and answers from step capacity alone. At runtime
      `blockSteppedRestoreForShedInvariant` (`lib/plan/restore/steppedRestoreAdmission.ts`) pins a
      stepped device to its lowest non-zero rung whenever anything else is shed — bypassed only by
      an active boost, which requires a CLAIMED hour of a `limitLowerPriorityDevices: 'always'`
      task. And `admitSteppedRestore` grants one rung per restore cooldown, so a multi-rung climb
      costs 5-25 minutes that the probe credits in full. A device in a house tight enough to produce
      the shortfall is exactly the device that cannot climb.
      That verdict now also drives a control decision: `step_power` releases an unbooked hour
      (`currentHourClaim`), so a wrongly optimistic probe stands a device down. Pre-existing, but PR
      #2061 widened who reaches it — devices whose top rung exceeds an hour's headroom used to fail
      the probe outright and land on `cannot_meet`. Residual exposure is narrow: it needs the hour's
      BUDGET slice to be zero (a zero headroom forecast no longer empties an hour), and in that
      state the daily-budget pace would hold a non-exempt device anyway — but `released` commands it
      off rather than merely holding it. Wants the probe to account for what the restore lane will
      actually grant. Source: pels-runtime-reality on PR #2061. [P2]

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

- [ ] **`test/e2e/deferredObjectiveColdStartSdkE2E.test.ts` is integration by the taxonomy's own
      rule.** It drives the stack by calling `buildDeferredObjectiveDiagnostics` /
      `applyDeferredObjectiveAdmission` and asserts on their returns, which
      `notes/testing-taxonomy.md` § "The border cases" classifies as integration, not e2e — yet
      `lib/objectives/deferredObjectives/AGENTS.md` names it "the canonical harness" for
      deferred-objective **e2e**. Two repo docs disagree, and the next person writing a
      deferred-objective test inherits the contradiction (this one did). Either move it and reword
      the module AGENTS.md to say the harness defines what may be SIMULATED rather than which tier
      it is, or rewrite it as a `createApp` SDK-boundary spec. Source: Codex on PR #2059. [P2]

- [ ] **Flow stepped-load runtime state still duplicates exact watts after transport admission.**
      `reportSteppedLoadActualStep` admits exact power into the transport-owned reported-step
      cluster, but `SteppedLoadReportedRuntimeState.planningPowerW` keeps a second setup-layer copy
      solely to distinguish same-step reports. Replace that change detection with the transport
      admission outcome, then remove the duplicate field so setup retains only command lifecycle
      and the reported step id. Source: layering review of EV target-power reachability delivery.
      [P2]

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

- [ ] **Remove the remaining drift consultation from the planner facade.** DELETE it instead of
      routing it. Call `applyPlanActions(plan)` on every non-dry-run rebuild and
      let the executor no-op per device — it is already built for that (`handleTargetCommandPreflight`
      skips on an equal observed value, and this train made retry suppression and cooldown stamping
      unconditional). That collapses the gate in `maybeApplyPlanChanges` to a dry-run check, drops
      `hasExecutionWorkOutstanding` (probably `shouldApplyStablePlanActions` too) from the facade,
      leaves `hasSettledActuation` as the only convergence question the planner asks, and makes
      "the planner knows nothing about drift" literally true rather than true-about-imports. The
      gate is a cost optimization, so removing it trades apply-path CPU for a clean boundary; land
      it with a before/after read of rebuild `applyMs` so the trade is measured, not assumed.
      *Source: the drift/reconcile layering train (2026-08-06); noted while closing the three
      inversions behind `inc_26449fb9`.*

- [ ] **Move target-command retry state out of the planner namespace.** The retry decision and
      attempt bookkeeping are executor materialization concepts, but `targetExecutor.ts`,
      `targetExecutorContext.ts`, and `lifecycleFallbackDispatcher.ts` still import their state and
      helpers from `lib/plan/planTargetControl.ts` / `lib/plan/planState.ts`. Extract the flat
      `PendingTargetCommandState` contract to a neutral lower-layer module and move send/retry/skip
      plus attempt recording into `lib/executor/`; leave only plan decoration, pruning, and observed
      synchronization in `planTargetControl.ts`. Do not solve this by adding a plan→executor edge or
      by duplicating retry timing. *Source: pels-layering-guardian review of #2083. [P2]*

- [ ] **`remainingActionableControlledLoadW` in the shortfall record disagrees with what shed
      selection can act on.** The capacity summary sources it from `residualKw.shed` (= current
      draw, `resolveResidualKwShed` in `lib/device/deviceResidualKw.ts`) while selection uses
      step-delta relief. In `inc_26449fb9` (prod 2026-08-05) the record published
      `remainingActionableControlledLoadW: 1193, remainingActionableControlledLoad: true` while
      the selector independently computed 0 and shed nothing — the record asserted actionable
      load that no lane could act on. Source it from `OvershootStats.reducibleControlledKw`
      instead, which is the selector's own figure. Blocked on wiring `overshootStats` through:
      `SheddingPlan.overshootStats` is currently dead — returned by `buildSheddingPlan` and never
      read by `planBuilder.ts`; its only consumers are assertions in
      `test/integration/planShedding.test.ts`. The per-cycle skip counters added in the
      stepped-ladder PR (`skippedCandidateCount` / `skippedCandidateReasons`) ride the same
      struct and would reach the incident record with it. Source: prod log review 2026-08-06. [P2]

- [ ] **`resolveSteppedLoadImmediateReliefKw` caps the *to*-side by `measured`, so step relief is
      structurally zero whenever `measured <= admission(toStep)`.** Both contributions collapse to
      `measured` and the delta is exactly 0 regardless of the from-step, so a stepped device whose
      power reading lags a step-up prices every adjacent rung at nothing. The ladder descent in
      `lib/plan/shedding/steppedCandidates.ts` works around this by finding a deeper rung that
      does relieve; the arithmetic itself is untouched. The calibration layer already detects the
      same inconsistency — `power_calibration_sample_skipped` with `reason: "below_lower_step"`,
      logged twice during `inc_26449fb9` — but the planner has no equivalent guard, and the
      calibrated/nameplate fallback in `resolveSteppedCandidatePower` is unreachable whenever
      the device's `currentDrawKw` is positive, including a stale reading (it used to be
      unreachable for ANY finite `measuredPowerKw`; since the producer always resolves a draw,
      only a zero reading reaches the fallback now). Consider treating a measurement
      that contradicts the reported step as not-evidence and falling back to the calibrated delta.
      Deliberately not done in the ladder PR: it means trusting a reported step over the meter,
      which is a larger judgement call than the descent (which stays meter-grounded).
      Source: prod log review 2026-08-06. [P2]

- [ ] **`getSteppedLoadLowestActiveStep` and the off rule disagree, so two more call sites can still
      land on an off-classified rung.** `getSteppedLoadLowestActiveStep` picks the first rung with
      `planningPowerW > 0` and never reads the id, while `isOffStep` treats
      `planningPowerW <= 0 || id === 'off'` as off. On a hand-configured profile carrying a
      positive-power rung named `off`, the two answer differently. The shed-candidate walk was
      reconciled at its call site (`lib/plan/shedding/steppedCandidates.ts`, filters the `set_step`
      targets through `isSteppedLoadOffStep`), but two callers were left:
      `resolveShedBehaviorFloorStepId` (`lib/plan/planSteppedShedResolution.ts`) returns that rung
      as the `set_step` floor whenever no planner rung was decided — a shed decided outside the
      shedding planner, or a prepared-binary-off candidate — so materialization can still park a
      `set_step` device on a rung the behaviour promises never to reach; and
      `getSteppedLoadRestoreStep` (`lib/utils/deviceControlProfiles.ts`) feeds restore sizing
      (`lib/plan/restore/helpers.ts`, `lib/executor/steppedLoadExecutorRestore.ts`), so a *restore*
      can target a rung the rest of the system classifies as off — the inverse contradiction.
      Fix each at its call site, as the shedding one was; changing either helper globally would
      move meaning under every other caller. The `hasUsableSteppedLoadLadder` docblock
      (`packages/contracts/src/deviceControlProfiles.ts`) also assumes the two agree, and needs a
      line if this is taken. Not reachable on any PELS-generated profile — every one carries a real
      zero-power `off` — and `hasUsableSteppedLoadLadder` rejects an all-off ladder at the parse
      boundary, so this needs a mixed hand-configured profile. Source: Codex review of PR #2170,
      2026-08-20. [P3]

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

- [ ] **Exempt restore lane keys on the instantaneous binding source, not the latch cause.**
      `shouldPlanBudgetExemptRestores` (`lib/plan/restore/timing.ts`) opens on
      `softLimitSource === 'daily'`, but `sheddingActive` is a latch: a capacity-latched shed
      whose binding source flips to `daily` mid-latch (daily pace recomputes below the capacity
      dynamic limit while binding headroom sits in the hysteresis band) opens the lane and lets
      an exempt admission consume part of the capacity clearance margin the latch was holding.
      Bounded by the admission floor and the shed/restore cooldowns (documented in the
      predicate's docblock), so no divergence — but recording the latch *cause* alongside
      `PlanEngineState.sheddingActive` and gating the lane on it would close the corner.
      Source: pels-runtime-reality review of the exempt-restore-lane PR, 2026-08-03. [P2]

- [ ] **A `set_temperature`-only budget-exempt device stays budget-pinned while binary/stepped
      exempt devices resume.** The exempt restore lane (`lib/plan/restore/exemptRestoreLane.ts`)
      covers binary and stepped candidates — the ledger's admission surface — but the temperature
      hold lane stays gated by `inShedWindow` (`planReasonsHoldDecisions.ts`), so a target-only
      exempt heater is not resumed while shedding is latched on the budget axis. Deliberate scope
      cut, stated in the lane's docblock; extending it means teaching the hold lane per-axis
      admission. Persona: owner who exempted a floor-heating thermostat and sees the exempt EV
      charger climb while the thermostat stays held; hypothesis: rare today because exemption is
      mostly applied to chargers/heaters with binary or stepped control. [P3]

- [ ] **The charger page shows the same battery level twice without saying they are the same
      number.** With a car ticked, the Car section reads `Polestar 3 · Charging · 63 %` while
      Setup's "Battery level" readout independently reads `63 %` — one screen, two apparently
      independent sources. Name the source in the Setup readout (`63 % · from Polestar 3`,
      `packages/settings-ui/src/ui/deviceDetail/socState.ts`), and have charge boost say where its
      level comes from when a car is adopted. `stateOfCharge.source === 'car'` already carries it.
      Source: pels-ux-fit review of PR #1976, 2026-08-02. [P2]

- [ ] **The car picker uses a native checkbox where `md-checkbox` exists.**
      `.detail-car-row input[type='checkbox']` (`packages/settings-ui/public/style.css`) renders a
      16 px control next to the 48 px `md-switch` rows in Setup and looks foreign. The row's tap
      target is already 48 px, so this is appearance only. AGENTS.md says use `@material/web` where
      a component matches. Source: pels-ux-fit review of PR #1976, 2026-08-02. [P2]

- [ ] **A ticked car that no longer exists renders as an ordinary device row.** `orphanedCarIds`
      (`packages/settings-ui/src/ui/deviceDetail/carAssociation.ts`) labels it `Removed car`, which
      reads as a car actually named that. It is kept visible so it can be un-ticked, which is
      right; the presentation should say what it is — hint styling, or a Clear affordance instead of
      a checkbox pretending to be a device. Source: pels-ux-fit review of PR #1976, 2026-08-02. [P2]

- [ ] **The car's battery level is shown without its age.** `AssociatedCarSnapshot.socObservedAtMs`
      is carried and unused by the UI, while Setup's own readout shows "Updated X ago". A car parked
      at work reporting a day-old level is exactly the case where the owner needs the timestamp.
      Source: pels-ux-fit review of PR #1976, 2026-08-02. [P2]

- [ ] **A transient settings read-miss silently disables every configured car association.**
      `buildCapacitySettingsSnapshot` (`setup/appSettingsHelpers.ts`) normalizes
      `ev_car_associations` unconditionally, so a `null`/malformed read replaces the eligibility
      map with `{}` and every charger shows no associated car until the next successful reload.
      Not destructive (nothing is persisted, and the next load restores it) and the same shape as
      its sibling per-device keys (`ev_boost_settings`, `temperature_boost_settings`), which is
      why it was not fixed in isolation — it is one more instance of the absence-classification
      duplication tracked below. Fix with that item, or sooner if the display blip is reported.
      Source: Codex review of PR #1972, 2026-08-02. [P2]

- [ ] **`hasSessionPowerEvidence` treats a missing observation timestamp as usable evidence.**
      `lib/device/evCarLinkChargerView.ts` returns `true` when `measuredPowerObservedAtMs` is
      absent, so a retained reading that predates the session can satisfy the self-stop idle
      condition — the exact confusion the function's own docblock warns about for the
      value. Pre-existing behaviour (the predicate was only relocated by PR #1972); changing it
      alters self-stop detection, so it needs its own change with a regression test covering a
      timestamp-less charger. Devices without capability timestamps are the honest limit here.
      Source: CodeRabbit review of PR #1972, 2026-08-02. [P2]

- [ ] **Net-export hours render "Managed 0.0 kW · Background 0.0 kW" under the hero power bar.**
      `computePowerBarScale` (`packages/settings-ui/src/ui/views/PlanHero.tsx`) clamps total draw
      to 0, so an exporting solar home with a known split shows a double-zero legend line that the
      pre-#1970 rule hid. Honest but odd next to an export story; consider hiding the line when
      total is 0, or fold into the solar export-display work
      (`notes/` solar direction) when it touches this surface.
      Source: 2026-08-02 pels-ux-fit review of PR #1970. [P2]

- [ ] **The same settings-absence classification is hand-rolled in four readers, and the bug
      shipped in the duplication rather than in any one policy.** `readOptionalSetting`
      (`setup/homeRuntime/homeModeCatalog.ts:126-146`),
      `readTemperatureControlDisabledDevicesSetting` (`setup/appSettingsHelpers.ts`),
      `readConfiguredPowerSource` (`setup/powerSourceSettings.ts`) and
      `readMainMeterSelection` (`setup/mainMeterSettings.ts`) each re-derive the same evidence:
      read the value, cross-check `getKeys()`, validate the list is a non-empty string array.
      Promote that evidence — not the verdict — into one `setup/` module returning
      `'value' | 'unwritten' | 'listed_but_empty' | 'key_list_unusable'`, and let each reader keep
      its own policy on top (they legitimately differ: the temperature policy fails closed on
      `listed_but_empty`, the mode catalog treats it as an explicit stored `null`). This does not
      conflict with `notes/persisted-settings-state.md`'s "no shared helper" ruling, which rejects
      sharing differing state machines, not shared evidence.
      Source: 2026-08-02 adversarial review of the temperature-control policy fix. [P2]

- [ ] **A transient failed read of the temperature-control policy flips every thermostat to on/off
      control, and nothing says so.** `resolveTemperatureControlDisabled`
      (`setup/appDeviceControlHelpers.ts:64-74`) classifies every temperature device
      target-control-disabled while the policy read is `unavailable` with no prior resolved value,
      so a capacity shed in that window turns thermostats OFF instead of lowering setpoints, and
      boost is stripped. Fail-safe direction and self-healing (retry per query), but it is one
      transient read driving a behavior flip. Count 2–3 consecutive unavailable resolutions before
      applying the all-temperature fallback, and emit a dedicated
      `temperature_control_policy_unavailable` event so the flip is diagnosable.
      **The diagnosability half is the load-bearing one, and this entry under-rated it.** As
      originally filed this was assessed P2 on the premise that `unavailable` is transient and
      self-heals. It was not: `ManagerSettings.get` answers an unset key with `null`, the reader
      classified absence on `undefined` alone, and so the policy pinned itself at `unavailable`
      *permanently* on every install that had never written the key — silently costing every
      thermostat all setpoint control (shipped in v2.20.0, fixed since; see
      `readTemperatureControlDisabledDevicesSetting`). A `temperature_control_policy_unavailable`
      event would have surfaced that in the first production log read instead of a live-device
      investigation. Do not re-derive the severity of a silent fail-closed state from the code
      path alone — an undiagnosable one is worth more than the flip it guards.
      Source: 2026-08-02 release review, pels-runtime-reality; re-scoped 2026-08-02 after the
      permanent case was found on a live Homey. [P2]
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
- [ ] **`checkShortfall` has two callers and two definitions of `totalKw`.**
      `lib/plan/admission/sheddingGuard.ts` passes `context.measuredDrawKw` (freshness-gated,
      `null` once the sample passes `POWER_SAMPLE_STALE_THRESHOLD_MS`); the two
      `lib/plan/rebuildScheduler/signalDriven.ts` sites pass `latchedTotalKw`
      (`resolveLastTotalPowerKw`, the raw latch, non-null whenever any sample has landed).
      Nothing enforces that they agree, and the guard's docblock says only "the caller's
      resolved whole-home total", which does not name a resolution. Divergent case: sample age
      90 s, latch 11.2 kW, threshold 9.0, no candidates — the planner does nothing while the
      signal-driven path mints an incident, so the lifecycle turns order-dependent.

      **Not reachable today**, which is why this is deferred rather than fixed in
      `refactor/capacity-guard-strip`: `schedulePlanRebuildFromSignal` has exactly one caller
      (`setup/powerSamplePipeline.ts`), inside the tracker ingest callback that runs after
      `saveState` and before the awaited rebuild, so the latch it reads is the sample just
      written — age ~0, `fresh`, and `measuredDrawKw` non-null too. The agreement is incidental
      (an ordering in another file) where it used to be structural (one `mainPowerKw` field
      served both callers). Moving that scheduler off the sample path, or adding a third caller,
      makes it live.

      Note which side changed: `mainPowerKw` was the raw latch, so `signalDriven` kept the old
      semantics and the planner moved to the gated reading — the planner is the correct side.
      The fix is not a one-liner: `latchedTotalKw` also feeds `resolveHardCapBreachFromSignal`,
      where the raw latch plus the `currentPowerW` fallback is the right input for a
      *scheduling* decision. Separate "what to schedule on" from "what decides an incident",
      then give `checkShortfall` one named resolution in its contract.

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

- [ ] **Fold the shortfall-alert staleness watchdog into `CapacityGuard`.**
      `setup/capacityShortfallAlertDispatch.ts:360-369` re-derives evidence staleness against
      `POWER_SAMPLE_STALE_THRESHOLD_MS` because `isConditionActive` resolves the tracker's
      latched total (`resolveLastTotalPowerKw`) with no freshness bound — consumer-side
      resolution the next consumer will have to copy. Resolve freshness where the total is
      resolved and delete the lane-local branch; the guard no longer holds power, so the
      predicate cannot live on it. **Now has a real owner:** the
      2026-08-16 planner-trusts-power change moved freshness resolution into `lib/power`
      (`sampleFreshness.ts` + `powerCycleReading.ts`), so the predicate belongs beside it rather
      than being re-derived a third time — `setup/homeSampledMeterIdentity.ts` hand-mirrors the
      same age math for a fourth. Source: 2026-08-02 release review,
      pels-layering-guardian. [P2]
- [ ] **Smart-task permission presentation: locked row hides its description; read-only row sits
      in "What PELS has learned".** While "May limit lower-priority devices" is gated off, its
      description is replaced by "Turn on 'May go over daily budget' to use this." so the owner
      can't learn what it does before granting the prerequisite (show both lines). On the task
      detail, the granted-permissions row renders inside the learned-inputs card; a permission is
      a setting, not something learned — move it beside the task inputs. Source: 2026-08-02
      release review, pels-ux-fit. [P2]
- [ ] **Devices list: "EXPLAIN" legend disclosure and "Flow-backed" chip are list-surface jargon.**
      *Persona:* new user on their first Devices visit.
      *Hypothesis:* the all-caps EXPLAIN toggle hides the icon legend a first-time user needs, and
      "Flow-backed" is wiring vocabulary on a list surface; an inline legend and a plainer chip
      ("Controlled by your Flow"?) would carry it. Source: 2026-08-08 device-page walk,
      pels-ux-fit. Files: `packages/settings-ui/src/ui/devices.ts`, `deviceListPresentation.ts`. [P2]
- [ ] **Activity log: collapse resume/turn-off alternation bursts.**
      *Persona:* owner reading the log after a windy evening.
      *Hypothesis:* consecutive-identical entries now collapse, but an A/B/A/B resume-vs-turn-off
      alternation within minutes still renders as 2N cards that read as malfunction; a paired
      collapse ("Tried to resume 5× in 4 min — not enough power") would tell the story in one row.
      Source: 2026-08-08 walk, pels-ux-fit finding 11 (remainder). Files:
      `packages/settings-ui/src/ui/views/DeviceLogView.tsx`. [P2]
- [ ] **Extract the shared device-detail render block from the three refresh paths.**
      *Persona:* next engineer adding a device-detail section.
      *Hypothesis:* `openDeviceDetail` and `refreshOpenDeviceDetail` duplicate a ~15-call render
      block (title, layout, live status, control states, shed, stepped, boosts, car, modes,
      visibility passes) that has already drifted cosmetically once and misses easily; one
      `renderDeviceDetailPanel(device)` called by both (with `refreshCurrentDeviceControlStates`
      keeping its deliberately lighter shed-refresh subset) removes the drift class. Pure
      refactor, no behavior change. Source: 2026-08-09 adversarial review. Files:
      `packages/settings-ui/src/ui/deviceDetail/index.ts`. [P2]
- [ ] **Move the hero/card power-fact grammar into shared-domain.**
      *Persona:* support reading logs against what the user saw.
      *Hypothesis:* `Reported N kW` / `≈ N kW when active` exist as two hand-mirrored literals
      (`views/PlanDeviceCards.tsx`, `deviceDetail/liveStatus.ts`) held equal by a comment; one
      shared-domain producer (like `resolveHeldCardReasonLine`) removes the drift class, and
      runtime logs could then reuse it. Source: 2026-08-08 stack review, pels-copy lens. [P2]
- [ ] **Consolidate the two device-modality resolutions the device-page train left behind.**
      *Persona:* next engineer touching device-detail predicates.
      *Hypothesis:* the draft-over-persisted `targetPowerConfig` merge lives in three sites
      (`deviceKind.ts` ×2, `deviceControlProfiles.ts`); one `resolveEffectiveTargetPowerConfig`
      retires the duplication and the `controlMode.ts` re-export shim with it. (The
      temperature-modality half of this item closed 2026-08-14 with the atomic temperature facet:
      both `liveStatus.ts` sites now key on `dev.temperature !== undefined`.) Source: 2026-08-08
      stack review, pels-layering-guardian. [P2]
- [ ] **Device page: first-run and prerequisite gaps the redesign exposed.**
      *Persona:* new user setting up their first devices.
      *Hypothesis:* four related holes — (a) an unmanaged EV buries Setup below two inert cards
      and the hero never says "Not managed — set up below"; (b) disabled Setup toggles carry no
      gate hint naming the prerequisite (Managed) while Budget exempt stays enabled beside them;
      (c) charge boost arms with no warning when the Car card above says the battery is never
      reported, so it can never fire; (d) the diagnostics intro caveats a Held-back card that is
      not rendered in the empty state. Source: 2026-08-08 stack review, pels-ux-fit. Files:
      `deviceDetail/sectionLayout.ts`, `index.ts`, `evBoost.ts`, `diagnostics.ts`. [P2]
- [ ] **Hero: state the smart-task deferral for temperature devices.**
      *Persona:* water-heater owner whose tank reads Off, 14 °C below target, smart task pending.
      *Hypothesis:* EV cards get a deferral state line ("Waiting for cheaper hours — done by
      HH:MM") from `resolveEvCardStateLine`; temperature smart-task devices have no equivalent, so
      the hero (and card) show Off with no why. A temperature counterpart in shared-domain closes
      the redesign's one remaining mystery-copy hero. Source: 2026-08-08 stack review,
      pels-ux-fit P1-3. [P2]
- [ ] **The e2e stub's Overview meta contradicts its own device draws.**
      *Persona:* reviewer reading a landing/docs capture top to bottom.
      *Hypothesis:* `homey.stub.js` plan meta claims `totalKw 1.5 / controlledKw 1.2` while the
      same snapshot's devices measure ~4.7 kW (water heater 2.1, Zaptec 1.38, heat pump 1.2) —
      on the real Overview the whole-home reading renders smaller than one device card beneath
      it. Fixing it cascades: specs assert the 1.5 = 1.2 + 0.3 arithmetic and every landing/docs
      capture re-renders with a different mood (higher draw flips the pace chips), so this is a
      deliberate follow-up seed-truth pass, not an inline fix. Source: 2026-08-09 pre-PR
      pels-ux-fit walk. [P2]
- [ ] **Advanced-diagnostics copy batch: jargon and robotic empties the populated captures exposed.**
      *Persona:* owner reading the Held-back details card on a calm device.
      *Hypothesis:* four small copy defects, one card — "No active service block" as Current
      reason is planner jargon (say what it means: nothing is holding the device back);
      "Restart backoff" surfaces a term `notes/ui-terminology.md` keeps internal with no
      advanced-surface carve-out; "Started: None" reads robotic; and "Resumed" actually renders
      the PREVIOUS episode's end (label it "Last resumed" so a Started/Resumed pair can never
      read as time running backwards). Files: `deviceDetail/diagnostics.ts`,
      `notes/ui-terminology.md`. Source: 2026-08-09 pre-PR pels-ux-fit walk; route through
      pels-copy-and-terminology. [P3]
- [ ] **A price-adjusted target gets no reason line on the hero or card.**
      *Persona:* owner seeing hero "target 25 °C" above a Home-mode row saying 21 °C during a
      cheap hour.
      *Hypothesis:* the solar lift has its explaining line ("Raised to use your solar power",
      `planTemperatureCardText.ts`) but the cheap-hour boost / expensive-hour reduction has no
      sibling, so the owner must reconstruct hero = mode + price delta themselves. A symmetric
      line ("Raised for cheap hours" / "Lowered for expensive hours"), sourced from the plan's
      price-adjust fact whenever plannedTarget diverges from the active mode target, closes the
      gap. Source: 2026-08-09 post-merge review, pels-ux-fit. [P2]
- [ ] **"Reported 2.1 kW" is mystery copy on the hero and Overview card.**
      *Persona:* owner reading the held water heater's power fact.
      *Hypothesis:* the qualifier marks the plan-holds-it-but-meter-sees-draw conflict, but
      "Reported" names neither the reporter nor the conflict; "Still drawing 2.1 kW" states the
      same fact in owner language. Shared generic-card grammar (`planCardGrammar` power fact +
      `liveStatus.ts` mirror) — change both surfaces or neither. Source: 2026-08-09 post-merge
      review, pels-ux-fit. [P3]
- [ ] **Charge-boost hint quotes its own field label mid-sentence.**
      *Persona:* EV owner reading "while the car's battery is below the Boost below level".
      *Hypothesis:* the hint embeds the field name "Boost below" as a noun phrase, producing a
      tongue-twister; "while the car's battery is below the level set here" (or renaming the
      field "Boost until battery reaches") reads naturally. Files:
      `packages/settings-ui/public/index.html` (charging card hint). Source: 2026-08-09
      post-merge review, pels-ux-fit. [P3]
- [ ] **Car card opens with an instruction there is nothing to act on.**
      *Persona:* EV-charger owner with no car app installed.
      *Hypothesis:* "Tick the cars that charge here…" renders directly above "No cars found" —
      a dead imperative; suppressing the intro (or ordering the empty-state line first) when the
      list is empty lets the empty state carry the card. Files:
      `deviceDetail/carAssociation.ts`. Source: 2026-08-09 post-merge review, pels-ux-fit +
      pels-m3-critic. [P3]
- [ ] **A satisfied thermostat reads "Running · 0.0 kW".**
      *Persona:* owner opening the bedroom thermostat at 22.8 °C over a 20 °C target.
      *Hypothesis:* owners read "Running" as actively heating; the satisfied-target case would
      read better as Idle, but the state word comes from the shared card grammar
      (`resolveDisplayStateKind` + `isSatisfiedTargetOnlyDevice`), so any change lands on the
      Overview card and hero together or not at all. Source: 2026-08-09 post-merge review,
      pels-ux-fit. [P3]
- [ ] **The hero's Smart task chip carries no status.**
      *Persona:* owner wondering whether the linked task is on track without tapping through.
      *Hypothesis:* the chip is a bare route badge; a short status tail (the smart-task list's
      own status word, e.g. "Smart task · on track") would answer the question in place, using
      `resolveSmartTaskListStatus` so the surfaces cannot disagree. Files:
      `deviceDetail/liveStatus.ts`. Source: 2026-08-09 post-merge review, pels-ux-fit. [P3]
- [ ] **"Disable temperature control" is Setup's only negative-phrased toggle.**
      *Persona:* owner scanning Setup where every other switch is positive.
      *Hypothesis:* ON = less capability amid five positive toggles; flipping it to "Temperature
      control" (default on) reads naturally but inverts a persisted setting's meaning — needs a
      migration story for the stored map, so it is a deliberate follow-up, not a rename.
      Source: 2026-08-08 stack review, pels-ux-fit. [P3]
- [ ] **Split temperature boost out of the stepped-profile card.**
      *Persona:* water-heater owner flipping boost seasonally.
      *Hypothesis:* the 2026-08-08 IA spec gives temperature boost its own switch-headed card (it is
      the routinely-flipped behavior toggle, invisible inside the dense profile card); the train
      landed the ordering but kept boost inside the profile card. Files:
      `packages/settings-ui/public/index.html`, `deviceDetail/temperatureBoost.ts`,
      `deviceDetail/sectionLayout.ts`. [P3]
- [ ] **`formatHoursBeforeDeadline` rounds the safety margin in the flattering direction.**
      `packages/shared-domain/src/deadlineLabels.ts:2421`: "projected ready ≈ 18:00, 2 hours
      before the deadline" against a 19:40 deadline overstates a 1 h 40 min margin via
      `Math.round`; this release's shortfall resolver ceils for exactly the opposite reason.
      Floor the hours or render "1 h 40 min". Source: 2026-08-02 release review, pels-ux-fit. [P2]
- [ ] **Two different sentences for the same blocked-resume state can appear on one screen.**
      On/off cards say "Not enough available power to resume — N kW more needed"
      (`packages/shared-domain/src/planReasonFormatting.ts:505`) while temperature/stepped cards
      say "Waiting to resume — N kW more needed" (`planTemperatureCardText.ts:118`). Converge on
      one sentence. Source: 2026-08-02 release review, pels-ux-fit. [P2]
- [ ] **Two disabled-dim languages in the stylesheet: raw `opacity: 0.38` beside
      `--opacity-disabled: 0.5`.** `packages/settings-ui/public/style.css:8367` (gated switch-row
      label) and the older 3049 use raw 0.38 while four other sites use the token. Promote 0.38 to
      a token or reconcile with `--opacity-disabled`, and use it in both spots; opacity is not in
      the stylelint gate, which is why CI admits it. Source: 2026-08-02 release review,
      pels-m3-critic. [P2]
- [ ] **Three new UI states have no screenshot-harness coverage.** The Main-meter conflict banner
      (`HomesSettingsSection.tsx:384`), the smart-task editor-open permissions disclosure, and the
      armed rescue chip with its granted-permissions line could only be reviewed by primitive
      analogy. Add a `conflict` state to `homes-management-screenshots.spec.ts` and an editor-open
      state to the smart-tasks capture harness. Source: 2026-08-02 release review,
      pels-m3-critic. [P2]
- [ ] **Copy nits from the v2.19.3→next release review.** (a) "Clear this device's active Smart
      task…" (`packages/settings-ui/public/index.html:1079`, sibling at 1089) capitalizes
      mid-sentence "Smart task"; canonical form is lowercase. (b) The `allow_smart_task_rescue`
      dropdown option `at no time` composes to "Allow … to go over today's budget at no time" —
      an Allow-sentence whose payload is a revocation; consider `at no time (turns this off)`.
      (c) `deadlineLabels.ts:1799` "a useful capacity, or a recent observation" leaks
      profile/observer vocabulary into heater help text (verify the line is in-range before
      editing). Source: 2026-08-02 release review, pels-copy-and-terminology. [P2]
- [ ] **docs/weather-insight.md still says auto-apply "replaces" the budget each day.** Since
      8ec444cd8 auto-apply is asymmetric: it skips `would_lower_while_limiting`, so it will not
      lower a budget the home has been running past. Add the one-line caveat to the
      "Auto-applying the suggested budget" section. Source: 2026-08-02 release review, docs
      freshness pass. [P2]
- [ ] **Widget doc screenshots are stale; the harness that refreshes them is never run.**
      `docs/public/screenshots/widgets/*.png` were captured 2026-07-03 (two on 2026-06-01), but
      `widgets/*/public/index.js` changed in 7abfcfaba (2026-08-05, which rewrote the held-card
      copy), 42834e1bd (2026-08-07) and d0cab7bc3 (2026-08-09), so the held-back and smart-task
      images show retired copy. `npm run docs:widget-screenshots`
      (`scripts/build-doc-widget-screenshots.mjs`) regenerates all ten from the real built widget
      and needs no Homey, but it is documented as "run locally (not in CI)" and nothing prompts it
      — so widget copy changes ship without it. Re-run it, and give it the same
      change-triggered prompt the settings-UI captures get. Source: 2026-08-10 docs/screenshot
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
- [ ] **The displayed restore shortfall omits live startup reservations.** When a
      higher-priority startup reservation (`headroomReserve`) is active, non-swap stepped
      rejections and binary batch continuations build their reason from the RAW headroom margin,
      so `resolveRestoreShortfallKw` renders a gap that ignores the reserved power — freeing the
      shown amount still leaves the device blocked until the reservation lapses. Bounded by the
      reservation window, and the direction is the same understatement class the 2026-08-01
      shortfall fix removed for the reserve stack. Fix: fold the live reservation into the
      structured reason's margin at the producing gate (same resolution-in-producer pattern).
      *Persona:* owner reading "X kW more needed" while a scheduled device holds its startup
      reservation. *Hypothesis:* rare overlap (reservation + blocked non-swap restore), self-heals
      within the window. Source: Codex review on PR #1954, 2026-08-02. [P2]

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
      planner cuts deeper than the real deficit needs. The complete fix compares the realised drop
      against the relief actually credited for the devices shed last cycle, and only escalates when
      the drop falls short — bigger than this hold because it needs per-device credited relief
      carried across cycles. Field case: 2026-08-01, hard cap 3.0 kW, total 4.351 kW; #4 shed at
      11:03:44 credited ≥1.81 kW but realised ~1.08 kW; the 11:03:54 repeat then took both #2 and
      the user's #1. Persona: the owner who ranked their priority list and expects #1 to survive;
      hypothesis: "PELS ignores my priorities" when it is really over-cutting on a stale total. [P2]

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
- [ ] **The immediate hard-cap alert's authority-fence retry loops at 1 Hz with no bound.**
      `setup/capacityShortfallAlertDispatch.ts` re-schedules `releaseDeferred` every second while
      `isTemporarilyFenced()` holds, and for a sub-home that fence includes `!isMembershipReady()` —
      an explicitly long-lived, operator-visible state ("pinned members are uncontrolled until the
      zones API recovers", `setup/homeRuntime/homeCapacityBundleReadiness.ts:185-196`). Under a
      degraded zones API the retry runs for the whole incident at 10× the sustained lane's cadence.
      Pre-existing (the behaviour predates the sustained card; only the file name changed), and
      cheap in absolute terms, but it should either back off or give up with a logged reason.
      Source: `pels-runtime-reality` review of the sustained hard-cap card, 2026-08-01.
- [ ] **`homeCapacityBundleApi.ts` justifies two placement decisions with a `max-dependencies`
      ceiling that is not binding.** Its header comment and the block at ~`:220` both say code lives
      there because "`createHomeCapacityBundle.ts` sits at its 20/20 `import-x/max-dependencies`
      ceiling". Measured against the real rule (`eslint.config.mjs:689`, `max: 20`,
      `ignoreTypeImports: true`) that file has 17 value dependencies — three slots of headroom.
      Correct the number or state the real reason (teardown lives here), so the next author does not
      launder code into the file on a constraint that does not exist.
      Source: `pels-layering-guardian` review of the sustained hard-cap card, 2026-08-01.

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

- [ ] **Budget-exempt restores are still blocked by the global restore gate while the house is
      over the budget-derived pace.** Per-axis admission (2026-08-01) lets an exempt candidate
      admit against capacity once the restore pass RUNS, but `shouldPlanRestores` still keys on
      the BINDING headroom: with unmanaged load pushing the house over a daily-bound pace
      (prod 2026-08-01 evening: 4.1 kW against a 0.5 kW pace, capacity pace ~19 kW), no restore
      pass runs at all and the exempt EV/heater stays held even though capacity has room and its
      draw would not count toward the budget. Extending the gate needs care: `activeOvershoot`
      keys the shed window, restores-during-overshoot interact with the 60 s shed cooldown, and
      the exempt-only pass must not resurrect churn. *Persona:* daily-budget home cooking dinner
      while the exempt EV waits with a deadline. *Hypothesis:* the deadline-reserve/rescue lanes
      mostly paper over this today; fix deliberately, not as a rider. Source: per-axis-admission
      review 2026-08-01. [P2]

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

- [ ] **`budgetReleasableHeadroomHold` does not check that lifting the budget would actually admit
      the candidate.** The flag is plan-wide (daily pace binding + fresh power + no capacity
      breach), so in the band where capacity sits between the budget pace and the candidate's
      restore need (e.g. capacity pace 5 kW, draw 4 kW, daily pace 4.5 kW, need 1.2 kW), the
      held-back widget offers "Let it run now" but the release still leaves the restore blocked on
      the capacity axis — a dead lever in exactly the shape the 2026-07-25 breach carve-out fixed
      for the breached case. A per-candidate variant needs the device's restore need against the
      capacity axis (available since the per-axis admission change). *Persona:* daily-budget home
      near its capacity pace tapping the rescue. *Hypothesis:* narrow band, self-heals as pace
      moves; the rescue is inert rather than harmful. Source: Codex review on PR #1953,
      2026-08-02. [P2]

- [ ] **A carried-forward `dailyBudget` hold keeps its budget-releasable framing through a
      stale-meter window.** `dailyBudget` is a sticky reason (`shouldNormalizeReason` never
      normalizes it back, and the diagnostics fold maps `insufficient_headroom → daily_budget`
      but never the reverse), so in cycles where the restore pass does not run (restore cooldown,
      `sheddingActive`, startup stabilization) while the meter is `stale_hold`/`stale_fail_closed`,
      a device labeled `dailyBudget` in the previous fresh cycle keeps the label and the widget's
      "Let it run now" offer — the exact state the `budgetReleasableHeadroomHold` doc says must
      stay capacity-bucketed. Bounded (≤300 s restore cooldown per episode; longer under
      `power_source=flow` sparse events) and the rescue action is inert until power is fresh, so
      P2 not P1. Candidate fix: normalize a carried `dailyBudget` hold back to the headroom
      framing when `powerKnown` is false. Source: pels-runtime-reality on the 2026-08-01
      budget-hold re-attribution. [P2]

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

- [ ] **The browser runs the uncached date-formatter path.**
      *Persona:* owner (`notes/personas.md`) on the settings UI, where chart and plan rendering
      formats many timestamps per view.
      *Hypothesis:* `lib/utils/dateUtils.ts` and `packages/shared-domain/src/utils/dateUtils.ts`
      are a sanctioned twin pair (settings-UI cannot import `lib/` — dep-cruiser
      `no-settings-ui-to-runtime`), but they have DRIFTED: the runtime copy caches its
      `Intl.DateTimeFormat` instances — the 2026-05 fix for what a CPU profile showed as 60% of
      plan-build cost — and the shared-domain copy does not. The browser therefore constructs a
      formatter per call. The shared-domain copy also carries `formatDayFirstInTimeZone`, which
      the runtime copy lacks, so the drift runs both ways.
      *Why it's needed:* the same ICU construction cost that dominated plan-build is being paid
      in a WebView on a phone. No sync script or CI check enforces the twins' parity, so the
      drift is invisible until someone diffs them. Source: knip blind-spot fix, 2026-08-07. [P2]

- [ ] **`packages/contracts` is in the knip blind spot that `shared-domain` just left.**
      *Persona:* contributor (`notes/personas.md`) trusting `deadcode:check` to catch dead
      exports.
      *Hypothesis:* `knip.json` declares `packages/contracts` with `entry: ["src/**/*.ts"]`, so
      every file is an entry point and no unused export there can ever be reported — the exact
      defect fixed for `shared-domain` and `widgets/` on 2026-08-07. Emptying that entry list
      surfaces ~31 candidates, mostly `settingsKeys` / `settingsUiApi` constants.
      *Why it's needed:* the fix is one config line, but the triage behind it is a real pass —
      contracts is the runtime↔UI seam, and a "dead" export there may be a wire field a
      consumer reads dynamically. Source: knip blind-spot fix, 2026-08-07. [P3]

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

- [ ] **Test fixtures still describe plan reasons as prose.** The regex layer left production on
      2026-08-07 — `packages/shared-domain/src/planReasonParsing.ts` is gone and the grammar now
      lives in `test/utils/planReasonFixtureParser.ts`, so it can no longer bend production types
      (it had been holding `insufficient_headroom`'s four admission fields nullable). What remains
      is ergonomic: ~460 fixtures still write `reason: 'shed due to capacity'`, so a copy change to
      a reason template is a silent parse miss in a fixture rather than a type error. Convert them
      to reason objects tier by tier and delete the fixture grammar.
      *Persona:* maintainer (`notes/personas.md`) changing reason copy.
      Source: 2026-08-01 budget-hold copy investigation; narrowed 2026-08-07. [P2]

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

- [ ] **`lib/device/evCarLinkProducer.ts` is over the 500 LOC cap.** It accumulated nine rounds of
      correlation rules (edges, settle, contention, sessions, self-stop, shadow, membership). The
      natural seam is session lifecycle (`resolveSession` / `resolveColdStartSessions` /
      `resolveUnexplainedSessions` / `clearSession*`) versus observation ingest, which barely share
      state beyond `activeLinks`. Source: CodeRabbit on PR #1895. [P2]

- [ ] **"Leave off until turned on again": sub-home plan paths are not driven by hold changes.**
      Three related gaps, all multi-home-only and all with the same shape — the hold store is
      shared across homes but the plan paths are not, so a sub-home keeps a stale
      `inactive/external_off_hold` plan until an unrelated sample or rebuild reaches it (which
      in flow mode can be a long wait):
      (a) realtime observed-state settlement (`setup/appServiceWiring.ts`) invokes only the MAIN
      `ctx.planService`, so a sub-home bundle's pending ON stays active past its confirmation and
      a genuine off inside the 15 s/75 s window is misread as PELS's;
      (b) a sub-home ON event reaches `scope.getPlanDevices()`, whose pre-pass releases the hold
      before `syncExternalOffHoldForDevice` sees it, so the detector reports `none` and no release
      rebuild is scheduled for that bundle;
      (c) the `respect_external_off_devices` settings handler rebuilds only main after
      `releaseDeOptedHolds()`, ignoring the returned device ids.
      Fix together: route settlement to the owning bundle, and use the released ids to rebuild
      each owning home. Single-home installs — the overwhelming majority — are unaffected.

- [ ] **"Leave off until turned on again": a release is lost if the store never recovers.**
      `clearHold` during an unreadable-state window records a tombstone, but deleting from the
      empty in-memory map returns false, so no pending write is retained. If the read stays broken
      for the full `EXTERNAL_OFF_HOLD_LOAD_GRACE_MS`, grace expiry stops further reloads without
      reconciling the tombstone, and a restart can reload the stale persisted hold and strand a
      device that was already released. Keep unresolved clears pending until they can be applied
      durably. Needs a five-minute total settings outage to reach.

- [ ] **"Leave off until turned on again": UI write can resurrect opt-ins cleared elsewhere.**
      `writeFreshSetting` skips `readFresh` for nullish values, so when another WebView or the
      Homey API UNSETS `respect_external_off_devices`, a toggle made before the realtime reload
      lands mutates the stale in-memory snapshot and writes the cleared opt-ins back. Distinguish
      a resolved-absent setting from an unavailable read before applying the fallback snapshot.

- [ ] **"Leave off until turned on again": the smart-task warning goes stale.**
      `reloadObjectivesIfObjectiveKey` updates `state.deferredObjectiveSettings` but neither
      refreshes the open detail controls nor emits `devices-updated`, and the `plan-updated`
      handler refreshes only live status and diagnostics. A task created, disabled, or cleared
      from another WebView therefore leaves the switch's "a Smart task may not finish on time"
      hint showing the previous state — the user can enable the switch without the warning, or
      keep seeing it after the task is gone. Refresh the open detail after the objective reload.

- [ ] **"Leave off until turned on again" is missing from Advanced → Clear device data.**
      `collectDeviceIdsFromSettings`, `clearDeviceSettings`, and `clearMultipleDeviceSettings`
      (`packages/settings-ui/src/ui/advanced.ts`) neither enumerate nor clear
      `respect_external_off_devices`, so clearing a device leaves the flag (and any persisted
      hold) behind, and a deleted device known only through this map is never offered by
      "Clear unknown devices". Re-adding the device silently reactivates the old behaviour.

- [ ] **"Leave off until turned on again" only STARTS a hold from a push-delivered off.**
      Detection runs at the realtime-reconcile gate (`setup/externalOffHoldDetection.ts`), so it
      fires on `realtime_capability` / `device_update` observations. A full snapshot refresh does
      not dispatch `observed_control_state_changed`, so an outside-off discovered only by a pull (live feed down
      for the whole window) starts no hold and the device is managed as usual. Deliberate for v1 —
      a pull cannot distinguish "the user just turned it off" from "PELS turned it off before the
      last restart", which is the cold-start ambiguity the spec refuses to guess at. Revisit only
      with a way to date the observation against the last PELS command. NOTE the RELEASE side is
      deliberately not symmetric: it sweeps the pull path every plan cycle
      (`releaseExternalOffHoldsForObservedOn`), because a missed release strands a device off
      whereas a missed detection merely means normal management. Persona: cabin owner on a flaky
      connection; hypothesis: they toggle the heater at the panel, the live feed is down, and PELS
      keeps managing it. Source: PR-1 implementation of the external-off hold (2026-07-25).

- [ ] **Thin `deviceDetail/index.ts` with a table-driven Setup-control registry.** The file is the
      device-detail orchestrator and sits at a documented 505-line ceiling (raised from the 500
      default by the "Leave off until turned on again" row). Every new per-device setting costs it
      an import, a handler registration, and a reflect call, so the next one breaches it again. The
      registrations are uniform enough to become a table of `{ sync, init }` entries iterated once.
      Persona: contributor; hypothesis: the next settings feature stalls on an unrelated lint
      ceiling and gets a second ad-hoc raise. Source: PR-2 of the external-off hold train
      (2026-07-25).

- [ ] **Show the budget-exempt carve-out on the Overview hero instead of hiding it in the number.**
      The hero power bar's x-axis is total metered power, which is the natural axis for the cap
      pace and the wrong axis for the budget pace (whose subject is the house minus the exempt
      slab). Today the mismatch is papered over by rebasing the budget pace (`+ exemptKw`), which
      is why the number moves for a non-budget reason. Direction: pull exempt devices out as a
      leading sub-segment of managed, so the bar reads `[exempt][managed][background][free]`, and
      draw the budget tick at `exempt + budgetNet`. "Over budget" then reads as "everything right
      of the exempt slab exceeds the tick", which is literally the predicate, and the tick
      position explains itself. Gate on `exemptKw > 0` so the default hero is unchanged.
      Prerequisite: settle the axis. The bar total is net grid import
      (`lib/power/sampleIngest.ts:113-123` keeps the cap path and the kWh bucket on net) while
      per-device `exemptKw` is gross appliance draw, so on a solar home the slab can exceed the
      bar; decide whether the hero axis is net (slab needs a clamp with a visible treatment) or
      gross (cap tick no longer sits on the axis the cap meters). Since per-axis restore
      admission (432737799), an exempt candidate is evaluated against the capacity axis only —
      the old `min(capacitySoftLimit, dailySoftLimit)` gate no longer applies to it, and the
      rewritten `lib/plan/planReasons.ts` comment says so — so presenting "available power" as
      cap-scoped is now admission-accurate for an exempt device. The one residual budget
      influence on an off exempt device is the global `shouldPlanRestores` gate, which has its
      own P2 entry; don't re-derive a per-device budget hold from the hero. Depends on
      the P1 reason-line copy fix and on `plan.meta` carrying the un-rebased pace + exempt kW.
      Rejected alternative: two permanently visible pace ticks (three ticks at 320 px, with the
      cap tick already mandatory, for a state most homes never enter). Persona: skeptical
      optimiser during a boost. Hypothesis: a bar that shows the carve-out is trusted where a
      jumping number is not. Source: safe-pace model review (2026-07-26); design in
      `notes/safe-pace-two-constraints.md` and `notes/overview-hero-spec.md`.
- [ ] **The area name rules are implemented twice in one package.**
      `packages/shared-domain/src/homeAreaConfigRules.ts` (`findHomeAreaNameRejection`, the
      enforcement) and `homesManagement.ts` (`validateDraftName`, the editor's inline check) each
      implement trim, non-emptiness and case-insensitive uniqueness, with different result kinds
      (`name_required` vs `name_missing`). Two answers to one question, and the editor-guidance item
      below would add a third. `validateDraftName` should delegate to `findHomeAreaNameRejection` and
      map the rejection into `SubHomeDraftError`. Held out of the enforcing PR: the mapping needs new
      `SubHomeDraftError` kinds and `composeDraftErrorLine` branches in files a concurrent branch owns.
      Same edge: `validateDraftMeter` (`homesManagement.ts`) still hand-spells `'Main home'` for its
      `meter_in_use` payload, while the reserved-name rule now reads it from
      `HOME_LIMITS_MAIN_HOME_OPTION` — point that one at the constant too, so a rename cannot leave
      the two disagreeing. Persona: contributor changing a name rule (or the Main home's label) in one
      place only. Source: multi-home finishing train, area-config invariants PR. [P2]

- [ ] **Area rules refuse on save instead of guiding in the editor.** The name-length cap, the
      reserved "Main home" name, the eight-area cap, and the whole-home-meter requirement are
      enforced at the `ui_homes_save` seam and surface as a toast after a round trip; only
      non-emptiness and uniqueness are pre-checked inline by `validateSubHomeDraft`. The editor
      should carry a `maxlength` on the name input, an inline error for the reserved name, a
      disabled "Add meter area" button at the cap, and an inline main-meter refusal from the
      `shouldPromptMainHomeMeter` predicate `homesSettings.ts` already evaluates for the notice.
      Held out of the enforcing PR because `SubHomeDraftError` and `HomesSettingsSection.tsx` were
      owned by a concurrent branch; the server rules were deliberately scoped to the entry being
      written so `validateDraftName` can absorb them unchanged (see the duplication item above, which
      this shares a fix with). Persona: owner who types a long or reserved name and only learns on
      save. Source: multi-home finishing train, area-config invariants PR. [P2]

- [ ] **A one-meter home can cycle between two meter-area refusals with no diagnosis.** An area needs
      its own meter and the Main home needs its own, so a home whose Homey Energy report lists a
      single meter cannot use meter areas at all. Today it discovers that by bouncing: saving an area
      refuses with `main_meter_required`, assigning that one meter to the Main home makes the area
      editor refuse inline with "'Main home' already uses this meter", and going back to Automatic is
      allowed again because nothing was persisted. The rules are each correct; what is missing is the
      one line that says the home has no second meter to split. Detect "no report meter is assignable
      to the Main home" on the Multiple meters page and say so. Overlaps the empty-meter-list hint
      item above. Persona: owner with a single HAN meter who tries to add a rental. Source: multi-home
      finishing train, area-config invariants PR. [P2]
- [ ] **`isMeterSourceAuthorizedForExecution` is a query that performs a command.** In
      `setup/homeRuntime/createHomeCapacityBundle.ts`, a predicate named `is…Authorized` calls
      `scheduleSourceActuationRetry()` — registering a timer that later runs `rebuildPlanFromCache`,
      and mutating the back-off attempt counter. Merely ASKING whether the
      source is authorized therefore schedules device writes. PR 5a hit this: the per-home read seam
      resolved `dryRunEffective` through the scope and armed recovery from a UI read. The fix there
      forked the source predicate (`resolveEffectiveDryRun` takes it as a parameter; control passes the
      execution one, reads pass the registry's raw one) — but both are structurally identical
      `() => boolean`, so the split now rests on comments telling future callers which to pass, and the
      compiler cannot help. Two candidate fixes: (a) brand the two predicate types nominally so passing
      the wrong one is a type error, or (b) **preferred** — move the recovery arming out of the query and
      into the actuation fence that actually needs it, which makes every read path safe by construction
      rather than by convention. *Persona:* contributor adding any new read of a bundle's effective
      dry-run state. Source: adversarial + layering review of multi-home PR 5a, 2026-07-26.

- [ ] **Move the capacity scalar block to the shared-utils layer so `lib/home` stops duplicating it.**
      `HomeRuntimeCapacityScalars` (`lib/home/homeRuntimeRead.ts`) is a hand-kept structural duplicate of
      `CapacityScalarSettings` (`lib/power/capacitySettingsStore.ts`): `lib/home` is a leaf domain and
      `no-home-to-peer` (severity ERROR) forbids reaching `lib/power`, so the read port cannot import the
      real type. The drift is asymmetric and the dangerous direction is the silent one: REMOVING or
      retyping a field in `CapacityScalarSettings` fails the build, but ADDING one does not — the producer
      spreads the concrete block (`homeCapacityBundleApi.ts`, `capacityScalars: { ...getScalars() }`) and a
      spread is exempt from excess-property checking, so the new field ships in the read payload while
      staying invisible in the port contract. That is a silent payload widening, not a silent omission, so
      the eventual fix must guard the contract rather than the carrying. The repo already
      solved this exact pair once: `HomeId` lives in `lib/utils/settingsKeys.ts` precisely so the capacity
      store and the home domain share ONE identity type without a peer import (see that file's own comment).
      Do the same for the three-field scalar block and re-export it from `capacitySettingsStore.ts`, then
      delete the duplicate. Persona: contributor extending capacity settings, who has no signal that a second
      declaration needs widening. Source: adversarial design review of multi-home PR 5a, 2026-07-26.

- [ ] **Persisted-store load grace only postpones a destructive reset.** `loadPowerCalibrationStore`
      (and the EV car-link store that mirrors it) run exactly once at init. When that read is
      transiently absent/malformed/throwing for an existing install, the store starts empty and the
      grace merely blocks writes for five minutes — nothing ever re-reads the recoverable value, so
      the first accepted mutation after the grace overwrites the real history with the empty-derived
      state. Related: the store stays dirty when a write lands inside the debounce or fails, and only
      another mutation or shutdown retries it, so accepted state can sit memory-only indefinitely and
      be lost on an unclean restart. Re-read and merge persisted history before enabling the first
      post-grace write, and schedule a retry when the gate expires or a write fails. Found by Codex on
      PR #1895 against the EV car-link store; deliberately NOT fixed there because it describes the
      shipped calibration-store pattern that store was modelled on, so the fix belongs where the
      pattern lives. Persona: any user whose Homey has a slow/flaky settings read at boot; hypothesis:
      silent loss of learned calibration is far worse than a delayed first write. See
      `notes/persisted-settings-state.md`. [P2]

- [ ] **Two EV car-link edge-lifecycle holes, both deferred from PR #1895 as design decisions.**
      (a) *Ambiguity is not durable.* Car and charger edge rings are pruned independently, so an
      ambiguous group can later become a unique match: with charger edges at t=0 and t=160 s and a
      car edge at t=80 s both chargers are reported ambiguous, but once the t=0 edge expires while
      the other two survive, the next pass awards the remaining pair a vote — contradicting the
      no-vote verdict already emitted. Either consume ambiguous groups or retain the verdict until
      every related edge has expired. (b) *Charger membership is never pruned.* When a charger
      leaves the committed view neither `lastChargerState` nor its `activeLinks` entry is cleared,
      so a charger returning under the same Homey id is diffed against its pre-removal baseline
      (manufacturing a plug edge), or keeps attributing the new session to the car that left. The
      reason this is not a one-line prune: the view builder already drops a charger whose plug
      state is momentarily unreadable, so this seam cannot tell "removed from Homey" from
      "temporarily unreadable", and pruning naively would churn sessions on every transient gap.
      Wants a membership signal that survives an unreadable capability. Both corrupt probe
      EVIDENCE only — nothing reads these events. Persona: two-car household whose affinity map
      the probe is meant to learn; hypothesis: a vote that contradicts an ambiguity already
      reported makes the whole log untrustworthy. [P2]

- [ ] **`runtimePackaging` contract-import detector false-positives on prose.** The regex in
      `test/integration/runtimePackaging.test.ts` is not line-anchored, so the bare word "import"
      inside a docblock matches and `[\s\S]*?` runs on into the next real declaration — flagging a
      pure `import type` as a value import. Hit while adding `lib/device/evCarLinkWiring.ts`
      (2026-07-26); worked around by rewording the comment. Anchor the pattern to a line start so
      the guard stops depending on comment wording. Left out of that PR to avoid loosening a
      packaging guard in the same change that needed it to pass. [P2]

- [ ] **`pels_status` blobs (bare and suffixed) are object-guarded, not field-resolved.** Both
      `getSettingsUiPower` (`setup/settingsUiApi.ts`, main's unsuffixed read) and `readSubHomeStatus`
      (`setup/settingsUiHomeScope.ts`, the `pels_status:<id>` read PR 5b added with deliberate precedent
      parity) check object-ness and then assert the full `SettingsUiPowerStatus` shape — closed unions
      (`powerFreshnessState`) and numbers included. *Persona:* contributor debugging a WebView that
      renders nothing for a status field after a partial/corrupt settings write. *Hypothesis:* a
      malformed blob (e.g. `powerFreshnessState: "garbage"`, `headroomKw: "3"`) flows inward typed as
      the closed union / number, matches no branch, and the surface silently drops the field with no
      log — the AGENTS.md boundary rule ("finiteness-gate numbers, shape-guard objects") says the
      producer should classify it instead. Extract one field-level status resolver (the
      `asRecord` + `toFiniteNumber` pattern `managerEnergy.ts` cites) and use it from both readers. P3.
      Source: adversarial review (typing lens) of multi-home PR 5b, 2026-07-27.

- [ ] **Meter picker hint invites an impossible pick when no meters are listed.** When the Homey
      Energy report exposes no id-carrying whole-home (cumulative) meter and no sensor-class device
      meter, the Whole-home meter select shows just "Automatic" while the always-visible hint still
      says "pick a meter to read it directly." Soften the hint to the Automatic-only case when the
      loaded option list is empty (needs a small conditional in homeyEnergyMeter.ts, since the hint
      is static markup today). Persona: Power-meter user with a single tracked meter; hypothesis:
      an instruction to pick from an empty list reads as something being broken. Source: pels-ux-fit
      review of the meter-picker PR (2026-07-19). [P2]

- [ ] **Make the strict sub-home tracker validator compile-time exhaustive.**
      `isPlausiblePowerTrackerState` validates every current `PowerTrackerState` field and nested
      objective-profile value, but its independent key arrays do not make TypeScript reject a future
      tracker field that is omitted from validation. Replace them with an exhaustive validator table
      using `satisfies Record<keyof PowerTrackerState, ...>` (while preserving the main tracker's
      compatibility-read policy). Source: tracker-contract review of PR #1872, 2026-07-23.

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

- [ ] **A task paused by PELS's OWN managed-device demotion points the owner at a disabled switch.**
      *Persona:* owner whose smart-task device stops reporting a power capability. *Hypothesis:*
      `applyFalseOverrides` (`setup/appDeviceSupport.ts:365`) writes `managed: false` for
      `fullyUnsupportedIds` with no user in the loop, and `resolveSmartTaskDeviceExclusion`
      (`setup/appInit/smartTaskHomeScope.ts`) cannot tell that from an owner's toggle — so the task
      renders `SMART_TASK_DEVICE_UNMANAGED_RECOURSE` ("Turn on Managed by PELS in Setup…") while the
      device list disables that very switch (`packages/settings-ui/src/ui/devices.ts`, gated on
      `manageability.canManage`). Narrow today: it needs a smart-task-capable device reporting
      `powerCapable === false`. Add a third `ObjectiveDeviceExclusion` arm for the auto-demoted case
      with copy that names the capability, or drop the recourse line when the toggle is inoperable.
      Done when a task on an auto-demoted device shows a cause that does not point at a control the
      owner cannot use. P3. Source: layering + copy lenses on the un-managed pause PR, 2026-08-23.

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

- [ ] **Sub-home per-poll CPU scaling: decorate once per poll instead of per-bundle.**
      *Persona:* multi-home owner on a busy Homey with several sub-homes. *Hypothesis:* `latestTargetSnapshot`
      re-runs `getSnapshot()` + full `decorateTargetSnapshotList` on every access, and every bundle's
      `getPlanDevices` (+ `createHomePowerPipeline.getLatestTargetSnapshot`) reads it and only then
      `filterDevicesForHome` — so an N-device home with M sub-homes does ~M+1 full-set re-decorations plus M
      independent plan builds bunched on the same 10 s poll tick (`routeMeterReadings`), risking
      cpuwarn-watchdog pressure. Decorate once per poll and hand each bundle its pre-filtered partition (or
      filter the RAW snapshot to the home's ids before decorating), and consider staggering bundle rebuild
      phases. Correctness is unaffected; this is a perf/maintainability follow-up deferred out of the R7b
      correctness PR. Source: R7b per-poll CPU-scaling audit, 2026-07-19.
- [ ] **`home_membership_store_read_suspect` WARN can fire on installs that never used multi-home.**
      *Persona:* single-meter owner with no `homes_config` who hits a transient Homey SDK settings-read
      failure. *Hypothesis:* now that multi-home is GA (the `multi_home_enabled` flag is gone), membership
      recompute reads `homes_config` / `device_home_assignments` on every observed-state refresh, so a
      genuinely `suspect` (thrown) read emits an edge-triggered WARN `home_membership_store_read_suspect`
      mentioning multi-home even though the owner never configured a meter area. Benign (keeps the empty
      all-main cache; edge-triggered, not a storm) and only on a real SDK throw, but it is a false-signal log
      for a feature the install isn't using. Topic-gate it, or only warn once the store has ever been
      `present` (an initialized marker exists). Source: pels-runtime-reality review of the multi-home GA cut,
      2026-07-22. File: `setup/homeMembership.ts` (`noteSuspectEdge` / `refreshStoreCaches`).
- [ ] **Two `MainMeterSelection`/power-source seams fabricate `state: 'resolved'` when their resolver is
      absent.** *Persona:* maintainer wiring a new call path into membership or snapshot refresh.
      *Hypothesis:* three seams fabricate an authoritative selection when their optional resolver is missing.
      `HomeMembershipService.readActiveMeterPowerSource` falls back to
      `?? { state: 'resolved', value: 'homey_energy' }` when the optional `getConfiguredPowerSource` dep is
      omitted; `AppSnapshotHelpers.resolveMainMeterSelection` falls back to
      `?? { state: 'resolved', meterDeviceId: null }` when its resolver is unbound; and
      `fetchLivePowerReport` ends its `mainMeterSelection ?? getHomeyEnergyMeterSelection?.() ??` chain on the
      same fabricated `resolved`/Automatic literal. All three claim the STRONGEST authority at seams whose
      entire purpose is to fence control when authority is unknown; every other path in those modules fails
      closed on `unavailable`. No live bug is proven (the power-source dep is always passed by
      `createHomeMembershipService`, and the snapshot resolver is bound at
      `setup/appInit/wireDeviceTransport.ts` `bindHomeyEnergyMeterResolver`), but the optional-with-fabricated-default shape means a wiring path that
      omits one silently claims authority instead of fencing, and it is now repeated three times. Note that
      `mainMeterSelection` is optional at EVERY level of the `refreshSnapshot` →
      `resolveLivePowerForRefresh` → `fetchLivePowerReport` chain, so the fabricated literal is reachable by
      simply not threading it. Make the deps required and let tests pass explicit stubs. Verified NOT a defect
      while auditing: an `unavailable` selection forces `homePowerW: null`
      (`snapshotRefresh.ts` `fetchLivePowerReport`), so `updateHomePowerFromReport` returns null and
      `recordImplicitHomeyEnergySample` writes nothing — `sameMainMeterSelection` treating
      `unavailable === unavailable` as equal only suppresses a debug log, and needs no change.
      Source: multi-home boundary-hygiene audit of the GA train, 2026-07-25. Files:
      `setup/homeMembership.ts`, `setup/appSnapshotHelpers.ts`,
      `lib/device/transport/snapshotRefresh.ts` (`fetchLivePowerReport`).
- [ ] **Hoist `createSelectOption` (and the render-signature guard pattern) out of `advanced.ts` into a
      shared settings-ui primitive module.** *Persona:* maintainer adding the next dynamic device picker.
      *Hypothesis:* three near-copies now exist — `createModeOption` (`modes.ts`), `createSelectOption`
      (`advanced.ts`, exported sideways to `homeyEnergyMeter.ts` for the whole-home meter picker) — each
      carrying the md-select first-paint `displayText`/`typeaheadText` workaround; a view module acting as
      shared-primitive host grows view→view coupling with every picker (layering-guardian P2, 2026-07-18).
      Files: `packages/settings-ui/src/ui/advanced.ts`, `packages/settings-ui/src/ui/modes.ts`,
      `packages/settings-ui/src/ui/homeyEnergyMeter.ts`.
- [ ] **Whole-home meter picker: close the confidence loop after picking a meter.** *Persona:* Homey Energy
      owner who just selected a specific meter and wants to know it worked without waiting for the stale
      banner. *Hypothesis:* the save toast confirms persistence, not readings — the runtime already restarts
      the poll for an immediate sample (`handleHomeyEnergyMeterChange`), so the panel could surface the
      first fresh reading (or point at Overview's Power now). Also from the same review: a hint line when
      the device-list fetch fails ("Couldn't load your devices — reopen this page to retry"; retry-on-reopen
      already works), and the panel now speaks two save-toast dialects ("Limits & safety saved." vs
      "Whole-home meter saved.") (ux-fit + m3-critic P2s, render-gate capture 2026-07-18). Related
      runtime nicety from the same review round (Codex P2): after a meter change the immediate
      settings-handler rebuild still plans on the previous meter's cached power state for the ~1s
      until the restarted poll's first sample lands and triggers its own rebuild — gating that first
      rebuild on the new selection's sample would close the window, at the cost of coupling rebuild
      timing to sample arrival.
      Files: `packages/settings-ui/src/ui/homeyEnergyMeter.ts`, `packages/settings-ui/src/ui/capacity.ts`,
      `lib/utils/settingsHandlers.ts`.
- [ ] **Overview hero repeats "Safe pace now X kW" twice within ~40 px.** *Persona:* any owner glancing at
      the Overview hero — it's the first block on the app's front page, and identical adjacent strings read
      as a copy-paste bug even when every number is right. *Hypothesis:* the caption above the power bar and
      the value-carrying tick legend below it render the identical string because two notes jointly specify
      the duplication: `packages/shared-domain/src/planHeroSummary.ts:158` deliberately makes the legend the
      "only touch-reachable home for the number" while `notes/overview-hero-spec.md:27` keeps the value
      caption above the bar (`notes/ui-terminology.md` § Hero legend sides with the legend). Reconcile the
      two notes and slim one home — per the legend note's own rationale the caption is the one to lose the
      value. Render-gate capture 2026-07-07 (m3-critic + ux-fit P2).
      Files: `packages/shared-domain/src/planHeroSummary.ts`, `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `notes/overview-hero-spec.md`.
- [ ] **Simulation-mode overview: "2 devices would be limited" has no visible correspondence, and card
      copy slips into indicative tense.** *Persona:* owner trying simulation mode to preview what PELS
      would do before trusting it. *Hypothesis:* the hero counts devices that would be limited, but no
      chip marks which cards are members — a user counting finds four limited-looking candidates — and
      hold/wait cards say "Waiting to resume …" (indicative) while the hero/banner speak subjunctively
      ("would be limited", "stay as-is"); only "Would still draw …" gets the mood right. Add a per-card
      "Would be limited" marker (or enumerate in the hero line) and route hold/wait card copy through the
      same simulation-mood rewrite (`packages/shared-domain/src/simulationReasonMood.ts`). Render-gate
      walk 2026-07-07 (ux-fit P2).
- [ ] **Simulation banner at ≤360 px: stack action below text (MD3 banner idiom).** *Persona:* narrow-device
      owner (320–360 px) with simulation on. *Hypothesis:* the fixed-width "Turn off simulation" action
      squeezes the message into three 2-word lines with a dangling em-dash; the Android-idiomatic fix is
      the MD3 banner stack at narrow widths — text full-width on top, action right-aligned below (the
      `.banner--stacked` shape already exists). Render-gate walk 2026-07-07 (ux-fit P2).
      Files: `packages/settings-ui/public/style.css`, `packages/settings-ui/public/index.html`.
- [ ] **Marginally-actionable shortfall can still rebuild-storm past the tight-noop backoff.** *Persona:*
      capacity-tight household in a clamped daily-budget hour with one tiny reducible load left.
      *Hypothesis:* the unwinnable-overshoot fix (convergence no longer bypasses the anti-storm guards when
      the plan is unactionable) closes the observed 2026-07-06 cpuwarn crash, but when a small reducible
      load keeps `remainingReducibleControlledLoad` true, the unactionable throttle stays off while the
      tight-noop backoff is still defeated by every ≥100 W power jitter
      (`isTightNoopBackoffActive` — `lib/plan/rebuildScheduler/policy.ts`: `if (deltaMeaningful) return false`).
      A jittering supply can then still drive near-per-sample ~1.6 s rebuilds that repeatedly re-shed nothing.
      *Why:* same CPU-watchdog exposure as the fixed crash, just gated on a marginal plan state; consider
      letting the tight-noop backoff survive meaningful deltas once N consecutive rebuilds were no-ops.
      Adjacent residual windows from the same review: `hasPendingPlanWork` counts expired-but-unswept
      `pendingBinaryCommands` raw (up to ~75 s for cloud devices), so convergence re-arms per-sample rebuilds
      for that burst window after each shed wave; and a transient hard-cap breach that subsides between
      max-interval rebuilds is aliased away (no shortfall incident/flow trigger) while the state is
      unactionable — physically acceptable (hard cap is the hourly step), but it changes incident telemetry.
      Files: `lib/plan/rebuildScheduler/policy.ts`, `lib/plan/planStateHelpers.ts`.
- [ ] **Decay (or context-scope) the binary expected-power peak ratchet.** *Persona:* EV/large-load owner
      whose charger is externally current-limited (Easee/Zaptec app, load balancing) below its historical peak.
      *Hypothesis:* `updateLastKnownPower` (`lib/device/managerRuntime.ts`) is up-only — once a binary device
      has drawn its all-time peak, every future restore admission prices the resume at that peak + buffer
      (`restoreType:"binary"`, `powerSource:"expected"`). Prod 2026-07-05: the Elbillader gated on 7.56 kW
      while its real 6 A resume cost ~1.4 kW; the manual-start window re-ratcheted the peak to ~4.9 kW.
      A recent-observed-draw estimate or a decaying/context-scoped peak (cf. context-scoped step calibration)
      would track the device's current configuration. Stepped devices are unaffected (step planning power wins).
      *Why:* restore admission over-prices resumes for any externally-limited binary load → devices wait far
      longer than physics requires. Files: `lib/device/managerRuntime.ts`, `lib/device/devicePowerEstimate.ts`,
      `lib/plan/restore/accounting.ts`.
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
- [ ] **Nudge EV chargers missing the target-power phase preset.** *Persona:* EV-charger owner who managed the
      charger but never set 1-/3-phase, silently getting binary on/off control with peak-priced resumes.
      *Hypothesis:* a managed `evcharger`-class device with no stepped profile and no
      `ev_charger_1_phase`/`ev_charger_3_phase` preset degrades to pause/resume-at-peak (the pre-2026-07-05
      Elbillader state: "waiting for 7.56 kW"). The device settings sheet can detect the shape and suggest
      enabling current stepping via the phase preset.
      *Why:* the preset unlocks the charger's whole value (shed to 6 A instead of full pause) and the
      degraded mode is invisible today. Files: `packages/settings-ui/src/ui/views/**` (device settings),
      `packages/shared-domain/src/evTargetPowerConfig.ts`.

*Hard-cap trajectory rekey follow-ups (2026-07-06 review findings; the rekey itself — "Above hard
cap" keyed to projected hourly energy instead of instantaneous kW — shipped with its P0/P1s fixed).*

- [ ] **Over-cap verdict: producer and hero share the predicate but not the inputs.** *Persona:*
      skeptic with the headroom widget on their dashboard next to the open Overview.
      *Hypothesis:* `pels_status.projectedOverHardCap` is computed from raw plan meta while the
      hero computes from the rounded UI snapshot (0.1 kW / 0.01 kWh / whole minutes), plus the
      widget lags the 60 s status write throttle — near the cap boundary the two surfaces can
      briefly disagree or flicker (no hysteresis on the strict `>`). Fix direction: compute the
      producer flag from the same normalized meta the snapshot ships (or move the resolved flag
      onto plan meta and let the hero consume it), and consider a small hysteresis band in the
      shared `isProjectedOverHardCap` helper.
- [ ] **"Safe pace starts each hour at" result-row copy is hand-synced across two files.**
      *Persona:* maintainer rewording the Limits page. *Hypothesis:* the identical label/note
      strings live in `packages/settings-ui/public/index.html` (#settings-capacity-reaction) and
      `BudgetOverview.tsx` with no shared constant or pinning test; the next reword splits them.
      Hoist to a shared-domain constant consumed by both (the static HTML side needs a small
      loader hook — same pattern as other shared strings).
- [ ] **Power-bar amber does triple duty.** *Persona:* returning user scanning the hero under
      pressure. *Hypothesis:* `--pels-status-warning` now means the static cap reference tick,
      the live over-safe-pace overflow stripe, and the Simulation chip on one card — and the
      overflow stripe over-reports (the whole trailing segment flips amber from the safe-pace
      crossing, not just the overage). Needs mock-ups before any redesign (visual-system change,
      not a bug fix); the cap tick's surface halo shipped as the immediate legibility fix.
*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups. The solar gross/net
split follow-ups from this batch are fixed by the solar-accounting follow-up; remaining open items continue below.*

- [ ] **Solar money v2 — per-day money accrual for past days.** *Persona:* prosumer/skeptic wanting
      a month view of what their solar earned/avoided.
      *Hypothesis:* the Usage-tab Solar card's money is today-only by design — `combined_prices`
      retains no past days, so avoided/earned for yesterday and older cannot be derived read-side.
      The v2 shape (reserved by the PR-5 spec so v1 fields never need reshaping): Sparegris-style
      per-local-day minor-unit counters (`solarAvoidedMinorByDay`, `solarExportEarnedMinorByDay`)
      keyed by local date, accrued at sample time from the CURRENT hour's real prices
      (`total`/`exportPrice`, never `budgetPrice`). v1 bucket families stay money-agnostic (kWh
      only) — resist pulling money accrual into them.
      *Why:* the skeptic's "what did my panels do this month" question needs history the read-side
      join cannot reconstruct. Files: `lib/power/tracker.ts`, `lib/power/sampleIngest.ts`,
      `packages/settings-ui/src/ui/solarUsageSection.ts`.
- [ ] **Extend `unreliablePeriods` awareness to the solar bucket families.** *Persona:* prosumer
      reading the Solar card after a Homey restart or sample gap.
      *Hypothesis:* the total-usage chart flags hours overlapping `unreliablePeriods` as
      "Unreliable — some readings missing this hour", but the solar generation/export buckets share
      the same held-sample integration and get no such flag — a long gap under-accrues produced and
      exported kWh silently (the numbers are honest floors, but the card can't say so).
      *Why:* consistency of the unreliable-hours story across Usage surfaces; low urgency because
      the shared gap-reset (48 h) bounds the error and the card's copy claims "so far today", not
      exactness. Files: `packages/settings-ui/src/ui/solarStats.ts`,
      `packages/settings-ui/src/ui/solarUsageSection.ts`.
- [ ] **Hoist onboarding-link copy into shared-domain.** The stale-data banner strings
      (`resolveStaleDataBannerContent` in `capacity.ts`) and the Overview empty-state strings
      (`PlanOverview.tsx`) are inlined in settings-ui, and the no-plan sentence is a duplicated
      literal between the Preact view and the static first-paint placeholder in `index.html`.
      One shared-domain copy module referenced from all three would restore the rule-4 origin
      and kill the drift risk. Source: pels-copy-and-terminology lens on the onboarding-links
      PR (2026-07-19). [P2]

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

- [ ] **No-plan hero renders a permanent loading skeleton.** With `plan === null` the Overview
      hero shows the same shimmer blocks as the boot skeleton, forever, above "No plan
      available yet…" — it reads as stuck loading, not a deliberate empty state. Give the
      no-plan hero an explicit empty render ("— kW · waiting for the first power reading").
      Persona: brand-new owner on first open; hypothesis: an intentional empty hero reads as
      guidance, a shimmer as breakage. Source: pels-ux-fit (2026-07-19). [P2]

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

- [ ] **Solar-surplus hold renders at warn tone though it is the expected daily state.** A "Run on
      solar surplus" dump load waiting for export shows `Limited` + warn-toned "Waiting for solar
      surplus" every non-sunny hour — an alert treatment for its normal posture. Consider an
      info/ok tone (state word and reason) for the `awaiting_solar_surplus` hold so routine reads
      routine. Persona: prosumer scanning Overview each morning; hypothesis: chronic warn tone on
      an expected state trains the user to ignore warn. Source: pels-ux-fit implementation gate
      (2026-07-04). [P3]

- [ ] **Settings-UI structural consolidation train (deferred by the 2026-07 coherence review).**
      A designed, not-yet-executed train that unwinds the two-rendering-paradigms mess within the
      approved map `notes/settings-ui-semantic-map.md`. Order: shared Preact primitives in
      `src/ui/views/components/` — `Chip` (absorb `chipModifier.ts`, `usageHero.ts`
      `CHIP_TONE_CLASSES`, `BudgetOverview.tsx` `deltaChipClass`; canonical tone set, migrate `ok`→
      `good`, then drop the CSS alias) → `SegmentedControl` (extract `ToggleGroup` from
      `BudgetOverview.tsx` + the roving-tabindex keyboard model from `segmentedControl.ts`) →
      `Card` (fix `DeadlinePlan.tsx`'s `budget-redesign-card` misuse) → `Hero` (the four Preact
      heroes; unblocks future hero-content work) → `DeviceRow` scaffold (from
      `PriceAwareDevicesView.tsx`) — then imperative→Preact migrations: Usage hero (kills the last
      static-HTML hero in `index.html`) → Usage day view (deletes `createToggleGroup`, segmented
      impl 2/3) → Devices list (converges `buildRedesignDeviceRow`, rides the toggle-ring-contrast
      P2) → device-detail overlay slice-by-slice (Power-limiting slice first: rehome the hidden
      `md-filled-select` state store in `shedBehavior.ts` + `index.html`, deleting
      `segmentedControl.ts`, segmented impl 3/3) → Modes (Sortable.js needs an imperative island) →
      Advanced. Plus a boot.ts quick win: replace the `budget-adjust`/`budget-weather` virtual-
      target if-chains with a declarative map. One surface/primitive per PR, screenshot-gated on
      convergence. Persona: contributor velocity + Set-and-forget owner (visual coherence);
      hypothesis: three segmented impls / two device rows / per-file chip vocab is where per-page
      drift keeps re-entering. [P2, structural]

- [ ] **Converge the three lone master-toggle rows on one switch-row pattern.** Weather insight,
      Simulation, and Price-aware devices each present a lone switch on its own line — weaker than a
      Material list-item row with a trailing switch (label + supporting text + trailing control).
      Converge all three on the one switch-row pattern so the "turn this feature on/off" grammar
      reads the same everywhere. Persona: Set-and-forget owner; hypothesis: a bare switch reads as a
      stray control, a titled row reads as "this is the feature's on/off". Source: PR #1813 review
      gates (2026-07-02). [PR-6 control grammar]

- [ ] **Segmented-selected uses full primary green instead of a tonal-selected container.** The
      segmented control's selected segment fills with the full primary accent, louder than the new
      tonal-selected identity the toggles/switches now share. Move it onto the same tonal-selected
      container so the "selected" grammar reads the same across segmented, toggle, and switch.
      Persona: Set-and-forget owner; pre-existing follow-up. Source: PR #1822 M3 review
      (2026-07-02). [PR-6b control grammar]

- [ ] **Devices disabled-pending vs off toggle-ring contrast is too subtle.** On the Devices
      screen the outline ring of a disabled-pending toggle reads almost identically to a plain off
      toggle, so a user can't tell "not available yet" from "available but off". Nudge the
      disabled-pending treatment (opacity/tone) so the two states are distinguishable. Persona:
      Set-and-forget owner; pre-existing. Source: PR #1822 M3 review (2026-07-02). [PR-6b control grammar]

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

- [ ] **Extract the duplicated ECharts select-style identity object.** The on-surface select border
      (`select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } }`) is copy-pasted at ~5
      sites (usageDayChartEcharts.ts `shared`, budgetRedesignChartOptions.ts `barSelect`, plus the
      smart-task/stats charts). One shared helper (chartReadout.ts or chartTooltipFormat.ts
      neighborhood) keeps the selection identity visually identical across charts by construction.
      *From PR #1806 review.*

- [ ] **Hoist `resolveUsageDayStackSegments` into the bucket producer (`usageDayView.ts`).** Today the
      chart resolves per-hour stack segments while `buildUsageDayBucketReadout` independently feeds the
      readout from the same bucket fields — the two reconcile because they share inputs plus the shared
      `SPLIT_KWH_EPSILON` predicates, not because there is one resolved value. Producing one resolved
      per-hour structure (segments + a single beforeSolar flag) in the bucket builder and passing it to
      both consumers would make the reconciliation structural (resolution-in-producer).
      *From PR #1806 review.*

- [ ] **Curtailment surplus: replace battery full-suppression with a batteryPowerW discount.** The
      curtailment-surplus estimator (`lib/solar/curtailmentSurplus.ts`) suppresses the inferred term
      entirely when a home battery is tracked — v1 cannot tell a throttled inverter from a charging
      battery. `battery_state_observed` already carries a typed `batteryPowerW`, but it is emit-only
      (deliberately no retained value); discounting the term by concurrent battery charge power needs a
      retained, freshness-gated aggregate at the transport boundary first. Tune against
      `curtailment_verify_*` / `surplus_pool` dogfood telemetry. *Persona:* prosumer with PV + battery +
      zero-export controller whose panels still curtail once the battery is full. *Hypothesis:* full
      suppression forfeits real recoverable surplus in battery homes for most bright afternoons.

- [ ] **Curtailment estimator: nightly steady-state re-fits with no consumer.** Dormancy is one-way —
      once armed, night ticks (generation 0, term 0) keep resolving the potential; the 30 s wiring memo
      (`POTENTIAL_MEMO_TTL_MS`, `setup/appInit/wireCurtailmentSurplus.ts`) still admits ~2 PV-gain
      re-fits/minute all night (each pipeline tick invalidates the fit memo), each walking the 90-day
      history for a value nothing consumes in the dark. Consider a zero-generation idle guard (skip
      potential resolution while the last N generation samples are 0) or an hour-granular memo.
      *Persona:* every armed solar home, all night, on a cpuwarn-sensitive Homey Pro. *Hypothesis:*
      the per-fit cost is ~ms so the burn is small but pure waste; fix opportunistically with the next
      estimator change rather than shipping a dedicated PR.

- [ ] **Give the `pv_forecast_state` boot read an abandon-grace window.** `createPvForecastStore.read()`
      runs once in the PvForecastController constructor; a single transient-failed/empty settings read
      starts the service empty and the 5-minute persist timer then overwrites up to 90 days of recorded
      generation history. Pre-existing gap (the history was always re-learnable), but stakes are higher
      now: net-evidence accrual restarts too and every hour re-classifies from 'unknown', so a wipe drops
      a zero-export home back into the legacy median underestimate until evidence re-accrues. Follow
      `notes/persisted-settings-state.md`: treat an empty boot read as suspect for a grace window (or
      require a confirming read) before the first destructive persist. *Persona:* prosumer on a Homey Pro
      that restarts under memory pressure. *Hypothesis:* transient settings-read failures are common enough
      on the Homey SDK that a 90-day history will eventually be lost to a boot race.

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

- [ ] **`appliedBudgetKwh` is stamped from the setting as it reads at day close, not as it read during the day.**
      `lib/weather/weatherCollector.ts` `resolveAppliedBudgetKwh` reads the current daily budget and stamps it on
      the day being closed, guarded so it only does so when that day is exactly yesterday (the 00:05 rollup runs
      before auto-apply writes the new number). Two gaps remain. First, an owner who changes the budget manually
      at 23:00 has the whole day's usage measured against their new number — bounded by the per-day step cap, but
      it means the loop can grow on the owner's own edit. Second, the correctness of the guard rests on a
      cross-module ordering assertion (`lib/weather` → `setup` → `lib/dailyBudget`) held only by a comment, with
      no type or test able to enforce it. The honest fix is a producer: `DailyBudgetService` stamps the budget in
      force at each day close and exposes `getBudgetKwhForDate(dateKey)`, so the collector reads a resolved value
      instead of inferring applicability. Persona: contributor changing the rollup or auto-apply order; hypothesis:
      they reorder two calls and silently break the pressure loop's only measured input. P2.

- [ ] **Two producers answer "what daily budget is applied".** `DailyBudgetService.getAppliedBudgetKwh()` (added
      for the budget-pressure loop) and `resolveDailyBudgetKwh(ctx)` in
      `setup/appInit/weatherAdvisorReadoutAssembler.ts` implement identical policy (enabled → finite → `> 0` →
      value, else absent) from two different sources: the service's in-memory settings and raw `homey.settings`.
      They can disagree in the window between a settings write and the service's `loadSettings()`, and the weather
      card would then show one number while the pressure loop measured against another. The service is the
      correctly-layered producer; delete the setup-local copy and widen the assembler's `Pick<AppContext, …>` to
      include `dailyBudgetService`. Persona: an owner who just changed their budget and reloads the Budget page;
      hypothesis: "Your daily budget" reads the old value for one refresh. P2.

- [ ] **A day starved by the daily budget that still lands UNDER budget raises nothing.** The budget-pressure loop
      (`packages/shared-domain/src/energySignature/budgetPressure.ts`) only grows on days that were budget-suppressed
      AND ran past their budget, because "a device was blocked for an hour" alone is true on almost every normal day
      (shed cooldowns, price shaping) and would wind the term up without bound. But the case is real: with
      `daily_budget_price_flex_share` high, safe pace can collapse to well under 1 kW through the expensive hours
      while the day still ends comfortably inside its budget — devices are held back all afternoon and the loop sees
      no error. That is an intra-day ALLOCATION problem, not a level problem, so inflating the daily total is the
      wrong tool; the right fix is on the shaping side (a per-hour floor, or bounding how far the flex share may
      starve a single hour). Persona: an owner on a shaped budget; hypothesis: they see "Limited" all evening on a
      day that never came close to its budget and conclude the budget number is meaningless. P2.

- [ ] **The weather-insight cluster entered the 80% coverage gate at near-zero coverage.** Adding `setup/**` to the
      `vitest.config.mts` coverage include (multi-home headroom PR) pulled in
      `setup/appInit/weatherAdvisorReadoutAssembler.ts` (0% statements, 0% branches) and
      `setup/appInit/createWeatherCollector.ts` (45% st / 41% br) — 68 uncovered branches between them. The suite
      clears the gate today with ~6.6pp of branch headroom, so nothing is red, but `project_weather_insight` is
      "merged, needs deploy": the next iteration on it starts from ~zero instrumented coverage and can push the
      global gate down while the author is looking at an unrelated diff. Same family, smaller: `appDebugCompaction.ts`
      (47 uncovered branches), `appInit/registerSettingsHandler.ts`, `appInit/priceServices.ts`,
      `backgroundTasksController.ts`, `appDebugPrimitives.ts`. Fix: add integration cover for the readout assembler
      and the collector factory before the next weather PR. Persona: contributor landing the next weather change;
      hypothesis: a coverage failure attributed to an unrelated diff costs a full CI round to diagnose. P2.

- [ ] **Weather meter-scope fingerprint: resolve the Automatic arm to the sampled meter identity.** With Main on
      Automatic, `readWholeHomeMeterScopeSignature` (`setup/weatherMeterScopeSignature.ts`) composes the constant
      `main:automatic`. Automatic now retains a previously proven cumulative meter across report reordering, but a
      change to the sole usable candidate can still switch the physically sampled device with no fingerprint change, so
      records from two physical scopes mix without an invalidation. The resolved identity already exists: membership
      publishes it through `noteResolvedHomeMeter` into `SampledMeterIdentity` (`setup/homeSampledMeterIdentity.ts`),
      keyed to the sample's own freshness horizon. It cannot simply be consumed by the composer, because it is
      unproven at the collector's boot-time `start()` reconcile (the primary invalidation edge): composing
      `undefined` there would skip the boot reconcile for Automatic homes entirely, and falling back to a constant
      arm would flip-flop against the resolved arm and strip learned state spuriously. The sound design is a
      mid-run reconcile edge: expose the current sampled id through the
      membership port, fire an identity-proven/changed callback from `MainMeterAuthority.noteResolvedHomeMeter`,
      and have the wiring compare the freshly composed signature against
      `weatherCollector.getHistoryStateSnapshot().meterScopeSignature`, driving `reloadWeatherCollector` only on a
      real mismatch (a full restart, not an in-place strip — a mid-run strip races in-flight backfill-chain
      continuations, which only the stop()-generation bump discards). The stable Automatic resolver removes pure
      report-order flapping, but candidate availability can still move the identity. Do NOT re-resolve the
      Automatic pick anywhere else — consume the membership fence's identity. Persona: multi-meter Automatic-mode
      home (e.g. main meter plus a PV/battery cumulative device); hypothesis: a silent sampled-device switch makes
      the energy signature blend two scopes and the advisor's suggestions drift without any visible cause. Source:
      codex P2 on PR #1910, 2026-07-27. P2.

- [ ] **The power-driven rebuild due-time floor is implemented twice.** `PlanRebuildIntentPolicy.resolveDueAtMs`
      (`setup/planRebuildIntentPolicy.ts`) and `createBundleRebuildScheduler` (`setup/homeRuntime/
      createHomeCapacityBundle.ts:218-226`) compute the tight-unactionable floor and the `hardCap`/`signal` due
      times byte-for-byte identically; the bundle's comment even says "Mirrors `PlanRebuildIntentPolicy
      .resolveDueAtMs`". They legitimately differ elsewhere (the bundle uses a wall clock and has no `flow` lane),
      so only the power-driven half should be shared. Both are in `setup/`, so no boundary blocks it. Fix: export a
      `resolvePowerDrivenDueAtMs(intent, nowMs, rebuildState)` from `planRebuildIntentPolicy.ts` and call it from
      both — `test/unit/planRebuildIntentPolicy.test.ts` then covers the sub-home path too. Persona: contributor
      tuning the floor; hypothesis: a one-sided edit changes main-home pacing while sub-homes silently keep the old
      behaviour, and nothing fails. P2. Source: adversarial review, multi-home headroom PR.

- [ ] **The starvation-rescue preview return shape is written out inline in four places.**
      `{ estimate; deadlineAtMs; hasExistingObjective }` appears at `setup/appHostApi.ts` (the stub),
      `setup/appSmartTaskApi.ts`, `setup/settingsUiStarvationRescueApi.ts` and
      `packages/contracts/src/widgetHostApi.ts`. Three predate the headroom PR; the extraction added the fourth.
      Fix: name it in `packages/contracts/src/starvationRescue.ts` and alias it at all four sites (type-only, so no
      bundle churn). Persona: contributor adding a field to the rescue preview; hypothesis: a four-way inline shape
      means adding a field is four edits and missing one is a silent structural mismatch at whichever site is
      typed loosest. P3. Source: adversarial review, multi-home headroom PR.

- [ ] **Gate the device-detail Price-response + Solar-surplus sections on `canManageDevice`, not just `resolveManagedState`.**
      Both sections (and the Price/Surplus Control toggles) gate visibility/enable on `resolveManagedState`
      (`deviceDetail/priceOpt.ts`, `deviceDetail/solarSurplus.ts`), but a device can be `managed` while
      `resolveDeviceDetailControlState().canManageDevice` is false (it still needs built-in device control activation).
      In that state the sections stay visible with editable deltas even though the action can't take effect. Persona: an
      owner mid-setup on a not-yet-controllable device; hypothesis: an editable control that silently does nothing reads
      as broken. P2 (pre-existing price-opt behaviour the surplus section mirrors; fix both together for consistency).
      Source: Codex on the surplus-absorb UI PR #1759, 2026-06-25.

- [ ] **Weather collector: transient miss of `weather_advisor_settings` silently halts sampling
      until the next restart or settings write.** `WeatherCollector.start()` registers no timers
      when the config blob reads absent/malformed, and nothing re-checks later (the hourly
      re-read in `sampleOnce` never runs because no timer exists). Persona: the Orchestrator running
      the hidden weather feature; hypothesis: one transient SDK read miss at boot costs a full
      day of temperature samples (unreconstructable for the live path) and the gap is only
      visible as a `partialTemp` day much later. Candidate fix: distinguish "blob present and
      disabled" (no timers, correct) from "blob unreadable" (schedule a bounded re-check).
      Source: pels-runtime-reality on the weather-collection PR, 2026-06-11.

- [ ] **MET fetch flattens 403/429 to a generic `failed` (no status-aware back-off).**
      `fetchMetForecast` maps every non-200 (and timeout) to `{outcome:'failed'}`, so a 403
      (banned User-Agent) and a 429 (rate-limited, possibly with `Retry-After`) are
      indistinguishable and get the same throttled-warn + keep-cache treatment. Persona: n/a
      (operational / MET ToS); hypothesis: harmless at today's ≤hourly Expires-gated cadence (a
      429 just keeps the cache and the next attempt is ≥1h out anyway), but a future faster cadence
      or a sustained 403 would benefit from distinct handling (surface a 403 as a louder "fix your
      User-Agent/contact" signal; honor `Retry-After` on 429). Candidate fix: carry the HTTP status
      on the `failed` outcome and branch the warn/back-off. Source: CodeRabbit on the MET PR,
      2026-06-14.

- [ ] **`normalizeMetForecast` trusts a persisted `fullDayCoverage` independent of `hourCount`.**
      Now that `fullDayCoverage` GATES the auto-apply active-day budget, a corrupted persisted cache
      claiming `fullDayCoverage:true` with a low `hourCount` (or vice-versa) would mis-gate. We only
      ever WRITE consistent pairs, so this is corruption-defense, not a live bug. Persona: n/a
      (robustness); hypothesis: negligible (the store is app-written), but cheap to harden a
      load-bearing flag. Candidate fix: on load, force `fullDayCoverage` false unless `hourCount`
      also clears the threshold (and the day includes its midnight hour), keeping the persisted flag
      consistent with its evidence. Source: CodeRabbit on the MET PR, 2026-06-14.

- [ ] **Weather: share the in-flight MET refresh with a near-simultaneous rollup.** When the app
      starts within seconds of the midnight rollup, the rollup's `refreshMetForecast` is skipped by
      the single-flight guard (same generation as the boot refresh already in flight) and may roll up
      on a not-yet-refreshed cache → the day falls to the `recent_days` persistence fallback. Bounded
      (one day), self-healing (the next refresh fixes it), and inert while auto-apply is off. Persona:
      an Orchestrator restarting the app near midnight; hypothesis: rare, and it self-heals at the next
      refresh, so the cost is at most one day on a recent-days budget instead of MET. Candidate fix:
      have an in-flight `refreshMetForecast` return/await the shared in-flight promise rather than
      skip, so the rollup observes the freshly-refreshed cache. Source: Codex on the MET PR, 2026-06-14.

- [ ] **Weather sub-page → Budget cross-link is a one-way trip.** The Weather insight sub-page's
      "See tomorrow's outlook in Budget" link opens the Budget weather detail view, but its Done
      button returns to the Budget plan view, not back to the sub-page the user came from —
      `openBudgetWeatherView()` sets no return target (unlike `budget-adjust`, which threads
      `adjustReturnTarget`). Persona: an owner exploring config who taps the cross-link; hypothesis:
      landing two surfaces from where they started mildly frays the "config here / payoff in Budget"
      bridge, though it's defensible since they explicitly chose Budget. Candidate fix: thread a
      referrer into `openBudgetWeatherView()` so Done returns to the Weather sub-page when that's the
      origin (Budget Tomorrow-card entry still returns to plan). Source: pels-ux-fit on the
      sub-page PR, 2026-06-13.

- [ ] **Auto-apply "Last applied" line uses an absolute date with no anchor to now.** The Weather
      sub-page shows `Last applied: 44 kWh on 12 Jun.` (`composeLastAutoApply`). Persona: an owner
      who turned auto-apply on and later checks it's healthy; hypothesis: for a feature that acts
      *every* day, a one-day-old absolute date can read as "did it stall?", and a genuinely stalled
      apply (device went unreadable for a week) looks identical to a fresh one. Candidate fix: resolve
      a relative cue in the producer (today / yesterday / N days ago) so a stalled auto-apply is
      spottable. When budget is OFF but a prior apply exists, consider annotating the line
      "— paused while the daily budget is off" so the inert hint + last-applied read as one story.
      Source: pels-ux-fit + pels-m3-critic on the auto-apply PR, 2026-06-13.

- [ ] **Weather confidence honesty: kill the chip gradation, show a prediction band, give the
      Tomorrow card three distinct exits, and let auto-apply abstain on low-trust days.** Today the
      confidence enum (`learning`/`low`/`medium`/`high`) drives a chip via
      `resolveWeatherConfidenceChip` that maps `low→Estimating`, `medium→Refining`, and — the bug —
      both `learning` AND `high` to `null`, so the *most* and *least* trustworthy states look
      identical (no chip), and the gradations in between aren't actionable to a user. Meanwhile the
      Tomorrow card shows the same confident number + verdict shape whether the fit is solid or thin,
      and auto-apply pushes the suggestion every day regardless of that day's trust. Personas: the
      Optimiser (a confident kW number on thin data destroys trust the moment they sanity-check it) and
      the Failing-scenario (recovering) visitor (a low-trust auto-apply can over-tighten the budget). Design direction
      (from the 2026-06-13 chip/correlation think): (a) drop the Estimating/Refining gradation; keep
      only a single reason-bearing "Rough estimate" chip when the fit is genuinely weak; (b) on the
      scatter, render the prediction as two dashed clamped rails (a band), coverage-flared at the
      sparse tails — NOT per-column background shading (correlation is a global property, not
      per-temperature) and NOT a filled cloud (the spec already bans fill as "mud at 320px"); (c)
      give the Tomorrow card three exits — Supported (clean number), Rough (number + range + the
      reason it's rough), and Can't-predict-yet (SUPPRESS the number and the verdict entirely;
      distinct from the S5 uncorrelated state); (d) have auto-apply abstain (keep current budget,
      annotate why) on a day whose forecast falls in a low-coverage temperature region. **Mock
      first** per the redesign rule — current-vs-proposed PNGs of the rails on the real noisy prod
      cloud + the three card states, signed off before code. Source: user chip/correlation think +
      low-R² investigation, 2026-06-13.

- [ ] **Temperature backfill cascade re-runs the whole kWh chain even when the records are
      unchanged.** On a completed temperature pass, `WeatherBackfillChain.startTemperatureBackfill`
      unconditionally strips `meterKwhBackfillDone` + `controlledBackfillVersion` (the `markDone`
      marker-strip destructure in `weatherBackfillChain.ts`) so the meter and controlled-split backfills re-run — correct when a
      new device or a widened stitch
      actually changed the record set, but a temperature `TEMP_BACKFILL_VERSION` bump that produces
      byte-identical records still forces a full REST sweep of every managed device's meter Insights.
      Persona: the Orchestrator on an upgrade boot; hypothesis: bounded (the backfills are idempotent and
      validated, so the result is identical) but it's a redundant multi-device Insights sweep on every
      temp-version bump, and on a flaky-network boot each re-run is another chance to transiently
      fail. Candidate fix: cascade the marker strip only when `upsertBackfillRecords` reports the
      record set actually changed (diff the upsert, or hash the kWh-relevant fields), leaving the
      kWh markers latched when the re-stitch was a no-op. Source: self-review of the refit-once
      backfill change, 2026-06-13.

- [ ] **Hysteresis on `resolveSoftLimitSource` so the starvation rescue affordance doesn't flicker at the
      daily≈capacity crossover.** `lib/plan/planBuilder.ts:resolveSoftLimitSource` picks `daily` vs `capacity`
      from a per-cycle `Math.abs(daily - capacity) <= SOFT_LIMIT_EPSILON` comparison with no hysteresis and no
      `both` state. When the daily pace and capacity soft limit hover within epsilon, `softLimitSource`
      oscillates cycle-to-cycle; since the starvation cause now folds through it (`reattributeHeadroomShortfallCause`),
      a held device's overview bucket — and thus the "Let it run now" rescue button — can flicker budget↔capacity
      at that boundary. Persona: Optimiser running a tight daily budget near their capacity pace; hypothesis: a
      rescue button that appears and vanishes every few seconds reads as a bug and erodes trust. Candidate fix:
      add hysteresis to `resolveSoftLimitSource`. Out of scope for the
      cause-classification fix (#1735) because it also moves the hero "Safe pace now" source label. Source:
      pels-runtime-reality on #1735, 2026-06-16. **Not** solved by the P1 targeted refactor
      "Express the soft limit as two predicates instead of one rebased `min()`": that would give
      `softLimitSource` a real `both` band, but the resolver stays stateless, so values
      oscillating across the epsilon boundary still alternate `capacity`/`both`/`daily`. This
      item needs retained state or separate enter/exit thresholds either way.
      **A `both`-leaning tiebreak is no longer a cheap option (2026-08-15).** `'both'` was
      declared on `DevicePlan['meta']`, the settings-UI wire type and `HeroSoftLimitSource` with
      NOTHING able to produce it — `resolveSoftLimitSource` answers `'capacity'` when the paces
      coincide — so it was deleted along with its two copy tables, a switch arm, three
      conditionals, two `pelsStatus` predicates, and the `notes/ui-terminology.md` rows that
      specified its wording. Reintroducing it now means re-adding user-facing copy and an
      exhaustiveness arm everywhere, not flipping a union member. Prefer retained state or
      enter/exit thresholds, which this item says it needs anyway.

- [ ] **A starved episode keeps its ORIGINAL cause, so a now-capacity-blocked device stays badged
      "budget limited" — and keeps being offered the budget remedy.** A starved episode carries its
      counting cause across pauses by design (`notes/starvation/README.md:25-29`), but the rescue
      affordance is gated on `cause === 'budget'` (`starvationRowIsRescuable`), so PELS offers a
      budget remedy to a device whose LIVE block is capacity.
      *Persona:* Failing-scenario (acute) owner who taps the remedy PELS itself offered and sees
      nothing happen.
      *Hypothesis:* re-evaluating the cause on resume (or gating the affordance on the live
      `reasonCode` rather than the episode cause) would stop offering a remedy that cannot help,
      and stop the badge contradicting the row's own status line.
      *Prod evidence, 2026-08-01 (`/tmp/pels`, prod suffix `0a4464c3`):* "Connected 300" at
      17:25:22Z emitted `device_starvation_resumed { cause: "daily_budget" }` while every plan cycle
      in the same window reported `reasonCode: "insufficient_headroom"` /
      `"Not enough available power to resume — needs 1.4 kW, 1.1 kW available"`, and
      `restore_rejected` fired continuously ("insufficient headroom to swap … effective 1.22kW after
      0.30kW swap reserve"). The episode had begun budget-caused ~2.3 h earlier.
      *Why it's needed:* this is the surface half of the "Let it run now did nothing" report — the
      permission half is fixed, but the affordance is still offered on the wrong signal.
      Files: `lib/diagnostics/**` (starvation cause retention), `packages/shared-domain/src/planStarvation.ts`
      (`starvationRowIsRescuable`), `lib/plan/settingsOverviewReadModel.ts`. Adjacent to the
      `resolveSoftLimitSource` hysteresis item above. Source: prod investigation, 2026-08-01. [P2]

- [ ] **Busy-gate the Budget header toggle (inherited apply race).** `onToggleClick` ignores
      `adjust.busy`: confirming a discard while an apply is in flight yields a post-navigation
      "Daily budget updated." toast and a lingering dirty status (workingDraft = pre-apply values vs
      newly-applied active). Pre-existing behavior (old single-click Done had the same race; the
      two-step confirm only adds friction), so not fixed in the access PR. Fix: disable the toggle
      while `busy`, or honor the `draftRevision` guard in `applyBudgetAdjust`'s success path the way
      preview already does. Persona: impatient Optimiser; hypothesis: rapid preview→apply→Done
      sequences on slow Homey bridges leave the Adjust view claiming unsaved changes that were in
      fact applied. Source: adversarial correctness lens, 2026-06-10.

*Chart-overhaul train review follow-ups (2026-06-11, PRs #1677–#1681). Non-blocking.*

- [ ] **Compose a real cause for the plain-miss history hero's "Why" line.** The fallback branch
      renders "Why: Didn't reach the target before the deadline." — circular (it restates the
      Missed outcome it annotates). Compose an actual cause the way the revised/refined miss
      paths already do (e.g. from delivered-vs-needed or the final plan snapshot). Persona:
      Failing scenario (recovering). Files: `packages/shared-domain/src/deferredPlanHistory.ts`
      (`formatPlanHistoryMissedReason` final fallback, ~line 402), rendered via
      `packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`. Source: pels-ux-fit on
      PR #1681, 2026-06-11.

- [ ] **Say WHY an eligible-but-unpicked cheap hour wasn't picked in the schedule readout.** The
      schedule chart's one-hue-two-states encoding + caption key ("dimmed bars were not picked")
      makes a dimmed CHEAPEST bar (often the in-progress Now hour) an open question the surface
      never answers — the readout gives a what ("Idle — heating starts 15:00"), not a why (e.g.
      the current hour can't contribute a full hour, or the plan already has enough energy).
      Persona: Optimiser reading "Scheduled for the cheapest hours it can use" next to a dimmed
      cheapest bar. Hypothesis: one producer-resolved reason clause on the readout's third
      segment for eligible-unpicked hours closes the credibility gap the key opened. Files:
      `packages/shared-domain/src/deadlineLabels.ts` (`formatSmartTaskHourReadoutPrimary`),
      `packages/settings-ui/src/ui/deadlinePlanTimeline.ts`. Source: pels-ux-fit on the
      data-viz palette PR, 2026-07-02.

- [ ] **Fix the smart-task walkthrough fixture's impossible physics.** The e2e stub's live
      smart task says "Needs 12.0 kWh · 8 hours left" with "Device power used 0.75 kW" — even
      running all 8 hours delivers 6 kWh, yet the surface reads on-track and the trajectory
      climbs 13.9 °C in ~6 h (≈11 kWh at the stated 0.80 kWh/°C). Pre-existing (identical in
      before-captures), but this fixture feeds every walkthrough/screenshot surface. Make the
      numbers consistent (e.g. 1.8 kW device power, or a 4.5 kWh need) and re-pin affected
      deadline-plan spec assertions. Persona: owner poking at simulation mode. Files:
      `packages/settings-ui/tests/e2e/fixtures/homey.stub.js` (smart-task objective fixture).
      Source: pels-ux-fit on the data-viz palette PR, 2026-07-02.

- [ ] **Disambiguate the smart-task schedule chart's two kinds of dimmed bar.** With the
      one-hue-two-states encoding, a bar is dimmed both when it is outside the task's allowed
      window (e.g. the in-progress "Now" bar, before the 15:00 start) and when it is inside the
      window but too expensive to pick — same styling, two meanings. Either distinguish "outside
      window / not yet allowed" from "available but too expensive", or exclude the pre-start Now
      bar from the pickable set so "not picked" only ever means too-expensive. Persona: Optimiser
      reading a dimmed cheapest Now bar. Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`
      (schedule bar item styling), `packages/settings-ui/src/ui/deadlinePlanTimeline.ts`. Source:
      pels-m3-critic + pels-ux-fit on the data-viz palette PR, 2026-07-02. [UX P2]

- [ ] **Move the Budget-chart inline series/legend/pill labels into shared-domain.** The Budget
      charts still build `Actual` / `Budget` / `Projection` / `Price` / `Managed` / `Background`
      and the `Budget N kWh` end pill inline in `packages/settings-ui/src/ui/views/BudgetOverview.tsx`
      + `budgetRedesignChartOptions.ts`, unlike the smart-task charts which source their strings
      from `packages/shared-domain`. Migrate them so the Budget charts follow the
      `feedback_ui_text_shared_with_logs` pattern (runtime logs can mirror on-screen wording).
      Source: adversarial-review on the data-viz palette PR, 2026-07-02. [P3 copy]

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
      `powerKnown === false`, `guardInShortfall`, active overshoot, shed cooldown (60 s), restore
      cooldown (60–300 s), startup stabilization. *Hypothesis:* a capacity-tight hour with three
      shed/restore cycles can consume most of the 15 minutes without the reserve ever holding a
      device back; the home then calms, a real contiguous block appears, and the reserve has already
      lapsed — the exact out-competition the feature exists to stop. Worse in `power_source = flow`,
      where a 20-minute sample gap can consume the entire window in one go. Fix: advance the clock
      only on the `armed` outcome, or record held-cycles rather than a start timestamp. *Persona:*
      owner with an EV charger on a smart task in a busy home. Source: pels-runtime-reality on
      preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **Let a lapsed startup reservation re-arm when conditions change.**
      `resolveReserveForDevice` (`lib/plan/admission/headroomReserve.ts`) deliberately keeps the
      arming stamp on expiry so the lapse sticks rather than flapping — but that means a reserve
      that lapsed at minute 15 can never re-arm, even if the blocking load disappears at minute 40
      and the device could now start with a short hold. Only a genuine start clears the stamp.
      *Hypothesis:* on a multi-hour booked window this makes the permission a one-shot. Fix: allow
      re-arm after a cool-off, or key the lapse to the planned bucket. Pairs with the bound-accounting
      item above; do them together. *Persona:* owner with a long overnight reheat. Source:
      pels-runtime-reality on preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **A stepped device with no reported step and no metering holds its reservation for the full bound.**
      `isReportedAtOrAboveLowestActiveStep` (`lib/plan/admission/headroomReserve.ts`) needs
      `reportedStepId`, which only the native-EV path populates, and the draw fallback needs
      `measure_power`. *Hypothesis:* a stepped water heater on a non-native profile with no power
      metering starts, draws its full lowest step, and the reserve keeps withholding that same
      amount from everyone else for 15 minutes — roughly double-booking the load. The docblock calls
      the unconfirmed case "the fail-safe direction"; for an unmetered stepped device it is the
      opposite. Fix: treat "no evidence channel at all" differently from "evidence says not started".
      *Persona:* owner with an unmetered stepped water heater. Source: pels-runtime-reality on
      preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **Stepped reservation stand-down leaves `plannedState: 'keep'`, so `countShedDevices` under-counts.**
      `admitSteppedRestore` (`lib/plan/restore/steppedRestoreAdmission.ts`) sets only `{ reason }` on
      the reserved-for-start path, while its sibling `rejectSteppedRestoreForInsufficientHeadroom`
      applies `buildOffSteppedRestoreShedUpdate` and the binary twin sets `plannedState: 'shed'`.
      *Hypothesis:* a different stepped device may therefore climb above its lowest active step while
      devices are standing down for a reservation, because the stepped shed invariant counts nothing.
      Actuation is still safe (`shouldHoldCurrentState` covers it), so this is posture/invariant
      divergence rather than a stray write — hence P2. *Persona:* owner with two stepped devices.
      Source: pels-runtime-reality on preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **Stepped and simulation cards drop the reservation's target name.**
      `reserved_for_start` has no branch in `resolveOffStatusLine`
      (`packages/shared-domain/src/planSteppedCardText.ts`) — it is in neither `isWaitingReason` nor
      `isLimitedReason` — so a stepped device standing down falls back to the generic
      `PLAN_STATE_HELD_FALLBACK_STATUS` and the device name (the entire payload of the reason) never
      reaches the card. `packages/shared-domain/src/simulationReasonMood.ts` likewise has no override,
      so a dry-run card asserts "Waiting so X can start" for a hold PELS is not performing.
      `awaiting_solar_surplus` has the same stepped-card gap, so this follows an existing pattern
      rather than inventing one — but the loss is total here where that code carries no payload.
      *Persona:* owner with a stepped device held back by a smart task. Source:
      pels-layering-guardian on preemptive-power-reservation, 2026-08-01. *P2*

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

- [ ] **Cover the two startup-reservation safety branches that currently have no test.**
      Both are load-bearing and both would fail silently if deleted.
      (a) *Swap suppression.* `lib/plan/restore/gating.ts` and `lib/plan/restore/steppedRestoreAdmission.ts`
      return early on `reserved.kind === 'blocked_by_reserve'` instead of falling through to the
      swap path. Delete either branch and PELS sheds a **running third device** to serve a candidate
      that is itself standing down for a reservation — a real write, and exactly the class of
      failure the redesign exists to prevent. `test/integration/planHeadroomReserve.test.ts` has no
      running third device, so it cannot reach the swap path.
      (b) *Stepped path.* Every fixture in that file is binary (`binaryControllable: true`), and
      no test calls `admitSteppedRestore` with reserves. Uncovered: the stepped stand-down (which
      now also applies `buildOffSteppedRestoreShedUpdate`, added 2026-08-01) and the reserve
      round-trip arithmetic on both gates (`availableHeadroom - reservedKw` in, `+ reservedKw` out).
      A sign error there leaks the reservation into the caller's running headroom total and
      mis-admits every later device in the cycle.
      *Persona:* Contributor changing the restore gates. Source: adversarial-review on
      preemptive-power-reservation, 2026-08-01. *P2*

- [ ] Split planner state from render-only explanation data so keep/shed/inactive decisions no
      longer depend on UI-facing `reason` objects.
      Files: `lib/plan/restore/index.ts` (returns `{ plannedState, reason }` bundled),
      `lib/plan/planReasons.ts` (mixes reason normalization with shed-temperature hold decisions),
      plan/executor/rendering boundaries.
*Smart-task controller extraction (2026-05-30 → PR-E #1338): COMPLETE. The planner knows nothing
about smart tasks — `no-plan-to-smarttasks` is `error` and green. Design of record:
`notes/state-management/deferred-objective-lifecycle-carveout.md`. The items below are
non-blocking follow-ups.*

- [ ] **Playwright stub: seeded smart-task data is internally inconsistent.** The
      `dev_connected300` fixture claims "Needs 12.0 kWh" and an on-track verdict, but the seeded
      learned rate (0.75 kW) × 6 picked hours cannot deliver 12 kWh. Fix the fixture so
      screenshot-gated reviews of the smart-task detail page are trustworthy — a reviewer
      reconciling the numbers today would flag a phantom bug (or miss a real one). Source:
      PR #1807 review gates (2026-07-01).

- [ ] **A meterless ON exempt device loses its exemption on the restore budget axis.**
      `sumBudgetExemptMeasuredUsageKw` counts only measured draw, so an ON exempt device without
      `measure_power` contributes 0 while its real draw sits in `total` — the budget axis is
      over-tight by its full draw and non-exempt restores are held while it runs. Shedding still
      credits it via the projected add-back, so shed and restore use different credits for the
      same device. *Persona:* budget-exempt smart task on an unmetered relay heater plus other
      managed thermostats. *Hypothesis:* conservative-only (holds restores, never sheds), bounded
      by the exempt device's runtime; most exempt devices (EVs, connected water heaters) meter.
      Candidate fix: fall back to expected power for an OBSERVED-ON meterless exempt device on
      this axis only. Source: adversarial review of PR #1956, 2026-08-02. [P3]

- [ ] **The planner has no signal that a device's power reading predates PELS's own last step
      command.** In `inc_26449fb9` (prod 2026-08-05) the water heater's `measure_power` lagged its
      step change by ~5 minutes — through five successful snapshot refreshes at 20:02:48,
      20:03:49, 20:04:51, 20:05:19 and 20:05:53 — reporting 1.193 kW while the whole-home meter
      showed the device drawing ~2.9 kW. The staleness is upstream in Homey (the capability value
      itself had not changed), not in PELS's refresh cadence, so the observer's freshness
      tri-state correctly reports it fresh. But a reading older than the command that should have
      changed it is weaker evidence than one taken after, and nothing expresses that today.
      *Persona:* owner of a Høiax/stepped water heater during a capacity event. *Hypothesis:*
      affects only stepped devices during the window between a step command and the device's next
      power report; the ladder descent already keeps shedding correct across it, so this is about
      better evidence, not a live defect. Candidate shape: stamp the last step-command time on the
      snapshot and expose a producer-resolved "measurement predates last command" bit.
      Source: prod log review 2026-08-06. [P3]

- [ ] **The deployed runtime ships unminified tsc output, and the module graph is the heap.**
      A heap snapshot of the real `homey-app-runner` image (2026-08-20, SIGUSR2 via a non-remote
      `homey app run`) shows the app's 31 MB shallow heap is 12.3 MB module-source strings plus
      10.5 MB compiled code — live runtime data is ~3-5 MB. V8 retains every loaded file's source
      as a string (two-byte when the file has any non-ASCII character), so the bytes tsc emits are
      the bytes the heap holds. Spot check: the 205 KB `create_smart_task` bundle minifies to
      129 KB with whitespace+syntax only (identifiers kept, stack traces readable) or 96 KB full.
      Emitting the runtime graph through a minify pass — esbuild whitespace+syntax over the tsc
      output into `.homeybuild/`, sourcemaps kept out of the package — is worth an estimated
      4-6 MB of heap on a runtime with ~15 MB of RSS headroom since firmware 13.4.0 counted every
      app's shared runtime pages (`homey:manager:apps` insights, fleet-wide step 2026-07-28), and
      also removes the on-device tsc pass behind the boot cpuwarns. Done when a non-remote SHS
      boot's heap snapshot shows module-source strings at or under ~8 MB, `check:homeybuild` still
      walks the packaged require graph cleanly, and prod insights RSS steps down after deploy.
      Found 2026-08-20. [P2]

## P3 Future and Exploratory Work

- [ ] **`planSteppedLoad`'s direct-`currentOn` sites are masked-safe only by profile shape.**
      The `lib/plan/planSteppedLoad.ts` direct-`currentOn` reads are safe for a step-only stepper ONLY
      because the lowest step is the single off step at sorted index 0, so "next higher from off"
      equals "restore step". *Hypothesis:* a profile with multiple zero-power sub-steps below the first
      active step makes those unequal, silently regressing the restore target. *Persona:* an installer
      with a multi-step `target_power` heater. Add a `getSteppedLoadNextRestoreStep` regression test
      pinning a step-only device on a `[off(0), idle(0), low(>0), …]` profile; not a code change now.
      Still uncovered as of 2026-08-17 — `test/integration/planSteppedLoad.test.ts` has a two-zero-step
      `zeroOnlyProfile` case, but it drives the SHED direction (`getSteppedLoadShedTargetStep`) and has
      no active step above the zeros, so the restore-direction hypothesis is untested. Promoted
      2026-08-17 out of the completed snapshot-discrimination umbrella. [P3]

- [ ] **The activation seam is unit-covered but never driven end to end.**
      The realtime snapshot refresh (`setup/appSnapshotHelpers.ts`) and the Flow headroom card both
      stamp `currentOn` onto raw snapshots before the activation in/active reads, and a step-only
      stepper carries `steppedLoadProfile`/`selectedStepId` to the same reads. Covered only via
      `resolveCurrentOn` and the predicates: `test/integration/appSnapshotHelpers.test.ts` still mocks
      `syncHeadroomCardState` (`vi.fn()`), verified 2026-08-17, so nothing exercises the real seam.
      *Hypothesis:* a future change drops the stamp or the propagation and silently degrades
      activation-attempt close/active detection. *Persona:* a maintainer refactoring the
      headroom/snapshot wiring. Add an integration test driving the real
      `syncHeadroomCardState`/`evaluateHeadroomForDevice` with (a) a raw-snapshot binary device and
      (b) a step-only stepper parked at its off step, asserting the attempt closes as inactive.
      Promoted 2026-08-17 out of the completed umbrella. [P3]

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

- [ ] **A gated boot serves a stale persisted `pels_status` as live.** The blob lives in Homey
      settings, so a home that boots gated (no meter reading yet) never rewrites it and the
      `plan_budget` widget plus any external `pels_status` reader keep rendering the pre-restart
      headroom, limits, and device counts. `lastPowerUpdate` is in the payload
      (`lib/plan/pelsStatus.ts`) so a consumer could age it, but none does. *Hypothesis:* an owner
      checks the widget after a restart with a dead meter and acts on numbers from before the
      reboot. *Persona:* the widget-first owner. [P2]

- [ ] **App tests model stale-hold as an ABSENT sample timestamp, which the build gate made
      unreachable.** `createApp` seeds `powerTracker.lastPowerW` only, deliberately
      leaving `powerTracker.lastTimestamp` untouched so a suite's own headroom expectations are not
      rewritten. Production stamps both from the same sample (`recordPowerSample` writes
      `lastPowerW` and `lastTimestamp` together), so the harness sits in a state real ingest
      cannot produce: a total present on a
      home that has never sampled, which resolves to `stale_hold`. Since
      `setup/powerMeasurementGate.ts`, a genuinely never-sampled home builds no plan at all, so the
      real stale-hold is *total present, timestamp OLD* — and tests like `plan.test.ts` "marks off
      devices as shed with stale-hold fallback headroom when no power sample is available" assert
      through a door production no longer has. Re-express them with an aged timestamp and stamp
      both in the seed. Measured blast radius when the seed was made faithful: 15 tests across
      `plan.test.ts`, `evDevices.integration.test.ts`, `smartTaskSubHomeGateApp.test.ts`, and
      `app.test.ts`, mostly EV/swap cases whose headroom expectations assume the synthesized 0.
      *Hypothesis:* a future change to freshness handling passes the suite while breaking real
      homes, because the suite's stale-hold is reached by a path production cannot take.
      *Persona:* the contributor who trusts a green run before shipping a capacity change. [P3]

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
- [ ] **The eight-area cap is not enforced where the memory is consumed.**
      `HOME_AREA_MAX_COUNT` is checked only at the `ui_homes_save` seam; neither `HomeRuntimeRegistry`
      nor `normalizeHomesConfig` bounds anything, so a `homes_config` written outside the UI still
      spawns one capacity bundle per area against the app's ~30 MB RSS headroom. Cap or clamp at the
      registry so the runtime bound is enforced by the runtime. Persona: owner restoring a
      hand-edited or migrated settings blob. *Hypothesis:* an over-large area list is admitted at boot
      and the app trends toward the 160 MB ceiling with no signal, because the only enforcement point
      was never on that path. Source: multi-home finishing train, area-config invariants PR. [P3]

- [ ] **Extend the growth-only principle from the area cap to root disjointness.** The area cap now
      bounds GROWTH, so a config already over it can still be renamed or re-metered
      (`homeMeterOwnership.ts`). The root-overlap rule one line below it still evaluates
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

- [ ] **A permanently implausible pins blob makes Automatic refuse with a "try again" that never
      comes true.** `readMultiHomeActivation` resolves activation only from a diagnostics snapshot the
      membership service can vouch for, sharing `isHomesConfigDegraded` with the read payload and the
      area write so there is one degraded condition. That predicate is true when EITHER
      `homes_config` or `device_home_assignments` classified suspect, and activation does not depend
      on the pins store, so a `device_home_assignments` blob that
      `isPlausibleDeviceHomeAssignmentsBlob` permanently rejects leaves Whole-home meter → Automatic
      refused with "your settings couldn't be read. Try again in a few minutes." Keeping the shared
      predicate is deliberate (an activation-only variant would put a second, subtly different
      "degraded" in one file), and the blast radius is bounded: single-home owners never reach the
      branch, and picking an explicit meter stays available. Either repair/reset the pins store on a
      durable implausible read, or say what is actually wrong. Persona: owner whose pin blob was
      corrupted or hand-edited. *Hypothesis:* the copy promises recovery that no elapsed time
      delivers. Source: multi-home finishing train, area-config invariants PR review. [P3]

- [ ] **`--pels-md-secondary-container` maps to an untinted grey, so every Material component that
      signals selection through it signals nothing.** *Persona:* anyone reading a Material selection
      state anywhere in the settings UI. *Hypothesis:* `packages/settings-ui/public/style.css` maps
      `--pels-md-secondary-container: var(--color-surface-3)`, a plain grey one tier BELOW the
      surface-4 containers these components sit in, so a selected row renders as a dent rather than a
      highlight — measured at 1.10:1 against its own menu container, and inverted. The home scope menu
      works around it locally with `--md-menu-item-selected-container-color`, but every other
      `secondary-container` consumer (chips, segmented buttons, any future menu) still resolves to the
      dead grey. *Why it's needed:* selection state is the entire information content of a picker;
      one token fix repairs all of them at once, and the local override should then be removed.
      Source: pels-m3-critic review of the multi-home selector-shell PR, 2026-07-27.

- [ ] **`.pels-select` hardcodes `min-height: 48px` where `--pels-touch-target-min` exists.**
      *Persona:* maintainer changing the app's touch-target floor. *Hypothesis:* the shared select
      primitive states the 48 px literal while every sibling primitive (`.tab`, `.pels-icon-toggle`,
      `.smart-task-edit__time-input`) resolves the token, so a future change to the floor would miss
      every native select. *Why it's needed:* one edit should move every touch target. Pre-existing,
      surfaced by the scope bar adopting the primitive. Source: pels-m3-critic review, 2026-07-26.

- [ ] **Main and meter-area limits speak two field languages on one page.** *Persona:* multi-home
      owner switching the scope bar between Main home and an area. *Hypothesis:* Main renders
      `md-filled-text-field` with label `Hard cap` and an in-field `suffix-text="kW"`; the area editor
      renders native `.pels-input` with `Hard cap (kW)`. Flipping the scope morphs the identical two
      inputs. *Why it's needed:* now that one bar switches between them in place, the mismatch is a
      visible transition rather than two separate screens. Duplicate of the existing P2 entry on
      converging the Main form onto the native primitive — do them together.
      Source: pels-m3-critic review, 2026-07-26.

- [ ] **`Status now` reflects the unsaved cap.** *Persona:* multi-home owner typing a new hard cap for
      an area. *Hypothesis:* `buildAreaEditorView` resolves the status against the LIVE edited
      `hardCapKw` so the card tracks the input without a re-read, which means the `Hard cap` figure on
      a card titled "now" can show a value that is not persisted and may never be. *Why it's needed:*
      either the card should label the pending value as pending, or the status figure should track the
      persisted cap while the reaction readout keeps tracking the input.
      Source: pels-m3-critic review, 2026-07-26.

- [ ] **The Multiple-meters panel takes the whole `ui_homes` payload on trust, so the write lockout it
      derives can fail open.** *Persona:* multi-home owner editing meter areas while the runtime cannot
      vouch for the persisted config. *Hypothesis:* `homesSettings.ts:294` casts the untrusted response
      straight to `SettingsUiHomesPayload` (`await callApi<SettingsUiHomesPayload>(...)`) with no shape
      guard, and `isConfigDegraded()` at `:113` then reads it as `latestPayload?.configDegraded === true`.
      An absent or non-boolean flag therefore resolves to "not degraded" and unlocks the save paths at
      `:476` and `:531` — the whole-value `homes_config` write that `packages/contracts/src/settingsUiHomes.ts`
      warns "could erase persisted areas". The server-side seam refuses independently on the same predicate
      (`setup/settingsUiHomesApi.ts:174`), so this is a UI-honesty and defence-in-depth gap rather than a
      live data-loss path, and no in-repo producer can currently emit a non-boolean flag. *Why it's needed:*
      `homeScope.ts` now resolves the same endpoint into a typed `RosterRead` (`resolved | unavailable`) and
      never touches a raw payload; this consumer should share that resolver instead of keeping a second,
      weaker reading of the same bytes. Source: adversarial review of the multi-home selector-shell PR,
      2026-07-27.

- [ ] **Share the bounded exponential-retry delay calculation.** `homeyEnergyPoll.ts`,
      `flowPowerSampleFreshnessClock.ts`, and `homeRuntimeRegistry.ts` each implement the same
      1-second-to-60-second capped exponential delay. *Persona:* maintainer tuning transient-failure
      recovery. *Hypothesis:* the three copies can drift when retry policy changes, producing
      inconsistent recovery cadence without an intentional product decision. *Why:* one pure helper
      keeps the timing contract aligned while each consumer retains ownership of its timer lifecycle.
      Source: adversarial simplification review of PR #1872, 2026-07-23.

- [ ] **`runtimePackaging.test.ts` is a weaker duplicate of the real contracts guard, and it cries wolf.**
      `test/integration/runtimePackaging.test.ts:19` runs `import\s+(?!type\b)[\s\S]*?\s+from '…'`
      globally over each file, so prose anywhere above the import block (a module docblock explaining
      the contracts boundary) starts a match that runs on to the next `from '…'` specifier and reports
      a genuinely `import type` line as a value import. The failure mode is one-directional — the lazy
      `[\s\S]*?` cannot skip a valid ` from '…'`, so prose yields false POSITIVES and never false
      negatives. It is also silent on the `export { X } from '…contracts…'` re-export form, and its
      `runtimeRoots` omits `setup/` and `packages/shared-domain/src/`. **The boot-crash invariant is
      NOT at risk:** all three gaps are covered by the dependency-cruiser rule
      `no-runtime-value-deps-on-contracts` (severity error, wider path set, evaluated post-compilation),
      which is green. *Persona:* contributor adding a types-only module under `lib/**` that documents
      why it types its payload off `packages/contracts`, and loses a cycle to a red lane that is wrong.
      *Hypothesis:* the test earns its keep only if it stops false-positiving — anchor per line and
      forbid the match from crossing a statement
      (`/^import\s+(?!type\b)[^;]*?\s+from ['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm`) — otherwise
      delete it and rely on the cruiser rule, which is strictly stronger. *Why:* a duplicated guard that
      is both weaker and noisier trains contributors to route around the accurate one. Worked around in
      `lib/home/homeRuntimeRead.ts` by rewording the comment. Source: multi-home PR 5a, 2026-07-26.

- [ ] **Pinned sub-home device stays uncontrolled if the zones API never commits a tree.**
      *Persona:* multi-home owner who PINNED a device into a sub-home on a Homey whose zones API is degraded.
      *Hypothesis:* a pinned device resolves to its sub-home WITHOUT a zone tree (pins are tree-independent),
      so main excludes it while the sub-home bundle blanket-gates execution on `hasSeenZoneTreeCommit()`
      (`createHomeCapacityBundle` dry-run gate) — if the tree never commits, the pin is controlled by nobody.
      R7b ships a durable WARN (`home_bundle_gated_no_zone_tree_commit`) after a boot grace, but does NOT open
      the actuation gate: opening it for pins is a real safety-posture change that conflicts with the existing
      boot-window guard e2e (`homeCapacityBundlesSdkE2E` asserts a pinned member is NOT actuated before a tree
      commit). Fix (per-device gating of only zone-rule members, or a bounded trust-fallback) needs its own PR
      that updates that invariant + test together. Deferred from R7b to keep "existing suites pass unmodified".
      Source: R7b boot-gate audit, 2026-07-19.

- [ ] **Curtailment hold-state read failure resets the refute ladder.** `createCurtailmentHoldStore.read`
      (`setup/curtailmentHoldStateAdapter.ts`) normalizes a thrown/absent/junk settings read to `null`, which
      the constructor treats identically to "no state", so a transient boot-read failure drops the in-memory
      `holdLevel` to 0. If an import-latch onset then persists before the next clean restart, it overwrites a
      real on-disk ladder (a 60-min hold resets to 15-min). *Persona:* zero-export prosumer whose curtailment
      inference is climbing the refute ladder across a restart. *Hypothesis:* bounded — the import latch +
      consumer `hardOff` still block real grid import, so it is re-try churn not unsafe control — and
      low-probability (settings.get rarely throws post-startup, and it needs a coincident transition before
      the next clean restart). *Why:* keeps the ladder honest across crash-loops. If hardened: distinguish a
      thrown read from junk/absent and suppress the first level-0 persist for the process lifetime so a clean
      restart rehydrates the untouched blob; keep the null-normalise for genuinely malformed data; do NOT
      build the shared PersistedSettingsState helper (`notes/persisted-settings-state.md` cuts that). Files:
      `setup/curtailmentHoldStateAdapter.ts`, `lib/solar/curtailmentSurplus.ts`. *P3 (release-review
      adversarial verify, 2026-07-03).*

- [ ] **Electricity-prices "Right now" can read "Normal" when the current hour has no price.**
      `resolvePriceLevel` (`lib/plan/pelsStatus.ts`) returns `NORMAL` whenever `hasPrices(combinedPrices)` is
      true and the hour is neither cheap nor expensive — but `hasPrices` only checks that SOME day has hours,
      not that the CURRENT hour is covered. So at a day boundary (yesterday's/tomorrow's hours cached but
      today's not yet fetched) the summary can show the calm "Normal" all-clear instead of "Awaiting prices".
      (The originally-reported inverse — "Awaiting prices" while current prices ARE present — does NOT
      reproduce: the view renders the producer's own `powerPayload.status.priceLevel`, and UNKNOWN ⟺ no prices
      at all.) *Persona:* price-watcher glancing the Electricity prices panel around midnight. *Hypothesis:*
      narrow, cosmetic — a false calm rather than a wrong control decision. *Why:* the "Right now" tier should
      never claim an all-clear it can't back with a current-hour price. Fix: tier `NORMAL` only when a price
      actually covers the current hour. Files: `lib/plan/pelsStatus.ts`. *P3 (release-review adversarial
      verify, 2026-07-03).*

- [ ] **Battery surplus Flow trigger: "Solar surplus started/stopped" + kW token (deferred from the surplus ladder).**
      *Hypothesis:* battery control stays permanently out (docs/solar.md commitment), but a Flow
      trigger carrying the post-allocator pool remainder lets a battery app charge with exactly the
      surplus PELS's loads declined — no PELS-side battery control needed (a charging battery already
      shrinks the pool via net power). *Why it's needed:* closes the "PELS can't tell my battery to
      charge from surplus" gap without breaking the read-only battery commitment. Needs a
      `.homeycompose` flow trigger card (en/no titles) + the pool-remainder token from the allocator.
      From the PR-7 ladder ruling, 2026-07-01. *Persona:* prosumer with PV + home battery.

- [ ] **Observe-only device wiring: consolidate the host and transport classification seams.**
      *Persona:* Contributor (`notes/personas.md`) extending the observe-only-device family (battery, solar,
      and any future tracked-but-uncontrolled role) without updating dispersed role checks.
      *Hypothesis:* the managed-observe-only feature spreads thin wiring across two layers — the
      deviceId-only `isObserveOnlyRoleDevice`/`resolveManagedState`/`isCapacityControlEnabled` resolution in
      `setup/appHostApi.ts`, and the producer fields + `observeBatteryStateFromList` + `note*Device` realtime
      top-ups under `lib/device/transport/`.
      *Why it's needed:* a small `ObserveOnlyDeviceRegistry` (owning the per-role producers + the membership-set
      resolution) would let both seams delegate and make the next role a localized addition. This is now a
      cohesion improvement; the former `app.ts` and `deviceTransport.ts` line-ceiling motivations are complete.
      Source: PR-D runtime-reality review, 2026-06-27.

- [ ] **Home battery: distinguish a real home battery from a controllable load mislabeled with the `homeBattery` energy role.**
      *Persona:* Orchestrator (`notes/personas.md`) running a third-party driver that sets
      `energy.homeBattery` on a device that is actually a controllable load.
      *Hypothesis:* `resolveDeviceClassKey` normalizes ANY device declaring the `homeBattery`
      energy role (or `class:'battery'`) to the `'battery'` class-key and forces it managed
      observe-only, so a misconfigured/mislabeled driver would make PELS silently stop controlling
      a load the owner expected it to manage.
      *Why it's needed:* the role/class signal is the only evidence today; an inferred edge with no
      known real instance, but if it occurs the failure is silent (no shed/restore, no warning). A
      guard could require a battery-specific capability (`measure_battery`) alongside the role before
      forcing observe-only, or surface a diagnostic when a `homeBattery`-flagged device also has a
      control capability. Source: PR-C flow-card-leak review, 2026-06-27.

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

- [ ] **Persist the device Activity-log so it survives a restart.**
      *Persona:* Orchestrator (`notes/personas.md`) — wants to debug their own setup over time.
      *Hypothesis:* the Activity-log recorder (`lib/plan/deviceOverviewLog.ts`, served via
      `/ui_device_log`) is session-only, so the log is empty after a restart; a persisted ring buffer
      would let the Orchestrator review what happened overnight.
      *Why it's needed:* the one surface that reconstructs per-device history is wiped on every boot.
      Needs the Homey-SDK transient-read grace pattern before persisting. A later cross-device "recent
      activity" feed on Overview is a possible follow-on if the per-device view proves used.
- [ ] **The rescue tooltip names the one thing that may change nothing.**
      *Persona:* Optimiser (`notes/personas.md`) tapping `Let it run now` on a held-back device.
      *Hypothesis:* `BUDGET_EXEMPT_CARD_ACTION_COPY.tooltip` reuses `rescueConsequence` — "This lets
      the device use power beyond today's budget until it reaches its normal target." For a device
      with a standing budget exemption, or one held on the capacity axis, that clause describes the
      grant that does nothing and omits the two that do (pausing and limiting lower-priority load).
      Pre-existing for capacity-held devices; more reachable since the rescue stopped being
      budget-only (2026-08-04).
      *Why it's needed:* the confirm step is a money action, so its one-line summary should name the
      lever that actually applies. Mitigated today by the armed state's server-gated
      `permissionsLine`, which discloses the real grant before commit, and by hover tooltips being
      unreachable in the touch WebView — so this is copy honesty, not a broken flow. Source:
      adversarial review, 2026-08-05.

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

- [ ] **Create-screen `Extra permissions` opt-out is additive-only.**
      *Persona:* Optimiser / Orchestrator (`notes/personas.md`) who expects
      the compose screen to reflect the standing permissions already granted for the device.
      *Hypothesis:* because `createDeferredObjective` preserves existing smart-task permissions,
      a user can read the compose screen as authoritative while it only shows additive opt-ins.
      *Why it's needed:* surfacing current standing permission state would make the create flow
      honest when permissions came from Flow cards or the Held-back devices lane.
      Files: `widgets/create_smart_task/src/public/render.ts`,
      `widgets/create_smart_task/src/api.ts`, `packages/shared-domain/src/deadlineLabels.ts`.
      *Design (learned 2026-06-04, PR #1473 closed without merging — branch
      `feat/create-screen-standing-permissions` preserved):* a first attempt that surfaced standing
      grants as read-only and suppressed each already-standing toggle, which hit four review rounds of
      **`at_risk`-mode** edges. Resume by realigning the whole feature on **`always`-strength**,
      not "a grant exists": (1) suppress a permission's opt-in toggle ONLY when it already stands as
      `always` (can't be strengthened); (2) show an `at_risk` standing grant's toggle as an *upgrade*
      affordance (the standing line's ` (if at risk)` suffix differentiates it from the unconditional
      toggle); (3) gate `limitLowerPriorityDevices` on **effective-`always`** budget — an `at_risk`
      standing budget must NOT satisfy it (matches the app's keep-limit-only-when-`always` gate);
      (4) `buildEffectiveRescue` must take the **stronger** mode when standing and requested differ.
      Already-correct pieces on the branch worth keeping: the producer-side expired/history filter on
      `getDeviceStandingRescue` (gate on `hasDeferredObjectiveForDevice`), the standing-and-toggles merge
      into BOTH preview and create candidates, and the route-agnostic `Already allowed:` copy.

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

- [ ] **The editor's boolean toggle can't express — or show — a standing `at_risk` grant.**
      *Persona:* a user whose task carries a legacy `at_risk` permission (no shipped dropdown offers
      that mode; only hand-edited or legacy persisted data reaches it).
      *Hypothesis:* the read-only row renders `May go over daily budget if at risk`
      (`SMART_TASK_RESCUE_MODE_SUFFIX`) while the editor's toggle for the same fact renders a plain
      ON. The write side is already correct — `resolveGrantedMode` keeps the existing mode rather
      than promoting it — so this is display-only. Note the paired edge: on such a task
      `gateCandidateExtraPermissions` requires `exemptFromBudget === 'always'`, so a limit grant
      alongside an `at_risk` exemption is dropped; that is now non-destructive for an already-standing
      grant but still shapes what a NEW request can add.
      *Why it's needed:* two blocks describing one permission differently is the drift the shared
      label constants exist to prevent.
      *If fixed:* render the mode suffix on the toggle's hint rather than inventing a third control —
      do NOT add an `at_risk` option to any surface (`no shipped dropdown offers it` is deliberate).
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/shared-domain/src/deadlineLabels.ts`. Source: pels-ux-fit + pels-runtime-reality on
      editable smart-task permissions, 2026-08-02. *P3*

*Smart-task failure-investigation & live UX — the underserved Optimiser and the
Failing-scenario (acute/recovering) visitors (`notes/personas.md`).*

- [ ] **Breadcrumb a recent miss on the active-task hero.** Show "Last [kind] task missed:
      {short reason}" for ~24 h after a finalized miss.
      *Persona:* Failing scenario (acute) — reopens the app worried about a
      repeating deadline pattern, and lands on the *active* task, not history.
      *Hypothesis:* a 24 h breadcrumb sourced from the same postmortem resolver as history
      detail gives the prior-failure context on the surface they actually land on, without the
      Smart tasks → past row → detail navigation dance.
      *Why it's needed:* the persona most likely to reopen under stress is shown only current
      state today; the breadcrumb earns the visit. Related: `notes/smart-task-ui/README.md` Q2.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`, `.../deadlinePlan.ts`
      (recent-miss query against `DeferredObjectivePlanHistoryEntry`).
- [ ] **Fold the revision-history panel into "What PELS has learned" at 320 px.**
      *Persona:* Orchestrator — expands cards to debug their own setup.
      *Hypothesis:* at 320 px the standalone collapsed panel costs ~80–96 px of chrome before
      any content; nesting "…and what changed since the plan was first written" inside the
      existing `PlanInputsCard` recovers that space and groups related debug info.
      *Why it's needed:* on the 320 px-min webview the extra card shell pushes the actual
      revision content below the fold, weakening the one surface this persona uses to
      reconstruct what changed. Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `PlanInputsCard`. Source: pels-m3-critic/ux-fit on PR #1197 (batches 1–3 shipped).

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

- [ ] **Add a generic immediate Smart-task intent for temperature devices and EV chargers.**
      *Persona:* Failing scenario (acute) / Orchestrator who needs one managed device to make
      progress now rather than at a later price-selected hour.
      *Hypothesis:* offering `Start now` beside `Ready by` after device selection provides one
      generic intent with kind-specific heating/charging wording. The immediate intent includes
      the current hour whenever the device is commandable and the hard cap permits it. It is
      price-neutral: disabled or unavailable prices must produce a non-price current-hour
      horizon, not `objective_price_feature_disabled` / `objective_missing_price_horizon`. It
      applies all three existing objective-scoped permissions as `always` (`exemptFromBudget`,
      `limitLowerPriorityDevices`, `pauseLowerPriorityDevices`), so the soft daily budget and
      lower-priority loads cannot silently defeat the request. Those permissions alone are
      insufficient because the scheduler may still select a later cheap hour; its intent
      discriminator must also suppress the
      `priceDeferralEligible` and `coldStartReleaseEligible` release paths; otherwise admission
      can idle a booked current-hour task.
      *Why it's needed:* the existing Held-back devices and Overview rescue is temperature-only,
      appears only after a daily-budget hold, and can still schedule its bounded task later.
      Reuse the Smart-task planner, preview, history, and write lifecycle; do not build separate
      heating and EV override subsystems. Require an explicit EV target percent, seed temperature
      from the current mode target, and keep stale-power/hard-cap safety. Preview and create must
      share an exact finite `deadlineAtMs`: `now + max(3 h, estimated duration + 1 h)`, refused
      when the estimate is unavailable/non-finite or exceeds the existing 36 h candidate horizon.
      Reaching the target finalizes `Succeeded`; expiry finalizes `Missed`; cancellation finalizes
      `Abandoned`. Define existing-task conflict handling before implementation.
      Design: `notes/smart-task-ui/README.md`.
      Files: deferred-objective contracts, a shared immediate-deadline resolver/constants,
      price-neutral policy horizon/current-hour allocation, admission permissions/release gates
      and diagnostic parity, lifecycle finalization, Smart-task candidate APIs, Smart tasks
      creation UI, and `widgets/create_smart_task/`.

*EV charging — the Optimiser / EV commuter (`notes/personas.md`).*

- [ ] **EV deadline polish: pause action + imminent-deadline urgency rule.**
      *Persona:* Failing scenario (acute) with EV-commuter / Optimiser overlap —
      realizes mid-evening the car won't be ready by morning and needs to intervene.
      *Hypothesis:* exposing `pause_until_next_planned_slot` and force-admitting planned charging
      when `(deadline − now) < requiredHours + 1 h buffer` lets the user intervene and trust the
      system to self-rescue when the window gets tight. Immediate charging belongs to the generic
      Smart-task item above, not this EV-only slice.
      *Why it's needed:* today an imminent deadline can stay shed under capacity/price logic
      with no escape hatch and no auto-urgency — the worst failure mode for the
      highest-intensity persona. (Notification delivery is the user's own flow; PELS supplies
      the trigger tokens — that token work lives in the P2 observability entry, not here.)
      Design: `notes/ev-ready-by/README.md`. Files: pause Flow action JSON/registration plus
      deferred-objective admission/status logic for urgency.

*Demoted from P2 (2026-06-03 scrutiny pass) — real product / future-capability work with a
persona but no current support-cost pressure; reframed to the P3 bar.*

- [ ] **Per-device kWh + money column on Usage.**
      *Persona:* Optimiser.
      *Hypothesis:* Usage emits total kWh only while the smart-task hero and Budget already show kr, so
      the Optimiser can't answer "what did this device cost last week?"; a per-device kr column
      (`Σ priceValue × deviceKwh`, derivable today) closes it.
      *Why:* money visibility is exactly this persona's question; Usage is the one surface that withholds
      it. Needs a per-device kWh API field. Files: `packages/contracts/src/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/usageHero.ts`, `.../usageStatsChartsEcharts.ts`.
- [ ] **Profile and reduce plan-rebuild CPU spikes / `cpuwarn`.**
      *Persona:* every persona — the app staying responsive within Homey's CPU/RSS envelope.
      *Hypothesis:* startup `planRebuild` up to ~6 s and steady `planBuild` ~1 s delay shed/restore
      reactions to power changes; isolating hot paths (plan build dominates) behind a repeatable perf
      benchmark keeps control reactive.
      *Why:* degraded reactivity is felt as the app being slow to protect the cap. *Validate first:* no
      missed-shed has been tied to it yet — benchmark before optimizing. Files: `lib/plan/planBuilder.ts`,
      `lib/plan/planService.ts`, `lib/diagnostics/perfLogging.ts`.
      *Update (2026-07-01):* the unactionable-shortfall rebuild storm that had turned this ~1.4 s build
      cost into a `cpuwarn` crash-loop (background load over a low hard cap with nothing left to shed) is
      fixed by the rebuild-scheduler unactionable throttle. What remains here is the raw build latency
      (reactivity), not crash survival — memoize per-device `getPriorityForDevice`/`getShedBehavior` within
      a build and skip deferred-objective decoration when no objectives are enabled.
      *Update (2026-08-07):* the raw build latency was profiled against production perf counters and was
      almost entirely one call. `plan_devices_setup_ms` (640 ms) and `plan_observe_diag_ms` (637 ms) were
      99 % of a 1293 ms build, while `plan_devices_base_ms` — the same 13-device loop without price calls —
      was 5 ms. Both loops asked `isCurrentHourCheap()`/`isCurrentHourExpensive()` **per device** (26 calls
      each, 52 per rebuild), and each call rebuilds the whole combined price series from settings
      (`PriceService.getCombinedHourlyPrices`, uncached: ~12 settings reads, one `Intl.formatToParts` per
      spot hour, a 360-entry grid-tariff pass) at ~25 ms a time. The level is now producer-resolved once per
      build onto `PlanContext.currentHourPriceLevel`, pinned by
      `test/integration/planPriceLevelResolvedOncePerBuild.test.ts`.
      Natural experiment confirming the attribution: between 2026-08-01 19:00Z and 2026-08-02 14:41Z
      thermostat target control was silently off (the never-written-key bug fixed by `f163bd912`), no device
      reached the price branch, and `buildMs` fell from ~1290 ms to ~40 ms; `plan_rebuild_status_ms` (2 price
      calls, unconditional) stayed flat at ~92 ms across both boundaries.
      *Update (2026-08-07), second pass:* the two remaining hot callers each built the series **twice** —
      `isCurrentHourCheap()` and `isCurrentHourExpensive()` are separate predicates, and `getPriceLevelFlags`
      already computes both from one pass. `PriceService.getCurrentHourPriceLevel()` now answers both from a
      single build, used by `PlanBuilder.resolveCurrentHourPriceLevel` and `PlanStatusWriter.compute`, so a
      rebuild went from 4 series builds to 2 (~50 ms). Pinned by
      `test/integration/priceLevelSingleSeriesBuild.test.ts`.
      *Memoizing `getCombinedHourlyPrices` is DECIDED AGAINST for now — do not attempt it as specified.* An
      invalidation-based cache is unsafe today: `price_area`, `nettleie_fylke`, `nettleie_orgnr`, and
      `nettleie_tariffgruppe` are written by the settings UI (`packages/settings-ui/src/ui/priceConfig.ts`)
      but have **no** entry in the `lib/utils/settingsHandlers.ts` routing table, so nothing calls
      `updateCombinedPrices()` when they change. The live rebuild on every read is precisely what keeps a
      price-area or grid-operator change visible; a cache invalidated at that funnel would serve stale
      prices. Precondition for revisiting: route those four keys through `refreshPriceDerivedState` first
      (a behaviour change of its own — it makes them trigger a plan rebuild), then the funnel is complete
      enough to invalidate against. Remaining cost without it is ~2 builds (~50 ms) per rebuild.
      *Still open here:* `PriceOptimizer.applyPriceOptimization` (`lib/price/priceOptimizer.ts`) still spends
      up to 3 series builds per pass — `isCurrentHourCheap()`, `isCurrentHourExpensive()` (both reached
      whenever `getCurrentLevel()` is not already CHEAP/EXPENSIVE), and its own `getCombinedHourlyPrices()`.
      Same fix as above, but it needs `getCurrentHourPriceLevel` added to the `priceStatus` port, so it was
      left out of the hot-path change. Low value on its own: the optimizer runs hourly, not per rebuild
      (~75 ms/hour). Plus the per-device `getPriorityForDevice`/`getShedBehavior` memo and the no-objectives
      decoration skip above.
- [ ] **Add a CPU-pressure circuit breaker that throttles plan rebuilds before Homey's watchdog fires.**
      *Persona:* every persona — the app surviving CPU pressure instead of crash-looping.
      *Hypothesis:* Homey's `cpuwarn` signal (`lib/diagnostics/resourceWarnings.ts`) is logged but never
      feeds back into scheduling; wiring it via an injected sink into an escalating rebuild backoff would
      make the app self-throttle its most expensive periodic work for *any* future CPU-runaway cause, not
      just the unactionable-shortfall trigger already fixed. Keep actionable `hardCap` intents exempt so a
      genuine shed is never starved.
      *Why:* defense-in-depth backstop; the specific 2026-07-01 crash-loop trigger is fixed by the
      unactionable rebuild throttle, but no general guard exists. Files: `lib/diagnostics/resourceWarnings.ts`,
      `lib/plan/rebuildScheduler/`, `setup/backgroundTasksController.ts`, `app.ts`.
- [ ] **Tighten shortfall entry/clear detection during the unactionable rebuild throttle.**
      *Persona:* every persona watching the "limited" state settle after load changes.
      *Hypothesis:* while the unactionable throttle is active the throttled skip no longer drives
      `checkShortfall` at all (it used to, but that entered shortfall without a rebuild and could deadlock
      the unrecoverable-shortfall skip), so both shortfall *entry* and *clear* detection now ride the 30 s
      max-interval rebuild. A skip-path `checkShortfall` that only *progresses* state when already
      `isInShortfall` (never enters shortfall) would restore per-sample cadence without reintroducing the
      deadlock.
      *Why:* minor recovery-latency polish; bounded to the 30 s max-interval and inside the 60–300 s
      restore cooldown, so not a correctness issue. Files: `lib/plan/rebuildScheduler/powerDriven.ts`,
      `lib/power/capacityGuard.ts`.
- [ ] **Tighten shedding of newly-returned load during an unactionable throttle without reviving the storm.**
      *Persona:* every persona — the app reacting promptly when a managed device starts drawing again.
      *Hypothesis:* the 15 s execution floor is deliberately independent of the `measurePowerBecameSignificantlyPositive`
      invalidation latch (so a device flickering across the 5 W threshold under a hard-cap breach can't re-arm
      the one-shot latch each sample and revive the rebuild-storm). The cost is that a genuine device-return
      re-check can be delayed ≤15 s, and because the power-sample loop awaits the scheduled rebuild,
      `capacityGuard` updates pause for that window. A bounded mitigation (e.g. a capped consecutive-latch-bypass
      allowance, or making the sample loop not block on a deferred rebuild) would restore reactivity while
      keeping storm-safety.
      *Why:* bounded (≤15 s, inside the 60 s re-shed cooldown) and only in a state where nothing was sheddable
      anyway, so accepted for now; a cleaner reactivity/storm-safety balance is the follow-up. Files:
      `lib/plan/rebuildScheduler/powerDrivenScheduling.ts`, `lib/plan/rebuildScheduler/powerDriven.ts`,
      `setup/powerSamplePipeline.ts`, `lib/power/sampleIngest.ts`.
- [ ] **Finish the starvation rollout beyond detection.**
      *Persona:* Orchestrator building their own automations.
      *Hypothesis:* starvation detection + the user-initiated rescue widget shipped, but there are no
      per-episode/duration flow triggers or insights coverage, so an Orchestrator can't react to starvation
      in their own Flows.
      *Why:* future product rollout against `notes/starvation/README.md`; the feature works without it.
      Files: `flowCards/**`, `drivers/pels_insights/**`, plan snapshot/contract wiring.
- [ ] **Support a kWh target on the EV deadline flow card.**
      *Persona:* EV commuter whose charger doesn't report SoC.
      *Hypothesis:* the `ev_soc` variant accepts only `targetPercent`; a kWh target is the one EV path
      that needs no SoC observation/freshness at all, so accepting `targetEnergyKwh` broadens supported
      chargers and removes a fragile dependency.
      *Why:* widens device support for the EV persona. Design: `notes/ev-ready-by/README.md`. Files:
      `packages/contracts/src/deferredObjectiveSettings.ts`, `flowCards/deadlineObjectiveCards.ts`,
      `lib/objectives/deferredObjectives/diagnosticsBridge.ts`,
      `.homeycompose/flow/actions/set_ev_charge_deadline.json`.
- [ ] **Gate the budget chart money (kr) view on actual/projection cost, not just budget pace.**
      *Persona:* Optimiser on a partially-priced day looking at the Budget chart's kr view.
      *Hypothesis:* `resolveBudgetCostViewAvailable` checks only `budgetPaceCostCumMinor`; the producer
      nulls the three cost series independently from different increment arrays (`paceInc` vs
      `actualInc`/`projInc`), so a bucket with near-zero pace increment but un-priceable actual/projected
      energy can leave the pace series finite while nulling actual/projection — the kr view then renders
      with the actual or projection line silently missing.
      *Why:* degrades gracefully (a dropped line, never a wrong number) and needs partial intra-day
      pricing, which the dominant whole-day-priced Nordpool scheme never produces — hence P3, surfaced by
      PR-C adversarial review. *Validate first:* construct a partial-pricing fixture; a view-aware gate
      must still allow the legitimately-null projection on yesterday/tomorrow views. Files:
      `packages/settings-ui/src/ui/budgetRedesignChartData.ts` (`resolveBudgetCostViewAvailable`),
      `lib/dailyBudget/dailyBudgetProjection.ts`.
- [ ] **Pin the contracts↔lib deferred-objective normalizer mirror as a tracked keep-in-sync pair.**
      *Persona:* Contributor editing objective validation rules.
      *Hypothesis:* three lanes (widget create, settings-UI edit, runtime persist) now validate through
      `lib/objectives/deferredObjectives/settings.ts` while the settings UI pre-gates through the
      `packages/contracts/src/deferredObjectiveSettings.ts` mirror; a one-sided edit would let the UI
      offer an edit the server rejects. Both files carry keep-in-sync comments; consider a shared
      fixture test that runs identical junk/edge candidates through both normalizers and diffs the
      results. Source: pels-layering-guardian on the smart-task edit PR (2026-07-05).
- [ ] **Smart-task detail: one date vocabulary for the deadline.**
      *Persona:* Owner reading the hero ("Target 65.0 °C by Mon 06:57") above the edit preview
      ("Ready by Tomorrow 06:30").
      *Hypothesis:* the hero uses weekday-time (`formatSmartTaskDeadline*` short form) while the edit
      preview uses the Today/Tomorrow long form; same concept, two formats centimetres apart. Pick one
      (likely the Today/Tomorrow form the create widget and preview already share). Source:
      pels-m3-critic on the smart-task edit PR (2026-07-05). Files:
      `packages/shared-domain/src/smartTaskDeadlineFormat.ts`, `packages/settings-ui/src/ui/deadlinePlanHero.ts`.
- [ ] **Smart-task edit lane: don't reattach a stale draft to a NEW task on the same device.**
      *Persona:* Owner whose task ended (or was cleared via Flow) while the editor sat open, then created a new task on the same device.
      *Hypothesis:* `buildSmartTaskEditProps` reattaches the module-scope editor snapshot by deviceId alone; a later task on the same device inherits the old draft's stale baselines. Guard the reattach on the context still matching the live entry (e.g. `snapshot.context.baselineDeadlineAtMs === entry.deadlineAtMs`) so a replaced task renders the editor closed. Source: Codex review on PR #1843 (2026-07-06). Files: `packages/settings-ui/src/ui/deadlinePlanMount.ts`, `packages/settings-ui/src/ui/smartTaskEdit.ts`.
- [ ] **Smart-task edit/clear gates: treat a still-pending legacy-blob migration as untrusted absence.**
      *Persona:* Legacy install whose `deferred_objectives` blob migration deferred on a flaky read.
      *Hypothesis:* `gateEditableTask` and `cancelDeferredObjectiveForContext` answer `task_not_found` when the per-device key is absent and `getKeys()` is non-empty — but if `migrateBlobToPerKeyIfNeeded` just deferred, the task may still live in the un-migrated blob. Trust absence only when the `DEFERRED_OBJECTIVES_PERKEY_MIGRATED` marker is set; otherwise map to the retryable `write_conflict`/`write_refused` lane. Nearly extinct in practice (all live installs are migrated). Source: Codex review on PR #1843 (2026-07-06). Files: `setup/settingsUiSmartTaskApi.ts`, `setup/appInit/deferredObjectiveCancel.ts`.
- [ ] **Smart-task home-scope gates optional-chain a REQUIRED `HomeMembershipPort` method.**
      *Persona:* maintainer reading the smart-task authority gates to decide whether a new caller is safe.
      *Hypothesis:* `isSmartTaskDeviceInMainHome` and `resolveSmartTaskHomeScope` both write
      `membership.hasPendingOwnershipGeneration?.() !== false`, but `hasPendingOwnershipGeneration(): boolean`
      is NON-optional on `HomeMembershipPort` — the `?.` is unreachable and the `!== false` exists only to
      absorb an `undefined` it can never produce. *Why:* the port was deliberately designed so control paths
      see one total, provenance-free surface; a dead optional-chain re-introduces exactly the "might this be
      missing?" ambiguity the port removed, and the double negative reads as if absence were a third state.
      Collapse both to a plain call (`membership.hasPendingOwnershipGeneration()`), keeping the genuine
      `membership?.` guard for the optional `ctx.homeMembership` itself. Behaviour-neutral. Source: multi-home
      boundary-hygiene audit of the GA train, 2026-07-25. File: `setup/appInit/smartTaskHomeScope.ts`.
- [ ] **`lastResolvedMainMeterDeviceId` is a three-state field whose third state is never distinguished.**
      *Persona:* maintainer extending Main-meter source fencing. *Hypothesis:* the field is typed
      `string | null | undefined` and documented as "`undefined` means no authoritative Main-meter selection
      has been observed; `null` is the authoritative Automatic selection", but at its ONLY read
      (`getKnownConfiguredMeterDeviceIds`) the two collapse into one branch
      (`=== undefined || === null ? [] : [id]`), so the extra state carries no information today. *Why:* an
      unused third state on a nullable field is the shape that made `currentOn` hard to reason about; either
      narrow it to `string | null`, or give the "never observed" case a real consumer and say what that
      consumer does differently. Behaviour-neutral either way. Source: multi-home boundary-hygiene audit of
      the GA train, 2026-07-25. File: `setup/homeMembership.ts`.
- [ ] **The plan-time daily-budget provider still defaults where the new setup rule says assert.**
      *Persona:* maintainer moving wiring out of `app.ts` under the `setup/AGENTS.md` boot-window rule.
      *Hypothesis:* `buildMainHomeScope` builds `getDailyBudgetSnapshot: () => ctx.dailyBudgetService?.getSnapshot() ?? null`,
      the same shape `AppSmartTaskApi.previewDeferredObjectivePlan` just replaced with an assertion. It is
      unreachable today only because `initHomeRuntimeRegistry` runs after `initDailyBudgetService` in
      `AppServiceWiring.startApp`, and nothing enforces that order. *Why:* `getSnapshot()` legitimately
      returns `null`, so the default makes "no daily budget" and "service not wired yet" indistinguishable —
      here on the path that feeds the *planner*, not a preview, so a reordering would silently plan without
      the daily budget instead of failing loudly. Ship the rule with no live counter-example: assert, or
      state in the closure why absence is a genuine domain value at this seam. Behaviour-neutral today.
      Source: adversarial review of PR #1889, 2026-07-26. File: `setup/homeRuntime/homeScope.ts`.
- [ ] **`realtime.ts` is now a re-export facade for tab navigation it no longer owns.**
      *Persona:* Contributor (`notes/personas.md`) looking for `showTab` and finding it re-exported from a file
      named "realtime".
      *Hypothesis:* PR 3b split `realtime.ts` into `uiRefreshTasks.ts` / `settingsChangeRouter.ts` /
      `tabNavigation.ts` but kept `export { setActiveTabIndicator, showTab } from './tabNavigation.ts'` (and the
      two refresh helpers) so existing importers did not have to move — six call sites across `boot.ts`,
      `deadlinePlanRouter.ts` and `packages/settings-ui/test/settings.test.ts`. *Why it's needed:* the facade
      spends half the readability win of the split. Repointing those six imports at the owning modules and
      deleting the two `export … from` lines finishes it. Deliberately deferred: `realtime.ts` is edited by
      several in-flight multi-home PRs, so the churn was not worth the conflict surface during the train.
      Source: PR-3b adversarial review, 2026-07-26.
- [ ] **Two extracted dep types duplicate their parent's members verbatim.**
      *Persona:* Contributor (`notes/personas.md`) adding a dependency to the plan builder or the app
      service wiring and having to edit two type declarations that must stay compatible.
      *Hypothesis:* `PlanMaterializationDeps` (`lib/plan/planBuilderMaterialization.ts`) restates 15
      members of `PlanBuilderDeps`, and `DeviceTransportWiringDeps`
      (`setup/appInit/wireDeviceTransport.ts`) restates 15 members of `AppServiceWiringDeps`,
      including two verbatim copies of the inline `getShedBehavior` / `getFlowConflict` shapes. Both
      are drift-SAFE today — each call site passes a variable, not a fresh literal, so a rename or
      narrowing on the parent fails the build — so this is duplication cost, not a correctness hole.
      The plan one is free to collapse (`PlanBuilderDeps = PlanMaterializationDeps & { … }`; the two
      sets partition cleanly). The setup one must use a **shared slice type** that both
      `appServiceWiring.ts` and `wireDeviceTransport.ts` import — NOT a type-only import back into the
      leaf. `appServiceWiring.ts → appInit/wireDeviceTransport.ts` is a value edge, so importing
      `AppServiceWiringDeps` back would form a genuine cycle; `arch:check` would stay green only
      because `tsPreCompilationDeps` is unset, which makes type-only edges invisible, NOT absent
      (the cruiser config says so at `.dependency-cruiser.cjs:327`). A type-aware cruise reports it.
      Do not cite checker blindness as permission. *Why it's needed:* the structural declaration was
      chosen to avoid importing the parent back; that is worth keeping, but the copies should be
      derived rather than retyped.
      Source: PR-3b adversarial review, 2026-07-26.
- [ ] **Residual tracker contamination after meter-scope invalidation.** When the whole-home meter
      selection changes, the weather collector forgets its meter-derived state — but the kWh
      reconcile still trusts the power tracker first, and the tracker's retained daily totals for
      the last ~30 days were measured under the OLD scope, so recent days can be re-vouched with
      old-scope values until they age out. Bounded (the fit spans up to two years of days), but a
      fit seeded with mixed-scope days is quietly wrong for weeks. Persona: owner who split their
      home into meter areas mid-season. *Hypothesis:* the energy signature drifts silently right
      after the scope change, when the owner is most likely to be watching it. Files:
      `lib/weather/weatherCollector.ts` (kWh reconcile), power-tracker daily totals.
      Source: multi-home finishing train, weather meter-scope PR. [P3]
- [ ] **Usage footer promises a Main-only reset under area scope.** "Reset usage history lives under
      Settings → Advanced" resets Main's tracker; a per-home reset through the bundle's persistence
      API is not built. Either scope the footer copy per home or build the per-home reset (route it
      through the bundle's persistence API, never a raw suffixed settings write — it collides with
      `SuffixedTrackerPersistenceController`'s echo-suppression latch). Persona: meter-area owner
      wanting a clean slate for one rental unit. *Hypothesis:* the owner follows the footer, resets
      the wrong home's history, and loses Main's data without clearing the area's. Files:
      `packages/settings-ui/src/ui/power.ts` (footer), `setup/homeRuntime/` (persistence API).
      Source: multi-home finishing train, per-home Usage PR. [P3]

### Meter-area beta review follow-ups

- [ ] **Finish scoped settings-surface loading and unavailable states.** Keep the beta treatment
      deliberately lightweight, but avoid blank or contradictory surfaces: give an area's Limits
      card a bounded loading/unavailable state; make single-home unavailable copy work without
      promising a scope picker; include unmanaged-but-eligible candidates in scoped Devices; retain
      the last-good source instead of normalizing a failed scoped read; and represent an unavailable
      Power source without relying on a Material select value that has no option. Persona:
      meter-area owner opening settings during boot, a transient read failure, or membership churn.
      Source: deferred review threads on PRs #1896, #1908, #1914, #1915 and #1916. [P3]
- [ ] **Remove remaining Main-only claims from area Overview and Usage renders.** Suppress Main's
      "cheapest hour ahead" anticipation for capacity-only areas; make the detail overlay consume
      the area's plan and effective simulation posture; preserve scoped power/plan unavailable
      results instead of falling back to Main; use runtime `dryRunEffective` while an area's
      actuation fence is closed; refresh the selected area's Usage source and tracker state; and
      either hide or explicitly label Main-only smart-task detail. Persona: meter-area owner who
      trusts the shown-home bar to describe every card below it. Source: deferred review threads on
      PRs #1914, #1916 and #1917. [P3]
- [ ] **Harden roster, badge and realtime churn after the beta settles.** Treat contradictory
      `hasSubHomes`/homes payloads as unavailable, add a bounded retry for the first unavailable
      badge read, preserve last-good badge state across unset/malformed payloads, repaint realtime
      zone moves and mode edits without losing local choices, and explicitly reject prototype-key
      and other malformed home identifiers. Keep truncated badge focus and similar keyboard polish
      in this same batch rather than blocking the beta train. Persona: owner editing zones or meter
      areas while another WebView is open. Source: deferred review threads on PRs #1909, #1911,
      #1913 and #1914. [P3]
- [ ] **Revisit non-critical runtime edges exposed by meter-area review.** Re-resolve held
      operating-mode aliases and make
      partial rename rollback explicit; document/cache the per-home mode resolution contract; and
      tighten markerless roster/readiness recovery without weakening the existing Main actuation
      fence. Also make interrupted additive mode renames resumable; show Home or an honest
      unavailable state in device detail before a new area's catalog lands; preserve matching
      source-mode targets across ownership moves instead of filling every missing destination mode
      from one anchor; and suppress the five initialization-setting echoes after the catalog
      write. Persona: long-running beta install that renames modes or changes meter topology.
      Source: deferred review threads on PRs #1910, #1911, #1913 and #1923. [P3]
- [ ] **Consolidate low-value mirror and fixture coverage from the stack review.** Add an executable
      check for the deploy-time `homeId` query-key mirror, assert `CAPACITY_LIMIT_KW` in the existing
      contracts/runtime settings-key mirror test, and clean up the test-lane/fixture-only comments
      (including the #1894-style internal-port classification nit) when those suites are next
      touched. These are drift guards, not evidence of current behavior regressions. Persona:
      contributor renaming a shared key or reorganizing tests. Source: deferred review threads on
      PRs #1894, #1896 and #1908. [P3]
