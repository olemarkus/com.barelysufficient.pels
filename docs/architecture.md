---
title: Architecture Contract
description: Dependency boundaries that keep PELS runtime code, settings UI, and shared modules from bleeding into each other.
---

# PELS Architecture Contract

PELS is layered. Modules in a higher layer may depend on modules in lower layers, never the other way round. The contract here is mechanical — `dependency-cruiser` enforces it on every CI run (`npm run arch:check`) — and the configuration in [`.dependency-cruiser.cjs`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs) is the source of truth. If this page disagrees with the cruiser config, the cruiser wins.

This page is the public contributor reference. Use it when you are deciding where new code goes, or why a refactor is being asked to move modules around.

## Layer overview

```
┌─────────────────────────────────────────────────────────────┐
│ Entry points                                                │
│   app.ts · drivers/** · packages/settings-ui/src/script.ts  │
├─────────────────────────────────────────────────────────────┤
│ App wiring and adapters                                     │
│   setup/** · lib/app/** (sunsetting) · flowCards/**         │
├─────────────────────────────────────────────────────────────┤
│ Domain modules                                              │
│   lib/device/** · lib/power/** · lib/objectives/** · lib/plan/**             │
│   lib/price/** · lib/dailyBudget/** · lib/observer/**                       │
├─────────────────────────────────────────────────────────────┤
│ Shared utilities                                            │
│   lib/utils/** · packages/contracts/src/** · packages/shared-domain/src/**
├─────────────────────────────────────────────────────────────┤
│ Test code (not imported by anything runtime)                │
│   test/** · packages/settings-ui/test/** · tests/**         │
└─────────────────────────────────────────────────────────────┘
```

### What each layer is for

| Layer | Purpose | Examples |
| --- | --- | --- |
| **Entry points** | Boot the runtime or render the settings UI. Wire dependencies but contain no domain logic. | `app.ts` (Homey app entry), `drivers/pels_insights/` (virtual device), `script.ts` (settings UI bootstrap) |
| **App wiring** | Adapt the Homey SDK and Flow cards onto the domain modules. This is where dependency injection happens. New wiring lives in `setup/`; `lib/app/` is sunsetting. | `setup/schedulerTelemetryObserver.ts`, `setup/settingsRepository.ts`, `flowCards/registerFlowCards.ts` |
| **Domain** | Pure planning, capacity, price, budget, and observation logic. No Homey SDK calls; no UI imports. | `lib/plan/planEngine.ts`, `lib/device/deviceTransport.ts`, `lib/power/tracker.ts`, `lib/objectives/profiles.ts`, `lib/observer/idleClassifier.ts` |
| **Shared utilities** | Pure helpers usable from anywhere — including the browser-side settings UI. Must remain Homey-SDK-free. | `lib/utils/*`, `packages/shared-domain/src/deadlineLabels.ts` |
| **Test code** | Specs and mocks. Runtime cannot import it. | `test/`, `packages/settings-ui/test/` |

## Hard rules (CI-enforced)

The following rules are encoded in [`.dependency-cruiser.cjs`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs):

