# Runtime complexity cleanup

> Status note: this document started as a point-in-time complexity review. Several simplifications
> called out below have already landed since the original snapshot, including
> `planReasonStrings.ts`, the `planExecutorTarget.ts` / `planExecutorStepped.ts` split, the
> `deviceManager` parsing / observation / binary-settle extractions, the activation-backoff
> simplification, and the first `app.ts` helper extractions around snapshot refresh / Homey Energy
> / stepped-load runtime ownership. Treat the raw LOC counts and any "current hotspot"
> descriptions for those areas as historical unless remeasured before use.

## See also

- [`god-file-policy.md`](god-file-policy.md) — proposal to stop granting blanket `max-lines`
  exemptions and classify every oversized runtime file as Bucket A (must shrink) or Bucket B
  (documented exception with a concrete ceiling).
- [`rebuild-scheduler-unification.md`](rebuild-scheduler-unification.md) — design note for
  collapsing the three plan-rebuild coalescers into a single `PlanRebuildScheduler`.

## Goal

Reduce complexity in core runtime files. Not "fewer lines per file" — less cognitive load when
reading, debugging, or modifying the system. Every change should make it easier to answer
"why did this device do X?" without jumping through unnecessary indirection.

## Guiding principles

1. **Simplify first, split second.** Reducing a 424-line state machine to 60 lines is better than
   splitting it across three files. Only split files when the resulting modules are genuinely
   independent concepts.

2. **Delete before abstracting.** If logic can be removed or collapsed, do that. Don't wrap
   complexity in an interface and call it clean.

3. **One concept per change.** Each PR tackles one simplification. Don't bundle a file split with a
   logic rewrite.

4. **Indirection has a cost.** Earlier analysis showed that tracing one restore path crossed
   roughly 14 files. Adding more files without removing indirection makes the problem worse.

---

## Current complexity hotspots

### 1. `planActivationBackoff.ts` — landed

This simplification has already landed via PR #401. The remaining relevance here is downstream:
`planRestore.ts` can now be simplified without having to preserve the older backoff lifecycle
shape.

**Remaining follow-up:** none in this file; see `planRestore.ts` / restore-gate cleanup.

### 2. `planReasons.ts` — mostly landed

The first extraction landed earlier, and the local decision/presentation split is now in place:
`planReasons.ts` makes bounded internal reason-code decisions and only renders final reason prose
at the edge. The visible `reason` strings remain stable for existing plan/debug/diagnostic
consumers.

**Remaining simplification:** downstream consumers such as `planLogging.ts` and
`planDiagnostics.ts` still classify behavior from free-form reason strings. Keep that follow-up as
separate scope instead of broadening the `planReasons.ts` cleanup PR.

**Current size:** ~696 LOC. `planReasonStrings.ts` is ~260 LOC and stays separate for now because
it now owns shared reason classification and rendering across multiple plan modules.

### 3. `planExecutor.ts` — partially landed

The control-type split has already landed via PR #396. `planExecutor.ts` remains a hotspot, but
the target-command and stepped-load pipelines no longer live in the file.

**Remaining simplification:** decide whether the remaining binary-control path should stay local or
be extracted further once the post-split shape has settled.

**Current size:** ~782 LOC after the landed split.

### 4. `app.ts` — partially landed, still active

Snapshot refresh, Homey Energy polling, and stepped-load helper ownership have already moved out
via PRs #397 and #398. `app.ts` is still a hotspot because it remains the lifecycle / timer /
service-wiring accumulation point.

**Remaining simplification:** continue collapsing one-line delegates, introduce `TimerRegistry`,
and replace the init-time dependency bags with `AppContext`.

**Current size:** ~938 LOC after the helper extractions.

### 5. `deviceManager.ts` — partially landed

PR #400 landed the parsing, observation, and binary-settle extractions. `deviceManager.ts`
remains large, but the specific split described in the original review is no longer open work.

**Remaining simplification:** only pursue further extraction if a new subsystem boundary is clear
after the current helper layout has settled.

**Current size:** ~894 LOC after the landed extractions.

### 6. `planService.ts` — 823 LOC, mixed concerns

