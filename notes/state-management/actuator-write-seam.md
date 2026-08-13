# Actuator Write Seam

This is the design-of-record for the **actuator** — a single seam every write
intent flows through to transport. It is the sequel to
[`observer-transport-split.md`](./observer-transport-split.md): it closes two
bullets that note left **deliberately deferred** (the transport `write(intent)`
abstract API, and observer ownership of the snapshot store) and adds a third
box the original split did not name — the actuator.

> Status: **in progress** — PR 1 (the seam + terminal-shed consumer) and the full
> PR 1b executor migration are **shipped** (stepped #1485, target #1489, binary
> #1490, and PR1b-final, which removed the executor's dead transport write members
> and added the `no-actuator-bypass` cruiser rule). The actuator is now the sole
> device write path. **PR 2 split:** **PR2a (the `getHomePowerW` read scalar →
> observer) is shipped** — `lib/observer/observedHomePower.ts` (`ObservedHomePower`)
> now owns the whole-home power read; transport pushes it via
> `observedStateDispatcher.setHomePowerW`. **PR2b (snapshot store → observer) is
> DEFERRED BY DECISION** (dual-store risk, no behavior change — see PR 2 below).
> **PR 3 (tighten) remains outstanding.** Train sequence at the end.
> Read the device-state invariants digest in [`lib/device/AGENTS.md`](../../lib/device/AGENTS.md) and
> [`observer-transport-split.md`](./observer-transport-split.md) first — this
> note assumes the `planned / commanded / observed / pending` vocabulary and
> the transport-is-the-SDK-leaf rule.

---

## The four boxes

| Box | Mandate | Vocabulary |
|-----|---------|-----------|
| **transport** (`lib/device/**`) | The only module that talks to the Homey SDK, in **both** directions. Produces normalized snapshots (read) and executes capability/channel writes (write). Resolves native-vs-flow internally because it owns the snapshot + SDK knowledge. | Homey capabilities, channels, flow cards |
| **observer** (`lib/observer/**`) | Consolidated state: snapshot store, freshness/staleness, alive/idle, settle resolution, and pure plan-blind interpretation. The single place anyone asks "what is true right now?" | `fresh / stale / unknown`, observed draw, observed on/off |
| **plan** (`lib/plan/**`) | Decides desired state ("what should run") and owns **cooldown admission** (shed/restore windows). | planned state, headroom, cooldowns |
| **actuator** (`lib/actuator/**`, new) | The single semantic write seam and the only runtime module allowed to request transport writes. It forwards SDK-blind commands; transport privately maps them onto native capabilities or Flow cards. | `{ binary / step / target }` control intents |

The executor (`lib/executor/**`) keeps its existing mandate — *issue / retry /
wait / skip + drift* — but on the write side it now hands a `DeviceCommand` to
the actuator instead of poking transport directly.

---

## The loop is an overlay, not a directory map

The four/five boxes are a **control-flow model**. The physical `lib/` tree has
~14 dirs that do not line up 1:1, and pretending otherwise is how this note
would rot. The honest mapping:

| Conceptual box | Physical home | Caveat |
|---|---|---|
| transport | `lib/device/**` (esp. `lib/device/transport/`) | `lib/device/` is **not** purely the SDK seam — it also carries the producer seams (`deviceActionProjection`, `deviceResidualKw`) and per-device runtime (`managerRuntime`). The former `shedBehaviorActuation` write leak is gone. |
| observer | `lib/observer/**` | Clean. Owns the home-power read scalar (PR2a). The snapshot store stays on transport (PR2b, deferred by decision). |
| plan | `lib/plan/**` | Clean core, but its **inputs** are separate peers: `power`, `price`, `dailyBudget`, `objectives` feed plan but aren't loop stages — they sit *beside* it as producers (`executor > plan > {power, dailyBudget, price, objectives, observer}`). |
| executor | `lib/executor/**` | Clean. Loses its write half to the actuator. |
| **actuator** | `lib/actuator/**` | **New** — the only dir this train creates. |

Dirs that don't belong to any loop stage:

- **`lib/power/`** — whole-home measurement (a *producer*, not a loop box).
  It's upstream measurement feeding observer/plan/device; the loop diagram's
  "reads" arrow elides it.
- **`lib/objectives/`** — smart tasks / deferred objectives. A plan-input peer
  whose clock emits lifecycle facts into setup. A satisfied/deadline fallback is
  now projected by setup into a producer-resolved request and handed to the
  executor-owned `LifecycleFallbackPort`; the executor converges it through the
  ordinary binary/target/stepped lanes and their injected actuator. Objectives
  therefore owns no actuation path, and setup owns only projection + wiring.
