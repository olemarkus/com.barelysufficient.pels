# Executor Layer

`lib/executor/` owns command execution, pending and retry state, and confirmation that a requested state materialized. The planner decides desired state; the executor reads that decision plus observer truth and converges the device through `lib/actuator/`.

## Decision boundary

- The plan's `plannedShedTargetKind` names the selected end state (`binary_off`, `step`, or `target_value`). A configured `turn_off` behavior is only the deepest floor the planner may choose; the current plan may leave a stepped device running at an intermediate rung. Binary shed dispatch consumes the selected end state and must not re-read shed policy.
- Legacy release paths in `shedReleaseActuation.ts` and `lifecycleFallbackDispatcher.ts` still read `getShedBehavior`. They are migration debt, not a pattern for new sites. Do not add another policy read; remove these through the planner/executor seam work when that work is in scope.
- Project broad plan-device shapes into narrow executor intent and observation types. Compatibility reads from legacy plan fields belong in small adapters. Keep planner admission, UI wording, snapshot serialization, and settings contracts out of this layer.

## Convergence

- The live side comes from Observer and executor-owned in-flight stores, never from a plan with old observations merged onto it. An unseen device is skipped, not assumed converged. Compare against the observation revision captured before the awaited build; if it changed during the build, decline actuation and let a fresh decision run.
- `hasPlanExecutionDriftAgainstIntent` is the actuation predicate, run against the plan the rebuild just built. There is no plan-to-plan settle comparison: the published plan is never refreshed by merging device inputs onto it.
- There is one actuation lane. Do not revive a reconcile mode that bypasses retry suppression or cooldowns, and do not add executor-side pacing that silently drops a planner decision. Skip a write for the write's own facts: already matching state, unreachable device, or an equivalent command in flight. The post-activation `force: stepRestore.wroteBinary` is a narrow exception because activation may reset a device's step limit.
- `ExecutableObservedDeviceState.observedBinaryAxis` is the raw on/off handle; `observedEffectiveOn` is the producer fold of binary and stepped axes. Use the field that answers the question at hand; do not merge them into one ambiguous state.
- `lib/executor/` imports from `lib/plan/` are a shrinking migration list enforced by `npm run executor:plan-edge`. Prefer contracts in `lib/planContract/` and remove stale allowlist entries when an edge disappears.

Timing details are in `notes/state-management/actuation-clocks-and-settle.md`.
