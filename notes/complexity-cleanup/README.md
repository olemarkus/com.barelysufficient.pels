# Runtime complexity cleanup

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

### 1. `planActivationBackoff.ts` — 405 LOC, over-specified state machine

Full 5-level penalty state machine with stick windows, clear windows, and diagnostic transitions.
The problem it solves: "don't keep retrying a device that fails to activate." A simple exponential
timer per device would cover the same cases in ~60 lines.

**Simplification:** Replace with exponential backoff. Block for N minutes after failure, double N
on each failure, cap at 30 min, reset after sustained success. Emit the same diagnostic events
from the simpler model.

**Risk:** Low. The public API surface is small (3 functions). Existing tests describe the desired
behavior, not the internal state machine.

**Prerequisite:** None.

### 2. `planReasons.ts` — 683 LOC, decision logic mixed with presentation

Reason strings are presentation concerns interleaved with control flow. Every restore/shed path
carries `reason:` assignments alongside decision gates. Reading the decision logic means reading
through string interpolation.

**Simplification:** Extract reason-string builders into `planReasonStrings.ts`. The decision
functions record a machine-readable code; strings are derived separately. This also unblocks
merging `planReasonHelpers.ts` (102 LOC, 1 consumer) into the decision file.

**Risk:** Low. Pure extraction, no logic change.

**Prerequisite:** None.

### 3. `planExecutor.ts` — 1587 LOC, three actuation pipelines in one file

The executor has three distinct control pipelines (binary, target-temperature, stepped-load) that
share only the top-level dispatch. Each pipeline is internally cohesive and does not call the
others.

**Simplification:** Extract stepped-load actuation (~240 LOC) and target-command actuation
(~300 LOC) into their own modules. The top-level dispatch and binary control stay. This follows
the existing pattern of `planExecutorSupport.ts`.

**Risk:** Medium. The methods access executor state/deps, so they need a clean deps parameter.
But `planExecutorSupport.ts` already shows the pattern.

**Prerequisite:** None. Can happen in parallel with other phases.

### 4. `app.ts` — 1284 LOC, accumulation point for wiring

The app class grew by accretion. Several method groups are internally cohesive and only interact
with the rest of the class through `this.xxx` field access:

- Snapshot refresh management (~170 LOC)
- Homey Energy polling (~50 LOC)
- Stepped-load runtime helpers (~130 LOC)
- One-liner delegates to services (~40 LOC of `= () => this.service.method()`)

**Simplification:** Extract cohesive groups into existing or new app helpers. Collapse one-liner
delegates where possible by passing services directly instead of wrapping each method.

**Risk:** Medium. The methods use `this` state extensively, so extraction requires passing state
or a context object.

**Prerequisite:** None, but benefits from doing planExecutor.ts first (pattern established).

### 5. `deviceManager.ts` — 1702 LOC, largest file

Already delegates to 9 helper files. The remaining class contains two large internal subsystems
that are extraction candidates:

- Device parsing pipeline (~200 LOC) — pure data transformation
- Capability observation tracking (~250 LOC) — freshness/staleness subsystem
- Binary settle window management (~100 LOC) — pending confirmation tracking

**Simplification:** Extract these three subsystems. DeviceManager keeps init, refresh, set,
apply, realtime listener management, and public API.

**Risk:** Medium-high. The observation tracking interacts with refresh timing. Needs careful
testing.

**Prerequisite:** None, but this is the most invasive split and should come after the lower-risk
phases.

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

### 8. `appPowerHelpers.ts` — 898 LOC, eight concerns in one file

Identified during the 2026-04-16 critical review. One module currently owns: rebuild-decision
policy, pending/coalesced scheduling, tight-noop exponential backoff
(`TIGHT_NOOP_BACKOFF_MS = [15000, 30000, 60000]`), tight-mitigation holdoff
(`TIGHT_MITIGATION_HOLDOFF_MS = 15000`), hard-cap breach fast-path, power-sample integration,
sample persistence, sample pruning. `PowerSampleRebuildState` has 12 fields including two timers
and a pending promise. `schedulePlanRebuildFromPowerSample` is 143 LOC with 8 parameter fields.

**Simplification:** Split into three modules:

- `planRebuildDecision.ts` — pure: `shouldRebuildFromDecision`, `resolveRebuildReason`,
  `isTightNoopOutcome`, `shouldApplyTightNoopBackoff`, `shouldApplyTightMitigationHoldoff`,
  `resolveTightNoopBackoffMs`, `isTightNoopBackoffActive`.
- `planRebuildScheduler.ts` — state machine: owns the pending-rebuild timer and promise,
  `armPendingTimer`, `createPendingRebuild`, `coalescePendingRebuild`, `clearPendingState`,
  `withPendingInputs`, `buildPostRebuildState`. One public `schedule(intent)` surface.
- `powerSampleIngest.ts` — persistence/pruning/cap-recording side.

