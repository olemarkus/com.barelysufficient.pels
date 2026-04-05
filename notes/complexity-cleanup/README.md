# Runtime complexity cleanup

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

4. **Indirection has a cost.** The `plan-module-simplification` notes established that tracing one
   restore decision crosses 14 files. Adding more files without removing indirection makes the
   problem worse.

---

## Current complexity hotspots

### 1. `planActivationBackoff.ts` — 431 LOC, over-specified state machine

Full 5-level penalty state machine with stick windows, clear windows, and diagnostic transitions.
The problem it solves: "don't keep retrying a device that fails to activate." A simple exponential
timer per device would cover the same cases in ~60 lines.

**Simplification:** Replace with exponential backoff. Block for N minutes after failure, double N
on each failure, cap at 30 min, reset after sustained success. Emit the same diagnostic events
from the simpler model.

**Risk:** Low. The public API surface is small (3 functions). Existing tests describe the desired
behavior, not the internal state machine.

**Prerequisite:** None.

### 2. `planReasons.ts` — 580 LOC, decision logic mixed with presentation

Reason strings are presentation concerns interleaved with control flow. Every restore/shed path
carries `reason:` assignments alongside decision gates. Reading the decision logic means reading
through string interpolation.

**Simplification:** Extract reason-string builders into `planReasonStrings.ts`. The decision
functions record a machine-readable code; strings are derived separately. This also unblocks
merging `planReasonHelpers.ts` (102 LOC, 1 consumer) into the decision file.

**Risk:** Low. Pure extraction, no logic change.

**Prerequisite:** None.

### 3. `planExecutor.ts` — 1074 LOC, three actuation pipelines in one file

The executor has three distinct control pipelines (binary, target-temperature, stepped-load) that
share only the top-level dispatch. Each pipeline is internally cohesive and does not call the
others.

**Simplification:** Extract stepped-load actuation (~240 LOC) and target-command actuation
(~300 LOC) into their own modules. The top-level dispatch and binary control stay. This follows
the existing pattern of `planExecutorSupport.ts`.

**Risk:** Medium. The methods access executor state/deps, so they need a clean deps parameter.
But `planExecutorSupport.ts` already shows the pattern.

**Prerequisite:** None. Can happen in parallel with other phases.

### 4. `app.ts` — 1077 LOC, accumulation point for wiring

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

### 5. `deviceManager.ts` — 1291 LOC, largest file

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

### 6. `planService.ts` — 704 LOC, mixed concerns

Contains rebuild orchestration, snapshot persistence (throttling, dedup, timers), and metrics
measurement. These are genuinely separate concerns sharing a class for convenience.

**Simplification:** Extract snapshot-write subsystem (~120 LOC) and rebuild-metrics helpers
(~120 LOC) into their own modules. Also move `planServiceInternals.ts` types into `planTypes.ts`
to resolve the blocked circular dependency.

**Risk:** Medium. The snapshot writer uses timers and deferred writes that need careful lifecycle
management.

**Prerequisite:** Phase 1 (planServiceInternals.ts type relocation).

### 7. `planRestore.ts` — 534 LOC, 8 sequential restore gates

A device must pass 8 gates before restore is allowed. Gates 3-4 (swap block + pending swap
block) are one concept split in two. Gates 5-6 (waiting + activation setback) are both "system
unsettled." Collapsing to ~5 gates removes conceptual overhead.

**Simplification:** Collapse redundant gates. With the activation backoff simplified (Phase 1),
the backoff-related gate also becomes simpler.

**Risk:** Low-medium. The gate behavior is well-tested. The collapse preserves all safety checks,
just combines conceptually identical ones.

**Prerequisite:** Phase 1 (backoff simplification reduces the gate interaction surface).

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

Each phase is one PR. Phases 1-2 are low-risk and can be done first as confidence builders.
Phases 3-5 are the main structural splits. Phase 6 is a logic simplification. Phase 7 is the
most invasive and can wait.

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
| `appInit.ts` deletion | Well-structured at 258 LOC with factory functions. Not a complexity problem. |
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
