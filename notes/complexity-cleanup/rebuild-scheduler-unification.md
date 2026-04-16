# PlanRebuildScheduler — design note

> **Status:** Design note (2026-04-16). Pre-implementation. Identified during the complexity
> review; scheduled as Phase 9 in `README.md`. Phase 8 has landed via the
> `appPowerRebuildPolicy.ts` / `appPowerRebuildScheduler.ts` / `appPowerSampleIngest.ts` split,
> so this note now describes the next step instead of a blocked prerequisite.

## Problem

Three independent coalescers gate plan-rebuild and snapshot-write work, each with a different
contract, timer, and cancellation story. They do not coordinate, which leaves a race window and
spreads the tight-noop backoff state across files.

Because each coalescer was added for a specific call-site (flow card, power sample, non-action
status refresh), "should this rebuild run now?" is answered by three overlapping state machines
instead of one. When two intents arrive close together the ordering depends on timer scheduling,
not on a priority rule.

## Current coalescers

### 1. `lib/app/appFlowRebuildScheduler.ts` — flow-card-driven

- Cooldown: `FLOW_REBUILD_COOLDOWN_MS = 1000`.
- Trigger: flow card handlers that need "after my change takes effect, rebuild the plan."
- State: one pending timer, one pending reason. New requests within the cooldown coalesce by
  replacing the reason.
- Size: 97 LOC.

### 2. `schedulePlanRebuildFromSignal` / `schedulePlanRebuildFromPowerSample` in `appPowerHelpers.ts`

- Debounce driven by `PowerSampleRebuildState` (12 fields, two timers, a pending promise).
- Tight-noop exponential backoff: `TIGHT_NOOP_BACKOFF_MS = [15000, 30000, 60000]`.
- Mitigation holdoff: `TIGHT_MITIGATION_HOLDOFF_MS = 15000`.
- Hard-cap fast-path bypasses the debounce.
- Trigger: every power sample, and any "signal" event deriving headroom/hard-cap/shortfall.
- Size: 893 LOC of which ~250 LOC is the scheduler/state machinery.

### 3. `planService.pendingNonActionSnapshotTimer`

- Debounces non-action snapshot writes (status/headroom updates that do not cross a control
  boundary).
- Separate timer, separate cancellation, separate reason-reduction rule.
- Lives inside `PlanService` alongside the full rebuild queue.

## Race window

Concretely: a flow card that triggers `appFlowRebuildScheduler.request(...)` and a power sample
that triggers `schedulePlanRebuildFromSignal(...)` within the same ~1 s window will each arm
their own timers. Whichever fires first wins; the other is discarded on arrival at
`PlanService`. There is no priority ordering — a low-value flow-card nudge can cancel a
high-value signal rebuild, or vice versa, depending on scheduling.

This has not (to our knowledge) produced a field incident, but the invariant is accidental, and
it prevents any single reasoning about "what will happen when X arrives?".

## Proposed design

One `PlanRebuildScheduler` in `lib/app/planRebuildScheduler.ts`. One state machine, one source of
truth for tight-noop backoff and holdoff, one prioritised intent queue.

### Public API

```ts
type RebuildIntent =
  | { kind: 'hardCap';  reason: RebuildReason }       // priority 0 (highest)
  | { kind: 'signal';   reason: RebuildReason }       // priority 1
  | { kind: 'flow';     reason: RebuildReason }       // priority 2
  | { kind: 'snapshot'; reason: RebuildReason };      // priority 3 (lowest)

class PlanRebuildScheduler {
  request(intent: RebuildIntent): void;
  cancelAll(reason: string): void;
  now(): SchedulerState;    // introspection for debug dump
}
```

Internally the scheduler holds:

- One pending timer with its deadline.
- One currently-pending intent (the highest-priority request since the last fire).
- The tight-noop backoff state (level + next-eligible timestamp).
- The mitigation holdoff deadline.
- The pending rebuild promise so callers can `await` completion.

### State machine rules

1. **Priority preemption.** A higher-priority intent arriving while a lower-priority one is
   pending replaces it and re-arms the timer at the higher-priority deadline. Lower-priority
   intents arriving while a higher-priority one is pending are dropped (logged).
2. **Hard-cap bypass.** `kind: 'hardCap'` skips both backoff and holdoff. Fires immediately
   (or on the next tick) and resets tight-noop backoff.
3. **Tight-noop backoff.** After a rebuild returns a tight-noop outcome, block further `signal`
   and `flow` intents until the next backoff level expires. Escalate the level on repeat
   tight-noops. Reset on any non-noop outcome. Snapshot intents are unaffected.
4. **Mitigation holdoff.** After a mitigation action fires, block `signal` intents (only) for
   `TIGHT_MITIGATION_HOLDOFF_MS` to let the power sample catch up. Other kinds are unaffected.
