# TODO

## P0 Correctness: stale data, confirmation, and observation integrity

These items are highest priority because they can make PELS act on state that is no longer true,
or present requested state as confirmed reality.

- [x] Fix restore → overshoot → shed instability. Root cause (1) fixed: restore headroom now
      reserves pending power for recently restored devices whose elements have not yet fired
      (`computePendingRestorePowerKw`, 3-minute window, 50% confirmation threshold). Root cause
      (2) was already handled by the `restoredOneThisCycle` gate. Root cause (3) (buffer too
      small) remains a monitoring item — `computeRestoreBufferKw` is tuned but may need
      adjustment based on field data.
      Files: `lib/plan/planRestoreSwap.ts`, `lib/plan/planRestore.ts`, `lib/plan/planConstants.ts`.
- [ ] If real-world cloud devices still show confirmation/drift gaps after the current freshness
      model fixes, add per-capability realtime subscriptions for control capabilities (`onoff`,
      `evcharger_charging`, `target_temperature`) on managed devices.
      Files: `deviceManager.ts`.

## P1 Correctness, inefficiency, and cleanup follow-ups

These are important follow-ups, but they are a mix of correctness bugs, avoidable inefficiencies,
and code-cleanup work. Keep them separated so the behavioral fixes do not get buried under larger
refactors.

### P1 Bugs: conflicting models and wrong answers

- [ ] Document the intended fallback order per consumer and align power resolution across
      `resolveCandidatePower`, `estimateRestorePower`, `resolveUsageKw`, and stepped-load power
      resolution to that model.
      Files: `planCandidatePower.ts`, `planRestoreSwap.ts`, `planUsage.ts`,
      `planSteppedLoad.ts`.
- [ ] Align `currentOn` vs `currentState` checks across shedding, restore, reconciliation, and
      executor logic so the same device does not look "off" in one stage and "on" in another.
      Files: `planShedding.ts`, `planRestoreDevices.ts`, `planReconcileState.ts`,
      `planExecutor.ts`.
- [ ] Standardize restore eligibility checks across normal restore, stepped restore, and swap
      restore so "can this device restore?" has one consistent answer.
      Files: `planRestoreDevices.ts`, `planRestoreSwap.ts`.
- [ ] Pick one source of truth for the controlled vs uncontrolled power split. Today the plan
      builder and `PowerTracker` compute it independently and can drift.
      Files: `powerTracker.ts`, `planBuilder.ts`, `planUsage.ts`.

### P1 Bugs: log semantics and status output

- [ ] Clarify `actionChanged:true` / `appliedActions:true` in rebuild-completed structured logs.
      These fields frequently appear without a corresponding human-readable line explaining what
      action changed. Either internal planner state changes are being counted as "actions", or
      real device actions are happening without a matching prose log. The semantics must be
      tightened so `actionChanged:true` means a visible device command was issued.
      Files: `lib/plan/planService.ts`, `lib/plan/planBuilder.ts`, rebuild logging path.
- [x] Fix `hourBudget` label in periodic status output. `hourBudget=4.0kWh` reads as "remaining
      feasible target for this hour" but actually means "full-hour configured budget." At 17:55
      with 3.17 kWh already used, the label implies 4.0 kWh is still achievable when only ~0.83
      kWh of budget headroom remains. Either rename to `hourCap` or show remaining budget.
      Files: `lib/core/periodicStatus.ts`, status tests.

### P1 Structured logging: runtime coverage and correlation
- [ ] Keep default structured event payloads bounded. Normal diagnostics should avoid large
      per-device arrays and full change objects unless the event is explicitly incident/debug
      scoped, so reconcile/incident output stays compact enough for diagnostics snapshots.
      Files: realtime reconcile / incident logging paths, structured-log tests.
- [ ] Expand structured events for the highest-value runtime failure/control paths that still only
      emit prose/debug logs, starting with command actuation, executor outcomes, periodic/status
      output, and the remaining startup/background-task paths.
      Files: `planExecutor.ts`, runtime helpers in `app.ts`, startup helpers, tests.
- [ ] Add bounded `reasonCode` values for important failures, fallback paths, and degraded-state
      decisions instead of relying on free-form prose or exception text alone.
      Files: `lib/logging/`, price/device/startup/runtime failure paths, tests.
- [ ] Expand ALS correlation helpers beyond rebuilds. Add shared helpers for flow-scoped IDs such
      as `incidentId`, `snapshotId`, and `priceRefreshId`, generated with `crypto.randomUUID()`
      and propagated automatically across async boundaries.
      Files: `lib/logging/alsContext.ts`, `lib/logging/logger.ts`, overshoot/snapshot/price flows,
      logging tests.