1. **No circular dependencies** anywhere in the runtime or shared packages.
2. **Runtime code must not import test code.** "Runtime code" here means everything under `app.ts`, `lib/**`, `setup/**`, `flowCards/**`, `drivers/**`, and `packages/{settings-ui,contracts,shared-domain}/src/**`.
3. **Backend must not import the settings UI.** Backend is `app.ts`, `api.ts`, `lib/**`, `setup/**`, `flowCards/**`, `drivers/**`. The boundary is one-way.
4. **Settings UI must not import the backend.** The settings UI may only consume `packages/contracts/**` and `packages/shared-domain/**`. The same `shared-domain` helpers are used by both sides, so user-visible strings and runtime log strings stay in lockstep.
5. **Shared packages must not import the runtime.** `packages/contracts/**` and `packages/shared-domain/**` cannot reach into `app.ts`, `api.ts`, `lib/**`, `flowCards/**`, or `drivers/**`. This is what keeps the settings-UI bundle browser-safe.
6. **Domain modules must not import `lib/app/**`.** Domain logic is independent of wiring.
7. **`lib/**` and `packages/**` must not import `setup/**`** (rule `no-lib-to-setup`). The arrow always points from `setup/` down into the libraries it wires; see the [App wiring lives in `setup/`](#app-wiring-lives-in-setup) section below.
8. **`flowCards/**` and `drivers/**` must not import `packages/settings-ui/**`.**
9. **Non-entry modules must not import `app.ts`.**

If any of these break, CI fails before tests run. Local check: `npm run arch:check`.

## App wiring lives in `setup/`

`setup/` at the repo root is the honest home for app-wiring classes — factories, observers, registrars that construct and connect services. These have no reuse value outside this app, so they live at the entry layer rather than masquerading as library code in `lib/app/`.

**Direction is enforced.** The [`no-lib-to-setup`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs) rule blocks any import from `lib/**` or `packages/**` into `setup/**`. Wiring imports the libraries it wires; never the reverse.

**Conventions (reviewed at PR time, not cruiser-enforced):**

- **One purpose per file**, named for the concrete wiring it does (`schedulerTelemetryObserver.ts`, `settingsRepository.ts`). No grab-bag `setupHelpers.ts`.
- **Each file exposes a class, or a single `register*` / `init*` / `create*` function.** Not bags of utility functions. The one carve-out is the settings-UI/widget endpoint handler files (`settingsUiApi.ts`, `settingsUiHomesApi.ts`, `settingsUiStarvationRescueApi.ts`, `settingsUiSmartTaskApi.ts`), which each export the handler set for one endpoint family because `api.ts` imports handlers by name. Cohesion still binds: a new endpoint family gets a new file, never an extra export bolted onto an unrelated one.

**`lib/app/` is sunsetting.** As remaining wiring migrates to `setup/`, `lib/app/` shrinks. `lib/app/appContext.ts` (the shared `AppContext` type definition) is the expected long-term inhabitant; everything else moves out.

## Where new code goes

| You are adding… | It belongs in… |
| --- | --- |
| A new Flow card | A topical file under `flowCards/` (the directory is flat by purpose, not by trigger/condition/action), with the card JSON under `.homeycompose/flow/<triggers\|conditions\|actions>/` |
| A new planner rule | `lib/plan/` — but the rule must be pure and unit-testable without a Homey instance |
| New UI on the settings page | `packages/settings-ui/src/ui/` — read state from contracts; emit changes through the API surface |
| A user-facing string also written to logs | `packages/shared-domain/src/` — both the UI and the runtime logger must import it from there |
| A type used on both sides | `packages/contracts/src/` |
| App-wiring code (factory, observer, registrar that constructs/connects services) | `setup/` — one purpose per file, exposes a class or single `register*`/`init*` function. See [App wiring lives in `setup/`](#app-wiring-lives-in-setup). |
| A Homey-SDK adapter | `setup/` for new wiring (preferred); `lib/app/` is sunsetting. Keep the adapter thin and forward to a domain module. |

## When duplication is the right call

If consolidating two helpers would require crossing a boundary (e.g. a runtime module reaching into the settings UI, or a domain module pulling something from `lib/app/`), **leave the duplication in place** and add a one-line comment explaining the constraint. The architecture cost of a back-door is higher than three lines of repeated arithmetic.

## Clean and trusted interfaces between layers

Every layer boundary follows one rule with two faces:

- **Clean** is the emitting side's obligation. Whoever hands a value across a boundary — an adapter resolving Homey SDK reads, the planner emitting a plan, the read model building a UI snapshot — resolves and validates it first. The interface says exactly what it means and nothing more: no raw `NaN` or malformed input flowing inward, no field declared optional that the emitter in fact always writes, no two spellings of absence for one quantity, no display payload riding on an actuation contract.
- **Trusted** is the consuming side's obligation, and it is only possible because of the first: read the value directly. No re-validating what the type already guarantees, no re-deriving what the emitter already resolved, no branching on the source, evidence, or provenance of the value received.

Trust is scoped to in-process handoffs of already-typed values. A boundary that crosses an untrusted transport — a network fetch, the Homey API bridge into the settings WebView, a persisted blob that may predate the current schema — is an external edge again: the receiving side's own adapter validates and discriminates the payload once (that is its clean-face duty toward its own consumers), and everything inward of that seam trusts. The settings UI does exactly this: it discriminates plan snapshots at its parse seam (`planSnapshotParse.ts`) and validates API envelopes at the fetch adapter, never inside the formatters.

Concretely: the planner emits a single `safePaceKw`. It does not emit `safePaceFromHardCapKw` and `safePaceFromDailyBudgetKw` for the consumer to combine. If a consumer needs to explain *why* the value is what it is, the emitter also emits a separate `reason` field.

The two faces enforce each other, which yields a diagnostic: a consumer that hedges — re-checks finiteness, sniffs for a key's presence, keeps a fallback derivation — is evidence of an unclean interface upstream. Fix the interface it stopped trusting, not the hedge.

The rule applies at every seam, not just the SDK edge: observer → planner, planner → executor, planner → read model, read model → UI, and internal handoffs such as `PlanContext` → plan meta. It isn't checked by the cruiser, but breaking it is the most common reason a feature ends up tangled across layers.

Existing comments cite the two faces under their former names, and both names refer to this section: "Validation belongs at the boundary" is the clean face at the external-input edge (root `AGENTS.md` keeps the operational checklist), and "Resolution belongs in the producer" — the resolution-in-producer rule — is the emitter-resolves-so-the-consumer-can-trust pairing.

## Peer DAG inside the domain layer

The domain peers (`lib/device`, `lib/power`, `lib/objectives`, `lib/observer`, `lib/plan`, `lib/price`, `lib/dailyBudget`, `lib/executor`) are not flat. The cruiser enforces the directional edges below — any other peer-to-peer import fails the build.

```
executor → plan → {power, dailyBudget, price, objectives, observer}
                ↘ device  (narrow, Phase 4 cleanup target)
dailyBudget → {power, price}
device → power    (estimatePower utility)
power ↔ objectives  (type-only cycle, established)
```

The rules behind this DAG (`no-power-to-plan`, `no-power-to-device`, `no-device-to-plan`, `no-observer-to-peer`, `no-price-to-peer`, …) exist as the gate for the ongoing `lib/app` dissolution: any helper currently in `lib/app/` that, if pushed into a peer, would create a forbidden edge identifies itself as cross-peer wiring residue. Wiring residue stays at the composition root (`app.ts` or `setup/**`), not inside a peer.

### Realtime event flow

Realtime device events (capability updates, full device updates from Homey) cross three peer layers between SDK ingress and a planner reapply:

1. **Translation** — `lib/device/` (`DeviceTransport` + `lib/device/transport/managerRealtimeHandlers.ts`) parses the raw Homey payload, runs the admit-or-suppress flow-vs-binary rule and pending-binary-command echo suppression, and produces normalized `observed-state-changed` / `plan-reconcile-observed` events.
2. **Observer fan-out** — `lib/observer/observedStateEvents.ts` owns the typed-event emitter (`ObservedStateEmitter`). Transport routes each event through a dispatcher callback bag (`observedStateDispatcher`) injected at construction time by wiring, so `lib/device/` → `lib/observer/` stays free of static imports (the `no-device-to-peer-except-power` cruiser rule holds).
3. **Drift verdict** — `lib/executor/planExecutionDrift.ts` compares the observed state against the executor-facing plan intent (`ExecutableDeviceIntent` vs `ExecutableObservedDeviceState`). Observer and transport never see plan intent.
4. **Re-plan trigger** — `setup/appRealtimeDeviceReconcileRuntime.ts` subscribes to the observer-owned emitter and requests a plan rebuild for the owning home. It consults no drift predicate: comparing a device against the committed plan was a planner question the wiring layer had no business answering, and the answer was only ever used to decide whether to RE-APPLY that plan — the lane that breached the hard cap in production (`TODO.md`, inc_26449fb9). An observation is now an ordinary planner input, and the planner decides, including deciding to do nothing.

See `notes/state-management/observer-transport-split.md` for the layering rationale and the six-step split-train history.

## Transitional allowances

A small number of modules still cross layers in ways the contract above forbids. Each is registered as a named `.dependency-cruiser.cjs` rule and accepted as tightening work, not as new patterns to imitate:

- `lib/utils/**` still has two imports from `lib/power` and `lib/plan`, both type-only. The `lib/device` edge is gone, and so is the last value import (`settingsHandlers.ts` → `CapacityGuard`), which disappeared once the capacity guard stopped mirroring the capacity settings. The cruiser rule for this case is registered at warning severity (not error), so CI does not fail on it — but new code must not extend this set.
- `lib/plan/**` imports no executor modules. Setup owns the concrete planner/executor composition and implements the narrow `PlanEngine` behavior contract; neutral cross-boundary result types live in `lib/planContract/`. The cruiser rejects compiled plan→executor edges through `no-plan-to-executor`, and the source AST guard behind `npm run arch:grep` rejects type-only and dynamic forms before compilation erases them.
- `lib/plan/**` consumes only the `DeviceObservation` read interface from `lib/device/deviceObservation.ts`; the `no-plan-to-device` cruiser rule blocks every other `lib/device/` import at error level. Binary control writes are dispatched by executor (`lib/executor/binaryControlDispatch.ts`), not plan. The orchestrating class is now `DeviceTransport` at `lib/device/deviceTransport.ts` — see `notes/state-management/observer-transport-split.md` for the layering rationale and the per-PR split history.

If you find a cross-layer import that has no named cruiser rule covering it, treat it as a bug, not a precedent.

## Related references

- [`.dependency-cruiser.cjs`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs) — the authoritative rules.
- [Technical Reference](/technical) — planner internals at a lower level than this contract.
- [Contributor Setup](/contributor-setup) — getting a local checkout running.