5. **Coalescing within a kind.** Multiple `flow` intents in the cooldown window reduce to the
   latest reason. Same for `signal`. `snapshot` intents coalesce across themselves but never
   preempt a rebuild kind.
6. **Cancellation.** `cancelAll` clears the pending timer, drops the pending intent, preserves
   the backoff/holdoff state (those are safety state, not scheduling state).

### Timer accounting

Exactly one `setTimeout` outstanding at a time. Moving from level-1 backoff to level-2 cancels
the level-1 timer before arming level-2. Integration with `TimerRegistry` (Phase 10): the
scheduler registers its timer under a stable name so `onUninit` teardown is automatic.

## Preserved invariants

- `TIGHT_NOOP_BACKOFF_MS = [15000, 30000, 60000]` and the 120 s cap.
- `TIGHT_MITIGATION_HOLDOFF_MS = 15000`.
- Hard-cap bypass is never delayed by backoff or holdoff.
- Non-action snapshot writes continue to flow independent of rebuild scheduling (they just
  arrive via the snapshot intent kind).
- Every current call site maps onto exactly one intent kind; no call site becomes stricter or
  looser in its debouncing than it is today.

## Rejected alternatives

- **Keep three coalescers, add a cross-coalescer priority arbiter.** Adds a fourth coordination
  object; does not remove any of the three. Rejected: fails the "fewer moving parts" rule.
- **Merge only two (flow + signal), leave snapshot separate.** Plausible intermediate step, but
  snapshot writes do share the underlying plan-state rebuild cost; keeping them separate means a
  snapshot-write storm can still starve a legitimate rebuild. Rejected: full unification is the
  same amount of code.
- **Replace all debouncing with a single cadence timer** (rebuild every N seconds regardless).
  Rejected: loses the hard-cap fast-path property that capacity safety depends on.

## Migration plan

Land this as Phase 9, now that Phase 8 has provided a stable decision module as input.

1. Introduce `PlanRebuildScheduler` as a new file, not wired anywhere.
2. Port `appFlowRebuildScheduler`'s contract onto the `flow` intent kind. Route flow-card call
   sites through the new scheduler. Delete `appFlowRebuildScheduler.ts`.
3. Port `schedulePlanRebuildFromSignal` onto the `signal` + `hardCap` intent kinds. The pure
   decision module in `appPowerRebuildPolicy.ts` decides which kind to raise. Route power-sample
   call sites through the new scheduler. Shrink the compatibility barrel and
   `appPowerRebuildScheduler.ts` accordingly.
4. Port `planService.pendingNonActionSnapshotTimer` onto the `snapshot` intent kind. Route
   snapshot write call sites through the new scheduler. `PlanService` stops owning the timer.
5. Lint sweep: remove unused helpers from the three former locations.

Each migration step is landable independently and the old coalescer keeps working until its
call sites are migrated.

## Test requirements

Before the first migration step lands:

- Three-coalescer race regression test in the current codebase: simulate flow + signal +
  snapshot intents within 100 ms. Record observed behavior as a baseline — the new scheduler
  must produce at least as strong a coalescing result (one rebuild, highest-priority reason).
- Tight-noop backoff coverage audit: every level transition (0→1→2→3→capped) must be covered.
- Hard-cap bypass test: backoff state does not delay a hard-cap intent.
- Mitigation holdoff test: `signal` suppressed for 15 s; `hardCap` not suppressed.
- DST sanity check: scheduler timers use monotonic ms, not wall-clock dates.
- `onUninit` teardown: pending timer cleared, pending promise resolved with a cancel reason.

## Risks

- **Medium-high.** This is safety-envelope code. Misplacing the backoff reset, the holdoff
  window, or the priority comparison can silently cause rebuild storms, missed hard-caps, or
  starved snapshot updates.
- **Depends on the landed Phase 8 boundary staying stable.** If the new policy/scheduler split
  regresses back into a mixed module, Phase 9 will regain the double-work risk the split removed.
- **Behavior change surface.** The priority rule is a new invariant; today's behavior is
  "whichever timer fires first wins." Landing this note's design strengthens the guarantee but
  changes observable ordering for adjacent-arriving intents.

## Open questions

- Is `snapshot` truly the lowest priority, or should `flow` be lowest? Flow card rebuilds are
  usually human-initiated and benign to delay; snapshot writes can affect UI freshness.
  Leaning snapshot-lowest, but worth confirming against real call-site semantics before coding.
- Should the scheduler expose a Promise for "next rebuild that includes this intent" so call
  sites can await without polling? The current power-sample path does this via
  `PowerSampleRebuildState.pendingPromise`; preserving that contract is a plus.
- Error path: if a rebuild throws, does the backoff escalate, or reset? Today's behavior differs
  between the three coalescers. Pick one (lean: escalate once, then reset on next success) and
  document it here before implementation.