- **`lib/planContract/`, `lib/flowApi/`, `lib/diagnostics/`, `lib/logging/`,
  `lib/utils/`** — cross-cutting / infra, orthogonal to the loop.
- **`lib/app/`** — sunsetting wiring; holds `appSnapshotHelpers`
  (its home-power read was re-pointed to the observer in PR2a; it still reads
  the snapshot store from transport, which stays put per PR2b's deferral).

**Scope discipline:** this train does **not** re-home the producer seams out of
`lib/device/`, nor split `lib/objectives/`, nor finish `lib/app/` dissolution.
It overlays the *write-path* vocabulary (transport / actuator) and makes three
bounded moves (actuator box, store→observer, the two leaks). The broader
dir-vs-loop reconciliation is a separate effort and may not be worth the BC
cost — flag candidates, don't chase them here.

---

## Control flow is one closed loop

A **data-flow cycle is not a dependency cycle.** Transport is a single bottom
leaf with two *injected ports*: a read-feed out (it pushes normalized
snapshots/events to observer via the `observedStateDispatcher` callback bag —
observer never imports transport) and a write-port in (the actuator calls a
transport write interface, injected as a local type — not the concrete class).
The loop is tied off at the **wiring layer** (`setup/`), which is exactly where
cycles are allowed to be closed. Transport therefore occupies **one** layer;
the cycle merely passes through it twice.

```
                    ┌──────────────────────────────────────────────┐
                    │                                                │
   reads ───────────▼                                                │ SDK write
        ┌───────────────────┐                                        │
        │     TRANSPORT      │  raw Homey SDK seam (read + write)     │
        │ snapshots / write  │  opens settle window on write ────┐   │
        └─────────┬──────────┘                                   │   │
                  │ normalized snapshot                          │   │
                  ▼                                              │   │
        ┌───────────────────┐                                   │   │
        │     OBSERVER       │  store · staleness · alive ◀──────┘   │
        │ consolidated state │  resolves settle → plan_reconcile     │
        └─────────┬──────────┘                                       │
                  │ flat, plan-blind values                          │
                  ▼                                                  │
        ┌───────────────────┐                                       │
        │       PLAN         │  desired state + cooldown admission   │
        └─────────┬──────────┘                                       │
                  │ committed plan                                   │
                  ▼                                                  │
        ┌───────────────────┐                                       │
        │     EXECUTOR       │  issue / retry / wait / skip · drift  │
        └─────────┬──────────┘                                       │
                  │ DeviceCommand (intent)                           │
                  ▼                                                  │
        ┌───────────────────┐                                       │
        │     ACTUATOR       │  the one write seam ──────────────────┘
        │ intent → transport │
        └───────────────────┘
```

- **Full cycle** (something should change): all boxes.
- **Observation / drift** (new control input): telemetry flows
  `transport → observer → planner`; the planner decides again, then executor and
  actuator converge onto that new plan. There is no apply-without-decide loop.
- **Settlement** is the dashed feedback, **not** a pipeline stage and **not**
  the actuator's job: executor records the semantic pending command when the
  transport request is accepted, observer confirms it from subsequent normalized
  telemetry, and changed observations trigger an ordinary plan rebuild.

---

## The two write contracts

The actuator and transport differ in **altitude**, and that difference is the
actuator's entire reason to exist (otherwise it is a pass-through).

### Transport write input — semantic request, privately bound

The actuator calls three semantic methods on `DeviceTransport`:

```
requestBinaryControl(deviceId, desired)
requestTemperatureTarget(deviceId, desired)
requestSteppedLoadStep({ deviceId, profile, desiredStepId,
                         planningPowerW, planningCurrentA, … })
```

Transport resolves raw capability IDs and native-vs-Flow routing from its private
snapshot binding. Binary requests report whether telemetry confirmation must
precede actuation accounting; temperature requests return the normalized value
actually sent so pending confirmation cannot wait for an unattainable raw value.

### Actuator write input — control intent, SDK-blind

A single uniform `DeviceCommand` the executor decides, naming a *control
outcome* — never a flow card or synthetic channel:

```ts
type DeviceCommand =
  | { kind: 'binary'; deviceId: string; desired: boolean }
  | { kind: 'target'; deviceId: string; target: 'temperature'; value: number; contextInfo?: string }
  | { kind: 'step';   deviceId: string; profile: SteppedLoadProfile; desiredStepId: string;
      planningPowerW: number; planningCurrentA: number; previousStepId?: string };
```

The actuator is the single write seam. It forwards channel-blind intent to
transport; transport performs the SDK translation. Executor consumes only the
semantic outcome (`requested`, normalized target, and actuation-accounting timing).

### The boundary test

- Field names a **Homey capability ID, flow card, or native/synthetic
  channel** → **transport** input.
- Field names a **control outcome** (on/off / step / setpoint) for a device →
  **actuator** input.

No raw capability identifier passes this boundary.

---

## EV / binary consolidation

EV start/stop and generic on/off are already **one dispatch path** today,
distinguished only by `capabilityId: 'onoff' | 'evcharger_charging'`
(`binaryControlDispatch.ts:52`). The actuator formalizes this: EV is **not** a
distinct intent — it is a `binary` command whose `control` discriminant is
`evcharger_charging`.

- **Folds into `binary`:** EV start/stop + every on/off device.
- **Does *not* fold into `binary`:** EV *amperage stepping* is the `step` kind
  (native EV current control); thermostat setpoint is the `target` kind. EV has
  two control modes; only start/stop is binary.
- **Stays upstream, never reaches the actuator:** EV *commandability* — plug
  state, "must be plugged in," grace windows — is producer-resolved as
  `commandableNow` in the `deviceActionProjection` seam. By the time a `binary`
  command exists, the device is already deemed commandable; the actuator never
  re-checks EV plug state.

So EV-ness shrinks to a `control` discriminant on one command kind.

---

## What the actuator does **not** own

Keeping these explicit prevents the seam from accreting policy:

- **Cooldowns** (shed 60 s; restore 60–300 s exponential backoff) are
  **planning constraints** — `lib/plan/planConstants.ts`, enforced in
  `planHeadroomState.ts:376` and `restore/timing.ts:135`. The actuator sees
  only post-admission intents.
- **Settle window** is opened inside `transport.setCapability` and resolved by
  observer; the actuator does not open, close, or read it.
- **Pending-command recording** happens at dispatch (today
  `recordPendingForDispatch` in `binaryControlDispatch.ts`, just before the
  write) and is evicted by observer's per-cycle sync. (Whether pending-record
  *initiation* moves into the actuator is a PR-3 question — see train below; it
  is decoupled from the write call either way.)
