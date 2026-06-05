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
3. **Backend must not import the settings UI.** Backend is `app.ts`, `lib/**`, `flowCards/**`, `drivers/**`. The boundary is one-way.
4. **Settings UI must not import the backend.** The settings UI may only consume `packages/contracts/**` and `packages/shared-domain/**`. The same `shared-domain` helpers are used by both sides, so user-visible strings and runtime log strings stay in lockstep.
5. **Shared packages must not import the runtime.** `packages/contracts/**` and `packages/shared-domain/**` cannot reach into `app.ts`, `lib/**`, `flowCards/**`, or `drivers/**`. This is what keeps the settings-UI bundle browser-safe.
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
- **Each file exposes a class, or a single `register*` / `init*` function.** Not bags of utility functions.
- **Files larger than ~150 LOC are considered fat-fingered** and should split into smaller wirings.

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

## Resolution belongs in the producer

When data flows from a producing module to a consuming module (planner → UI, price source → planner), the producer flattens whatever it knows into a final value. Consumers must not branch on the source, evidence, or provenance of the value they received. This rule isn't checked by the cruiser, but it is the most common reason a feature ends up tangled across layers.

Concretely: the planner emits a single `safePaceKw`. It does not emit `safePaceFromHardCapKw` and `safePaceFromDailyBudgetKw` for the consumer to combine. If a consumer needs to explain *why* the value is what it is, the producer also emits a separate `reason` field.

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
4. **Reapply trigger** — `setup/appRealtimeDeviceReconcileRuntime.ts` subscribes to the observer-owned emitter, consults the executor's drift predicate, and (when drift is real) enqueues a planner rebuild via `planRebuildScheduler.request(...)`.

See `notes/state-management/observer-transport-split.md` for the layering rationale and the six-step split-train history.

## Transitional allowances

A small number of modules still cross layers in ways the contract above forbids. These are listed in `TODO.md` and accepted as tightening work, not as new patterns to imitate:

- `lib/utils/**` still has a few imports from `lib/device`, `lib/power`, and `lib/plan`. The cruiser rule for this case is registered at warning severity (not error), so CI does not fail on it — but new code must not extend this set.
- `lib/plan/**` imports the executor in two places (`planEngine.ts` instantiates `PlanExecutor`; `planReconcileState.ts` imports a drift predicate). The cruiser warns. Phase 3 of the architecture refactor moves these contracts into `lib/planContract/` so the executor↔plan boundary is symmetric.
- `lib/plan/**` consumes only the `DeviceObservation` read interface from `lib/device/deviceObservation.ts`; the `no-plan-to-device` cruiser rule blocks every other `lib/device/` import at error level. Binary control writes are dispatched by executor (`lib/executor/binaryControlDispatch.ts`), not plan. The orchestrating class is now `DeviceTransport` at `lib/device/deviceTransport.ts` — see `notes/state-management/observer-transport-split.md` for the layering rationale and the per-PR split history.

If you find a cross-layer import that isn't in the TODO list, treat it as a bug, not a precedent.

## Related references

- [`.dependency-cruiser.cjs`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs) — the authoritative rules.
- [Technical Reference](/technical) — planner internals at a lower level than this contract.
- [Contributor Setup](/contributor-setup) — getting a local checkout running.
