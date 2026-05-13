# Runtime Complexity Cleanup

This note is the current simplification map. Older point-in-time phase lists and migration notes
have been removed from this folder when the code they described landed.

## Principles

1. **Simplify first, split second.** Reducing state and branches is better than spreading the same
   behavior across more files.
2. **Delete before abstracting.** Add a helper only when it removes real duplication or gives a
   clearer ownership boundary.
3. **One concept per PR.** Keep move-only cleanup separate from behavior changes.
4. **Keep the control path traceable.** A split that makes "why did this device do X?" harder to
   answer is not an improvement.

## Current Hotspots

### `app.ts` and `appInit.ts`

`TimerRegistry` and `AppContext` are in place, but `app.ts` is still the lifecycle and service
assembly point, and `lib/app/appInit.ts` still carries plan-service creation plus
`resolveHasBinaryControl`.

Remaining work:

- decide whether the now-thin `appInit.ts` adapter should be deleted
- move `resolveHasBinaryControl` to a more durable core/device-manager home if it stays shared
- keep trimming delegates that no longer buy readability or testability
- split app lifecycle context into initialized vs initializing phases so post-startup services are
  not exposed forever as optional fields

### `PlanRebuildScheduler` and power-sample rebuild bridging

`lib/app/planRebuildScheduler.ts` exists and is wired as the shared priority/timer queue for
`hardCap`, `signal`, and `flow` intents. Flow-card rebuilds and realtime EV SoC rebuilds enter the
shared scheduler directly, while power-sample rebuilds still pass through
`appPowerRebuildScheduler.ts`.

Remaining work:

- remove or explicitly document the optional fallback scheduler path in `appPowerRebuildScheduler`
- decide whether the scheduler's internal timers should register with `TimerRegistry`
- decide whether tight-noop backoff, mitigation holdoff, and pending-promise state should stay in
  the compatibility wrapper or move into the unified scheduler

### `planService.ts`

Plan snapshots are in-memory/realtime only, but `planService.ts` still mixes rebuild orchestration
with perf aggregation, trace recording, and completion logging.

Remaining work:

- extract rebuild-metrics/tracing helpers into a focused module
- fold or delete `planServiceInternals.ts` if the remaining helper surface no longer pays for
  itself

### Restore and reason boundaries

The local `planReasons.ts` split reduced presentation coupling, but restore admission still has
branch-local wrapper calls and some decisions still flow through UI-facing reason data.

Remaining work:

- unify stepped restore admission wrappers so pending-swap source-off holds and stepped swap
  executor context apply consistently across restore branches
- keep splitting planner state from render-only explanation data
- preserve existing swap, cooldown, and meter-settling safety checks while reducing repeated gates

### Device-manager and snapshot cleanup

Parsing, observation, and binary-settle internals have been extracted, but `DeviceManager` remains
the shared owner for SDK setup, snapshots, realtime updates, and command writes.

Remaining work:

- deduplicate `applyDeviceDriverOverride` along the snapshot pipeline
- remove redundant downstream `managed !== false` filters after the parse-time invariant has soaked
- only extract more `DeviceManager` code when a new subsystem boundary is clear

### Persisted settings state

Calibration, active deadline plans, and deadline history still duplicate dirty/debounce/grace/flush
state machines. See `notes/persisted-settings-state.md` for the proposed shared helper.

## LOC Policy

Use [`god-file-policy.md`](god-file-policy.md) for the max-lines cleanup proposal. Treat raw LOC as
a signal, not the goal; the cleanup target is lower cognitive load and stronger ownership.

## Out Of Scope

The following ideas remain deferred until a concrete bug or ownership problem justifies them:

- generic device control model interfaces
- load-reduction strategy interfaces
- broad price/source abstraction layers
- a generic state-publisher utility
- splitting `registerFlowCards.ts` purely because it is long