- **Drift detection / retry policy** stay in the executor.
- **EV commandability** stays in the producer seam (above).

---

## Two write leaks this seam closed

Both former wrong-layer write paths are now gone:

1. ~~`lib/device/shedBehaviorActuation.ts` issuing a binary off directly through
   transport.~~ **Deleted.** Its replacement converges through the executor and
   injected actuator.
2. ~~`setup/appInit/deferredObjectiveLifecycle.ts` hand-assembling its own
   `ShedActuationTransport` from `deviceManager`.~~ **Deleted.** Setup now projects
   the lifecycle fact into a neutral executable request and calls the
   executor-owned `LifecycleFallbackPort`; only the normal executor lanes reach
   the injected actuator.

---

## Dependency-cruiser rules (to add / promote)

Transport stays the sole SDK owner. The actuator does **not** import it — the
write surface (`ActuatorTransport`) is a *local interface* the wiring layer
injects, so the actuator carries no peer dependency at all. It is a **pure
leaf**, like observer/price.

- `no-actuator-to-peer` *(shipped, PR 1)* — `lib/actuator/**` must not import any
  peer (`device / power / plan / price / dailyBudget / objectives / observer /
  executor`). The transport is injected, never imported. Plus `lib/actuator/`
  added to `no-domain-to-app-layer`.
- The existing `no-plan-to-device` and `no-executor-to-device-internals` rules
  (both `severity: 'error'`, already passing) keep plan/executor off the concrete
  `DeviceTransport`. There is **no** `todo-narrow-plan-device-dep` rule and never
  was; nothing is being promoted from warn→error here.
- `no-actuator-bypass` *(NEW cruiser rule; **shipped in PR1b-final**)* —
  `lib/plan/**` and `lib/executor/**` RECEIVE an injected `Actuator`; they must
  not reach into the actuator package to build or wire their own write path. The
  rule forbids any **value** import from `lib/actuator/**` — notably
  `createDeviceActuator` (only `setup/**` may call it, via
  `setup/appInit/buildDeviceActuator.ts`). The legitimate edge,
  `import type { Actuator }`, is erased and therefore invisible to the cruise, so
  it stays allowed automatically. **Scope:**
  `from: ^lib/(plan|executor)/ → to: ^lib/actuator/`. It complements
  `no-plan-to-device` / `no-executor-to-device-internals` (which only cover
  `lib/device/**`) by closing the actuator-side bypass. **Verified real:** passes
  clean on the shipped code (plan/executor hold only `import type` edges) AND
  fires on a value-import probe of `createDeviceActuator`
  (`error no-actuator-bypass: …→ lib/actuator/deviceActuator.ts`) — it is not a
  hollow rule. (An earlier draft scoped it to the type-only
  `lib/actuator/deviceCommand.ts`, which would have been hollow — that module
  exports only types, and with `tsPreCompilationDeps` unset there is no value
  import to catch.) Post-compilation, so it catches VALUE imports, not
  `import type` edges; the residual "no raw `.setCapability()` call" guarantee is
  **structural** (see the honesty note), not a cruiser rule.
