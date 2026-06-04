# Actuator Write Seam

This is the design-of-record for the **actuator** — a single seam every write
intent flows through to transport. It is the sequel to
[`observer-transport-split.md`](./observer-transport-split.md): it closes two
bullets that note left **deliberately deferred** (the transport `write(intent)`
abstract API, and observer ownership of the snapshot store) and adds a third
box the original split did not name — the actuator.

> Status: **in progress** — PR 1 (the seam + terminal-shed consumer) implemented
> on branch `actuator-split`; PR 1b/2/3 outstanding. Train sequence at the end.
> Read [`CLAUDE.md`](./CLAUDE.md) (device-state invariants) and
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
| **actuator** (`lib/actuator/**`, new) | The single write seam. Translates a uniform, SDK-blind `DeviceCommand` into transport's write methods, and is the **only** module allowed to call them. Owns the intent→channel mapping (incl. flow-vs-native). | `{ binary / step / target }` control intents |

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
| transport | `lib/device/**` (esp. `lib/device/transport/`) | `lib/device/` is **not** purely the SDK seam — it also carries the producer seams (`deviceActionProjection`, `deviceResidualKw`), per-device runtime (`managerRuntime`), and today the `shedBehaviorActuation` write leak. |
| observer | `lib/observer/**` | Clean. (Store currently still on transport — PR 2.) |
| plan | `lib/plan/**` | Clean core, but its **inputs** are separate peers: `power`, `price`, `dailyBudget`, `objectives` feed plan but aren't loop stages — they sit *beside* it as producers (`executor > plan > {power, dailyBudget, price, objectives, observer}`). |
| executor | `lib/executor/**` | Clean. Loses its write half to the actuator. |
| **actuator** | `lib/actuator/**` | **New** — the only dir this train creates. |

Dirs that don't belong to any loop stage:

- **`lib/power/`** — whole-home measurement (a *producer*, not a loop box).
  It's upstream measurement feeding observer/plan/device; the loop diagram's
  "reads" arrow elides it.
- **`lib/objectives/`** — smart tasks / deferred objectives. A plan-input peer
  that *also* triggers writes via the lifecycle (the
  `deferredObjectiveLifecycle` leak), so it straddles plan-input **and**
  actuation-trigger. After this train it triggers writes through the actuator
  (injected by wiring), not by hand-assembling a transport adapter.
- **`lib/planContract/`, `lib/flowApi/`, `lib/diagnostics/`, `lib/logging/`,
  `lib/utils/`** — cross-cutting / infra, orthogonal to the loop.
- **`lib/app/`** — sunsetting wiring; holds `appSnapshotHelpers`
  (a snapshot-store reader that PR 2 re-points).

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
- **Reconcile / drift** (close a gap): the inner loop
  `transport → observer → executor → actuator → transport`. The executor acts
  on the **committed plan** (with its cooldown gates) — it does not re-derive
  desired state, but it also cannot outrun plan's shed/restore cooldowns.
- **Settlement** is the dashed feedback, **not** a pipeline stage and **not**
  the actuator's job: transport *opens* a settle window at write time
  (`binarySettleOps.start` inside `setCapability`), observer *resolves* it from
  the next observations and emits `plan_reconcile` on drift.

---

## The two write contracts

The actuator and transport differ in **altitude**, and that difference is the
actuator's entire reason to exist (otherwise it is a pass-through).

### Transport write input — mechanism, Homey-shaped

Names capabilities, channels, flow cards. Today, four concrete methods on
`DeviceTransport`:

```
setCapability(deviceId, capabilityId, value)                       // deviceTransport.ts:1890
requestSteppedLoadStep({ deviceId, profile, desiredStepId,         // deviceTransport.ts:1980
                         planningPowerW, planningCurrentA, … })     //   (routes native↔flow internally)
applyDeviceTargets(targets)                                        // deviceTransport.ts:2066
triggerFlowBackedBinaryControl(deviceId, capabilityId, value)
```

Vocabulary: *"poke this Homey channel with this payload."* Transport keeps the
native-vs-flow routing for stepped loads because that choice is
snapshot-dependent SDK knowledge it already owns
(`isNativeSteppedLoadControlEnabled`).

### Actuator write input — control intent, SDK-blind

A single uniform `DeviceCommand` the executor decides, naming a *control
outcome* — never a flow card or synthetic channel:

```ts
// As shipped in lib/actuator/deviceCommand.ts. `flowBacked` is producer-resolved
// (see below); the actuator only routes on it. The executor's setpoint path (PR 1b)
// will likely add a capability-addressed `target` variant alongside the
// applyDeviceTargets-backed one here.
type DeviceCommand =
  | { kind: 'binary'; deviceId: string; control: 'onoff' | 'evcharger_charging'; desired: boolean; flowBacked: boolean }
  | { kind: 'target'; deviceId: string; value: number; contextInfo?: string }
  | { kind: 'step';   deviceId: string; profile: SteppedLoadProfile; desiredStepId: string;
      planningPowerW: number; planningCurrentA: number;
      actuationMode?: 'plan' | 'reconcile'; previousStepId?: string };
```

