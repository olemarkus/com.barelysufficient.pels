# Setup — App Wiring

`setup/` constructs components, connects callbacks, and hands services to the composition root in `app.ts`. It does not own runtime state or domain decisions.

## No state

- Keep mutable runtime state with its owning `lib/` module. A `setup/` class may hold readonly references to collaborators, not a changing cache, store, queue, or domain state. `npm run setup:stateless` enforces the syntactic rule; its allowlist only shrinks.

## No domain logic

- Do not parse, classify, project, validate, or calculate domain values here. Do not read the Homey SDK here. Hand a narrow port from `lib/ports/homeyRuntime.ts` to the domain module that owns the read and its failure policy. `npm run setup:boundaries` enforces peer and SDK import budgets; regenerate shrinking allowlists only through the guard's `--seed` flow after a migration.
- `lib/planInput/` owns the deliberate cross-domain projection into planner input. Setup binds its narrow source operations; it does not recreate the projection. A setting read by both runtime and UI has its shared type and policy in `packages/shared-domain/src/settings/`; a runtime-only setting belongs to its `lib/` owner. See `notes/settings-key-ownership.md`.
- Prefer one concrete wiring purpose per file. Existing endpoint handler groups are organized by endpoint family; do not add unrelated handlers or generic helper bags.

## External reads and startup

- Homey `settings.get()` may return either `null` or `undefined` for an absent key. The owning reader uses `getKeys()` to distinguish a never-written key from a transient miss and preserves last-good behavior where appropriate. Never convert an unavailable read into a plausible domain default. See `notes/persisted-settings-state.md`.
- Ordered startup builds optional `AppContext` services into required services. Assert an unavailable required service at the startup boundary (`requireInitializedAppContext` or a narrow `require*`); do not use `?.` or `??` to invent a value. Keep `subscribePlanObservedState` after `initPlanService` so listeners cannot reach an unwired planner.
- `app.ts` is the composition root. `setup/appInit/` holds boot factories and registrars; `setup/homeRuntime/` holds per-home factories used for Main and sub-homes. A new per-home factory belongs in `homeRuntime/`.
- The configured Main meter and the provenance of a sampled reading are separate facts. The save seam rejects invalid meter ownership; runtime fences legacy or temporarily untrusted samples. Repair supported configuration problems at their producer rather than weakening either rule.

## Adapter naming

Existing `*Adapter.ts` files that read settings are migration debt. Add new readers and stateful store ports to the owning `lib/` module and pass their Homey port from setup.