- [ ] Add the next high-value structured events:
      `capacity_action_selected`, `price_source_fallback_used`, `device_state_unknown_entered`,
      `ui_snapshot_written`, and degraded-mode boundary events.
      Files: capacity handling, price services, device manager/UI snapshot writers, tests.
- [ ] Emit compact summary snapshot events only at key boundaries such as startup completion,
      device snapshot refresh completion, plan rebuild completion, UI snapshot writes, and
      degraded-mode enter/exit. Keep payloads bounded and machine-friendly.
      Files: startup, device manager, plan service, UI snapshot write paths, tests.
- [ ] Extend logging tests to cover end-to-end correlation and boundary behavior, including
      overshoot incidents grouped by `incidentId`, rebuild flows grouped by `rebuildId`, nested
      ALS contexts, and Homey forwarding for correlated structured events.
      Files: `test/logging/`, flow-specific runtime tests.

### P2 Structured logging: schema and cleanup polish

- [ ] Add typed structured-log event/reason-code definitions and migrate the current stringly
      typed event names / reason codes to them so payloads do not drift across services.
      Files: `lib/logging/`, structured-log call sites, logging tests.
- [ ] Replace ad hoc `Date.now() + Math.random()` correlation IDs such as `incidentId` and
      `rebuildId` with `crypto.randomUUID()` so generated IDs are uniform and do not encode
      accidental timestamp semantics.
      Files: `capacityGuard.ts`, `planService.ts`, logging tests.
- [ ] Finish the structured logging policy migration so runtime logging no longer depends on prose
      `this.log()` / `this.logDebug()` messages. Spell out the target end-state, how debug-topic
      filtering applies to structured debug events, and which legacy prose log sites remain to be
      removed.
      Files: `AGENTS.md`, `notes/`, logging helpers, remaining runtime log call sites.

### P1 Dead code and dead plumbing

- [x] Remove unused `updateLocalSnapshot` dependency from the binary-control pipeline.
      `planBinaryControl.ts` declares it in `BinaryControlDeps` but never calls it.
      `planExecutor.ts` still threads it through `buildBinaryControlDeps()`. Dead plumbing
      with no behavior change on removal.
      Files: `lib/plan/planBinaryControl.ts`, `lib/plan/planExecutor.ts`.

### P1 Inefficiencies: unnecessary work or repeated lookups

- [ ] Cache snapshot lookup by device ID in `applyPlanActions` instead of repeating
      `latestTargetSnapshot.find(...)` across action paths.
      Files: `planExecutor.ts`.

### P1 Cleanup: reduce duplicate logic and state-model sprawl

- [ ] Remove duplicate stepped-state derivation in `resolveSteppedLoadCurrentState` and rely on
      the already decorated snapshot state instead of deriving the same intent twice.
      Files: `planSteppedLoad.ts`, `planDevices.ts`.
- [ ] Consolidate stepped-load state naming and storage across runtime state, decorated snapshot,
      and `DevicePlanDevice`. Reduce copied fields and rename confusing carry-forward state such
      as "previous desired step" data.
      Files: `appDeviceControlHelpers.ts`, `planDevices.ts`, `planTypes.ts`.
- [ ] Replace the four pending-state systems (binary, target, step, shed/restore) with a more
      consistent per-device pending-action model and shared timeout / confirmation semantics.
      Files: `planState.ts`, `planBinaryControl.ts`, `planTargetControl.ts`,
      `appDeviceControlHelpers.ts`.
- [ ] Merge temperature-target and binary-power actuation settlement, retry policy, pending vs
      observed semantics, and logging behind one shared control pipeline instead of two parallel
      implementations that drift.
      Files: `planBinaryControl.ts`, `planTargetControl.ts`, `planExecutor.ts`,
      pending/logging helpers.
- [ ] Make stepped-load logs name their source of truth explicitly. Requested/confirmed step logs
      should distinguish desired step, last confirmed step, effective planning step, and externally
      observed step so stale desired state is never presented as actual device state and
      "outside PELS" followed by a later PELS request is easy to interpret.
      Files: stepped feedback logging path, `planExecutor.ts`, `planLogging.ts`.
- [ ] Replace the 30+ field `DevicePlanDevice` bag with tighter types where shed behavior and
      control-model-specific fields are coupled instead of independent optionals.
      Files: `planTypes.ts`.

### P1 Simplification: reduce plan module indirection

See `notes/plan-module-simplification/README.md` for context.

- [x] Merge `planRestoreGate.ts` (43 lines) and `planTiming.ts` (18 lines, 1 consumer) into
      `planRestoreTiming.ts`. All three are about "should restores happen now?" and the splits
      just add import hops.