Contains rebuild orchestration, snapshot persistence (throttling, dedup, timers), and metrics
measurement. These are genuinely separate concerns sharing a class for convenience.

**Simplification:** Extract snapshot-write subsystem (~120 LOC) and rebuild-metrics helpers
(~120 LOC) into their own modules. Also move `planServiceInternals.ts` types into `planTypes.ts`
to resolve the blocked circular dependency.

**Risk:** Medium. The snapshot writer uses timers and deferred writes that need careful lifecycle
management.

**Prerequisite:** Phase 1 (planServiceInternals.ts type relocation).

### 7. `planRestore.ts` — 505 LOC, 8 sequential restore gates

A device must pass 8 gates before restore is allowed. Gates 3-4 (swap block + pending swap
block) are one concept split in two. Gates 5-6 (waiting + activation setback) are both "system
unsettled." Collapsing to ~5 gates removes conceptual overhead.

**Simplification:** Collapse redundant gates. With the activation backoff simplified (Phase 1),
the backoff-related gate also becomes simpler.

**Risk:** Low-medium. The gate behavior is well-tested. The collapse preserves all safety checks,
just combines conceptually identical ones.

**Prerequisite:** Phase 1 (backoff simplification reduces the gate interaction surface).

### 8. `appPowerHelpers.ts` — landed

The split identified during the 2026-04-16 critical review has now landed. The previous monolith
was decomposed into:

- `appPowerRebuildPolicy.ts` — pure decision/backoff/holdoff policy helpers.
- `appPowerRebuildScheduler.ts` — the timer/promise state machine for signal-driven rebuilds.
- `appPowerSampleIngest.ts` — power-sample ingest, persistence, pruning, and budget-cap recording.
- `appPowerHelpers.ts` — compatibility barrel used by existing call sites.

The tight-noop exponential backoff and tight-mitigation holdoff contracts were preserved during
the split, and `test/appPowerHelpers.test.ts` remains the main regression coverage for this area.

**Remaining follow-up:** use the cleaner policy/scheduler boundary as the Phase 8 prerequisite for
the cross-file rebuild-scheduler unification work described below.

### 9. Triple plan-rebuild coalescer — cross-file race window

Three distinct debouncers gate plan rebuilds and snapshot writes with different contracts:

- `lib/app/appFlowRebuildScheduler.ts` (FLOW_REBUILD_COOLDOWN_MS=1000) — flow-card-driven.
- `schedulePlanRebuildFromSignal` in `appPowerHelpers.ts` — power-sample-driven with tight-noop
  exponential backoff.
- `planService.pendingNonActionSnapshotTimer` — non-action snapshot writes.

They never coordinate. A flow rebuild and a signal rebuild can race, and each has its own
cancellation and priority story.

**Simplification:** Replace with a single `PlanRebuildScheduler` exposing three prioritised
intents: `requestRebuild(reason, priority)`, `requestSnapshotWrite(reason)`,
`requestImmediateHardCap(reason)`. One state machine, one pending timer per intent class.

See [`rebuild-scheduler-unification.md`](rebuild-scheduler-unification.md) for the state-machine
design, preserved invariants, and migration plan.

**Risk:** Medium-high. Safety-envelope code. The appPowerHelpers split has now landed, so the
decision module is a stable input to the new scheduler.

**Prerequisite:** satisfied by the landed appPowerHelpers split.

### 10. Timer lifecycle scatter in `app.ts`

Ten timer fields live directly on `app` (`snapshotRefreshTimer`, `staleObservationRefreshTimer`,
`targetConfirmationPollInterval`, `postActuationRefreshTimer`, `realtimeDeviceReconcileTimer`,
`heartbeatInterval`, `homeyEnergyPollInterval`, `powerTrackerSaveTimer`,
`powerTrackerPruneInterval`, `powerTrackerPruneTimer`). Each has its own start method; cleanup is
enforced only by discipline in `onUninit`. Adding a new timer and forgetting to register its
cleanup silently leaks.

**Simplification:** Introduce a ~40 LOC `TimerRegistry` in `lib/app/`:

```
class TimerRegistry {
  register(name: string, handle: NodeJS.Timeout | number): void
  clear(name: string): void
  clearAll(): void
  has(name: string): boolean
}
```