**Risk:** Medium. This module encodes the safety envelope around plan rebuilds — tight-noop
backoff and mitigation holdoff prevent pathological rebuild storms. The 1401-line
`test/appPowerHelpers.test.ts` is the main insurance.

**Prerequisite:** Coverage audit of `appPowerHelpers.test.ts` confirming every backoff/holdoff
branch is covered before the split begins.

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

**Risk:** Medium-high. Safety-envelope code. Land after appPowerHelpers has been split so the
decision module is a stable input to the new scheduler.

**Prerequisite:** Phase 8 (appPowerHelpers split).

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
| 1 | planActivationBackoff.ts | Delete ~370 lines of unnecessary complexity | Low |
| 2 | planReasons.ts + merges | Separate decision logic from presentation | Low |
| 3 | planExecutor.ts | Split three independent pipelines | Medium |
| 4 | app.ts | Extract cohesive method groups | Medium |
| 5 | planService.ts | Separate persistence from orchestration | Medium |
| 6 | planRestore.ts | Collapse redundant gates | Low-medium |
| 7 | deviceManager.ts | Extract parsing and observation tracking | Medium-high |
| 8 | appPowerHelpers.ts | Split decision / scheduler / ingest | Medium |
| 9 | PlanRebuildScheduler | Unify three coalescers; close rebuild race | Medium-high |
| 10 | TimerRegistry | Eliminate timer-leak failure mode | Low |
| 11 | AppContext + delete appInit.ts | Collapse four callback bags and the glue layer | Medium |

Each phase is one PR. Phases 1-2 are low-risk and can be done first as confidence builders.
Phases 3-5 are the main structural splits. Phase 6 is a logic simplification. Phase 7 is the
most invasive of the original set. Phases 8-11 were added in the 2026-04-16 review; Phases 8
and 11 both shrink `app.ts` wiring, Phase 9 depends on Phase 8, and Phase 10 is independent.

Workpackages that can land in parallel: {1}, {2}, {3}, {4 ∪ 10 ∪ 11}, {5}, {6 after 1}, {7},
{8}, {9 after 8}. The cross-file Phases 9 and 11 each conflict with `app.ts`, so land them
sequentially relative to each other.

## P1 Simplicity Candidates

If the next stretch of work explicitly prioritizes simplification, these are the strongest P1
candidates because they remove indirection without opening a wide correctness surface:

1. **Phase 1: `planActivationBackoff.ts`.** Lowest-risk deletion of complexity, and it makes the
   later restore-gate cleanup smaller.
2. **Phase 2: `planReasons.ts` + helper merge.** Improves debuggability immediately because the
   decision path stops being buried in string-building noise.
3. **`planService.ts` snapshot-write extraction.** Rebuild orchestration and throttled snapshot
   persistence are separate concepts and are currently coupled for convenience.
4. **`app.ts` wiring cleanup.** The biggest local win is extracting snapshot-refresh / Homey
   Energy polling coordination and deleting pass-through delegates where direct service access is
   enough.
5. **Settings UI `deviceDetail.ts`.** Not part of the original runtime cleanup, but it is now a
   real simplification candidate: render logic, stepped-load draft state, diagnostics refresh, and
   repeated `setSetting(...)` save paths all live in one file.

If these get promoted, keep the same rule as above: one concept per PR. Do not bundle
`planActivationBackoff.ts` simplification with a `planRestore.ts` gate rewrite, and do not mix
the `app.ts` wiring cleanup with unrelated runtime behavior changes.

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

### Phase 1: Simplify planActivationBackoff
- [ ] Replace state machine with exponential timer (~60 LOC)
- [ ] Preserve same public API and diagnostic events
- [ ] Verify existing backoff tests pass against new implementation

### Phase 2: Split planReasons + merges
- [ ] Extract reason-string builders into planReasonStrings.ts
- [ ] Merge planReasonHelpers.ts into planReasons.ts
- [ ] Move planServiceInternals.ts types into planTypes.ts

### Phase 3: Split planExecutor
- [ ] Extract stepped-load actuation into planExecutorStepped.ts
- [ ] Extract target-command actuation into planExecutorTarget.ts

### Phase 4: Split app.ts
- [ ] Extract snapshot refresh management
- [ ] Extract Homey Energy polling
- [ ] Absorb stepped-load helpers into appDeviceControlHelpers.ts
- [ ] Collapse one-liner delegates

### Phase 5: Split planService
- [ ] Extract snapshot-write subsystem into planSnapshotWriter.ts
- [ ] Extract rebuild-metrics into planRebuildMetrics.ts

### Phase 6: Collapse planRestore gates
- [ ] Merge swap + pending-swap gates
- [ ] Merge waiting + activation-setback gates where applicable

### Phase 7: Split deviceManager
- [ ] Extract device parsing pipeline
- [ ] Extract capability observation tracking
- [ ] Extract binary settle window management

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