- [x] Merge `planSheddingStepped.ts` (41 lines, 1 consumer) into `planShedding.ts`.
- [ ] Merge `planReasonHelpers.ts` (102 lines, 1 consumer) into `planReasons.ts`.
      Blocked: merging would push `planReasons.ts` over the 500-line lint limit.
      Files: `lib/plan/planReasonHelpers.ts`, `lib/plan/planReasons.ts`.
- [ ] Merge `planServiceInternals.ts` (64 lines, 2 consumers) into `planService.ts`.
      Blocked: creates a `planService ↔ planStatusWriter` circular dependency.
      Files: `lib/plan/planServiceInternals.ts`, `lib/plan/planService.ts`.
- [ ] Collapse `shouldBlockRestoreForSwap` and `shouldBlockRestoreForPendingSwap` in
      `planRestoreHelpers.ts` into one swap-blocking gate. They are two checks for the same
      concept (is a swap in progress for this device?).
      Files: `lib/plan/planRestoreHelpers.ts`.
- [ ] Replace `planActivationBackoff.ts` (424 lines) with a simpler exponential timer per device.
      The current state machine (penalty levels 0-4, stick windows, clear windows, diagnostic
      transitions) is over-specified for the problem. A "don't retry for N minutes, double N on
      failure, cap at 30 min" approach would cover the same cases in ~60 lines.
      Files: `lib/plan/planActivationBackoff.ts`, restore/shedding tests.
- [ ] Separate reason-string generation from decision logic in `planReasons.ts` (468 lines).
      Reason strings are a presentation concern currently interleaved with control flow.
      Consider generating reasons as a post-pass over the finalized plan.
      Files: `lib/plan/planReasons.ts`, `lib/plan/planRestore.ts`.

### P1 Wiring and orchestration cleanup

- [ ] Reduce pass-through wiring boilerplate between `app.ts` and `lib/app/appInit.ts`.
      A meaningful share of the code is thin wrapper methods and lambda forwarding that
      only adapts app methods into service dependencies. Trim or collapse where it does not
      protect a real boundary; pass narrower dependency objects instead of many one-line
      lambda wrappers.
      Files: `app.ts`, `lib/app/appInit.ts`.
- [ ] Reduce top-level orchestrator complexity in `app.ts`, `planExecutor.ts`, and
      `planService.ts`. All three carry explicit size/complexity lint suppressions and act as
      accumulation points for wiring, sequencing, and cross-cutting control logic. Track
      shrinking them as a first-class task, not only as a side-effect of deeper planner
      refactors. Good changes: remove thin wrappers, push mechanical wiring into better-owned
      helpers, separate lifecycle sequencing from domain decisions. Bad changes: splitting
      files without reducing actual orchestration load.
      Files: `app.ts`, `lib/plan/planExecutor.ts`, `lib/plan/planService.ts`.

## P2 Product and test follow-ups

- [ ] Rework temperature-device starvation detection to the intended-target / suppression-only
      model described in `notes/starvation/README.md`. This is detection only: it must not change
      planner decisions. Includes pauseable accumulation, counting vs pause reasons, overview
      badge/status suffix, insights, diagnostics/logs, and once-per-episode duration-threshold
      flow triggers.
      Files: diagnostics model/service, plan snapshot/contracts/UI, flow cards, insights.
- [ ] Treat stepped-load upward transitions for already-on devices as active mode transitions, not
      restore UI. `low -> medium/max` should not show a gray `Restoring` badge/text just because
      the target step changed.
      Files: `packages/settings-ui/src/ui/plan.ts`, plan state/status derivation.
- [ ] Debounce/coalesce rapid temperature changes from the device tab so bulk edits do not flap
      the plan or spam writes/retries.
      Files: settings UI device detail, target write path, tests.
- [ ] Add a budget-exemption toggle on the device page so a device can be marked or unmarked as
      budget-exempt without leaving the device detail flow.
      Files: settings UI device detail, settings write path, tests.
- [ ] Add gray badge/state handling for unknown or disappeared devices in the overview/device list
      instead of leaving them visually ambiguous.
      Files: settings UI overview / device list.
- [ ] Expose yesterday's daily-budget deviation as variables/tags and surface it in daily-budget
      data where useful.
      Files: daily budget API, flow cards, UI/contracts.
- [ ] Add headroom threshold flow cards for crossing above/below a configured threshold. Support
      generic triggers/conditions rather than only per-device headroom checks.
      Files: `flowCards/registerFlowCards.ts`, flow-card tests.