Every `setTimeout`/`setInterval` becomes `this.timers.register('snapshotRefresh', setTimeout(...))`
and `onUninit` becomes `this.timers.clearAll()`.

**Risk:** Low. Pure mechanical extraction.

**Prerequisite:** None. Land any time; complements the `app.ts` wiring cleanup.

### 11. `app.ts` dependency bags

Four init sites on `app.ts` take large plain-object callback bags (init settings handler, init
plan engine, register flow cards, start app services — 22-28 callbacks each). Each bag was
invented independently, overlaps with the others, and drifts as features are added. Roughly 40
one-line getters near the bottom of `app.ts` exist only to populate these bags.

**Simplification:** Construct an `AppContext` struct once in `onInit`. Every module that needs
state takes `ctx` and reads fields directly. The four bags and most of the one-line getters go
away. `lib/app/appInit.ts` (264 LOC of lambda-rewrapping factories whose only real logic is
`resolveHasBinaryControl`) can then be deleted — construct `PlanEngine`, `PlanService`, and
`PriceCoordinator` directly from `ctx` in `app.ts`.

**Risk:** Medium. Touches every init site. Startup ordering must be preserved exactly.

**Prerequisite:** None, but naturally pairs with Phase 10 (TimerRegistry) since both shrink
`app.ts`.

---

## Phase order

Phases are ordered by: standalone value, risk, and dependency.

| Phase | Target | Primary win | Risk |
|-------|--------|-------------|------|
| 1 | planActivationBackoff.ts | Landed via PR #401 | Low |
| 2 | planReasons.ts + merges | Separate decision logic from presentation | Low |
| 3 | planExecutor.ts | Largely landed via PR #396; binary-path follow-up remains | Medium |
| 4 | app.ts | Helper extractions landed via PRs #397/#398; wiring cleanup remains | Medium |
| 5 | planService.ts | Separate persistence from orchestration | Medium |
| 6 | planRestore.ts | Collapse redundant gates | Low-medium |
| 7 | deviceManager.ts | Core internal split landed via PR #400; only further cleanup remains | Medium-high |
| 8 | appPowerHelpers.ts | Split decision / scheduler / ingest | Medium |
| 9 | PlanRebuildScheduler | Unify three coalescers; close rebuild race | Medium-high |
| 10 | TimerRegistry | Eliminate timer-leak failure mode | Low |
| 11 | AppContext + delete appInit.ts | Collapse four callback bags and the glue layer | Medium |

Several phases above have already landed. The main open structural work is now Phases 5, 6, and
8-11, with only narrower follow-up left in the earlier app/executor/deviceManager phases.

Open workpackages that can still land in parallel: {2}, {5}, {6}, {8}, {9 after 8}, {10}, {11}.
The cross-file Phases 9, 10, and 11 each conflict with `app.ts`, so land them sequentially
relative to each other.

## P1 Simplicity Candidates

If the next stretch of work explicitly prioritizes simplification, these are the strongest P1
candidates because they remove indirection without opening a wide correctness surface:

1. **Phase 2: `planReasons.ts` + helper merge.** Improves debuggability immediately because the
   decision path stops being buried in string-building noise.
2. **`planService.ts` snapshot-write extraction.** Rebuild orchestration and throttled snapshot
   persistence are separate concepts and are currently coupled for convenience.
3. **`app.ts` wiring cleanup.** The biggest local win now is finishing the delegate/timer/context
   cleanup after the snapshot-refresh / Homey Energy / stepped-load helper extractions landed.
If these get promoted, keep the same rule as above: one concept per PR. Do not bundle
the `planRestore.ts` gate rewrite with unrelated correctness work, and do not mix the remaining
`app.ts` wiring cleanup with unrelated runtime behavior changes.

---

## What this does NOT include

Items from the original refactoring spec that are deferred or dropped:

| Item | Reason |
|------|--------|
| Device control model interfaces | Premature abstraction. No concrete bug or complexity it eliminates today. Worth revisiting after the pending-state unification (TODO P1). |
| Load reduction strategy interfaces | Speculative. The branching on shed action type is 3-way and localized. |
| Command observation policy interfaces | `planObservationPolicy.ts` (56 LOC, 7 consumers) is fine as-is. |
| Power source interfaces | Branching on `power_source` is in ~2 places. A shared helper would suffice if needed. |
| Price source/scheme interfaces | Reasonable but independent of the complexity goal. Better as a follow-up when pricing is reworked. |
| State publisher utility | YAGNI. |
| `appInit.ts` deletion | **Revisited 2026-04-16:** superseded by Phase 11. The factory functions are ~260 LOC of lambda-rewrapping whose only real logic is `resolveHasBinaryControl`; they exist to service the four callback bags. Once `AppContext` replaces the bags, this file collapses naturally and should be deleted as part of that phase. |
| `registerFlowCards.ts` split | Procedural registration code. Low change frequency, low coupling. |
| `appDebugHelpers.ts` split | Debug dump helpers. Low priority. |
| `deviceDiagnosticsService.ts` split | Stateful service, clear structure. Defer until diagnostics rework. |

---

## Progress

### Landed
- [x] Phase 1: simplify `planActivationBackoff` via PR #401
- [x] Phase 3: split `planExecutor` by control type via PR #396
- [x] Phase 4 (partial): extract snapshot refresh / Homey Energy / stepped-load runtime helpers
      from `app.ts` via PRs #397 and #398
- [x] Phase 7: extract `deviceManager` parsing / observation / binary-settle internals via PR #400
- [x] Split Settings UI device detail into focused `deviceDetail/` modules so render wiring,
      shed behavior, stepped-load draft state, diagnostics, and price-optimization handlers no
      longer share one max-lines-exempt file

### Phase 2: Continue planReasons cleanup
- [x] Extract reason-string builders into `planReasonStrings.ts`
- [x] Keep moving restore/shed decisions toward bounded machine-readable codes
- [x] Re-measure whether `planReasonStrings.ts` should stay separate or be folded back once the
      remaining formatting surface is smaller
      Keep separate: it now carries shared reason classification plus rendering used outside
      `planReasons.ts`, so folding it back would re-couple decision and presentation surfaces.

### Phase 4 follow-up: continue shrinking app.ts
- [ ] Collapse one-liner delegates
- [ ] Re-measure whether any cohesive runtime helper groups still justify extraction before
      moving to `TimerRegistry` / `AppContext`

### Phase 5: Split planService
- [ ] Extract snapshot-write subsystem into planSnapshotWriter.ts
- [ ] Extract rebuild-metrics into planRebuildMetrics.ts

### Phase 6: Collapse planRestore gates
- [ ] Merge swap + pending-swap gates
- [ ] Merge waiting + activation-setback gates where applicable

### Phase 8: Split appPowerHelpers
- [ ] Coverage audit of `test/appPowerHelpers.test.ts` for every backoff/holdoff branch
- [ ] Extract `planRebuildDecision.ts` (pure decision policy)
- [ ] Extract `planRebuildScheduler.ts` (state machine + pending timer/promise)
- [ ] Extract `powerSampleIngest.ts` (persistence, pruning, cap recording)

### Phase 9: Unify rebuild coalescers into PlanRebuildScheduler
- [ ] Design sign-off against `notes/complexity-cleanup/rebuild-scheduler-unification.md`
- [ ] Three-coalescer race regression test before any code changes
- [ ] Fold `appFlowRebuildScheduler.ts` contract into the unified scheduler
- [ ] Fold `planService.pendingNonActionSnapshotTimer` into the unified scheduler
- [ ] Remove the old per-concern debouncers

### Phase 10: TimerRegistry
- [ ] Add `lib/app/timerRegistry.ts` (~40 LOC)
- [ ] Migrate the ten timer fields on `app.ts` through the registry
- [ ] Add a `onUninit` test asserting all registered timers are cleared

### Phase 11: AppContext + delete appInit.ts
- [ ] Introduce `lib/app/appContext.ts` with the struct and the construction helper
- [ ] Replace the four init-site callback bags with `ctx` references
- [ ] Inline the ~40 one-line delegate getters
- [ ] Move `resolveHasBinaryControl` to `lib/core/deviceManagerControl.ts`
- [ ] Delete `lib/app/appInit.ts`