- `device-no-actuation` — `lib/device/**` hosts no control actuation. Achieved
  *structurally* in PR 1 by relocating the terminal-shed actuator out of
  `lib/device/`; the existing `no-device-to-peer-except-power` already blocks any
  attempt to re-add a `lib/device → lib/actuator` call.

> Honesty note: dependency-cruiser is import-based, so the "only the actuator
> writes" invariant is enforced *structurally* plus by the rules above, not by a
> pure rule that says "no `.setCapability` call here." As of PR1b-final the
> structural half is now load-bearing: the executor's transport view
> (`PlanExecutorDeviceTransport`) is **`= DeviceObservation`** — read-only, with no
> write members at all — and the `PlanExecutorTargetContext.deviceManager` lost its
> `setCapability` member too, so there is no transport write surface for the
> executor to call; every write goes through the injected `Actuator`. The
> `no-actuator-bypass` rule (now shipped) additionally forbids plan/executor from
> **value**-importing anything out of `lib/actuator/**` (notably
> `createDeviceActuator`); the `import type { Actuator }` edge is erased and stays
> allowed. Code review still covers the residue a post-compilation import rule
> cannot see (a raw write call, an `import type` edge).

---

## Migration train

Each PR is independently shippable and leaves the build green. Opener is the
substantial write-model piece, not the store move.

**PR 1 — stand up the actuator seam; terminal-shed is its first consumer.** *Shipped.*

Scoped narrower than first sketched, because the executor's binary/stepped/target
dispatch turned out to be an entangled actuation *subsystem* (decision-shaped
logging, pending bookkeeping, retry/backoff), not a set of bare `setCapability`
calls — folding it in here would be the "many-CI-rounds" trap. But
`lib/device/shedBehaviorActuation.ts` was already a scoped actuator (its own
intent union + injected transport surface), so it became the natural seed.

- New `lib/actuator/`: `deviceCommand.ts` (the `DeviceCommand` union +
  `ActuatorTransport` injected write surface + `ActuatorOutcome`) and
  `deviceActuator.ts` (`createDeviceActuator` → `Actuator.apply`, mapping
  intent → transport method, routing binary on the producer-resolved `flowBacked`
  flag).
- The former terminal-shed leaf was first relocated behind `actuator.apply()`;
  it was later retired when lifecycle fallback adopted the executor's shared
  binary/target/stepped convergence paths.
- Current wiring registers the executor-owned narrow lifecycle-fallback port in
  app context; `deferredObjectiveLifecycle` owns authority gates, device-specific
  request resolution, and disarm. The executor consumes only a neutral executable fallback.
- Cruiser: `no-actuator-to-peer` + `lib/actuator/` added to
  `no-domain-to-app-layer`.
- Tests: `deviceActuator.test.ts` covers intent→method mapping; lifecycle fallback
  retry and Homey-boundary behavior live in the executor integration and SDK E2E lanes.

**PR 1b — migrate the executor dispatch subsystem onto the actuator.** *Shipped.*
Split into sub-PRs so each is independently shippable and behavior-preserving:

- **PR1b-1 — stepped.** *Shipped (#1485).* Inject the shared `Actuator` into the
  plan engine + executor (via wiring's `buildDeviceActuator`, lifted from the
  former terminal-only builder so both paths share one builder) and route the
  executor's stepped binding (`planExecutor` `requestSteppedLoadStep`) through
  `actuator.apply({ kind: 'step', ... })`. `steppedLoadExecutor.ts` is unchanged —
  only the binding routes through the actuator; behavior is identical.
- **PR1b-2 — target.** *Shipped (#1489).* Re-point `targetExecutor` / the
  `setCapability` setpoint path through the actuator, adding the
  capability-addressed `target` variant (`target.capabilityId`) to `DeviceCommand`
  for the per-capability setpoint write.
- **PR1b-3 — binary.** *Shipped (#1490).* Re-point `binaryControlDispatch` through
  the actuator; move the flow-vs-native binary decision
  (`isFlowBackedBinaryControl`) to the producer so the command carries a resolved
  `flowBacked`, matching the terminal-shed path; hoist the flow-log and delete the
  now-redundant `isFlowBackedBinaryControl` recompute on the dispatch path.
- **PR1b-final — close out.** *Shipped (this PR).* Removed the now-dead transport
  write members from the executor's transport view: `PlanExecutorDeviceTransport`
  is now `= DeviceObservation` (read-only) and `PlanExecutorTargetContext`'s
  `deviceManager` lost `setCapability`. Added the `no-actuator-bypass` cruiser rule
  now that all three write sites are migrated and the actuator is the sole write
  path (see the rules section for why it could not land earlier). No behavior
  change.
- Keep logging/pending/retry where they are unless a clean home emerges — this
  train is about the write seam, not relocating the executor's bookkeeping.

  **Consumer-side recompute — *Shipped.*** The binary path used to *re-resolve* the
  flow-vs-native decision after the write: `isFlowBackedBinaryControl(...)` was
  recomputed at three post-write consumer sites (`turnOffDevice` in
  `binaryExecutor.ts`; `applyBinaryRestoreWithSnapshot` and
  `applyCapacityControlOffRestoreWithSnapshot` in `binaryRestoreHelpers.ts`) to
  decide whether the command was flow-backed when recording confirmation. PR1b-3
  hoisted the *dispatch-path* recompute but left these consumer-side re-resolutions.
  The decide-and-dispatch wrapper now returns a `BinaryControlOutcome`
  (`{ applied: false } | { applied: true; flowBacked }`) carrying the
  producer-resolved flag the command already had, so the three sites read
  `outcome.flowBacked` and no longer call `isFlowBackedBinaryControl`. The symbol is
  gone from `lib/executor/**` entirely; the `binary:seam` guard
  (`scripts/check-binary-seam.mjs`, in `ci:checks`) keeps it that way. This closed
  the "Finish the planner/executor/device-transport state boundary split" TODO.

**PR 2 — move the read model to observer.** Split into PR2a (shipped) and PR2b
(deferred by decision) once the two halves were found to have very different
risk profiles.

**PR2a — `getHomePowerW` → observer. *Shipped.***
- New `lib/observer/observedHomePower.ts` (`ObservedHomePower`) owns the
  whole-home power scalar. `DeviceTransport` no longer caches `latestHomePowerW`
  or exposes `getHomePowerW()`; it is removed from the `DeviceObservation`
  interface too.
- `updateHomePowerFromReport` pushes the resolved scalar to the observer via a
  new `setHomePowerW(w)` method on the `observedStateDispatcher` callback bag;
  transport still does not statically import observer.
- Re-pointed the sole external reader, `lib/app/appSnapshotHelpers.ts`
  (`recordImplicitHomeyEnergySample`), to a `getHomePowerW` dep wired in `app.ts`
  to read from the observer (lib/app → observer is an allowed edge). The
  `homey_energy` poll path is unchanged: `pollHomePowerW()` still returns the
  resolved scalar directly to `HomeyEnergyPollSource`.
- **Source correction:** the value originates from a Homey SDK energy report read
  in the device layer (`managerFetch` → `managerHomeyApi` → `managerEnergy`), not
  from `lib/power/`. Observer introduces no `lib/power/**` import — the original
  "via event/contract from `lib/power/`" wording was wrong about the source.

**PR2b — snapshot store → observer. *DEFERRED BY DECISION (not done).***
- Relocating `latestSnapshot` / `latestSnapshotById` from `DeviceTransport` to
  the observer would be a **dual-store**: transport keeps the array as a pipeline
  scratchpad (the parse/merge/realtime pipeline mutates it in place during
  `refreshSnapshot`), and transport cannot import observer
  (`no-device-to-peer-except-power`). The move buys **no behavior change** while
  adding a high snapshot-rollback regression surface (the merge/realtime
  freshness invariants in `lib/device/AGENTS.md`).
- Not worth doing until the read-side parse/merge pipeline itself relocates out
  of transport. The external snapshot reader `lib/plan/snapshotWarmupGate.ts`
  stays on transport for now.

**PR 3 — tighten.**
- Promote warn-level rules to error; retire transitional allowances.
- Decide whether pending-record *initiation* moves into the actuator (it is
  already decoupled from the write call, so this is a clarity move, not a
  correctness one).
- Reconcile `README.md`, `docs/architecture.md`, and this note's status →
  shipped.

---

## Settled decisions

- Pending intent stays at executor dispatch; observer confirms it from telemetry.
- Primary temperature commands use the transport-resolved single target binding.
- Accepted asynchronous Flow dispatch defers cooldown/state accounting until confirmation.