- [ ] Add a mode-switch surface to the insights device so flows and dashboards can drive or show
      operating mode more directly.
      Files: `drivers/pels_insights/**`, related flow cards/capabilities.
- [ ] Align restore-cooldown badge/state text in the plan UI. Either add a dedicated badge state
      or make badge text match the existing state line, and audit true shed devices so they do not
      accidentally render as neutral gray.
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [ ] Rename the restore-cooldown plan UI test so the description matches the actual assertion.
      Files: `packages/settings-ui/test/plan-ui.test.ts`.
- [ ] Add stepped-load coverage for profiles without an explicit off-step. Shed should converge to
      the lowest available step instead of assuming a synthetic off-step exists.
      Files: stepped-load planning / executor tests.
- [ ] Add remaining restore-pending follow-up tests for per-device scoping, retry-window expiry,
      confirmation clearing, no-false-pending cases, unaffected on/off restore flow, and status
      classification. Slow-device confirmation timing and provisional-live-load behavior now have
      dedicated coverage; keep this item focused on the remaining pending-state gaps.
      Files: restore / reconciliation / status test suites.
- [ ] Add restore-cooldown branch-coverage tests so rebuild-triggered restore, swap restore, and
      feedback-triggered restore all respect the same cooldown gate and log why restore was
      blocked.
      Files: restore planning / app integration tests.
- [ ] Add remaining binary drift consistency tests that assert observed-state update ordering and
      correct reapply target direction across realtime -> reconcile integration. Pending-command
      suppression now has dedicated coverage; keep this item focused on the missing drift path
      assertions.
      Files: realtime reconcile tests, device manager realtime tests, executor/reconcile tests.
- [ ] Audit whether daily-budget confidence scoring (549 lines) changes any control decision or
      is purely informational. If informational, consider whether the complexity is justified or
      can be simplified significantly.
      Files: `lib/dailyBudget/dailyBudgetConfidence.ts`, daily budget plan/service.

## P3 Architecture, tooling, and perf tightening

- [ ] Remove the remaining `lib/utils/** -> lib/{core,plan}` imports by moving those helpers to
      better owned modules, then make the architecture check strict instead of advisory.
      Files: `lib/utils/settingsHandlers.ts`, `lib/utils/capacityHelpers.ts`,
      `lib/utils/appTypeGuards.ts`, architecture checks.
- [ ] Expand unused-export checks to cover the shared packages and settings UI, then remove the
      temporary allowlist exceptions that exist only because those areas are not checked yet.
      Files: `scripts/check-dead-code.mjs`, `tsconfig.runtime-unused.json`,
      `packages/contracts/**`, `packages/shared-domain/**`, `packages/settings-ui/**`.
- [ ] Tighten hot-path perf linting by changing `unicorn/no-array-reduce` to
      `{ allowSimpleOperations: false }` once the remaining reducers are migrated.
      Files: `eslint.config.mjs`, `lib/plan/planShedding.ts`,
      `lib/dailyBudget/dailyBudgetAllocation.ts`, `lib/dailyBudget/dailyBudgetConfidence.ts`,
      `lib/dailyBudget/dailyBudgetMath.ts`, `lib/dailyBudget/dailyBudgetService.ts`.
- [ ] Review whether our ECharts usage follows current best practices for sizing, resize handling,
      lifecycle/disposal, and option update patterns before we add more chart complexity.
      Files: `packages/settings-ui/src/ui/**`, chart helpers/tests, notes if new guidance is needed.
- [ ] Expand hot-path iteration rules (`no-array-for-each`, `no-array-reduce`, loop allocation
      bans) from `lib/{core,plan,dailyBudget}` to the rest of runtime after violations are
      cleaned up.
      Files: `app.ts`, `flowCards/**`, `drivers/**`, lint config.
- [ ] Re-enable `functional/immutable-data` for hot-path overrides once intentional mutable fast
      paths are isolated behind explicit, well-scoped exceptions.
      Files: `eslint.config.mjs`, hot-path runtime modules.
- [ ] Enable targeted `no-await-in-loop` in safe non-actuation loops after documenting approved
      sequential-actuation patterns.
      Files: lint config, loop call sites.
- [ ] Precompute shared zone/hour lookup data during plan rebuild so `resolveRemainingCaps`,
      `resolveRemainingFloors`, and `buildControlledMinFloors` do not repeatedly call
      `getZonedParts`.
      Files: plan rebuild helpers.
- [ ] Keep investigating long-running `planRebuildApply` stalls after the stepped-load flow fix.
      The known ~90s case was caused by awaiting `desired_stepped_load_changed` flow execution in
      the apply path; remaining investigation should distinguish slow Homey device writes,
      delayed refreshes, and local sequencing bottlenecks before they distort cooldown and control
      timing.
      Files: apply path instrumentation, perf logging, executor / plan service timing.
