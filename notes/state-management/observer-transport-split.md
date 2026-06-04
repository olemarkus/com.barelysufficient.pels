# Observer / Transport Split

This is the design-of-record for splitting `DeviceManager` into two physically
separate modules. **The split shipped** across a 6-PR train (PRs #1095, #1102,
#1107, #1140, #1148, #1158); `DeviceManager` was renamed to `DeviceTransport`
and the observer now owns the typed-event emitter. A later follow-up (PR2a of the
actuator-write-seam train) moved the home-power read scalar onto the observer
(`lib/observer/observedHomePower.ts`, class `ObservedHomePower`); the snapshot
store — `latestSnapshot` / `latestSnapshotById` — deliberately stays on
`DeviceTransport`; see the "Shipped vs original target" callout below. The note
is kept as the single source for "why is it shaped like this" — runtime code in
`app.ts`, `lib/device/`, `lib/observer/`, `lib/plan/`, `lib/executor/`, and
`.dependency-cruiser.cjs` points here for the layering rationale. The
**Sequencing** section carries per-PR notes on what actually landed versus the
original target; see the "Shipped vs original target" callout under
**Target shape** for the bullets that stayed deferred.

> The **Why**, **Target shape**, and **Decisions** sections below are preserved in
> their original design-time voice (present tense describes the *pre-split* state and
> the *intended* end state). For what actually shipped, read the **Sequencing**
> section and the "Shipped vs original target" callout — those are authoritative.

## Why

`lib/device/manager.ts` (2060 LOC) plus ~30 `manager*.ts` helper files
(~7 kLOC total) carry two responsibilities welded together:

1. **Observation**: snapshot store, freshness, realtime merge, parsing pipeline,
   pending-command tracking, settle reconciliation, `getHomePowerW()`.
2. **Actuation transport**: `setCapability()`, `requestSteppedLoadStep()`,
   native EV wiring, native stepped-load wiring, flow-backed control.

Plan and executor both import `DeviceManager` directly, executor for both reads
and writes. This is a long-standing inversion: plan layer code at
`lib/plan/planBinaryControl.ts:217` calls `deviceManager.setCapability(...)`
directly. The cruiser already flags it as a warn-level rule
(`todo-narrow-plan-device-dep` at `.dependency-cruiser.cjs:146-151`) but does
not yet break the build.

The split makes the existing `observer→plan→executor` layering literal and lets
the cruiser rule promote to error.

## Target shape

> **Shipped vs original target** — the sub-sections below describe the
> design's original end state. Several bullets did not ship in the train
> (PRs #1095, #1102, #1107, #1140, #1148, #1158) and stay deliberately
> deferred: the transport's `write(intent)` / `subscribe(handler)`
> abstract API never landed (executor still calls `setCapability` /
> `requestSteppedLoadStep` directly on `DeviceTransport`); observer never
> gained full snapshot ownership (`latestSnapshot` / `latestSnapshotById` are
> still on `DeviceTransport` — PR2b, deferred by decision, see below). The
> home-power read scalar **did** move to the observer in PR2a of the
> actuator-write-seam train (`lib/observer/observedHomePower.ts`); the realtime
> "subscribe normalized events" surface was instead realised via the
> observer-owned `ObservedStateEmitter` + the `observedStateDispatcher` callback
> bag (PR #1158). For what actually shipped, see the **Sequencing** section.
>
> **PR2a — `getHomePowerW` shipped (actuator-write-seam train).** The observer
> now owns the whole-home power read. `lib/observer/observedHomePower.ts`
> (`ObservedHomePower`) holds the scalar; `DeviceTransport` no longer caches
> `latestHomePowerW` or exposes `getHomePowerW()` (removed from the
> `DeviceObservation` interface too). The *source* is unchanged — a Homey SDK
> energy report read in the device layer (`managerFetch` → `managerHomeyApi` →
> `managerEnergy`); `updateHomePowerFromReport` now pushes the resolved scalar
> to observer via a new `setHomePowerW(w)` method on the `observedStateDispatcher`
> callback bag (same injection pattern as the event dispatcher and
> `pendingPredicate`; transport still does not import observer). Wiring
> (`lib/app/appSnapshotHelpers.ts`) reads the value back from the observer via a
> `getHomePowerW` dep wired in `app.ts` (lib/app → observer is an allowed edge).
> Observer introduces **no** `lib/power/**` import — the correction to the
> original "fed via event/contract from `lib/power/`" wording below.
>
> **PR2b — snapshot store move, DEFERRED BY DECISION.** Moving `latestSnapshot` /
> `latestSnapshotById` onto the observer was evaluated and dropped. It would be a
> dual-store: transport keeps the array as a pipeline scratchpad (the
> parse/merge/realtime pipeline mutates it in place during `refreshSnapshot`),
> and transport cannot import observer (`no-device-to-peer-except-power`). The
> move buys no behaviour change while adding a high snapshot-rollback regression
> surface. It is not worth doing until the read-side parse/merge pipeline itself
> relocates out of transport.

Two physical modules:

### `lib/device/transport/` (rename of DeviceManager's actuation half)

Pure Homey SDK seam plus all per-control-model wiring:

- `nativeEvWiring.ts`, `nativeSteppedLoadWiring.ts`
- `managerNativeEv.ts`, `managerNativeSteppedCommand.ts`
- `steppedLoadSyntheticCapabilities.ts` (synthetic capability IDs that hide
  native vs flow — already a transport-level abstraction)
- The native-vs-flow branching in `managerControl.ts`
- **The parse/overlay pipeline**: `managerParseDevice.ts` (497 LOC),
  `managerParseSnapshot.ts`, `flowReportedCapabilities.ts` (460 LOC),
  `managerFetch.ts`, the read half of `managerHomeyApi.ts`. Transport produces
  already-merged, already-admitted snapshots — observer never re-parses raw
  events.
- The per-model translation half of `managerRealtimeHandlers.ts`
  (`extractBinarySettleEvidence`, `extractRawBinaryValue`, native step
  capability admission).

External API is uniform across native and flow:

- `write(deviceId, intent)` — abstract intent
  (`{kind: 'set_step', value}` / `{kind: 'set_onoff', value}` / etc.).
  Transport routes to native or flow internally.
- `subscribe(handler)` — emits normalized events
  (`{deviceId, kind: 'step_reported', value, evidenceAt}`). Native-vs-flow
  source is resolved into admit-or-suppress before the event fires.

### `lib/observer/` (existing folder, expanded with a state store)

Owns the stored view, not the parse pipeline:

- Snapshot store (`latestSnapshot`, `latestSnapshotById`) — note: this stayed on
  `DeviceTransport`; the move (PR2b) is deferred by decision (see the callout
  above).
- Freshness, realtime fanout
- Pending-command tracking, settle reconciliation
- `getHomePowerW()` (whole-home value) — **shipped to the observer in PR2a**
  (`lib/observer/observedHomePower.ts`). The original design said this would be
  "fed via event/contract from `lib/power/`"; that was wrong about the source.
  The value originates from a **Homey SDK energy report read in the device
  layer**, and transport pushes the resolved scalar to the observer via the
  `observedStateDispatcher.setHomePowerW(w)` callback. Observer holds it without
  importing `lib/device/` or `lib/power/`.
- Today's pure interpretation helpers (`observedState.ts`,
  `observationFreshness.ts`, `observationTrust.ts`, `observedPower.ts`,
  `idleDetector.ts`, `devicePowerCalibration.ts`)

Model-agnostic. Never branches on native vs flow.

## Decisions

These were pressure-tested with `pels-layering-guardian` against the current
cruiser config and the existing `notes/state-management/` contracts before
being captured here.

### Write path: executor → transport directly, observer subscribes

Observer does **not** mediate writes. Executor calls `transport.write(...)`
directly. Observer subscribes to transport events and records pending state
from event traffic, not from being on the call path.

Reasoning:

- `managerBinarySettle.ts` is already event-driven today —
  `notePendingBinarySettleObservation` is invoked from a realtime event
  subscriber, not from the write path. Nothing in the settle logic actually
  needs to be on the write call path.
- Putting observer on the write path would create an `observer → transport`
  edge that directly violates the existing `no-observer-to-peer` rule
  (`.dependency-cruiser.cjs:109-115`). That rule was deliberate; we keep it.

### Settle suppression: injected predicate from wiring

Today `shouldSuppressPendingBinaryChange`
(`managerRealtimeHandlers.ts:400-420`) runs inside transport's parse pipeline,
before reconcile produces the merged snapshot. Post-split, observer holds
pending state but transport's parse needs to consult it.

Resolution: transport accepts a `pendingPredicate(deviceId, capabilityId)`
callback supplied by `lib/app/` and backed by observer. Transport does not
statically import observer; the predicate is just a function reference passed
in at wiring time. The parse pipeline keeps producing pre-merged snapshots,
which matches the current shape.

### Plan→device write inversion: killed in the same effort

`lib/plan/planBinaryControl.ts:217` `deviceManager.setCapability(...)`, plus
`:257` and `planBinaryControlHelpers.ts:107` `deviceManager.getSnapshot()`,
all go away. Binary-control writes move into executor. The new cruiser rule
"`lib/plan/**` must not import `lib/device/**`" lands as error from day one,
not as a transitional exception.

The plan-side `getSnapshot()` calls become observer reads (plan may consume
observer).

### Drift detection and reapply trigger: three-way split

Today `managerRealtimeHandlers.ts` (492 LOC) does translation, drift detection,
and reapply triggering all in one file. Post-split:

- **Translation** (raw Homey event → normalized capability changes) → transport.
- **Drift detection** (observed change disagrees with plan intent) → executor.
  Per `notes/state-management/README.md`, drift compares observed against
  plan intent; observer does not know plan intent.
- **Reapply trigger** (decide to ask planner for a new pass) → wiring
  (`lib/app/`). Observer emits "observed state changed for these capabilities"
  + cursor; wiring orchestrates the reapply.

Post-PR #5 reality check: the drift-against-plan-intent code already lived in
`lib/executor/planExecutionDrift.ts` (since PR #1b of this train), and
wiring's `appRealtimeDeviceReconcileRuntime.ts` already consulted it before
scheduling a planner reapply. The remaining gap PR #5 closes is the
event-emitter ownership: pre-PR transport emitted the post-translation typed
events directly via its own EventEmitter; post-PR observer owns the emitter
(`lib/observer/observedStateEvents.ts`, class `ObservedStateEmitter`) and
transport routes the events through it via a dispatcher callback bag
(`observedStateDispatcher`) injected at construction time. Same pattern as
PR #4's `pendingPredicate`. The transport-side `shouldReconcilePlan` boolean
stays inside transport — it is a snapshot-vs-snapshot change filter, not
drift-against-plan-intent.

## Cruiser rule changes

| Today | Target |
|---|---|
| `no-device-to-peer-except-power` (error) | Unchanged; transport stays SDK-leaf. |
| `no-observer-to-peer` (error) | Unchanged; observer remains a peer leaf. |
| `todo-narrow-plan-device-dep` (warn, plan→device) | Promoted to **error**. |
| (no rule today) | New error rule: `lib/executor/**` must not import `lib/device/**`. |
| (no rule today) | New error rule: `lib/observer/**` must not statically import `lib/power/**`. (PR2a reality: observer's `ObservedHomePower` receives the scalar from transport via the `observedStateDispatcher.setHomePowerW` callback — the *source* is a Homey SDK energy report in the device layer, not `lib/power/`. No `lib/power/` import is needed or introduced.) |

## Sequencing

Each step is independently mergeable. Steps 1–3 buy most of the layering
payoff without moving any files. Step 1+2 land in PR #1a; step 3 lands as
PR #1b after the read-side narrowing is proven; total train is 6 PRs.

1. **`getSnapshotByDeviceId(id)` helper** on DeviceManager. Kills the inline
   `getSnapshot().find()` pattern at the call sites we'd otherwise have to
   migrate. (PR #1a)
2. **Extract a `DeviceObservation` interface** from DeviceManager's read
   methods. DeviceManager implements it. Plan + executor depend on the
   interface for reads, not the concrete class. (PR #1a)
3. **Restructure plan to return binary control decisions instead of
   dispatching.** Move `dispatchBinaryCommand` and the `setCapability` call
   into executor. Add cruiser rules binding `lib/executor/**` and
   `lib/plan/**` to the `DeviceObservation` interface only, not the concrete
   class. Promote `todo-narrow-plan-device-dep` to error. (PR #1b)
4. **Move read-side files** (`managerObservation.ts`, `managerParseDevice.ts`,
   `managerParseSnapshot.ts`, `managerFreshness.ts`, `managerRealtimeHandlers.ts`,
   `managerFetch.ts`, the full `managerHomeyApi.ts`, plus the parse-adjacent
   helpers `managerParse.ts`, `managerParseIdentity.ts`,
   `managerParsedControlState.ts`, `managerRealtimeSupport.ts`,
   `flowReportedCapabilities.ts`, `managerManagedFilter.ts`,
   `managerHelpers.ts`) into `lib/device/transport/`. `manager.ts` stays put
   (becomes a facade in PR #3). (PR #2 — shipped)
5. **Extract write side as `DeviceTransport`.** DeviceManager goes away.
   (PR #3 — shipped: `lib/device/manager.ts` renamed to
   `lib/device/deviceTransport.ts`, class `DeviceManager` renamed to
   `DeviceTransport`. The actual write-side extraction step the design
   originally envisioned was simplified during the train — the class is
   already the single transport seam after PR #2, so PR #3 only needed
   to rename, kill the historical `DeviceManager` identifier, and fold
   in the secondary cleanup of moving `stateOfCharge.ts` into
   `lib/device/transport/`.)
6. **Wire the injected `pendingPredicate`** and move pending/settle state into
   observer. Observer subscribes to transport events. (PR #4 — shipped:
   `lib/device/managerBinarySettle.ts` moved to `lib/observer/binarySettle.ts`;
   pending-binary-command sync/store moved into `lib/observer/pendingBinaryCommands.ts`
   and `lib/observer/pendingBinaryCommandTypes.ts`; the dispatcher
   `lib/executor/binaryControlDispatch.ts` now returns a discriminated
   `{ok: true} | {ok: false; reason: 'dispatch_failed'}` result and owns
   pending writes/deletes through the observer-owned store; plan's
   `decideBinaryControl` no longer touches pending state; transport accepts a
   `pendingPredicate(deviceId, capabilityId)` callback supplied by wiring
   (`app.ts`) and backed by observer's binarySettle store. PR #5 inverted
   the event-ownership relationship instead of having observer subscribe
   to transport: observer now owns the emitter and transport dispatches
   into it via the injected `observedStateDispatcher` callback bag (same
   pattern as `pendingPredicate`). Transport's default ops bag is inert (no-op
   stubs + empty state); tests that exercise binary-settle behaviour pass
   real observer ops through the constructor options. No static observer
   import remains in `lib/device/`; the `no-device-to-peer-except-power`
   cruiser rule stays a single error rule with no exceptions.)
7. **Three-way realtime split**: translation in transport, drift detection in
   executor, reapply trigger in wiring. (PR #5 — shipped: observer owns the
   typed-event emitter at `lib/observer/observedStateEvents.ts`
   (`ObservedStateEmitter`, with event-name strings preserved verbatim from
   their pre-PR transport-side declarations); transport accepts an
   `observedStateDispatcher` callback bag supplied by wiring (`app.ts`) and
   routes every post-translation fan-out through it via two new private
   helpers (`dispatchObservedStateChanged`, `dispatchPlanReconcile`).
   Transport's own EventEmitter still fires the legacy events when no
   dispatcher is wired, so legacy direct-`DeviceTransport` tests continue
   to subscribe with the same event-name strings without behaviour drift.
   Drift detection against plan intent already lived in
   `lib/executor/planExecutionDrift.ts` since PR #1b — wiring's
   `appRealtimeDeviceReconcileRuntime.ts` consults that predicate before
   scheduling a planner reapply. The reapply trigger
   (`scheduleAppRealtimeDeviceReconcile` → `planRebuildScheduler.request`)
   stays in wiring. No drift conditions changed; only the location of the
   post-translation event emitter moved. The transport-side
   `shouldReconcilePlan` boolean stays in transport as a snapshot-vs-snapshot
   change-significance filter — it is not drift-against-plan-intent.)

## Secondary cleanups surfaced during review

These are not strictly part of the split but block it in subtle ways:

- ~~`lib/device/steppedLoadSyntheticCapabilities.ts` is imported by
  `lib/executor/steppedLoadExecutor.ts:29`. Synthetic capability IDs are a
  contract, not transport — move to `packages/contracts/src/` so the executor
  doesn't strand when transport moves.~~ Shipped in PR #2: file moved to
  `packages/shared-domain/src/steppedLoadSyntheticCapabilities.ts` (not
  `packages/contracts/src/`; the latter is pruned from the Homey runtime
  build, which would have broken the value imports of
  `PELS_TARGET_STEP_CAPABILITY_ID` etc.). `SteppedLoadStepRequestResult` /
  `SteppedLoadStepRequestTransport` types moved with it.
- ~~`lib/device/stateOfCharge.ts` is consumed by both `managerRealtimeHandlers.ts`
  and `managerObservation.ts` (now under `lib/device/transport/`) plus
  `manager.ts` and `managerRuntime.ts` (which stay in `lib/device/`).~~
  Shipped in PR #3: file moved to `lib/device/transport/stateOfCharge.ts`.
  All current consumers are transport-side or in the renamed
  `deviceTransport.ts` / `managerRuntime.ts`, so the move converts the
  previous back-edge into a clean intra-transport import. Extracting the
  structural `DeviceCapabilityMap` and `FlowReportedCapabilities*` type
  deps to a neutral location is deferred to a follow-up cleanup (no PR #
  assigned).
- `lib/device/devicePowerCalibrationStore.ts` straddles the boundary. Decision:
  it stays in `lib/device/` (calibration enrichment happens at parse time, before
  the snapshot reaches observer). Observer reads enriched snapshots; it never
  imports calibration directly. PR #2 verified the only consumer is `app.ts`
  (wiring); PR #3 reconfirmed during the rename — still only `app.ts`
  imports it, so it stays put.

## Reconciled with other notes

Resolved when the train landed: `notes/state-management/README.md` and
`docs/architecture.md` were updated to describe transport as the SDK-leaf that
produces normalized snapshots and observer as the state-store peer (the
`DeviceManager` → `DeviceTransport` rename is reflected throughout). No
outstanding cross-note revisions remain.
