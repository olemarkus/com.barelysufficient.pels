# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

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

No open P0 release blockers after the 2026-07-25 release-review cleanup. That
pass partitioned realtime reconcile work by home, finite-gated saved meter-area
limits, and corrected the Main-meter setup guide. Remaining multi-meter work is
tracked as P1/P2/P3 follow-up below.

## P1 Correctness, Data Integrity, and Supported UX

*v2.9.0 closeout and v2.8.x release-review follow-ups. These are safe for
patch releases, not release blockers; each item carries its own source/date.
(The v2.8.0 card-title rename landed in PR #934.)*

- [ ] **A smart task loses its budget exemption mid-planned-bucket when the learned rate flaps
      to `objective_missing_charge_rate`.** Prod 2026-08-01 18:40:45: the water heater's objective
      flipped `on_track` → `unknown` (`reasonCode: objective_missing_charge_rate`) while its
      current bucket had 1.183 kWh planned; `unknown` is not plannable, so the per-cycle admission
      decision resolved `budgetExempt: false` (`lib/objectives/deferredObjectives/admission.ts`
      ~91/101), the exempt add-back vanished, and the hero's safe pace collapsed 2.2 → 1.3 kW in
      one cycle — the horizon log kept printing `budgetExemptApplied: true` (the config flag) the
      whole time, which is why the drop looked inexplicable. 398 `deferred_objective_unknown`
      events for this one device in a single day's log: the rate-confidence lane flaps, and every
      flap strips the exemption and yanks the pace. The task's protections should degrade
      gracefully through a transient rate gap (grace window on the last plannable status, like the
      SDK-read abandon-grace convention), and the horizon log should carry the per-cycle applied
      exemption, not only the config flag. Found in the 2026-08-01 per-axis-admission
      investigation. [P1]

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

- [ ] **An EV SoC reading goes stale the instant a long pause ends.** `resolveStateOfChargeStatus`
      (`lib/device/transport/stateOfCharge.ts` ~360) stops ageing a reading out while the charger is
      idle — that is the fix in PR #1897 — but once `chargeInMotion` becomes true again it compares
      `nowMs - observedAtMs` against `EV_SOC_STALE_MS` using TOTAL wall-clock, which includes the
      whole idle interval. So a charger paused longer than 40 minutes has an immediately-stale
      reading the moment PELS resumes it, and `measure_battery` is change-only: the car cannot
      republish until the level actually moves. The objective can therefore fall to
      `objective_progress_stale` in the window right after a resume and pause the charger again,
      which is the oscillation shape #1897 exists to remove, reached by a different route. The fix
      is to measure staleness against elapsed CHARGE-IN-MOTION time, or grant a fresh window from
      the idle-to-charging transition — either way it needs a new retained field threaded through
      `RetainedStateOfChargeSession`, so it is its own change rather than a rider on #1897. Raised
      by Codex on PR #1897, 2026-07-27. Two adjacent session/freshness holes found in the same
      review, both left open deliberately: (a) a reconnect observed WITHOUT `lastUpdated` anchors
      nothing, so the invalidation stands and an idle charger — which republishes only on a level
      change — keeps a stale reading indefinitely. Substituting the refresh time was implemented and
      then reverted on #1897, because a full refresh can carry a cached connected state older than a
      newer realtime plug-out (`snapshotRefresh.ts` parses the pull before merging retained fresher
      observations) and a fabricated future `sessionStartedAtMs` cannot be undone by reapplying that
      plug-out — trading a stale reading for a session anchored to the wrong car. A correct fix needs
      the refresh path to distinguish cached from fresh connected evidence, not a timestamp
      substitution at this seam. (b) For a charger that keeps a generic `plugged_in` and only toggles
      `evcharger_charging`, that boolean is the sole age-gate input, but the realtime binary path
      mutates `snapshot.evCharging` without re-running `resolveStateOfChargeStatus` — so freshness
      only moves on an unrelated refresh or SoC event. Recompute SoC freshness whenever the charging
      boolean changes. The SAME missing accounting causes the mirror defect: once a
      reading HAS aged out during a genuine charging interval, the next idle observation reaches the
      unconditional `if (!chargeInMotion) return 'fresh'` and resurrects it, so objective and
      EV-boost consumers trust a percentage that may have moved a long way while the charger was
      delivering. Accumulated in-motion age fixes both directions at once — do them together, and do
      not patch one with a sticky flag. Persona: EV owner whose overnight smart task is paused by
      PELS and then stalls the moment PELS restarts it; hypothesis: a task that stalls on resume is
      indistinguishable from one that never planned. [P1]

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
      `Elbillader`, badged "Always on"
      (`PLAN_CARD_ALWAYS_ON_CHIP_LABEL` = budget exempt), took 20 `diagnostics_shed_recorded` /
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

      **The exemption IS reaching the planner.** The card rendered the "Always on" chip, which
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
      "Always on" that never draws; hypothesis: whichever cause holds, a resetting countdown reads
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

- [ ] **A fenced Main home stops protecting its physical hard cap, and the UI can only warn that it
      MIGHT be happening, not that it IS.**
      *Persona:* multi-meter owner on the DEFAULT Automatic whole-home meter whose area meter happens
      to sort first among the Homey Energy `cumulative` items. *Hypothesis:* the Main actuation fence
      refuses ALL commands including sheds (`setup/appInit/createPlanEngine.ts:30-33`), so a proven
      sampled-meter collision suspends hard-cap protection. The hard cap is the hourly grid tariff
      step (effekttrinn), and not a tuning knob. It is not breaker protection and cannot be: an
      hourly average says nothing about the peak inside the hour, so the copy this entry directs
      must never promise it (`notes/ui-terminology.md`, "Hard cap is an hourly ceiling").
      That trade-off is deliberate (the reading really is unattributable). `HOMES_MAIN_METER_NOTICE`
      now names BOTH consequences, including that PELS may have stopped limiting Main entirely, so
      the notice is no longer wrong — and the EXPLICIT-selection clash is now surfaced outright:
      `ui_homes` carries `mainMeterConflictAreaName` (resolved from the same classifiers the save
      gate uses) and the Multiple meters panel leads with "PELS has stopped limiting your Main
      home", naming the area. The remaining gap is every SAMPLED-clause fence state — this entry's
      Automatic persona, but also an explicit selection inside the switchover window, where the
      configured id is already clean (so `mainMeterConflictAreaName` is null) while the last
      admitted sample still belongs to the area until the replacement poll lands
      (`homeMainMeterAuthority`, the sampled clause). `HomeMembershipService.getDiagnostics()`
      still does not expose that fence, so an owner who is currently unprotected reads the same
      MIGHT-sentence as one who is merely over-limited. Expose the sampled-clause fence state in
      diagnostics and render state-specific copy. Note PR 4 (require an explicit Main meter)
      removes the reachable Automatic configuration, so that arm may reduce to a transitional
      state; the switchover window remains.
      Source: pels-runtime-reality review of the multi-home finishing train PR 2.

- [ ] **An id-less whole-home aggregate can be an area's meter, and the signal that detects it is discarded.**
      *Persona:* owner whose ONLY device marked "tracks total home energy consumption" is the annex
      meter. *Hypothesis:* Homey then emits an aggregate `cumulative` item with no id whose value is
      that meter alone (`lib/device/managerEnergy.ts` already documents id-less aggregates), so Main
      plans against the annex's physical sample while the annex bundle plans the same sample over a
      disjoint device set — the `notes/multi-home-model.md` violation — with `sampledDeviceId === null`
      and therefore no fence. `cumulativeItemCount` is already computed and logged but never consumed;
      `cumulativeItemCount >= 1 && sampledDeviceId === null && areas have meters` is a usable detector
      and should at least warn. Related: the fence's stated harm is "one sample driving two
      controllers" but its trigger is an id match, so it fences areas that are not actuating while not
      fencing equally unattributable readings. Pick one framing and make code and docs agree.
      Source: pels-runtime-reality review of the multi-home finishing train PR 2.

- [ ] **`has_headroom_for_device` answers about a meter-area device with the Main home's guard, and
      mutates Main's cooldown state doing it.**
      *Persona:* multi-meter owner whose annex EV charger asks "is there available power for device?"
      in a Flow before it starts a session. *Hypothesis:* every input the card reads is bound to Main.
      `getHeadroom`/`getCapacityGuard` resolve `ctx.capacityGuard`
      (`setup/appInit/registerAppFlowCards.ts:64-65`) and `evaluateHeadroomForDevice` resolves Main's
      plan service (`:117`), so an area device is measured against Main's available power instead of
      its own meter's. The run listener is also not a read: `evaluateHeadroomForDevice(...
      cleanupMissingDevices: true)` writes Main's `PlanEngineState` (headroom-card cooldowns,
      activation penalties, activation-attempt diagnostics, `lib/plan/planHeadroomDevice.ts:82-120`)
      over the FULL unfiltered snapshot, and a `stateChanged` result then requests a Main plan
      rebuild. So asking about an area device perturbs Main's control state. Fix direction: resolve
      the device's owning home and answer from THAT home's guard, routing any rebuild to that home.
      Deliberately NOT refused or filtered out of the picker: the card takes a device and a device
      already names its home, so it stays in scope and must keep working (owner ruling, 2026-07-26).
      Blocked on the per-home runtime read seam: `HomeRuntimeRegistry` is a private field of
      `AppServiceWiring` and `HomeCapacityBundle` exposes no guard/available-power handle, so fix
      this together with that seam. Files: `flowCards/headroomAndEvSocCards.ts:37-77`,
      `setup/appInit/registerAppFlowCards.ts:64-65,117`,
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

- [ ] **A mode-target raise bypasses headroom admission even with a fresh power reading — planner-wide.**
      *Persona:* owner of a small-cap meter area (or a tight Main hard cap) whose heater's expected draw
      exceeds the headroom left at the moment a mode raise lands (e.g. 5.5 kW of a 6 kW cap, ~2 kW
      heater, 18→22). *Hypothesis:* a mode-target raise from a NON-shed state is emitted as an ordinary
      `target_update` (`resolvePlannedTarget`, `lib/plan/planDevices.ts`), so unlike the from-shed
      release lane — which IS admission-gated on headroom (`applyRestorePlan`,
      `insufficient_headroom`) — it consults neither `context.headroom` nor the device's expected load,
      briefly pushing the home over its soft limit until the next poll's shed cascade recovers (with
      restore backoff damping any oscillation). This is Main's long-standing command-intent →
      measure → shed model, deliberately preserved when mode targets bound live for meter areas
      (PR #1886, owner decision "PELS drives area setpoints"); gating it on headroom + expected-load
      reservation is a planner-wide product change affecting Main identically, so it needs an owner
      call, not a rider on the area fix. Raised by Codex on PR #1886, 2026-07-27, declined there as
      pre-existing-by-design.

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

- [ ] **An EV charger needs two `evcharger_charging=true` writes and ~90 s to actually start.**
      Prod 2026-07-26, first session PELS ever started from a bare `plugged_in` charger: the
      19:32:37Z write logged `binary_write_timeout` then
      `stepped_load_restore_binary_undriven` (step prepared, binary axis not driven on); the
      19:34:07Z retry is what landed, with draw appearing at 19:35:07Z. So the resume path
      recovers, but only via the retry — ~2.5 min from admission to current flowing, on a device
      that was already admitted with 7.3 kW of headroom. Same family as `2e637fb40` ("step
      prepared, still off"), which is present in that build, so this is a *remaining* gap in the
      stepped-restore binary phase rather than a regression of it. Worth confirming whether the
      first write is lost at the Homey seam (the timeout) or the executor declines to drive the
      binary axis on that cycle. Persona: EV owner who plugs in and watches nothing happen for two
      minutes. Source: prod verification of the plug-state commandability fix. [P2]

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

- [ ] **An observed-off device attributes usage from whatever step it is parked at.**
      `resolveObservedOffUsageKw` (`lib/plan/planUsage.ts` ~36-41) falls to
      `getHighestKnownPowerKw`, which takes the max of measured/expected/planning/configured —
      so a device measuring 0 W is still attributed non-zero usage, and since 2026-07-25 that
      `planningPowerKw` can be a drifted step rather than the restore step (1.38 kW → 7.36 kW for
      a charger that reverted to 32 A). That flows into the managed/background split
      (`lib/power/sampleIngest.ts`), the budget-exempt bucket, the daily budget, the learned
      background profile, and the smart-task headroom reserve. The mis-attribution pre-dates the
      2026-07-25 change (it attributed the lowest step before), and the exposure is bounded: a
      `plannedState: 'shed'` device attributes 0, so only the `keep`-and-observed-off restore-pending
      window is affected, which is normally seconds. Fix is a semantics call — either attribute the
      restore step for an observed-off device, or attribute 0 and let the restore reservation carry
      it — so it does not belong in a patch release. Source: adversarial review of the flow-report
      admission, 2026-07-25. [P2]

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
      no limit is holding is still wrong. Source: prod investigation + test suite, 2026-07-25. [P2]

- [ ] **Stepped devices never say how much power a resume is waiting for.**
      `steppedRestoreAdmission.ts` hardcodes `headroomKw: null` on both `restoreNeed` reasons, so
      `formatRestoreNeedUserFacing` (`packages/shared-domain/src/planReasonFormatting.ts` ~388-389)
      falls through to the bare "Waiting for available power", while binary/temperature devices —
      which go through `planReasonStrings.ts` with real admission margins — get
      "Waiting to resume — X kW more needed" (the admission-accurate shortfall from
      `resolveRestoreShortfallKw`; do NOT reintroduce the retired "needs X kW, Y kW available"
      pair). `availableHeadroom` is already in scope at
      both sites, so this is a two-line fix. Persona: owner watching a paused EV charger and unable
      to tell how far off a resume is. Source: prod investigation 2026-07-25. [P2]

- [ ] **"Raising target 6a to 6a".** `formatRestoreNeedUserFacing`
      (`packages/shared-domain/src/planReasonFormatting.ts` ~385-387) renders
      `Raising target ${fromTarget} to ${toTarget}` with no equality guard, and
      `steppedRestoreAdmission.ts` ~69/~88 sets `fromTarget` to the observed step and `toTarget` to
      the restore step — equal whenever the device already sits at the restore target, which became
      the common case once flow step reports were admitted while off (2.17.3). The from/to branch
      also takes precedence over the need/available suffix, so it hides the numbers even when they
      exist. Best fixed together with the entry above: guard on inequality and let the suffix carry
      it. Source: prod investigation 2026-07-25. [P2]

- [ ] **A shed-invariant hold renders as "Limited by the hard cap" on the stepped card.**
      `isLimitedReason` in `packages/shared-domain/src/planSteppedCardText.ts` (~133-135) includes
      `PLAN_REASON_CODES.shedInvariant`, and the `PLAN_STATE_CAPACITY_STATUS` return at ~260 fires
      before the dedicated `shedInvariant` branch at ~302 ever runs — so a safety-rule hold is
      reported as the hard cap, which is neither what is happening nor a lever the owner has
      (feedback_hard_cap_is_physical). Pre-dates the 2026-07-25 capacity/held-fallback constant
      split, which renamed the constant without changing which reasons reach it. Fix: a
      capacity-only predicate for that branch, so `shedInvariant` falls through to its own wording,
      plus regression coverage. `planTemperatureCardText.ts` is NOT affected — its `isLimitedReason`
      excludes `shedInvariant`. Closely related to the entry below (same card, same overstatement).
      Source: CodeRabbit review of #1876, 2026-07-25. [P2]

- [ ] **"Blocked by safety rule" on a device running normally at its target step.** Seen on 2.17.3
      with the EV charger `Active` at 1.36 kW on step `6a` and `reasonCode: shed_invariant`. The
      invariant only refuses step *increases* while other devices are limited; it never pushes a
      device down, so "blocked" overstates what is happening to a device that is running. Same root
      as the existing `resolveSteppedStatusLine` entry above (rendering the invariant's cap rather
      than the device's state). Source: prod observation 2026-07-25. [P2]


- [ ] **Shed-invariant card copy claims a step the device is not at.** `resolveSteppedStatusLine`
      renders the shed-invariant reason as `Limited to ${maxStep}`
      (`packages/shared-domain/src/planSteppedCardText.ts` ~307), but `maxStep` is the invariant's
      cap (lowest non-zero step), not the device's state — prod 2026-07-05 20:07 showed "Limited
      to Low" while Connected 300 ran at Medium drawing 1.2 kW (the invariant only refuses
      increases; it never pushes a device down). The reason struct already carries
      `fromStep`/`toStep`; render from those instead, e.g. "Holding at Medium — can't increase
      while 10 devices are limited". Source: overview correctness review (2026-07-05).
- [ ] **Hero limited-count disagrees with the stepped card's "N devices still limited".** The
      hero counts `stateKind === 'held' || plannedState === 'shed'` (11 on the 2026-07-05 screen,
      including a hold-reason EV that was never shed), while the stepped card's count comes from
      the planner's `countShedDevices` (`lib/plan/restore/coordination.ts`), which counts only
      `plannedState === 'shed'` and skips non-controllable devices (10). Both internally correct,
      visibly off-by-one on one screen. Either feed the card the same held||shed count the hero
      uses, or drop the count from the card copy. Source: overview correctness review
      (2026-07-05).
- [ ] **Simulation honesty on the device-detail activity log.** The Overview plan cards + hero
      now read hypothetically with simulation on (PR #1819: card header "Would be turned off
      (simulation)", reason line "Would still draw N kW", hero "N devices would be limited right
      now"). But `formatDeviceOverview`'s `stateMsg` (`resolveShedStateMsg` / `resolveEvStateMsg`,
      `packages/shared-domain/src/deviceOverview.ts` ~175-226) still emits factual "Charging
      paused" / "Turned off" / "Lowered", feeding the device-detail activity log
      (`DeviceLogView.tsx`) + runtime logs. If the device-detail log should also read
      hypothetically under simulation, thread `dryRun` there too — out of scope for PR #1819
      (Overview plan-card surface only). Source: PR #1819 review gates (2026-07-02).
- [ ] **An unresolved budget-exempt draw is treated as zero exempt draw.**
      `computeDailySoftLimit` (`lib/plan/planBuilder.ts:534`) does
      `sumBudgetExemptLiveUsageKw(devices) ?? 0`, but that producer
      (`lib/plan/planUsage.ts:75`) returns `null` when exempt devices exist and none report
      power, and returns a silent *partial* sum when only some report. `budgetPaceImportKw` then
      collapses to `budgetPaceKw` while `P_import` still includes the exempt device's draw, so
      the threshold is short by that draw and non-exempt devices get shed for a missing reading
      rather than for real budget pressure. Given that Homey reads transiently fail, this is
      reachable in normal operation. Fix at the producer: return an explicit "exempt draw
      unresolved" state (and distinguish partial from complete) and have the planner handle it
      rather than defaulting to zero. Same `?? null` path feeds `lib/power/sampleIngest.ts:167`,
      so the energy bucket silently stops excluding that device for the interval too. Note the
      rebased threshold needs no floor: `P_import > budgetPaceKw + exemptKw` already equals
      `P_nonExempt > budgetPaceKw`. No clamp is missing anywhere on the kW axis;
      `P_nonExempt` stays signed, per the naming/ownership refactor below. Also correct the
      stale comment at `lib/plan/planReasons.ts:63-68` while here: it says the daily limit "adds back
      only an exempt device's LIVE draw, zero while it is off", but `computeDailySoftLimit` sums
      `PlanInputDevice[]`, which carries no `plannedState`
      (`packages/planner-types/src/planInputDevice.ts:112-114`), so `resolveUsageKw` cannot take
      its shed-zero branch and an observed-off exempt device falls to `getHighestKnownPowerKw`
      instead. The add-back already projects an off device's expected draw, which matters
      because a future "project the candidate draw so exempt devices are capacity-bound for
      restore" change would double-count. Same fallback as the open P1 observed-off attribution
      item. Source: safe-pace model review (2026-07-26); see `notes/safe-pace-two-constraints.md`.
- [ ] **A tight-capacity hour hands `softLimitSource` over to `'capacity'` near `:00`.**
      `capacityPaceKw` decays toward `sustainableRateKw` as the hour ends
      (`lib/plan/planBudget.ts:44-46`) while `budgetPaceImportKw` holds level, so a hand-over
      fires exactly when the rebased daily pace sits above the decaying capacity pace near the
      boundary. It does not fire when the daily pace is well below the sustainable rate (a 2 kW
      daily pace against an 8 kW sustainable rate stays daily-bound through `:00`), so this is a
      conditional transition on tight-capacity hours, not a guaranteed hourly one. When it does
      fire it moves every `softLimitSource` consumer at once: the reason copy flips from budget
      to capacity, `resolveLimitReason` follows, starvation cause attribution re-buckets, and the
      startup stabilization gate (`lib/plan/restore/index.ts:55`) changes state. Decide whether
      the reason line should change under the user at the hour boundary, and whether the runtime
      gates should read a `capacityActive` predicate rather than the display source. Distinct
      from the open `resolveSoftLimitSource` hysteresis item (that one is epsilon-band jitter,
      this is a real transition) but they share consumers and should be designed together.
      Source: safe-pace EOH review (2026-07-26).

- [ ] **The docs define safe pace as "hard cap minus safety margin", which is wrong.**
      `docs/glossary.md` ("Safe pace") and `docs/how-pels-decides.md` (~line 55) both state the
      safe pace *is* the cap minus the margin. It is not: the capacity pace is a burst rate,
      `remainingKWh / remainingHours` capped by the end-of-hour drain ceiling
      (`lib/plan/planBudget.ts:20`), which legitimately sits *above* cap-minus-margin for most of
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
      four different quantities depending on call site and wiring, and the unwired fallbacks
      disagree with each other: `lib/power/capacityGuard.ts:124-129` falls back to the hourly
      allowance, `lib/executor/shortfallExecutor.ts:40-41` falls back to the **hard cap**,
      `lib/diagnostics/periodicStatus.ts:83` and `lib/plan/rebuildScheduler/signalDriven.ts:86-87`
      to the allowance. A caller cannot tell which quantity it got, so a wiring regression
      degrades to a quieter limit instead of failing loudly, which is the root `AGENTS.md`
      "unavailable must not become a default" rule applied to a control threshold. Adopt the
      canonical names in `notes/safe-pace-two-constraints.md` § "Canonical names"
      (`hardCapKw`, `safetyMarginKw`, `hourlyAllowanceKWh`, `sustainableRateKw`, `capacityPaceKw`,
      `budgetPaceKw`, `budgetPaceImportKw`, `bindingPaceKw`) and give each exactly one producer.
      `hourlyAllowanceKWh` and `sustainableRateKw` are one owner with two named readings, since
      `planBudget.ts:25` subtracts it as energy and line 44 multiplies it as a rate. "One owner"
      means one per scope: the capacity rows are per home (each bundle wires its own provider,
      `setup/homeRuntime/createHomeCapacityBundle.ts:406`), the budget rows are main-only
      (sub-homes get `getDailyBudgetSnapshot: () => null`, `createHomeCapacityBundle.ts:291`), so
      a sub-home has no `budgetPaceKw` and its `softLimitSource` can never be `'daily'`. Concrete work:
      (a) collapse the five independent `hardCapKw - safetyMarginKw` computations
      (`lib/power/capacityModel.ts:7`, `lib/power/capacityGuard.ts:129`,
      `lib/plan/rebuildScheduler/signalDriven.ts:87`, `lib/power/sampleIngest.ts:159`,
      `packages/settings-ui/src/ui/capacity.ts:219`) onto one owner. It is a pure function of two
      settings values with no runtime state, so the owner is the capacity-settings owner, and it
      should be handed out already resolved next to the existing `getHardCapKw` accessor
      (`setup/homeRuntime/homeScope.ts:153`). The settings UI then receives it through the
      contract as data rather than recomputing it, which also sidesteps that it cannot import
      `lib/**`;
      (b) delete `resolveCapacitySoftLimitKw` (`lib/power/capacityModel.ts:10`), an alias of
      `resolveUsableCapacityKw` whose name promises the capacity pace but returns the allowance;
      (c) make `capacityGuard.getSoftLimit()` return one quantity, surfacing an unwired provider
      as an explicit unresolved state rather than a substituted threshold, and decide the caller
      contract at the same time: `lib/executor/planExecutor.ts:428` needs a number, so specify
      fail-closed (matching the stale-meter posture) rather than today's fall back to
      `hardCapKw`, which is the loosest candidate. Without that the ambiguity just moves from the
      producer to every call site;
      (d) give `budgetPaceKw` a real name and producer instead of leaving it an unnamed
      intermediate inside `computeDailySoftLimit`, so downstream can obtain the pace that applies
      to the non-exempt house;
      (e) materialise `P_nonExempt = P_import - exemptKw` on `PlanContext` and `plan.meta`,
      **unclamped**. The power side only ever has it as an implicit term inside the rebased
      threshold, so nothing downstream can show the user what is actually measured against their
      budget. It equals `nonExemptGross - solar` and goes negative when solar more than covers
      the non-exempt load, which is the exact analogue of `P_import` going negative on export
      (`capacityGuard.reportTotalPower` does not floor). Do not add a floor: it would break the
      deficit identity in the item below (`capacityPaceKw` 20, `budgetPaceKw` 5, `exemptKw` 7,
      `P_import` 2 gives 10 kW headroom today and 5 kW clamped, delaying restores). The kWh axis
      keeps its floor for the separate reason at `lib/plan/planHourContext.ts:21-22`. Ship it as
      **two distinctly named quantities with distinct contract fields**, not one field computed
      two ways: `P_nonExemptControl = P_import - projectedExemptKw` and
      `P_nonExemptMeasured = P_import - measuredExemptKw`. `sumBudgetExemptLiveUsageKw` returns
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
      `resolveSoftLimitSource` further down: adding a `'both'` band keeps the resolver stateless,
      so a pace difference oscillating across the epsilon boundary still alternates
      `capacity`/`both`/`daily` between rebuilds and every source-dependent surface still
      flickers. That item stays open and needs retained state or enter/exit thresholds. Fix the
      `?? 0` P1 above first. Source: safe-pace model review (2026-07-26); design in
      `notes/safe-pace-two-constraints.md`.

- [ ] **Tighten the device-state snapshots to discriminated types.** `TargetDeviceSnapshot`,
      `DevicePlanDevice`, and `PlanInputDevice` carry binary/temperature/stepped/EV/freshness/power
      fields as one nullable bag; discriminate by control kind so the compiler enforces per-variant
      field presence (removes a class of nullable-field bugs). Files: `packages/contracts/src/types.ts`,
      `lib/plan/planTypes.ts`, `lib/plan/planBuilder.ts`, settings UI contract tests.
      **Slice 1 (control-kind TYPE GUARDS) landed:** added narrowed helper types
      `SteppedLoadKind` / `SteppedPlanDevice` / `SteppedPlanInputDevice` in `lib/plan/planTypes.ts`
      and converted `isSteppedLoadDevice` (`lib/plan/planSteppedLoad.ts`) into a real type guard
      (overloads narrow the two flat plan device types to their `Stepped*` slices, plus a generic
      overload for `Pick`-typed callers). Migrated the ~11 plan/executor sites that already branch on
      the stepped discriminant so they read `steppedLoadProfile` without `?.`/null-assert. **No fields
      were moved off the base types** — the flat types keep every field optional; narrowing happens
      only at the guard. The field-level variant discrimination that actually forbids cross-kind
      field reads (temperature ~21 files, stepped ~34, EV ~26) and the `TargetDeviceSnapshot`
      discrimination (~119 importers) remain as follow-up slices. Temperature/EV kind guards were NOT
      added in slice 1 — no plan/executor site branches on `controlModel === 'temperature_target'`
      (or the EV capability) and then reads kind-specific fields un-narrowed, so a guard would be
      dead code; add those alongside the field-move slices that create real consumers.
      **EV-observed guard landed (slice 1 of the observer-snapshot EV discrimination):** added
      `isEvObserved(snapshot): snapshot is EvObservedSnapshot` + `EvObservedSnapshot` (=
      `TargetDeviceSnapshot & { evChargingState: EvChargingState }`) — the observer-snapshot twin of
      `isEvPlanDevice` (since relocated to `packages/shared-domain/src/evObservedState.ts` by the
      field-move slice below). `getEvRestoreBlockReason` (`lib/device/deviceActionProjection.ts`)
      narrows through it (behaviour-preserving: EV + no resolved state → `state_unknown`, as before).
      **EV-vocabulary de-couple landed (2026-06-07, PRs #1528/#1531/#1540/#1544/#1554/#1561/#1568/#1570/#1571):**
      every consumer in `lib/plan`/`lib/objectives`/`lib/executor`/settings-UI now reads producer-resolved
      bits / shared-domain predicates (`isEvDevice`, `resolveEvBlockReasonForDevice`,
      `isEvSessionInactiveForDevice`, `resolveEvBoostBlockReason`) instead of raw plug-state, and
      `scripts/check-ev-vocab.mjs` (in `ci:checks`) forbids `plugged_*` literals in those three layers.
      **EV field-move landed (2026-06-07): `evChargingState` removed from `EvPlanInputKind` /
      `DevicePlanDevice` (`EvKind`) / `ObjectiveDeviceInput`.** The producer
      (`setup/appInit/toPlanDevice.ts`) now resolves the observed plug-state ONCE into a flat
      `evCommandability: EvCommandabilityResolution` (`{ blockReason, sessionInactive, chargerNotResumable }`,
      new type in `@pels/contracts`) via `resolveEvCommandability` (shared-domain); it is threaded through
      the `planDevices`/`planReconcileState` carriers and the `withEvDiscriminant` regrouper. The device-shaped
      resolvers (`isEvSessionInactiveForDevice` / `isEvChargerNotResumableForDevice` /
      `resolveEvBlockReasonForDevice` / `isEvBoostBlockedByPlugState`) read the materialized flat bits only —
      the raw-`evChargingState` consumer arm was retired once every caller passed materialized fields; the sole
      reader of the raw plug-state is the producer `resolveCommandableNow`. Architectural
      correction surfaced in review: the settings-UI read model used to read `evChargingState` off the plan
      device — but the **observer** is its canonical owner (`ObservedDeviceState.evChargingState`), so
      `settingsOverviewReadModel` now sources it via a `getObservedEvChargingState` planService dep wired to
      `ctx.getObservedState(id)`. `evChargingState` stays on `TargetDeviceSnapshot`/`ObservedDeviceState`
      (transport + observer + settings-UI display) as designed. Fixed in passing: `isEvPhysicallyUnplugged`
      read the raw string directly (would have silently no-op'd on plan devices after the move) — now reads the
      materialized `evSessionInactive` bit.
      **`evChargingState` typed as the `EvChargingState` union (closed enum) — foundation landed.** Field +
      every consumer type now use `EvChargingState` (no `string`, no `null`); the producer
      (`getEvChargingState` + the two realtime seams) normalises any vendor value outside the capability enum
      to `undefined` (uncommandable / `state_unknown`), and the verbose "unknown charging state 'X'" diagnostic
      was dropped (unknown is ignored, not surfaced).
      **EV-observed field-move landed (2026-06-12): `evChargingState` is OFF the base
      `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.evChargingState` read is now a
      hard TS2339; consumers narrow through `isEvObserved` (moved to
      `packages/shared-domain/src/evObservedState.ts`, browser-safe, generic over the carrier so settings-UI
      narrows the same way — first UI consumer: the EV-boost status in `deviceDetail/evBoost.ts`). New contracts
      types: `EvObservedFields` (required `evChargingState`, the narrowed cluster) + `EvObservedProbe` (the
      optional "might be EV-observed" loose shape). OWNER seams keep physical custody via probe-widened types:
      `TransportDeviceSnapshot` (`lib/device/transportDeviceSnapshot.ts`) for transport's stored/mutated
      snapshots (the transport halves swapped wholesale — they never leak outside `lib/device`), and
      `readObservedEvChargingState` (`lib/observer/observedDeviceStateProjection.ts`) as the one sanctioned raw
      accessor feeding the read-model's flat DTO field. `toPlanDevice` widens its param with the probe (it
      resolves + strips, as before). Type-level only — zero runtime behavior change. NOT moved, deliberately:
      `stateOfCharge` (independent presence semantics — SoC without plug-state is real, ~30 UI/widget/flowCard
      readers; needs its own slice with its own cluster shape) and `evCharging` (transport-internal only, zero
      outside readers).
      **Temperature-observed field-move landed (2026-06-13): `currentTemperature` is OFF the base
      `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.currentTemperature` read is now a
      hard TS2339; consumers narrow through `hasObservedTemperature` (`packages/shared-domain/src/temperatureObservedState.ts`,
      browser-safe, generic over the carrier). New contracts types: `TemperatureObservedFields` (required
      `currentTemperature`) + `TemperatureObservedProbe` (optional owner-side widening); `TransportDeviceSnapshot`
      now intersects both EV and temperature probes. Consumers migrated: `lib/objectives/samples.ts`
      (`isFreshTemperatureDevice` composes `isTemperatureControlDevice && hasObservedTemperature`), the
      settings-UI deadline progress readers (`deadlinesList.ts`, `deadlinePlanResolvers.ts`), the smart-tasks
      widget payload, and the `appDebugHelpers` dump. **Deliberate divergence from `isEvObserved`: the guard is
      PRESENCE-ONLY, not kind+presence.** `currentTemperature` comes from the `measure_temperature` capability,
      which a non-temperature `deviceType` device can carry (deviceType is keyed on target caps), so a kind gate
      would reject a *present* reading (a present-but-rejected gap EV does not have). Callers wanting the kind
      compose it explicitly. **Fallbacks removed at source:** present implies finite (all three producer seams —
      `getCurrentTemperature` at parse, `applyMeasuredTemperatureObservation` at snapshot-refresh, and the
      `measure_temperature` branch of `applyFreshnessOnlyCapabilityUpdate` at realtime — write only finite
      values), so the scattered `Number.isFinite`/`isFiniteNumber` re-checks at consumers are gone. Type-level
      only — zero runtime behavior change.
      **State-of-charge-observed field-move landed (2026-06-13): `stateOfCharge` is OFF the base
      `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.stateOfCharge` read is now a hard
      TS2339; consumers narrow through `hasObservedStateOfCharge`
      (`packages/shared-domain/src/stateOfChargeObservedState.ts`, browser-safe, generic over the carrier). New
      contracts types: `StateOfChargeObservedFields` (required `stateOfCharge`) + `StateOfChargeObservedProbe`
      (optional owner-side widening); `TransportDeviceSnapshot` now intersects EV, temperature, and SoC probes.
      **Presence-only, like the temperature guard:** it proves the `stateOfCharge` snapshot *object* is present,
      NOT `status === 'fresh'` — that bag keeps its own `status`, so consumers retain their freshness/`status`
      gates after narrowing (the guard only removes the outer `?.`/`if (!soc)`). The one spot that differs from
      the scalar slices: `freezeObserved` (`lib/observer/observedDeviceStateProjection.ts`) still deep-freezes the
      nested SoC bag. Consumers migrated: `lib/objectives/samples.ts` (EV-SoC sample composes `isEvDevice &&
      hasObservedStateOfCharge && status === 'fresh'`), the EV-SoC freshness/boost seams in `app.ts` +
      `flowCards/registerFlowCards.ts` (probe-widened owner reads), the settings-UI device-list + deadline readers,
      and the smart-tasks widget payload. `percent` finiteness was already a producer guarantee
      (`normalizeStateOfChargePercent`), so this is pure type-tightening — zero runtime behavior change.
      **Boundary-finiteness sweep landed (2026-06-13): `measure_power` realtime seam was the last ungated one.**
      A read-only audit (map + adversarial-verify) confirmed the producer layer validates finiteness everywhere
      EXCEPT the `measure_power` branch of `applyFreshnessOnlyCapabilityUpdate` (`lib/device/transport/managerFreshness.ts`),
      which gated only on `typeof === 'number'` — so a realtime `NaN`/`Infinity` power event was stored on
      `measuredPowerKw` (the sibling of the temperature P1; it also rendered "NaN kW" via the unguarded
      `planSteppedCardText` reader and falsely advanced the freshness clock). Fixed drop-at-source
      (`&& Number.isFinite(value)` → no write, no freshness bump). Swept the same class in the load-setting
      reads too: `getLoadSettingWatts` (`devicePowerEstimate.ts`) and `getSnapshotLoad`/`getApiLoad`
      (`lib/device/load.ts`) now drop a non-finite settings/snapshot `load` instead of propagating an infinite
      estimate. An exhaustive boundary unit test (`test/unit/managerFreshness.test.ts`) seals the freshness seam.
      With this, "validate-and-drop at the Homey boundary; present-implies-finite" holds for every numeric
      capability write seam and load-setting read — the invariant the observed-field clusters rely on.
      **Measured-power-observed field-move landed (2026-06-13): `measuredPowerKw`/`measuredPowerObservedAtMs`
      are OFF the base `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.measuredPowerKw`
      read is now a hard TS2339; consumers narrow through `hasObservedMeasuredPower`
      (`packages/shared-domain/src/measuredPowerObservedState.ts`, browser-safe, generic over the carrier). New
      contracts types: `MeasuredPowerObservedFields` (required `measuredPowerKw` + optional
      `measuredPowerObservedAtMs` — the two travel together) + `MeasuredPowerObservedProbe` (optional
      owner-widening); `TransportDeviceSnapshot` now intersects all four observed probes. Power-measurement
      absence is the legitimate common case, so the guard draws the present/absent line and "present implies a
      finite, non-negative kW" is the producer invariant (the write seams store only finite values); the
      staleness-sensitive `sampleIngest` still checks `measuredPowerObservedAtMs` independently. Consumers
      migrated: objectives `resolveCredibleDevicePower`, `sampleIngest`, `executablePlanProjection`, the
      transport calibration-store seams, and the settings-UI device-list/view carriers; the rest read off
      local types (`PlanInputDevice`, etc.) that keep their own `measuredPowerKw?` and are unaffected.
      **Retired the two NaN-blind `?? 0` restore-gap reads** (`planSteppedRestorePending`, `restore/accounting`)
      into named helpers `resolveObservedDrawKw` / `resolveObservedDrawKwWithNameplate`
      (`lib/plan/restore/observedDraw.ts`) — `isFiniteNumber`-gated, so a non-finite `powerKw` nameplate can no
      longer propagate through `??` (the old `measuredPowerKw ?? powerKw ?? 0` was NaN-blind). Type-level +
      one defensive-correctness improvement; no intended behavior change given the producer invariant.
      **Stepped-descriptor field-move landed (2026-06-13): `steppedLoadProfile`/`targetPowerConfig` are OFF the
      base `DeviceDescriptor` and `reportedStepId` is OFF the base `ObservedDeviceState` — the FINAL slice of
      this P1.** An un-narrowed `snapshot.steppedLoadProfile`/`targetPowerConfig`/`reportedStepId` read is now a
      hard TS2339. Two new browser-safe guards in `packages/shared-domain/src/steppedLoadObservedState.ts`:
      `isSteppedLoadSnapshot` (narrows `SteppedLoadDescriptorFields`; checks `steppedLoadProfile?.model ===
      'stepped_load'` — the snapshot-shaped twin of `lib/plan`'s `isSteppedLoadDevice`, so `steppedLoadProfile`
      IS the kind discriminant) and the presence-only `hasObservedReportedStep` (narrows
      `ReportedStepObservedFields`). New contracts types: `SteppedLoadDescriptorFields` (required
      `steppedLoadProfile` + optional `targetPowerConfig`, which rides the cluster) + `SteppedLoadDescriptorProbe`
      (optional owner-widening), and `ReportedStepObservedFields`/`ReportedStepObservedProbe`. `TransportDeviceSnapshot`
      and `DecoratedDeviceSnapshot` now intersect both new probes (the transport produces and the app-layer
      decorator re-resolves + writes these onto the carrier). `suggestedSteppedLoadProfile` STAYS on the base
      (it is a CONFIGURE hint for non-stepped devices, not part of the stepped cluster). Consumers migrated:
      objectives `resolveCredibleDevicePower`, the flow-card stepped-load + EV-phase paths,
      `AppSmartTaskApi.deviceSupportsLimitLowerPriority`, and the settings-UI device-detail carrier + smart-tasks widget payload;
      owner/producer seams (transport parse/calibration-store/native-EV/debug-snapshot) probe-widen instead.
      `targetPowerConfig` reads stay owner-probe reads (a continuous EV preset carries it without a full stepped
      profile), not `isSteppedLoadSnapshot` narrows. Type-level only — zero runtime behavior change.
      **Temperature de-kind slice T1 landed (2026-06-07): planner branches on modality, not device kind.**
      Moved the starvation device-class set and the `deviceType === 'temperature'` checks out of
      `lib/plan/planDiagnostics.ts` into browser-safe shared-domain predicates (`isTemperatureControlDevice`,
      `isStarvationSupportedDeviceClass` in `packages/shared-domain/src/temperatureDeviceKind.ts`), mirroring
      `isEvDevice`. Added `scripts/check-device-kind-vocab.mjs` (in `ci:checks`) — an AST guard forbidding
      deviceClass family-name literals and `deviceType`/`deviceClass` literal comparisons in `lib/plan` +
      `lib/executor` (executor was already clean). Value-level only; no `TargetDeviceSnapshot` touch.
      **Objectives de-kind slice T2a landed (2026-06-08): `lib/objectives` consumes shared predicates.**
      Swapped the `deviceClass === 'evcharger'` / `deviceType === 'temperature'` power-estimation
      fallbacks in `samples.ts` / `objectiveSteps.ts` / `planningSpeed.ts` to `isEvDevice` /
      `isTemperatureControlDevice`. The EV swap intentionally widens to the canonical EV identity
      (`isEvDevice` also matches the `evcharger_charging` capability, not just `deviceClass`), aligning
      objectives with how every other layer identifies EV chargers; genuine `objectiveKind === 'temperature'`
      branches (`admission.ts`, `coldStartRelease.ts`) are objective-kind, not device-kind, and stay.
      `lib/objectives` is now in `check-device-kind-vocab.mjs`'s `consumerDirs`, so the guard enforces all
      three consumer layers.
      Remaining under this item:
      - **type discrimination (snapshot side): COMPLETE.** All observed clusters (EV / temperature / SoC /
        measured-power) AND the stepped clusters (descriptor `steppedLoadProfile`/`targetPowerConfig` off
        `DeviceDescriptor`; observed `reportedStepId` off `ObservedDeviceState`) have moved off the base
        snapshot types onto orthogonal `*Fields` clusters with `*Probe` owner-widening and shared-domain guards.
        An un-narrowed read of any of these on a base-typed value is a hard TS2339. What is left is the
        plan-layer discrimination still tracked under "Slice 1" above — converting the flat `DevicePlanDevice` /
        `PlanInputDevice` bags to discriminated unions (`SteppedLoadKind`/temperature/EV kinds) — a separate
        partition from the now-finished `TargetDeviceSnapshot`/`ObservedDeviceState`/`DeviceDescriptor` move.
      - **binary on/off discrimination (plan side): `currentOn` slice landed (2026-06-14).** The on/off truth
        is now a strict-boolean `currentOn` on the binary plan kinds (`BinaryPlanInputKind`/`BinaryControlKind`),
        resolved once by the producer (`resolveCurrentOn` — binary axis AND stepped-off fold, no staleness gate)
        and stamped at `toPlanDevice`/`planDevices`. The kind-agnostic `isObservedOff`/`isObservedOn` wrappers
        were DELETED; all consumers narrow via `isBinaryPlanDevice` and read `currentOn` directly (list sites
        partitioned by kind), so on/off is unaskable on a non-binary device and the four-valued `currentState`
        survives only as a UI/reason label. Behaviour change (intended): on/off is the latched last value with no
        staleness gate (stale-off = trusted-off, stale-on = trusted-on, active step = on).
        **`binaryControl` drop landed:** `binaryControl` is OFF the consumer plan kinds
        (`BinaryControlKind`/`BinaryPlanInputKind` carry only `currentOn`); `withBinaryDiscriminant` emits
        `currentOn` and strips the raw axis. `toPlanDevice` now also resolves `currentState` so the plan path and
        reconcile trust the producer instead of re-resolving from `binaryControl`; `observedPower`,
        `planExecutionDrift` (via `observedBinaryState`, which prefers `currentOn`), `planHeadroomDevice`, restore
        accounting, and the deferred-objective terminal release all read `currentOn`. Reconcile recombines
        `currentOn` with the merged stepped profile (no raw axis). Transport/observer/shared-domain and the
        executable-from-snapshot projection keep `binaryControl` as the observed binary axis.
        **`observationStale` removal landed:** the field is OFF the plan kinds — the plan trusts
        producer-resolved control state (no plan-side distrust gate), `resolveObservedCurrentState` resolves a
        concrete latched label (never `unknown` from staleness), and the idle/overview/starvation freshness gates
        source staleness from the observer (`getObservationStale` dep, `isDeviceObservationStale` over the
        projection). With this the plan-side binary-discrimination program is complete (open P2/P3 below).
        *Step-only stepper on/off resolved on the step axis (2026-06-14): a stepped device without `onoff` reads
        off/on from its step; restore/usage/overshoot/reconcile/activation/swap-completion + the executor all fixed.*
        Open follow-ups (P2/P3, deferred):
        - *planSteppedLoad masking is emergent (P3).* The `planSteppedLoad.ts` direct-`currentOn` sites (L161/266/299)
          are masked-safe for a step-only stepper ONLY because the lowest step is the single off step at sorted index
          0, so "next higher from off" == "restore step". **Hypothesis:** a profile with multiple zero-power sub-steps
          below the first active step would make those unequal, silently regressing the restore target. **Persona:**
          an installer with a multi-step `target_power` heater. Add a `getSteppedLoadNextRestoreStep` regression test
          pinning a step-only device on a `[off(0), idle(0), low(>0), …]` profile; not a code change now.
        - *Fixture `currentOn` precedence (deferred, P2, test-only).* `resolveFixtureCurrentOn`
          (`test/utils/planTestUtils.ts`) lets an explicit `currentState` label win over structural
          (binary+stepped) resolution, diverging from production `currentOn` stamping (production never consults the
          label). Reordering to resolve structurally first is more faithful but cascades: ~31 stepped fixtures
          express off-ness via `currentState` alone without a structural `binaryControl: { on: false }` signal and
          flip `currentOn` under the reorder. **Hypothesis:** those underspecified fixtures can mask a planner/
          executor regression where production resolves `currentOn` differently than the fixture asserts.
          **Persona:** a maintainer touching stepped shed/restore. Do it as a focused PR: reorder the helper, then
          add explicit `binaryControl` to each fixture that intends "off". (CodeRabbit #1728.)
        - *Activation-seam end-to-end coverage.* The realtime snapshot-refresh (`appSnapshotHelpers`) and Flow
          headroom card now stamp `currentOn` onto raw snapshots (the Flow card stamps the whole `devices` array)
          before the activation in/active reads, and a step-only stepper carries `steppedLoadProfile`/`selectedStepId`
          to the same reads. Unit-covered via `resolveCurrentOn`/the predicates, but not driven end-to-end (the
          appSnapshotHelpers test mocks `syncHeadroomCardState`). **Hypothesis:** a future change could drop the seam
          stamp/propagation and silently degrade activation-attempt close/active detection. **Persona:** a maintainer
          refactoring the headroom/snapshot wiring. Add an integration test driving the real
          `syncHeadroomCardState`/`evaluateHeadroomForDevice` with (a) a raw-snapshot binary device and (b) a
          step-only stepper parked at its off step, asserting the attempt closes as inactive.
        - *Step-axis stale-trust is undocumented (P2).* `resolveRestoreObservedState` (and the new step-axis
          predicates) read `selectedStepId` + profile with NO `observationStale` gate, so a stale step-only stepper
          at its off step resolves authoritatively to off — sound (`selectedStepId` is PELS's latched last-commanded
          step) and consistent with the documented "stale observation is trusted" invariant, but it extends
          stale-trust from the binary axis to the step axis without a dedicated note or test. **Hypothesis:** a future
          change to step latching could silently flip stale step-only restore eligibility. **Persona:** an installer
          with a `target_power` load. Add a one-line note in `lib/observer/AGENTS.md` + an integration test pinning a
          stale step-only stepper's restore/shed classification.

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
      bounded (~a handful of bytes/device, re-cleared on return). Candidate fix: fold surplus-stamp
      pruning into the existing lockstep per-device cleanup (`planHeadroomState.cleanupMissingHeadroomDevices`,
      which already prunes `surplusEligibilityByDevice`). *Persona:* maintainer. *Hypothesis:* harmless
      today; note-only so it is not silently assumed pruned. P3. Source: pels-runtime-reality on PR-7,
      2026-07-02.

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
      devices into `shedSet`, but materialization recomputes a stepped device's target from its
      CURRENT confirmed step (`planSteppedShedResolution.ts`), so membership means "one step below
      wherever you are now" every cycle. An EV charger on `set_step` shed behaviour at 16 A therefore
      walks 10 A → 6 A → lowest active step across a 30 s hold, on readings the module itself has
      declared to be non-evidence. Bounded (it leaves the candidate set at the lowest active step)
      and not a regression versus the pre-hold behaviour, which stepped it down on those same cycles
      — but it means the incident class is only closed for binary devices, and priority-ranked
      stepped loads are exactly what users notice. Fix needs the hold to carry the decided target
      step, not just membership. Persona: the owner who ranked an EV charger below their heating.
      Source: `pels-runtime-reality` on the unchanged-reading-hold PR. [P2]
- [ ] **Check whether Homey substitutes `[[token]]` placeholders inside a Flow card's `hint`.**
      Five trigger manifests write tag names as `[[home]]` / `[[outcome]]` / `[[hours_remaining]]`
      inside `hint` (`capacity_shortfall`, `capacity_shortfall_sustained`, `deadline_ended`,
      `deadline_status_changed`, `smart_task_hours_remaining`). Homey documents substitution for
      `titleFormatted`; if it does NOT apply to `hint`, every one of those cards shows the user a
      literal `[[home]]` in the Flow editor. *Persona:* anyone adding one of these cards.
      *Hypothesis:* the bracket syntax reads as a template that failed to render. Verify against a
      real Homey (or the Flow editor screenshot harness) and then fix all five together — a single
      card diverging from the convention is worse than the convention being wrong.
      Source: CodeRabbit review of PR #1948, 2026-08-01.
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

- [ ] **Retire the legacy prose reason parsers.** Plan reasons are structured objects end to end
      (`buildRestoreHeadroomReason` et al.), but `packages/shared-domain/src/planReasonParsing.ts`
      still round-trips a dozen prose regexes (`insufficient headroom (…)`, `shed due to …`) for
      legacy string reasons, and test utils lean on `legacyDeviceReason`. Every copy change to a
      reason template risks a silent parse miss instead of a type error. Migrate the remaining
      producers/consumers of prose reasons onto the structured contract and delete the regex layer.
      Source: 2026-08-01 budget-hold copy investigation. [P2]

- [ ] **Three EV car-link membership gaps that keep the probe blind to a car.** All three leave a
      car unobserved rather than mis-observed, so they cap what the probe can measure without
      corrupting anything. (a) *Initially-unavailable cars are never retained.* A class `car` device
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

- [ ] **Smart-task `status: 'unknown'` conflates "no verdict" with a verdict, one layer above the adapter.**
      `withUnknown()` (`diagnosticFields.ts`) stamps `status: 'unknown'` for transient DATA problems —
      `objective_progress_stale`, `objective_missing_temperature`, `objective_missing_charge_rate`,
      `objective_missing_capacity` — into the same field that otherwise carries genuine trajectory
      verdicts (`on_track` / `at_risk` / `cannot_meet` / `satisfied` / `invalid`). Every consumer
      must then branch on a value meaning "we could not compute one":
      `activePlanRevisionBuild.ts:56` falls back to `horizonPlan.status`, `planPreview.ts`,
      `endedEventBus.ts`, and `planHistoryInProgressState.ts` each special-case it.
      This is the consumer-side dual of the boundary rule in `AGENTS.md`: a read failure should
      become an explicit semantic result at the producer, not a nullable/sentinel business value
      that flows inward. It has already produced a real bug — gating the external-off overlay on
      the live status meant a stale SoC reading silently reverted every surface to a cached
      **On track** while the device was held off (fixed by not consuming the degraded value at all,
      but the shape that invited it is still there).
      Fix shape: split availability from verdict — e.g. `{ kind: 'resolved', status } | { kind: 'unavailable', reasonCode }`
      — so no downstream layer can accidentally treat "unknown" as a trajectory claim.

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

- [ ] **"Leave off until turned on again" does not suppress the smart-task deadline floor.**
      `applyDeferredAdmissionToInput` gates override, boost, priority holds, and budget exemption
      on `heldOff`, but `hasDeadlineFloor` still activates the decoration path:
      `buildDeferredTargetOverrides` supplies a floor for every planned thermal diagnostic, and
      `buildExecutableTargetIntent` can emit a target update even though the plan device is
      inactive, because the external-off reason is not a target-intent admission hold. PELS can
      therefore still move the thermostat setpoint on a device the user has switched off. It does
      not turn the device on — the binary guards hold — so the visible effect is a changed target
      on an off device, and the right setpoint is already in place when they turn it back on.
      Decide whether that is desirable before suppressing it.

- [ ] **"Leave off until turned on again" is missing from Advanced → Clear device data.**
      `collectDeviceIdsFromSettings`, `clearDeviceSettings`, and `clearMultipleDeviceSettings`
      (`packages/settings-ui/src/ui/advanced.ts`) neither enumerate nor clear
      `respect_external_off_devices`, so clearing a device leaves the flag (and any persisted
      hold) behind, and a deleted device known only through this map is never offered by
      "Clear unknown devices". Re-adding the device silently reactivates the old behaviour.

- [ ] **`commandableNow` cannot tell an absent EV capability from an unreadable one.**
      `packages/shared-domain/src/commandableNow.ts` ~191 treats `evChargingState === undefined` as
      "no such signal — skip", so an EV whose charging-state observation is momentarily unavailable
      fails OPEN: an off charger becomes commandable and eligible for `binary_restore`, the no-op
      Homey write resolves successfully, and `recordRestoreActuation` stamps the GLOBAL restore
      cooldown — delaying valid restores for every other device with no charging convergence to show
      for it. Raised by Codex on PR #1901 and deliberately deferred there, because the two cases are
      not equally reachable: a genuinely-absent capability never reaches this code at all (an EV
      charger needs BOTH `evcharger_charging` and `evcharger_charging_state` or it drops out of the
      snapshot entirely — `deviceCapabilityLifecycle.integration.test.ts` ~204), so the only residual
      case is a vendor value outside the Homey enum, which `getEvChargingState` normalises to
      `undefined` permanently. Failing closed on that would be a permanent block, which is strictly
      worse than the cooldown stamp. The real fix is a producer-resolved distinction
      (`resolved | unavailable`) at the capability read, per the resolution-in-producer rule, so the
      consumer can fail open only for genuine absence. Second site, and the one that makes this
      structural rather than cosmetic:
      `lib/executor/planExecutionDrift.ts` ~183 RE-DERIVES commandability with
      `resolveCommandableNow({ dev: observed.snapshot })`. Its comment claims a raw snapshot, but
      `ExecutableObservedDeviceState` documents (`executablePlan.ts` ~56) that the drift/reconcile
      path feeds a PLAN device — and `toPlanDevice` ~237 strips `evChargingState` after resolving
      `commandableNow` ~279. So on that path the re-derivation sees no plug state, fails open, and
      reports restore drift for an EV that is genuinely unplugged or discharging; repeated realtime
      events can then trip the per-device reconcile circuit breaker and suppress GENUINE drift. The
      fix is to consume the materialized `commandableNow` instead of recomputing, which needs it
      carried on `ExecutableObservedDeviceState` (`ExecutorDeviceSnapshot` does not expose it
      today) — a typed-seam change, hence its own PR. Persona: owner whose water heater waits out a
      restore cooldown burned by a charger that was never going to start; hypothesis: a global
      cooldown stamped by a no-op write is invisible and self-inflicted. [P2]

- [ ] **"Leave off until turned on again" only STARTS a hold from a push-delivered off.**
      Detection runs at the realtime-reconcile gate (`setup/externalOffHoldDetection.ts`), so it
      fires on `realtime_capability` / `device_update` observations. A full snapshot refresh does
      not dispatch `plan_reconcile`, so an outside-off discovered only by a pull (live feed down
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
      gross (cap tick no longer sits on the axis the cap meters). Do NOT present "available
      power" as cap-only for an exempt device: `lib/plan/planReasons.ts:63-68` documents that
      the exemption covers daily-budget shedding only, restore admission still gates on
      `min(capacitySoftLimit, dailySoftLimit)`, and an off exempt device can genuinely be held
      by the daily budget, though not for the reason that comment gives (see below). Depends on
      the P1 reason-line copy fix and on `plan.meta` carrying the un-rebased pace + exempt kW.
      Rejected alternative: two permanently visible pace ticks (three ticks at 320 px, with the
      cap tick already mandatory, for a state most homes never enter). Persona: skeptical
      optimiser during a boost. Hypothesis: a bar that shows the carve-out is trusted where a
      jumping number is not. Source: safe-pace model review (2026-07-26); design in
      `notes/safe-pace-two-constraints.md` and `notes/overview-hero-spec.md`.
- [ ] **The hard-cap alerts' `home` tag is a display name, not a stable id, so Flows string-compare
      a renameable label.** Neither `capacity_shortfall` (`args: []`) nor `capacity_shortfall_sustained`
      (whose only arg is the sustain duration) can filter by home, so a Flow that wants only one home's
      alerts has to string-compare the tag, and a rename propagates to the token immediately (the bundle
      is adopted in place, not replaced). *Persona:* owner with a Flow filtering on the annex's alerts
      who renames the area. *Hypothesis:* the Flow silently stops matching. A second `home_id` token
      carrying `MAIN_HOME_ID` / the sub-home's `homeId` would let a Flow branch on something durable
      while `home` stays the human label. Additive, so it can land later; decide it with the
      per-area Flow work rather than widening the card twice. (The reservation, uniqueness and
      length halves of the original entry landed in PR #1893.)
      Source: adversarial review of the multi-home finishing train PR 8a, 2026-07-26.
- [ ] **A legacy Flow-saved area config re-enters Homey Energy with the Main home on Automatic.**
      The residual (c) of the flow/area transitions: (a) saving an area on the Flow source and
      (b) switching to Flow while areas run are now refused symmetrically at the `ui_homes_save`
      seam (`homey_energy_required`, both power-source writes routed through the seam), but a
      config whose areas were saved BEFORE the exclusion can still switch **to** Homey Energy
      while the Main home is on Automatic — deliberately, because that switch is the remedy
      direction (the Whole-home meter picker only renders on Homey Energy) and refusing it would
      trap the owner on Flow. The cost is a window where areas run against Automatic, covered only
      by the `shouldPromptMainHomeMeter` nudge until the next area save re-asserts
      `main_meter_required`. Persona: pre-exclusion owner moving back to Homey Energy who misses
      the nudge. *Hypothesis:* rare and self-healing; revisit only if support reports show the
      nudge being missed. Source: multi-home finishing train, PR 4c. [P3]

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
      `scheduleSourceActuationRetry()` — registering a timer that later runs `rebuildPlanFromCache` +
      `reconcileLatestPlanState`, and mutating the back-off attempt counter. Merely ASKING whether the
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

- [ ] **`setup/homeRuntime/createHomeCapacityBundle.ts` is import-capped: 20/20 with no override.**
      `import-x/max-dependencies` is severity ERROR at max 20 and this file sits exactly on it, so the
      next extraction out of it — the usual remedy when it approaches the 500-line ceiling — is a hard
      CI failure unless the new module is reached through a specifier the file already value-imports
      (PR 5a put `resolveEffectiveDryRun` in `homeCapacityBundleApi.ts` for exactly this reason) or is
      type-only. Effective lines are 487/500. Any planned work here should budget both numbers up front.
      *Persona:* contributor extending the per-home capacity bundle. Source: multi-home PR 5a, 2026-07-26.

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

- [ ] **Act on the EV car-link probe once detection accuracy is proven.** The probe
      (`notes/ev-car-link/README.md`) currently only logs: it links a class `car` device to a
      charger from coincident plug edges, records where the car stops charging on its own, and
      shadow-compares the car's `measure_battery` against whatever the flow card reports. Nothing
      reaches planning. Once a few weeks of `/tmp/pels` logs show `ev_car_link_resolved` picking
      the right pair and `stoppedAtSocPct` clustering, the two payoffs are: (a) clamp a smart
      task's target to the car's observed limit so a 90% task on an 80%-limited car reads
      "your car stops at 80%" instead of silently landing `missed`; (b) stop crediting smart-task
      progress while `ev_car_self_stopped` holds, so the allocator stops booking hours the car
      will not take. (b) needs a seam: the producer lives in `lib/device`, a peer that may not
      import `lib/objectives`. Persona: EV owner with a car-side charge limit; hypothesis: an
      unexplained missed deadline is the single worst smart-task outcome. [P2]

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

- [ ] **`getTargetDevices` (`devices.ts`) must never be handed a `homeId`.** The plan-side half of
      this entry shipped with the per-home Overview (6b): `readOverviewPlan` in `overviewPlanRead.ts`
      resolves through `resolveHomeScopedRead`, and the `homey.stub.js` scoped plan handler now serves
      a per-area `plan_snapshot:<homeId>` fixture. Still standing as a guard for any future scoped
      devices consumer: `getTargetDevices` collapses the payload to a flat list (an `unavailable`
      scoped read would masquerade as "healthy home, no devices") AND writes the HOME-level
      `state.hasManagedSolarDevice` / `state.hasExhibitedExport` gates, which a resolved sub-home payload
      would silently retract for the whole home (an area without PV would hide the export-price section
      home-wide). Devices remains badge-grouped. Modes filters that same flat, already-loaded device
      list through the authoritative membership roster; neither surface needs a scoped devices read.
      A future scoped consumer must resolve through `resolveHomeScopedRead` and never funnel a scoped
      payload into the two global solar flags. P2.
      Source: adversarial review (typing + correctness lenses) of multi-home PR 5b, 2026-07-27. Files:
      `packages/settings-ui/src/ui/devices.ts`, `packages/contracts/src/homeScopedRead.ts`.

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

- [ ] **Extract the bounded source-recovery retry scheduler from `HomeRuntimeRegistry`.** The
      observe/authorize half of this landed in PR 3b as `setup/homeRuntime/powerSourceEpochFence.ts`
      (the generation/latch state machine behind `observeChange` / `reconcileObservedFromSettings` /
      `isMeterSourceAuthorized` / `isEpochDiscarded` / `commitTransition`), taking
      `setup/homeRuntime/homeRuntimeRegistry.ts` to 420 effective lines. What is still mixed in with
      bundle-map reconciliation and settings routing is the recovery side: `scheduleRecoveryRetry` /
      `clearRecoveryRetry` / `recoveryRetryAttempt` and their four backoff constants. Behavior is
      covered and no current bug is proven; this finishes the one-purpose setup-layer boundary before
      the next source lifecycle change. Source: adversarial simplification review of PR #1872,
      2026-07-23; half delivered 2026-07-26.

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
      *Hypothesis:* the source-filtered lifecycle device set omits the meter, but the diagnostic emitter only
      receives the durable sub-home predicate, so the still-enabled task reports `objective_missing_device`
      until deadline handling safely disarms it without a command. Add a reason-bearing durable-exclusion
      seam and dedicated source diagnostic so status/history explain the task's real scope before it ends.
      P2. Source: runtime-reality review of PR #1873, 2026-07-23.

- [ ] **(surplus-posture) `resolveSurplusPostureForDevice` reads `POWER_SOURCE` on the plan path (caller
      discipline).** *Persona:* maintainer. *Hypothesis:* `toPlanDevice`'s surplus-posture helper reads the
      power-source setting directly rather than receiving a producer-resolved bit; harmless today (sub-homes
      pass `surplusPostureEnabled: false` so the read is short-circuited), but it is a consumer reading a
      settings source on the hot plan path — a layering smell to resolve at the boundary and pass inward. P3.
      Source: R7b fix-round-2 layering read, 2026-07-19.

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
- [ ] **`dryRunEffective` doubles as a sub-home discriminator in the `pels_status` producer.**
      *Persona:* maintainer extending per-home status, plus any owner whose Flow automations read the
      persisted `pels_status` blob. *Hypothesis:* `buildPelsStatus` takes `dryRunEffective?: boolean` where
      `undefined` means "main home" and `true`/`false` is a sub-home's membership-gated posture, then gates a
      SECOND, unrelated field on it: `const areaTotalKw = dryRunEffective !== undefined && …` decides whether
      the blob carries `totalKw`. One optional boolean therefore carries two orthogonal meanings, actuation
      posture and home kind. The tri-state itself is sound (the consumer, `resolveHomeLimitsStatus`, reads
      `undefined` as "fall back to the persisted dry-run intent"), but the overload means that the first time
      the main home writes its own posture — a perfectly reasonable change, since main has a posture too —
      `totalKw` silently starts appearing in main's persisted blob, altering a payload external automations
      read. Pass the area-total decision explicitly (an `includeAreaTotalKw` flag or a `homeKind`
      discriminator) instead of inferring it from `dryRunEffective !== undefined`. No current bug: main is the
      only caller that omits the field today. Source: multi-home boundary-hygiene audit of the GA train
      (`ee09127c4..origin/main`), 2026-07-25. Files: `lib/plan/pelsStatus.ts` (`areaTotalKw`),
      `lib/plan/planStatusWriter.ts`, `packages/shared-domain/src/homeLimitsStatus.ts`.
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
      `stepCommandRetryCount` climbing), the UI shows only generic "Waiting before resuming" cooldown copy —
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
- [ ] **"Safe pace now X kW" prints twice in the on-track hero.** *Persona:* first-run user
      reading the calm state. *Hypothesis:* the power subline and the tick legend now carry the
      identical string three lines apart; one of them can likely go in the on-track state, but
      which one depends on the amber-system rework above — decide together.

*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups. The solar gross/net
split follow-ups from this batch are fixed by the solar-accounting follow-up; remaining open items continue below.*

*The runtime test tree is now typechecked: `tsconfig.tests.json` + the `tsc:tests` `ci:checks` lane
landed 2026-06-13, after a one-off cleanup of all ~1,555 masked errors (field-move fixture drift via
the discriminant regroupers + pre-existing mock-shape debt). Test-fixture type drift is now a hard
CI failure, so future field-move slices can't silently grow the debt.*

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
- [ ] **Source-hide the "Run on solar surplus" / temperature-lift controls on the flow power source WITHOUT hiding the export-price section.**
      *Persona:* flow-source owner with a Homey solar device who flips the surplus toggle.
      *Status:* the destructive half is FIXED — `toPlanDevice` now gates the runtime `surplusOnly`
      stamp to `homey_energy` (`resolveSurplusOnlyPosture.meteredPowerSource`), so a flow home can
      no longer strand a dump load "Waiting for solar surplus" forever; the toggle is at worst
      inert there. What remains is purely the misleading *offer*: `/ui_devices.hasManagedSolarDevice`
      is not source-gated, so a flow+solar-device home still shows the surplus controls.
      *Why not the one-liner:* gating `hasManagedSolarDevice` in `getSettingsUiDevicesPayload` also
      hides the export-price *settings* section — it feeds `resolveHomeExhibitsSolar`, which gates
      `showExportSection` "in lockstep" (`priceConfig.ts:162`). The fixed feed-in amount is
      deliberately usable on flow (`docs/solar.md`), so that section must stay. Correct fix:
      DECOUPLE — gate only the surplus controls (the dump-load toggle in
      `deviceDetail/solarSurplus.ts` + the temperature-lift row in `deviceDetail/index.ts`) by
      power source directly, leaving `resolveHomeExhibitsSolar`/the export section intact. *P3
      (was P2 before the producer gate removed the harm).* Files: `packages/settings-ui/src/ui/deviceDetail/solarSurplus.ts`,
      `packages/settings-ui/src/ui/deviceDetail/index.ts`.

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

- [ ] **First-run setup checklist on Overview.** A truly fresh install now gets two recovery
      links (no-data banner → power source, empty overview → Devices page), but the user still
      assembles the setup order themselves. A dismissable Overview checklist card (1. choose
      power source → 2. pick managed devices → 3. optionally prices) that ticks itself off and
      disappears once configured would make the path explicit. Needs mock-ups before build.
      Persona: brand-new owner on first open; hypothesis: the two links fix recovery but not
      orientation — a visible sequence prevents the "really tricky to know what to do" first
      session. Source: user onboarding feedback (2026-07-19). [P3]

- [ ] **Simulation wait-lines still read factually on device cards.** Under simulation a held
      card's waiting copy ("Waiting to resume — 0.2 kW more needed", "Waiting for solar surplus",
      "Waiting for available power") renders unchanged — `toSimulationReasonLine` deliberately
      passes non-acted lines through, but "Waiting to resume" claims PELS will resume the device,
      which under simulation it never will, and the card carries no `(simulation)` marker in that
      state. Decide a hypothetical form (e.g. "Would resume when 0.2 kW frees up (simulation)")
      with the copy lens across the three producers (`formatReasonSummary`, `resolveWaitingText`,
      `resolveBlockedStatusLine`/`resolveOffStatusLine`). Persona: onboarding owner running
      simulation; hypothesis: a factual promise PELS can't keep in sim erodes the mode's honesty
      framing. Source: pels-ux-fit implementation gate on the card-grammar PR (2026-07-04). [P2]

- [ ] **"Lowered by PELS" names the actor but not the constraint.** The held temperature card's
      fallback reason is the only reason line stating a what with no why — siblings name the
      binding constraint ("Limited to stay within today's budget"). When a cause is resolvable
      (starvation.cause, reason.code) prefer a constraint-naming line; keep the actor form only
      for the truly unattributed fallback. Persona: set-and-forget owner asking "why is my room
      cooler?"; hypothesis: naming the constraint pre-empts the "PELS did something to me"
      support thread. Source: pels-ux-fit implementation gate (2026-07-04). [P2 copy]

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

- [ ] **"Solar now" hero line does not refresh on status-only power pushes.** `realtime.ts` `updatePlanPower`
      only refreshes the hero's Solar-now triple on a FULL-tracker push; runtime `power_updated` events send
      `tracker: null` (status-only), so after the 60 s staleness gate hides Solar now, subsequent 10 s samples
      do not bring it back until the next full `/ui_power` read (30 s periodic or tab activation). There is an
      explicit design comment asserting the staleness gate "retires it on its own", so this may be intended —
      verify against the desired UX before changing (the fix would thread the solar fields off the status
      payload or force a solar-only refresh). *Persona:* prosumer watching the Overview live. *P2 (Codex late
      review on #1814, 2026-07-02) — confirm intended-vs-bug first.*

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

- [ ] **"Projected cost" has two bases for a prosumer — decide a unified stance.** The `plan_budget`
      widget's projected cost is now summed on the PLANNING price (`budgetPrice ?? total`, an estimate
      of the plan's self-consumed-solar economics), while the smart-task detail hero's "N kr planned"
      cost line (`resolveLiveCostAndDelivery` in `deadlinePlan.ts`) stays on the IMPORT price (money
      that reconciles to the bill). Both are labelled "projected"/"planned" cost but sit on different
      bases, so a prosumer comparing the two glances sees figures that don't tie out. The widget's
      estimate framing is defensible (it's a planning glance, not a receipt), and the hero's import
      basis is correct for a bill-reconciling figure — but the split is undocumented and a future
      reviewer will re-flag it. Decide a unified stance (e.g. both on import with a separate planning
      badge, or both on planning with an explicit estimate label) and record it in
      `notes/ui-terminology.md`. *Persona:* prosumer reconciling the widget glance against the
      smart-task receipt. *Hypothesis:* the two-basis split is invisible until a user does the
      arithmetic; low-frequency but confidence-eroding when hit. *P3 (M3 review, planning-price PR).*

- [ ] **Planning price — three deliberate exclusions to revisit.** (1) The `price_lowest_before` /
      `price_lowest_today` flow cards and their 30 s trigger checker
      (`lib/price/priceLowestFlowEvaluator.ts`) deliberately stay on the Import price `total`: their
      `current_price` token is money the user compares against their bill, and ranking the trigger by
      the planning price would emit a token that no longer matches the price that picked the hour.
      Decide separately whether to migrate (planning-ranked hour + total-money token, or a second
      planning-price token). (2) Capacity-limit staleness window: `CAPACITY_LIMIT_KW` sits in
      `DEDUPED_CAPACITY_KEYS`, not `DEDUPED_PRICE_KEYS` (`lib/utils/settingsHandlers.ts`), so changing
      the capacity limit (the budgetPrice blend denominator) updates live cheap/expensive classification
      immediately (computed on read) while the persisted `combined_prices` flags/budgetPrice wait for the
      next natural refresh or PV-forecast hook (≤3 h). Harmless drift window; wire `CAPACITY_LIMIT_KW`
      into a combined-prices recompute if it ever matters. (3) Consumer re-read cadence after the
      PV-forecast hook: the hook only rewrites `combined_prices` (parity with every existing price
      refresh) — the daily-budget snapshot and smart-task horizon pick the new planning price up on
      their own next cycle (power sample / clock tick / :58 settle), which in a flow-source home with
      sparse samples can lag. If dogfood shows it mattering, fire the planner's existing `signal`
      rebuild intent on `onCombinedPricesUpdated('changed')` rather than a bespoke nudge.
      *Persona:* prosumer with export pricing configured who tunes their main-fuse capacity limit.
      *Hypothesis:* the ≤3 h persisted-flag drift is invisible in practice; the flow-card token split is
      the one a user could notice (trigger fires on a "cheap" surplus hour whose money token looks high).

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

- [ ] **Disambiguate PV clamp-suspect hours with the battery signal (battery-observe train).** The PV-gain
      net evidence (`classifyHourNetEvidence`, `packages/shared-domain/src/solar/pvGenerationHistory.ts`)
      deliberately conflates zero-export clamp / battery absorb / balanced load into one 'suspect' class —
      a charging home battery absorbs surplus, so a battery home's bright hours read suspect and only thin
      the unclamped training pool. Once battery devices are observed (managed & !controllable train), join
      the battery charge signal into the evidence producer so battery-absorb hours with real grid headroom
      classify unclamped again. *Persona:* prosumer with PV + home battery. *Hypothesis:* battery homes sit
      in the clamp-aware quantile mode (forced-low confidence) longer than their data warrants.

- [ ] **Curtailment surplus: replace battery full-suppression with a batteryPowerW discount.** The
      curtailment-surplus estimator (`lib/solar/curtailmentSurplus.ts`) suppresses the inferred term
      entirely when a home battery is tracked — v1 cannot tell a throttled inverter from a charging
      battery. `battery_state_observed` already carries a typed `batteryPowerW`, but it is emit-only
      (deliberately no retained value); discounting the term by concurrent battery charge power needs a
      retained, freshness-gated aggregate at the transport boundary first. Tune against
      `curtailment_verify_*` / `surplus_pool` dogfood telemetry. *Persona:* prosumer with PV + battery +
      zero-export controller whose panels still curtail once the battery is full. *Hypothesis:* full
      suppression forfeits real recoverable surplus in battery homes for most bright afternoons.

- [ ] **Curtailment verify-window coverage gap: a lift whose support MIGRATES to the inferred term is
      never verified.** The window opens only on a lift RISING edge with a positive term
      (`trackLiftEdges`, `lib/solar/curtailmentSurplus.ts`); a lift that engaged on measured export and
      later survives only because the inferred term backfills the pool (export faded, term grew) runs
      unverified — no window, no refute-ladder learning. Bounded: a wrong term still hits the sticky
      import latch within one tick and the gate's sustained-import hard-off releases the lift, so the
      exposure is the ordinary bounded import burst, just without ladder escalation. Closing it means
      opening a window on a term-becomes-load-bearing transition, which needs pool-composition feedback
      from the allocator (seam width). *Persona:* real-export prosumer on a partly cloudy day whose
      export fades under an engaged lift. *Hypothesis:* rare and latch-bounded; revisit only if
      `surplus_pool` telemetry shows sustained inferred-dominant pools with an engaged lift and no
      matching `curtailment_verify_started`.

- [ ] **Curtailment verify aggregate-lift blind spot: an incremental second-device engage produces no
      rising edge.** `isSurplusLiftEngaged` is a whole-home ANY over the eligibility map, so a second
      device engaging while the first is already lifted never opens a verify window for the added draw.
      Bounded by the same latch + hard-off backstop. A per-device edge signal (eligibility-map diffing in
      the wiring, or an allocator callback) would close it at the cost of seam width. *Persona:*
      zero-export home with two willing heaters whose inferred pool covers both. *Hypothesis:*
      multi-willing-device zero-export homes are rare in dogfood; the single-window simplification is
      the right trade until telemetry shows stacked engagements refuting late.

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

- [ ] **Export scheme round trips: pure-share configs lose the share on spot-less entry; fixed-amount
      configs come back with a re-enable — accepted trade-offs.** Crossing the Norway unit boundary
      in EITHER direction with export pricing enabled takes one of two paths
      (`resolveExportSchemeChangePlan` in `exportPriceSettings.ts`): a non-zero fixed amount turns
      export pricing OFF (the number was entered in the old scheme's unit — carried raw, −5 øre
      would become −5 source-units and 0.50 NOK would be re-read as 0.50 øre, 100× off), keeping
      the stored numbers inert so returning to the entry scheme only needs a re-enable; a pure
      share config (fixed = 0) normalizes `export_spot_factor` to 0 when entering a spot-less
      scheme (no isolatable spot ⇒ NO export price), so the share is re-entered on return —
      entering Norway a stored share is a unitless percent and stays untouched. The plan resolves
      against the PERSISTED scheme so a failed save can't misattribute the fixed amount's unit.
      Both paths are toasted; a stale non-zero share on a spot-less scheme (CLI-set or a failed
      write) renders editable with a "set the share to 0" repair note rather than a masked 0.
      Deliberate (honest-state over config memory); revisit only if scheme switching turns out to
      be a real workflow. *Persona:* Orchestrator experimenting with price sources. *P3
      (adversarial review rounds 2+4+5, export-price PR).*

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
      `main:automatic`, but `extractAutomaticHomePowerReading` samples the FIRST usable cumulative item — a Homey
      reorder/availability change can silently switch the physically sampled device with no fingerprint change, so
      records from two physical scopes mix without an invalidation. The resolved identity already exists: membership
      publishes it through `noteResolvedHomeMeter` into `SampledMeterIdentity` (`setup/homeSampledMeterIdentity.ts`),
      keyed to the sample's own freshness horizon. It cannot simply be consumed by the composer, because it is
      unproven at the collector's boot-time `start()` reconcile (the primary invalidation edge): composing
      `undefined` there would skip the boot reconcile for Automatic homes entirely, and falling back to a constant
      arm would flip-flop against the resolved arm and strip learned state spuriously. Sharpened by the round-5
      narrowing: the fingerprint no longer carries the per-area meter roster (area meters are fenced out of Main's
      samples, so an area re-meter must not strip Main's history), which makes the Automatic arm the ONLY remaining
      way a roster edit can silently move Main's sampled device — an area claiming the very device Automatic had
      elected. The sound design is a mid-run reconcile edge: expose the current sampled id through the
      membership port, fire an identity-proven/changed callback from `MainMeterAuthority.noteResolvedHomeMeter`,
      and have the wiring compare the freshly composed signature against
      `weatherCollector.getHistoryStateSnapshot().meterScopeSignature`, driving `reloadWeatherCollector` only on a
      real mismatch (a full restart, not an in-place strip — a mid-run strip races in-flight backfill-chain
      continuations, which only the stop()-generation bump discards). Needs flap dampening: an Automatic pick that
      oscillates between two devices must not strip the learned state on every flip. Do NOT re-resolve the
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
      `{ estimate; deadlineAtMs; hasExistingObjective }` appears at `app.ts` (the stub),
      `setup/appSmartTaskApi.ts`, `setup/settingsUiStarvationRescueApi.ts` and
      `packages/contracts/src/widgetHostApi.ts`. Three predate the headroom PR; the extraction added the fourth.
      Fix: name it in `packages/contracts/src/starvationRescue.ts` and alias it at all four sites (type-only, so no
      bundle churn). Persona: contributor adding a field to the rescue preview; hypothesis: a four-way inline shape
      means adding a field is four edits and missing one is a silent structural mismatch at whichever site is
      typed loosest. P3. Source: adversarial review, multi-home headroom PR.

- [ ] **`notes/state-management/snapshot-decomposition.md` cites line numbers that no longer exist.** Line 102 cites
      `app.ts:1841 latestTargetSnapshot` (app.ts is now ~1060 raw lines) and line 273 says "`app.ts` (×5)"
      `getSnapshot()` pullers where there are 6. Fix: repoint to symbol names rather than line numbers. Persona:
      contributor picking up the remaining snapshot-decomposition stages; hypothesis: a wrong line number sends the
      reader to unrelated code and erodes trust in the whole note. P3.

- [ ] **Gate the device-detail Price-response + Solar-surplus sections on `canManageDevice`, not just `resolveManagedState`.**
      Both sections (and the Price/Surplus Control toggles) gate visibility/enable on `resolveManagedState`
      (`deviceDetail/priceOpt.ts`, `deviceDetail/solarSurplus.ts`), but a device can be `managed` while
      `resolveDeviceDetailControlState().canManageDevice` is false (it still needs built-in device control activation).
      In that state the sections stay visible with editable deltas even though the action can't take effect. Persona: an
      owner mid-setup on a not-yet-controllable device; hypothesis: an editable control that silently does nothing reads
      as broken. P2 (pre-existing price-opt behaviour the surplus section mirrors; fix both together for consistency).
      Source: Codex on the surplus-absorb UI PR #1759, 2026-06-25.

- [ ] **Consolidate the per-device price-opt + surplus-absorb blob shape into one contract.** The
      `{ enabled, cheapDelta, expensiveDelta, surplusWilling?, surplusDelta? }` shape is now tracked independently in
      `lib/price/priceOptimizer.ts` (`PriceOptimizationSettings`), the inline copies in `planEngine.ts`/`planBuilder.ts`,
      the new `PriceOptDeviceConfig` in `lib/plan/planSurplusAbsorb.ts`, and the validator literal in
      `setup/priceOptimizationSettingsAdapter.ts`. The optional fields mean tsc won't catch a *missing* propagation when
      the blob next grows. Persona: engineer extending the price-opt/surplus blob; hypothesis: a future field-add
      silently desyncs one copy (the validator or a plan-side literal). P3 (pattern predates this PR; revisit once the
      surplus UI lands and the lib/plan ↛ lib/price local-copy convention can be re-evaluated). Source:
      pels-layering-guardian on the surplus-absorb backend PR, 2026-06-25.

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
      add hysteresis (or a `both`-leaning-to-budget tiebreak) to `resolveSoftLimitSource`. Out of scope for the
      cause-classification fix (#1735) because it also moves the hero "Safe pace now" source label. Source:
      pels-runtime-reality on #1735, 2026-06-16. **Not** solved by the P1 targeted refactor
      "Express the soft limit as two predicates instead of one rebased `min()`": that gives
      `softLimitSource` a real `both` band, but the resolver stays stateless, so values
      oscillating across the epsilon boundary still alternate `capacity`/`both`/`daily`. This
      item needs retained state or separate enter/exit thresholds either way.

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

- [ ] **Grace the plan-history recorder's boot load against transient-empty reads.** The
      `DeferredObjectivePlanHistoryRecorder` constructor does a single un-graced `deps.load()`
      (`lib/objectives/deferredObjectives/planHistory.ts:196`); per
      `feedback_homey_sdk_unreliable`, a transient-empty boot read followed by a finalization
      flush silently drops up to 30 persisted history entries. Give it the trustworthy-read
      grace the backfill key-list path already has (`objectiveStore.ts` treats an empty
      `getKeys()` as untrusted and retries instead of committing). Source: pels-runtime-reality
      on PR #1678, 2026-06-11.

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
      (b) *Stepped path.* Every fixture in that file is binary (`controlCapabilityId: 'onoff'`), and
      no test calls `admitSteppedRestore` with reserves. Uncovered: the stepped stand-down (which
      now also applies `buildOffSteppedRestoreShedUpdate`, added 2026-08-01) and the reserve
      round-trip arithmetic on both gates (`availableHeadroom - reservedKw` in, `+ reservedKw` out).
      A sign error there leaks the reservation into the caller's running headroom total and
      mis-admits every later device in the cycle.
      *Persona:* Contributor changing the restore gates. Source: adversarial-review on
      preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **Measure how much of the contiguous-block problem the startup reservation actually recovers.**
      The reservation (`lib/plan/admission/headroomReserve.ts`) stops PELS from resuming devices into
      the block a scheduled device needs to start, but it cannot stop a managed thermostat sitting in
      `plannedState: 'keep'` from switching itself on under its own thermostatic control — that would
      require shedding it, which is exactly the behaviour removed on 2026-08-01. The original
      ~2:1 out-competition (commit `18296a370`) was attributed partly to that autonomous cycling.
      *Hypothesis:* the PELS-driven share dominates and the reactive swap path covers the rest (a
      device that has switched itself on is drawing, so displacing it yields genuine relief); if prod
      logs show reserving devices still waiting many minutes with power available, the remedy needs
      rethinking — but NOT by reinstating a proactive shed lane. Watch `headroom_reserve_decision`
      (topic `plan`) for `expired` outcomes. *Persona:* owner with an EV charger or water heater on a
      smart task. Source: preemptive-power-reservation, 2026-08-01. *P2*

- [ ] **Hoist the active-plan shape guard into shared-domain so the UI and runtime can't drift.**
      The settings-UI `coerceDeferredObjectiveActivePlans`
      (`packages/settings-ui/src/ui/deferredObjectiveActivePlans.ts`) is a leaner duplicate of the
      runtime `normalizeDeferredObjectiveActivePlans`
      (`lib/objectives/deferredObjectives/activePlanSettings.ts`): it hard-codes `version: 1`, skips
      the version check, and does no per-device `isActivePlan` filtering. Benign today (every consumer
      optional-chains each leaf, so a malformed entry degrades to "no state line"), but on a future
      `DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION` bump the runtime normaliser would reject the old blob
      while the UI guard forces `version: 1` onto a v2-shaped payload and renders stale/foreign fields.
      Fix per the resolution-in-producer rule: extract one browser-safe `coerce`/`normalize` into
      `packages/shared-domain/src/` (precedent: `deferredObjectiveValues.ts` already exports value normalisers
      there) and delegate the top-level shape/version check from BOTH `activePlanSettings.ts` and the
      settings-UI module — single source of truth, `settings-ui ↛ lib` boundary intact. **Trigger:
      do this before/with the next active-plans schema-version bump.** Source: pels-layering-guardian
      on PR #1517, 2026-06-05.

*v2.10.0..HEAD release-review findings (2026-05-29, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit`). No P0 blockers; the past-tasks hit-rate
reorder and the remaining widget-copy hoist shipped as their own follow-up
PRs. Items below are later polish.*

*v2.9.1 RC release-review carry-forward (re-added on `v2.9.1..main`
release-review pass, 2026-05-26 — the original entry committed as
`6dea64be` on the v2.9.1 release branch never propagated to main).*

*Session P2 deferrals from batch 21 reviews (2026-05-24).*

*v2.9.0 retrospective P2 cleanup and docs follow-ups (2026-05-23).*

*Confidence-model Step-2 follow-ups (2026-05-23). Step 2 of Cause #1
(`resolveBandedProfileConfidence` + `applyBandedConfidence`) shipped — the
overall `kwhPerUnit.confidence` now reflects the pooled within-band residual,
so a converged multi-step device can escape `low` (the standing v2.9 P0 signal
seen 985/985 in prod). These are `pels-runtime-reality` follow-ups that didn't
block merge.*

*v2.7.1 release-review P2 batch (2026-05-17), six-agent fan-out — non-blocking
polish/drift/follow-up. (Most resolved or discarded in the 2026-06-03 scrutiny pass.)*

*Phantom-design items removed (2026-05-31 m3-critic merit pass): the
"Electricity-prices two-select contrast" and "inconsistent active-vs-history chart
styling" items were written against UI that no longer exists — there are zero
`md-outlined-select` in shipped markup (every select is the token-bound dark-themed
`md-filled-select`, and migrating would break `segmentedControl.ts`), and both
smart-task charts already share the palette tokens and are deliberately different
chart types, not two languages for one chart. Do not re-raise from the stale
live-walk screenshots.*
- [ ] Split app lifecycle context into initialized vs initializing phases so services that are
      required after startup are not exposed forever as optional fields.
      Files: `lib/app/appContext.ts`, `app.ts`, app init/service tests.
- [ ] Split planner state from render-only explanation data so keep/shed/inactive decisions no
      longer depend on UI-facing `reason` objects.
      Files: `lib/plan/restore/index.ts` (returns `{ plannedState, reason }` bundled),
      `lib/plan/planReasons.ts` (mixes reason normalization with shed-temperature hold decisions),
      plan/executor/rendering boundaries.
- [ ] **Split the `PelsApp` class so `app.ts` reaches <=500** — the last Bucket-B god-file still
      carrying a `max-lines` override (lowered 1907→1110→950 by successive trains, not deleted).
      Every other Bucket-B god-file was decomposed under 500 and its override deleted (the
      eslint-cleanup train, PRs #1786–#1796: deviceTransport 2261→491, restore/index 1340→379,
      registerFlowCards 1148→148, deviceDiagnosticsService 1200→320, plus planBuilder / planReasons /
      planService / planExecutor / steppedLoadExecutor / managerObservation / planDevices /
      activePlanRecorder / diagnosticsBridge / deferredPlanHistory(+Receipt) / powerDriven /
      appDebugHelpers). Remaining: `app.ts` is the `Homey.App` composition root (~40 service fields +
      the `implements AppContext` delegator surface); the smart-task API cluster and the plan-rebuild
      intent policy came out in the multi-home headroom PR (override lowered 1110→950), so reaching
      <500 now needs the per-domain delegator surface split into sub-controllers — a large entrypoint
      restructure, out of scope for the behavior-neutral exemption sweep. The `import-x/max-dependencies` overrides on `app.ts` (50) and
      `setup/appServiceWiring.ts` — the two composition roots — are accountable here too. Update: the
      `appServiceWiring.ts` override was DELETED by the PR-3b headroom pass (the `wireDeviceTransport`
      extraction took its fan-in to 19, under the shared cap of 20), so only `app.ts` (50) remains.
      **`setup/appServiceWiring.ts` is at 19/20 — ONE value-import slot left.** A PR that needs a 21st
      must extract, not re-add an override. Note the breach surfaces late: `test.yml` fires only on
      `pull_request: branches: [main]`, so a stacked train branch first sees it at the merge into
      `main`, not on the PR that caused it. `import-x/max-dependencies` is severity ERROR.
      Persona: contributor.
*Smart-task controller extraction (2026-05-30, `feat/smarttask-lifecycle-producer`).
Program to make the planner know nothing about smart tasks (deferred objectives):
relocate the lifecycle out of `lib/plan` into a clock-driven controller that
mutates `PlanInputDevice`s and owns ending + terminal actuation; planner stays
smart-task-agnostic. **Finish line REACHED (PR-D2): `no-plan-to-smarttasks` is now
`error` and green — `lib/plan` (and the executor) import zero `lib/objectives`,
value AND type (grep-verified).** See
`notes/state-management/deferred-objective-lifecycle-carveout.md`. Shipped: PR-A
(`ObjectiveDeviceInput` read contract), PR-A2 (DailyBudget-payload hoist), PR-B
(subsystem relocation to `lib/objectives`), PR-C (lifecycle emission on a 30 s
clock), PR-D1 (`@pels/planner-types` + `PlanInputDevice` hoist), PR-D2 (decoration
appliers + eval onto the `DeferredObjectiveDecorationController`, constructed in
app-wiring; rule flipped to `error`), **PR-E #1338 (clock-driven terminal device
disable — Goal 2 output side, the "disable-after-task-ends" end-game)**. PR-D1b
dropped (ExecutablePlan has no objectives consumer — see carve-out note step 5).
**PROGRAM COMPLETE; remaining items below are non-blocking follow-ups.***

- [ ] **Release spot-check: smart-task detail deep-link on a real phone.** PR #1807 removed the
      `.deadline-plan-panel` mobile-chrome top inset (vestigial since ce3357cf put the panel
      in-flow below the always-visible tab bar). Repo evidence says the back button clears
      Homey's app chrome; after this ships, open `?page=deadline-plan` on a real phone once to
      confirm and close the loop. Source: PR #1807 review gates (2026-07-01).

- [ ] **Release spot-check: shell tab labels at 320 px on a real phone.** The narrow-width tab-fit
      guard (`layout-regressions.spec.ts` "keeps redesigned shell navigation compact at 320px") now
      loads the real Space Grotesk (`loadSpaceGrotesk`) so it measures the intended font, not the CI
      fallback — "Smart tasks" fit with ~38 px of slack in CI. On-device the Homey WebView could
      still substitute a wider system font (Android WebView ships no Space Grotesk), so after this
      ships, open the settings UI on a real 320-px-wide phone once and confirm no tab label wraps or
      ellipsis-clips; if it does, switch the shell nav to M3 scrollable-tabs or a graceful wrap
      rather than a hard clip. Source: PR #1813 review gates (2026-07-02).

- [ ] **Playwright stub: seeded smart-task data is internally inconsistent.** The
      `dev_connected300` fixture claims "Needs 12.0 kWh" and an on-track verdict, but the seeded
      learned rate (0.75 kW) × 6 picked hours cannot deliver 12 kWh. Fix the fixture so
      screenshot-gated reviews of the smart-task detail page are trustworthy — a reviewer
      reconciling the numbers today would flag a phantom bug (or miss a real one). Source:
      PR #1807 review gates (2026-07-01).

- [ ] **Canon note: en-GB date pinning forces English months beside a localized daily readout.**
      The Usage-tab date grammar is now English-pinned day-first (`formatDayFirstInTimeZone`, en-GB)
      so CI can't flip to month-first, but that means a non-English Homey renders English month
      abbreviations ("15 May") next to an otherwise-localized daily readout. Decide + document the
      canon in `notes/ui-terminology.md` (§ date grammar, cross-refs the "Thu 4 Jun" line at :439):
      either accept English months as the one pinned grammar, or move the pin to a locale that
      still guarantees day-first. Source: PR #1826 copy-sweep review gates (2026-07-02).

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

## P3 Future and Exploratory Work

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

*Entry bar: each item states a **hypothesis**, **why it's needed**, and the **persona**
(`notes/personas.md`) it serves. Items that can't name all three are maintainability/
cosmetic chores — do them in passing or drop them; don't park them here.*

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

- [ ] **"Main home" appears three times in the top 150 px once areas exist.** *Persona:* multi-home
      owner opening Limits & safety in Main scope with simulation on. *Hypothesis:* the simulation
      banner ("Main home simulation on — Main home devices stay as-is"), its action ("Turn off Main
      simulation") and the scope bar ("Showing Main home") stack, so the most repeated words on screen
      carry the least information. *Why it's needed:* with the scope bar now naming the home
      structurally, the banner could drop its own scoping prefix and read as the global alert it is.
      Touching `resolveDryRunBannerContent` is 8b's banner contract, so it belongs there, not here.
      Source: pels-copy-and-terminology review, 2026-07-26.

- [ ] **The home scope control and the Limits pickers below it are three different Material
      species on one screen.** *Persona:* multi-home owner on Limits & safety with an area selected.
      *Hypothesis:* the scope bar is an `md-filled-tonal-button` opening an `md-menu`, `Power source`
      is an `md-filled-select`, and the per-area editor uses native `.pels-input`. Each is defensible
      alone (chrome / form field / native-primitive rule), but they stack within one scroll. *Why
      it's needed:* the app should be able to state which picker species means what, or converge
      them; the existing entry on migrating the Main form to the native primitive is one half of
      that answer. Source: pels-m3-critic review, 2026-07-27.

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

- [ ] **The smart-task plan-detail deep link bypasses the shell's panel-shown event, so the home
      scope bar cannot hide behind it.** *Persona:* multi-home owner who taps a smart-task chip on the
      Overview device cards once Overview honours the home scope. *Hypothesis:* `showDeadlinePlanPanel`
      (`packages/settings-ui/src/ui/deadlinePlanRouter.ts`) deliberately uses `setActiveTabIndicator`
      instead of `showTab`, so it hides every `[data-panel]` and shows `#deadline-plan-panel` WITHOUT
      dispatching `pels:tab-shown`. Neither `state.activePanel` nor `renderScopeBar()` runs, so the scope
      bar keeps whatever visibility the previous panel gave it. Inert today (`SCOPE_AWARE_PANELS` in
      `homeScope.ts` holds only `limits`, which has no deadline-plan anchor), but the moment `overview`
      joins that set, a plan-detail deep link will leave a `Showing …` bar above a surface that does not
      honour it — the exact honesty rule the module documents. *Why it's needed:* the fix belongs to the PR
      that adds `overview` to `SCOPE_AWARE_PANELS`, which must either set `state.activePanel` and dispatch
      `pels:tab-shown` from `showDeadlinePlanPanel`, or expose a scope-bar hide hook the router can call.
      Source: adversarial review of the multi-home selector-shell PR, 2026-07-26.

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

- [ ] **Headroom widget: decide how a negative "Power now" reads in an exporting solar home.** With
      net export the Available-power widget's `Power now` figure goes negative with no explaining
      subline (the Overview hero has the `Solar now …` line; the 100 px tile has no room for one).
      Decide whether the tile renders the signed value as-is (honest but startling), clamps at 0
      with the export carried elsewhere, or gains a minimal export cue — and record the decision in
      `notes/ui-terminology.md`. *Persona:* prosumer glancing the dashboard mid-day. *Hypothesis:*
      a bare negative kW without context reads as a bug, not as export. *Why:* the widget is many
      prosumers' most-glanced PELS surface. Files: `widgets/headroom/src/public/render.ts`,
      `packages/shared-domain/src/headroomWidgetCopy.ts`. *P3 (2026-07 coherence review).*

- [ ] **Cheapest-hours minimum-run fallback for "Run on solar surplus" dump loads (candidate v1.2).**
      *Hypothesis:* "if this device has not run on surplus for N hours, run it in the cheapest upcoming
      hour instead" turns the posture's cold-tank failure mode (a cloudy stretch means the load never
      runs) into a bounded worst case, widening the safe audience beyond truly-optional loads.
      *Why it's needed:* v1 deliberately scopes the posture to loads that can skip days (pool pumps,
      towel dryers, garage/cabin heaters) and warns against sole water heaters; this fallback is what
      would make a water heater safe. Builds on the existing cheapest-hours machinery
      (`lib/price` combined prices + hour ranking); needs a per-device last-ran timestamp and an
      N-hours setting. From the PR-7 cold-tank ruling, 2026-07-01.
      *Persona:* prosumer with PV and a flexible-but-not-optional load.

- [ ] **EV/stepped "charge from solar only" surplus mode — own train (deferred from the surplus ladder).**
      *Hypothesis:* the dump-load posture generalises to variable-draw devices only with per-step
      allocation; a naive on/off treatment of an EV charger would chatter at the off↔6 A boundary (the
      industry failure mode). *Why it's needed:* solar-only charging is the most-requested PV feature
      class; the binary rung deliberately excludes EV/stepped. Sketch: per-step reservation in the
      surplus allocator (`resolveSurplusEligibility` API change — reserve at a step's draw, not one
      expected draw), per-step-level hysteresis, hold-at-lowest-step posture (step-only-stepper rule:
      shed to lowest step, not off), EV-objective precedence (SoC deadline overrides solar-only), and
      context-scoped step-calibration validity. Interim reality: stepped loads already soak export via
      headroom, and budgetPrice moves smart-task charging into solar hours. From the PR-7 ladder
      ruling, 2026-07-01. *Persona:* EV owner with PV.

- [ ] **Battery surplus Flow trigger: "Solar surplus started/stopped" + kW token (deferred from the surplus ladder).**
      *Hypothesis:* battery control stays permanently out (docs/solar.md commitment), but a Flow
      trigger carrying the post-allocator pool remainder lets a battery app charge with exactly the
      surplus PELS's loads declined — no PELS-side battery control needed (a charging battery already
      shrinks the pool via net power). *Why it's needed:* closes the "PELS can't tell my battery to
      charge from surplus" gap without breaking the read-only battery commitment. Needs a
      `.homeycompose` flow trigger card (en/no titles) + the pool-remainder token from the allocator.
      From the PR-7 ladder ruling, 2026-07-01. *Persona:* prosumer with PV + home battery.

- [ ] **Inverter `target_power` read-side probe (deferred from the surplus ladder; write-control rejected).**
      Verified against a real system: `target_power` is setable ±25000 W with `target_power_mode`
      {device, homey}, minCompatibility 12.13.0. PELS (>=12.4.0) may read/write it on third-party
      devices with graceful degradation and NO compat bump, but must NEVER declare the capability on
      `drivers/pels_insights` (that would force >=12.13.0 app-wide). Write-control (a "negative-price
      export brake") is deferred indefinitely — it is the opposite of absorb-first and has ~zero field
      support. *Hypothesis:* a read-side probe of `target_power` on tracked solarpanel devices is an
      inference enhancer for the PV gain/curtailment model. *Why it's needed:* only as an input to the
      solar inference lane — record it there when that lane next evolves. From the PR-7 ladder ruling,
      2026-07-01. *Persona:* prosumer with a Homey-integrated inverter.

- [ ] **Observe-only device wiring: extract it out of the recurring-ceiling god-files (`app.ts`, `deviceTransport.ts`).**
      *Persona:* Contributor (`notes/personas.md`) extending the observe-only-device family (battery, solar,
      and any future tracked-but-uncontrolled role) without re-tripping the `max-lines` ceilings.
      *Hypothesis:* the managed-observe-only feature spreads thin wiring across two Bucket-B god-files — the
      deviceId-only `isObserveOnlyRoleDevice`/`resolveManagedState`/`isCapacityControlEnabled` resolution in
      `app.ts`, and the producer fields + `observeBatteryStateFromList` + `note*Device` realtime top-ups in
      `lib/device/deviceTransport.ts`. Each new observe-only role nudges both ceilings up again (battery:
      app.ts 1900→1906, deviceTransport 2234→2250; solar: 1906→1907, 2250→2261), so the bumps are a smell, not
      a fix.
      *Why it's needed:* a small `ObserveOnlyDeviceRegistry` (owning the per-role producers + the membership-set
      resolution) would let app.ts/deviceTransport delegate instead of grow, and make the next role a localized
      add. Update: `deviceTransport.ts` was since decomposed to 491 lines with its `max-lines` override DELETED
      (eslint-cleanup train), so the deviceTransport-ceiling motivation no longer applies; this is now a cohesion
      improvement (and helps the remaining `app.ts` class-split above). Source: PR-D runtime-reality review, 2026-06-27.

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
- [ ] **Fold the same-file `capacityNote` literal onto `STARVATION_WAITING_FOR_POWER_COPY`.**
      *Persona:* maintainer / support (`notes/personas.md`) reading log/UI copy parity.
      *Hypothesis:* `capacityNote: 'Waiting for available power.'` in `planStarvation.ts` re-types the
      same phrase the new `STARVATION_WAITING_FOR_POWER_COPY` constant owns (differs only by a trailing
      period), so the two can silently diverge from the overview/row-subtext wording.
      *Why it's needed:* completing the same-file dedup removes the last in-file copy of this literal.
      Deferred from the dedup PR because `capacityNote` is bundled into the `starvation_rescue` widget,
      so the change regenerates `widgets/starvation_rescue/*` — a build-artifact churn out of scope for a
      string-sourcing chore. Fix: `` capacityNote: `${STARVATION_WAITING_FOR_POWER_COPY}.` `` and commit
      the regenerated widget bundles. Source: pels-copy-and-terminology on PR #1535, 2026-06-06.

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

*Smart-task failure-investigation & live UX — the underserved Optimiser and the
Failing-scenario (acute/recovering) visitors (`notes/personas.md`).*

- [ ] **Deadline-hero "Need X kWh" shows the original requirement, not live remaining.**
      *Persona:* Optimiser (watches the plan progress and expects the number to tick
      down, and cross-checks remaining vs delivered).
      *Hypothesis:* the active-plan recorder no longer persists `energyNeededKWh`/`plannedKWh`
      decrements within an unchanged schedule (to avoid Homey settings churn), so the hero
      reads the original starting energy until the schedule/status/source/objective changes —
      a user watching for hours reads the static number as stuck or wrong.
      *Why it's needed:* the original-vs-remaining framing may erode trust for active monitors.
      *Validate first:* only act if users actually report confusion; then route live remaining
      through a non-persisted live snapshot (current diagnostic's `energyNeededKWh` in the UI
      bootstrap payload), never per-cycle persistence.
      Files: `lib/objectives/deferredObjectives/activePlanRecorder.ts`, `setup/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`, `.../deadlinePlanResolvers.ts`.
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
*EV charging — the Optimiser / EV commuter (`notes/personas.md`).*

- [ ] **EV deadline polish: manual override actions + imminent-deadline urgency rule.**
      *Persona:* Failing scenario (acute) with EV-commuter / Optimiser overlap —
      realizes mid-evening the car won't be ready by morning and needs to intervene.
      *Hypothesis:* exposing `charge_now` / `pause_until_next_planned_slot` actions and
      force-admitting planned charging when `(deadline − now) < requiredHours + 1 h buffer`
      lets the panicking user override manually *and* trust the system to self-rescue when the
      window gets tight.
      *Why it's needed:* today an imminent deadline can stay shed under capacity/price logic
      with no escape hatch and no auto-urgency — the worst failure mode for the
      highest-intensity persona. (Notification delivery is the user's own flow; PELS supplies
      the trigger tokens — that token work lives in the P2 observability entry, not here.)
      Design: `notes/ev-ready-by/README.md`. Files: new flow action JSONs + registrations.

*Usage & budget — the Orchestrator and Set-and-forget owner (`notes/personas.md`).*

- [ ] **Per-device usage history page with step-change context.**
      *Persona:* Orchestrator ("what did this device cost last week?") and Optimiser
      (per-device kWh/cost, did it run in cheap hours).
      *Hypothesis:* users debugging their own setup want measured kWh over time per device,
      and the number is uninterpretable without knowing which step/mode was active during each
      period — so the page needs step-change context to be trustworthy.
      *Why it's needed:* both personas' Usage rows in `notes/personas.md` ask for per-device
      drill-down PELS doesn't render today. Build the page and the 30-day hourly-retention
      per-device step-change tracker that feeds it together — the tracker is not shippable on
      its own. Files: future device-level step-change tracker; per-device usage-history route + chart.
*Planner accuracy for multi-device homes — the Optimiser (`notes/personas.md`).
Both are data-gated: act only when prod evidence shows the gap, else leave alone.*

- [ ] **Promote committed-task floor reservations beyond priority 1.**
      *Persona:* Optimiser with several managed devices — a deadline-committed device
      that isn't the single top-priority one.
      *Hypothesis:* floor promotion is gated on `priority === 1 && both rescue permissions ===
      'always'` because the reserved-headroom forecast (`hardCap − uncontrolled`) assumes every
      controlled watt is displaceable — true only at the very top. A richer forecast that also
      subtracts higher-priority controlled load (`hardCap − uncontrolled − higherPriorityControlled`)
      would let the gate broaden to "highest priority present on this Homey", so a default-priority
      committed device's rescue stops being budget-exemption-only and can claim a guaranteed floor.
      *Why it's needed:* today a non-top committed device plans at the un-promoted floor and can
      still `cannot_meet`; the Optimiser with a mixed-priority home is the one who hits it. *Validate
      first:* pick up only if post-Slice-2 prod logs show a long-tail `cannot_meet` rate on
      non-top-priority tasks (user-confirmed the design is safe — it only sheds strictly
      lower-priority devices than the rescued one; the success flash stays honest meanwhile).
      *Scope narrowed 2026-08-01:* this is now ONLY about floor promotion. The permission half is
      done — `gateCandidateExtraPermissions` no longer withholds `limitLowerPriorityDevices` from
      non-top devices, so the grant is live (boost engages) even where `fullyReserved` stays false.
      Do not re-conflate the two: swap selection already refuses any candidate that is not strictly
      lower priority, which is why persisting the permission is safe at any priority; the
      reserved-headroom forecast is what still needs `priority === 1`.
      Files: `lib/objectives/deferredObjectives/policyHorizon.ts`, `.../rescueReplan.ts`,
      `lib/dailyBudget/dailyBudgetBreakdown.ts`. Source: pels-runtime-reality on PR #983 / #1373.

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
- [ ] **Sticky/debounced `at_risk` smart-task rescue (phase 2).**
      *Persona:* Optimiser whose plan churns around the satisfied↔at_risk boundary.
      *Hypothesis:* the contract/runtime already parse an `at_risk` rescue mode that the JSON dropdown
      deliberately doesn't expose; if exposed without hysteresis it would flap and remove its own
      trigger, so it needs sticky/debounced engage-once-at-risk / exit-only-after-solidly-not semantics
      before it can ship.
      *Why:* future capability; flapping would oscillate lower-priority limit/resume.
      *Validate first:* unexposed today (dropdown is `never`/`always`); only build when the rescue lane
      needs it. Files: `lib/objectives/deferredObjectives/**`, `flowCards/smartTaskRescueCard.ts`,
      `.homeycompose/flow/actions/allow_smart_task_rescue.json`.
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
- [ ] **Model backup-hour reservations for committed smart-task schedules.**
      *Persona:* Optimiser with a tight deadline.
      *Hypothesis:* day-zero committed schedules degrade straight to `cannot_meet` with no backup-hour
      spill; modeling backup hours distinct from committed delivery hours (and reserving budget for them)
      would let a task that can't deliver in its committed hours use reserved capacity instead of failing.
      *Why:* future capability; `cannot_meet` is correct-but-blunt today. Files:
      `lib/objectives/deferredObjectives/horizonPlanner.ts`, `.../bucketAllocation.ts`,
      `notes/deferred-load-objectives/`.
- [ ] **Finish the starvation rollout beyond detection.**
      *Persona:* Orchestrator building their own automations.
      *Hypothesis:* starvation detection + the user-initiated rescue widget shipped, but there are no
      per-episode/duration flow triggers or insights coverage, so an Orchestrator can't react to starvation
      in their own Flows.
      *Why:* future product rollout against `notes/starvation/README.md`; the feature works without it.
      Files: `flowCards/**`, `drivers/pels_insights/**`, plan snapshot/contract wiring.
- [ ] **Rework device detail into focused Behavior / Setup / Diagnostics sections.**
      *Persona:* Orchestrator configuring a device, and support reading diagnostics.
      *Hypothesis:* device detail is one long mixed scroll (modes, deadline, price, limiting, stepped,
      boost, setup, control model, native wiring, SoC, diagnostics); a focused IA keeps common controls
      reachable and moves the dense read-only diagnostics surface off the primary path.
      *Why:* important setup controls feel hidden and the diagnostics surface is a dense support read at
      the bottom of operational controls — functional but unloved. Files:
      `packages/settings-ui/src/ui/deviceDetail/**`, device-detail e2e/screenshots.
- [ ] **Define the binary operating precondition for temperature-lowered devices.**
      *Persona:* Optimiser with a device that is both temperature- and binary-controllable.
      *Hypothesis:* `set_temperature` limiting only lowers the target; if such a device is observed
      off, the lowered target never takes effect — decide whether drift detection should turn it back
      on, then encode that as executable intent rather than special-casing drift.
      *Why:* a real but currently-undecided control-correctness edge. *Validate first:* needs a design
      decision (no evidence it has bitten). Files: `lib/executor/executablePlanProjection.ts`,
      `lib/executor/planExecutor.ts`, `lib/executor/planExecutionDrift.ts`.
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
- [ ] **Re-document or retire `capped_idle`: its canonical device (Høiax Connected 300) is not actually cap-cycling.**
      *Persona:* Contributor (`notes/personas.md`) maintaining the idle classifier against the design-of-record.
      *Hypothesis:* `capped_idle` was designed around the Connected 300 as a device "cycling at a ~60 °C internal
      cap" (`notes/idle-classification.md` capped_idle row + "Why 20 min", and the `lib/observer/idleDetector.ts`
      docblock). Field logs show the device has **no** cap (it reaches ~90 °C) and a **fixed 6 °C hysteresis**, so
      it holds a *flat* 0 W (it does not cycle) down to ~setpoint−6 — which is exactly why the cycling-required
      `capped_idle` never fired and it fell to `unresponsive`. With the near-target band now widened to 6 °C
      (this PR) that device classifies as `near_target_idle`, so the documented canonical `capped_idle` example
      is false and the state's cycling trigger may have no known real instance.
      *Why it's needed:* the design-of-record now contradicts observed behaviour; either name a real device that
      genuinely cycles below target at an internal cap (and keep `capped_idle`), or retire the state. Not urgent —
      the band widening already routes the real device to the correct benign `near_target_idle`. Source: idle
      log-review + hysteresis investigation, 2026-06-29. Files: `notes/idle-classification.md`,
      `lib/observer/idleDetector.ts`, `packages/shared-domain/src/idleClassificationCopy.ts`.
- [ ] **Pin the contracts↔lib deferred-objective normalizer mirror as a tracked keep-in-sync pair.**
      *Persona:* Contributor editing objective validation rules.
      *Hypothesis:* three lanes (widget create, settings-UI edit, runtime persist) now validate through
      `lib/objectives/deferredObjectives/settings.ts` while the settings UI pre-gates through the
      `packages/contracts/src/deferredObjectiveSettings.ts` mirror; a one-sided edit would let the UI
      offer an edit the server rejects. Both files carry keep-in-sync comments; consider a shared
      fixture test that runs identical junk/edge candidates through both normalizers and diffs the
      results. Source: pels-layering-guardian on the smart-task edit PR (2026-07-05).
- [ ] **Smart-task edit lane: distinct copy for a paused (disabled future) task.**
      *Persona:* Owner with a paused EV task opening the detail-page editor race-window.
      *Hypothesis:* `gateEditableTask` rejects a stored-but-disabled entry as `task_not_found`, so the
      UI says "This task has already ended." — false for a paused-but-open task (it still blocks
      rescue and re-creation). A distinct `task_paused` reason + copy ("This task is paused …") would
      be honest; needs the paused state to actually be user-reachable first. Source:
      pels-runtime-reality on the smart-task edit PR (2026-07-05). Files:
      `setup/settingsUiSmartTaskApi.ts`, `packages/shared-domain/src/deadlineLabels.ts`.
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
- [ ] **Owner decision: gate load-adding mode raises on available headroom, not just a fresh sample?**
      A meter area holds a load-adding mode-target write until its meter has a fresh sample, but once
      one lands the raise is emitted as an ordinary `target_update` regardless of remaining headroom:
      at 5.5 kW measured against a 6 kW cap, raising a heater 18→22 °C (~2 kW) bypasses restore
      admission, reserves nothing, and can push the area over its cap until later polls and shed
      cooldowns claw it back. Declined in the multi-home stack because the same admission shape
      applies to the Main home's mode raises today — gating them on headroom is a planner-wide product
      change (mode changes stop being immediate whenever the home is near its cap), not an area bug.
      *Persona:* owner whose area runs close to its cap most hours. *Hypothesis:* an overshoot the
      planner itself caused, however brief, reads as PELS breaking its one promise. Source: Codex
      review of multi-home PR #1886 (thread "Admit fresh-sample raises against available headroom"),
      2026-07-27. Files: `lib/plan/planDevices.ts`, `lib/plan/planActionMaterialization.ts`. [P2]
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
- [ ] **Three `.ts` files sit at 499–500 against the shared 500-line ceiling.**
      *Persona:* Contributor (`notes/personas.md`) whose one-line change to a hot file is rejected at
      commit time by a `max-lines` warning that has nothing to do with their change.
      *Hypothesis:* after the PR-3b headroom pass, `lib/device/deviceTransport.ts` (500/500),
      `lib/device/transport/binarySettleEvidence.ts` (499) and `lib/dailyBudget/dailyBudgetPlanCore.ts`
      (499) cannot absorb a single line; `lib/dailyBudget/dailyBudgetManager.ts` and
      `flowCards/deadlineObjectiveCards.ts` sit at 497. None carries a `max-lines` override — they all
      ride the shared 500. (`lint-staged` does pass `eslint --max-warnings=0`, so this fails at commit
      rather than in CI; the cost is an unplanned extraction mid-change, not a wasted CI round.)
      PR 3b deliberately relieved only the eight files the multi-home train edits, to keep a
      behaviour-free pass from touching unrelated subsystems — `deviceTransport.ts` in particular wants
      a real subsystem boundary (`notes/complexity-cleanup/god-file-policy.md`), not a line shave.
      *Why it's needed:* the next contributor to touch any of these has to do someone else's refactor
      first. Relieve them when next touched.
      Source: PR-3b census, 2026-07-26.
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
- [ ] **Suffixed `operating_mode:<homeId>` writes are not noop-deduped.** Suffixed keys bypass the
      settings write skipper by design, so repeated identical writes cause repeated (cheap) bundle
      rebuilds. The shipped per-home selector writes only on an explicit changed value, so normal UI
      renders do not trigger it; the remaining edge is an integration repeatedly writing the same
      suffixed value. Files: `lib/utils/settingsWriteDedupe.ts`,
      `setup/homeRuntime/homeRuntimeRegistry.ts`.
      Source: multi-home finishing train, runtime mode-pinning PR. [P3]
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
- [ ] **Revisit non-critical runtime edges exposed by meter-area review.** Refit the weather model
      once enough new-scope overlap days arrive; re-resolve held operating-mode aliases and make
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