- [ ] Avoid full plan rebuilds on every power sample. Sample updates should normally refresh
      headroom/status only, and rebuild the full plan only when PELS crosses a control boundary
      (over a limit, into another protection mode, or enough headroom exists to recover another
      device).
      Files: power update pipeline, rebuild scheduler, plan status/headroom path.
- [ ] Add per-phase ampere limit support. A single-phase circuit can be overloaded while total
      household kW is within the global limit. Blocked until Homey Energy exposes per-phase
      current data; reading directly from HAN device capabilities is too fragile.
      Files: power tracking, capacity guard, plan context, settings UI.
- [ ] Add stale-measurement failsafe. If no fresh power sample arrives for a configurable window
      (e.g. 2 minutes), trigger protective shedding or at minimum surface a warning, rather than
      silently planning on stale data.
      Files: power sample pipeline, capacity guard, plan engine, settings/config.

## P4 Future extensibility

- [ ] Introduce a pluggable pricing strategy interface so non-Norwegian price schemes can swap in
      their own calculators without touching control logic.
      Files: pricing domain / aggregation pipeline.
- [ ] Auto-adjust daily budget from past eligible exemptions using the policy in
      `notes/daily-budget-auto-adjust/README.md`. Keep base budget, correction, and effective
      budget separate, and derive correction from completed-day eligible exempted kWh rather than
      starved minutes.
      Files: daily budget state/service/UI/settings/diagnostics.
- [ ] Support configurable per-device cooldowns for restore/shedding behavior instead of a single
      global timing model.
      Files: device config, restore/shedding timing, settings UI.
- [ ] Support explicit headroom reservations within the budget model (`book X kW for X minutes`)
      so predictable near-term loads can reserve capacity/headroom.
      Files: headroom/daily budget planning, UI/flows.
- [ ] Restore more than one device at a time when headroom allows, e.g. restore a configurable
      share of headroom rather than strict one-by-one reactivation.
      Files: restore planner/executor/tests.
- [ ] Make price influence more explainable and adaptive to actual price spread, so users can see
      that price weighting is doing real work and the effect scales with volatility.
      Files: price optimization, daily budget, settings UI.
- [ ] Explore weather-aware budget context or diagnostics so current budget pressure can be
      compared with recent weather / heat demand.
      Files: daily budget analytics/UI.
- [ ] Store a small per-device action log ring buffer and expose it in the UI so users can inspect
      hysteresis, price-driven changes, sheds, restores, and other recent actions.
      Files: diagnostics/history storage, settings UI.

## P5 Product, docs, and integration backlog

- [ ] Rewrite landing-page / getting-started copy to emphasize automatic and intelligent control,
      hard-cap setup, usage-flow setup, modes/targets/priorities, and mode-switch flows; remove
      contributor-oriented copy from end-user docs and simplify over-technical early sections.
      Files: website / published docs.
- [ ] Add a Homey Energy-only how-to for users who want PELS without extra integrations.
      Files: website / published docs.
- [ ] Add a proper daily-budget how-to with a worked budget-exemption example.
      Files: website / published docs.
- [ ] Add website metadata and refresh branding assets/copy, including a non-black PELS logo.
      Files: app/site metadata, branding assets.
- [ ] Revisit daily-budget history navigation: remove the 7/14-day toggle, add week navigation,
      and consider merging hourly details plus daily history into one shared view.
      Files: settings UI daily-budget views/components.
- [ ] Replace the hourly price list with a line graph for today/tomorrow with cheap/expensive
      background bands and the existing tooltip content.
      Files: settings UI prices/daily-budget charts.
- [ ] Fix the mobile vs web color-scheme mismatch so the visual language is consistent across
      surfaces.
      Files: settings UI / website styling.
- [ ] Design a virtual thermostat driver based on the examples in `tmp`, focusing on pairing,
      settings, repair, and overall user UX before implementation.
      Files: new driver design / UX note / `tmp` review.
- [ ] Add a virtual EV charger / proxy driver that proxies official capabilities by default,
      allows optional extra capability mapping via settings or flows, hides the proxy from the
      main settings device list, uses device class `other`, and supports stepped charging /
      unsupported chargers such as Easee and Zaptec.
      Files: new driver(s), pairing/settings integration, device discovery/UI.
- [ ] Add generic proxy / flow-owned devices for unsupported integrations (for example Flexit) and
      flow-only controllable loads that are hidden by default but can participate in
      price/capacity control when configured.
      Files: new drivers, settings UI, flow cards.
