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
│   lib/app/** · flowCards/**                                 │
├─────────────────────────────────────────────────────────────┤
│ Domain modules                                              │
│   lib/core/** · lib/plan/** · lib/price/** · lib/dailyBudget/** · lib/observer/**
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
| **App wiring** | Adapt the Homey SDK and Flow cards onto the domain modules. This is where dependency injection happens. | `lib/app/appPowerCalibrationWiring.ts`, `flowCards/registerFlowCards.ts` |
| **Domain** | Pure planning, capacity, price, budget, and observation logic. No Homey SDK calls; no UI imports. | `lib/plan/planEngine.ts`, `lib/core/deviceManager.ts`, `lib/observer/idleClassifier.ts` |
| **Shared utilities** | Pure helpers usable from anywhere — including the browser-side settings UI. Must remain Homey-SDK-free. | `lib/utils/*`, `packages/shared-domain/src/deadlineLabels.ts` |
| **Test code** | Specs and mocks. Runtime cannot import it. | `test/`, `packages/settings-ui/test/` |

## Hard rules (CI-enforced)

The following rules are encoded in [`.dependency-cruiser.cjs`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs):

1. **No circular dependencies** anywhere in the runtime or shared packages.
2. **Runtime code must not import test code.** "Runtime code" here means everything under `app.ts`, `lib/**`, `flowCards/**`, `drivers/**`, and `packages/{settings-ui,contracts,shared-domain}/src/**`.
3. **Backend must not import the settings UI.** Backend is `app.ts`, `lib/**`, `flowCards/**`, `drivers/**`. The boundary is one-way.
4. **Settings UI must not import the backend.** The settings UI may only consume `packages/contracts/**` and `packages/shared-domain/**`. The same `shared-domain` helpers are used by both sides, so user-visible strings and runtime log strings stay in lockstep.
5. **Shared packages must not import the runtime.** `packages/contracts/**` and `packages/shared-domain/**` cannot reach into `app.ts`, `lib/**`, `flowCards/**`, or `drivers/**`. This is what keeps the settings-UI bundle browser-safe.
6. **Domain modules must not import `lib/app/**`.** Domain logic is independent of wiring.
7. **`flowCards/**` and `drivers/**` must not import `packages/settings-ui/**`.**
8. **Non-entry modules must not import `app.ts`.**

If any of these break, CI fails before tests run. Local check: `npm run arch:check`.

## Where new code goes

| You are adding… | It belongs in… |
| --- | --- |
| A new Flow card | A topical file under `flowCards/` (the directory is flat by purpose, not by trigger/condition/action), with the card JSON under `.homeycompose/flow/<triggers\|conditions\|actions>/` |
| A new planner rule | `lib/plan/` — but the rule must be pure and unit-testable without a Homey instance |
| New UI on the settings page | `packages/settings-ui/src/ui/` — read state from contracts; emit changes through the API surface |
| A user-facing string also written to logs | `packages/shared-domain/src/` — both the UI and the runtime logger must import it from there |
| A type used on both sides | `packages/contracts/src/` |
| A Homey-SDK adapter | `lib/app/` — keep the adapter thin and forward to a domain module |

## When duplication is the right call

If consolidating two helpers would require crossing a boundary (e.g. a runtime module reaching into the settings UI, or a domain module pulling something from `lib/app/`), **leave the duplication in place** and add a one-line comment explaining the constraint. The architecture cost of a back-door is higher than three lines of repeated arithmetic.

## Resolution belongs in the producer

When data flows from a producing module to a consuming module (planner → UI, price source → planner), the producer flattens whatever it knows into a final value. Consumers must not branch on the source, evidence, or provenance of the value they received. This rule isn't checked by the cruiser, but it is the most common reason a feature ends up tangled across layers.

Concretely: the planner emits a single `safePaceKw`. It does not emit `safePaceFromHardCapKw` and `safePaceFromDailyBudgetKw` for the consumer to combine. If a consumer needs to explain *why* the value is what it is, the producer also emits a separate `reason` field.

## Transitional allowances

A small number of modules still cross layers in ways the contract above forbids. These are listed in `TODO.md` and accepted as tightening work, not as new patterns to imitate:

- `lib/utils/**` still has a few imports from `lib/core` and `lib/plan`. The cruiser rule for this case is registered at warning severity (not error), so CI does not fail on it — but new code must not extend this set.

If you find a cross-layer import that isn't in the TODO list, treat it as a bug, not a precedent.

## Related references

- [`.dependency-cruiser.cjs`](https://github.com/olemarkus/com.barelysufficient.pels/blob/main/.dependency-cruiser.cjs) — the authoritative rules.
- [Technical Reference](/technical) — planner internals at a lower level than this contract.
- [Contributor Setup](/contributor-setup) — getting a local checkout running.