The actuator is the **only** translator from this intent vocabulary down to the
four transport methods, and the **only** importer of the transport write
interface. It also absorbs the one decision that currently leaks upward — the
flow-vs-native binary choice at `binaryControlDispatch.ts:159`
(`isFlowBackedBinaryControl(snapshot, capabilityId)`) — so the executor stops
branching on channel.

### The boundary test

- Field names a **Homey capability ID, flow card, or native/synthetic
  channel** → **transport** input.
- Field names a **control outcome** (on/off / step / setpoint) for a device →
  **actuator** input.

`control: 'evcharger_charging'` passes the test: it names *which binary to
drive*, not an SDK channel, so it belongs on actuator input.

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

## Two write leaks this seam closes

These are writes issued from the wrong layer today; the actuator absorbs both:

1. `lib/device/shedBehaviorActuation.ts:203` — the **device layer** issuing a
   binary off via `transport.setCapability`. Mechanism-with-policy in the SDK
   leaf. Moves to the actuator.
2. `setup/appInit/deferredObjectiveLifecycle.ts:139` — **wiring** hand-assembling
   its own `ShedActuationTransport` from `deviceManager`. Replaced by depending
   on the actuator.

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
- `no-actuator-bypass` *(PR 1b)* — `lib/plan/**`, `lib/executor/**`, and
  `setup/**` must not import transport's write methods/type directly; they go
  through the `Actuator` interface. Enforceable only once the executor dispatch
  is migrated (PR 1b), since the executor still calls transport writes today.
- `device-no-actuation` — `lib/device/**` hosts no control actuation. Achieved
  *structurally* in PR 1 by relocating the terminal-shed actuator out of
  `lib/device/`; the existing `no-device-to-peer-except-power` already blocks any
  attempt to re-add a `lib/device → lib/actuator` call.
- Promote the existing warn-level `todo-narrow-plan-device-dep` once the write
  path no longer reaches transport from plan/executor (PR 3).

> Honesty note: dependency-cruiser is import-based. The "only the actuator
> writes" invariant is enforced *structurally* (one `Actuator` class, write
> methods behind an actuator-only type) plus the rules above; there is no pure
> import rule that says "no `.setCapability` call here." Code review covers the
> residue.

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
- Relocated the terminal-shed actuator `lib/device/shedBehaviorActuation.ts` →
  `lib/actuator/terminalShedActuation.ts`, refactored to issue writes through
  `actuator.apply()` instead of poking transport. **Kills the device-layer write
  leak.**
- Wiring: `buildShedActuationTransport` → `buildShedActuator` constructs the
  injected transport + the actuator; `deferredObjectiveLifecycle` consumes the
  actuator and passes the step-bookkeeping callback separately. **Kills the
  hand-built-transport leak.**
- Cruiser: `no-actuator-to-peer` + `lib/actuator/` added to
  `no-domain-to-app-layer`.
- Tests: `deviceActuator.test.ts` (intent→method mapping incl. EV `control`
  discriminant, flow-vs-native, step passthrough) + relocated
  `terminalShedActuation.test.ts` + reworked `deferredTerminalEnding.test.ts`.

**PR 1b — migrate the executor dispatch subsystem onto the actuator.**
- Re-point `binaryControlDispatch`, `targetExecutor`, `steppedLoadExecutor`, and
  the `planExecutor` bindings to issue writes through the actuator, generalizing
  `DeviceCommand` as needed (e.g. a capability-targeted `target` variant for the
  executor's `setCapability` setpoint path).
- Move the flow-vs-native binary decision (`binaryControlDispatch.ts:159`
  `isFlowBackedBinaryControl`) to the producer so the command carries a resolved
  `flowBacked`, matching the terminal-shed path.
- Then add `no-actuator-bypass` and promote `todo-narrow-plan-device-dep`.
- Keep logging/pending/retry where they are unless a clean home emerges — this
  PR is about the write seam, not relocating the executor's bookkeeping.

**PR 2 — move the snapshot store to observer (the read model).**
- Relocate `latestSnapshot` / `latestSnapshotById` / `getHomePowerW` from
  `DeviceTransport` to the observer store.
- Re-point the two external readers: `lib/app/appSnapshotHelpers.ts:387`
  (`getHomePowerW`) and `lib/plan/snapshotWarmupGate.ts` (`latestSnapshot`).
- Observer receives `homePowerW` via event/contract (must not statically import
  `lib/power/**`).
- This finishes the deferred bullet from `observer-transport-split.md`.

**PR 3 — tighten.**
- Promote warn-level rules to error; retire transitional allowances.
- Decide whether pending-record *initiation* moves into the actuator (it is
  already decoupled from the write call, so this is a clarity move, not a
  correctness one).
- Reconcile `README.md`, `docs/architecture.md`, and this note's status →
  shipped.

---

## Open questions

- **Pending-record home (PR 3):** keep at dispatch, or move into the actuator?
  Leaning keep-at-dispatch unless a second caller needs it, to avoid the
  actuator growing bookkeeping.
- **`applyDeviceTargets` vs per-capability `target`:** confirm whether the
  `target` command kind should fan to `applyDeviceTargets` (batch) or
  `setCapability` (single). Today both paths exist; the actuator should pick one
  per call site without changing observed behavior.
