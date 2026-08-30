# Setup (App Wiring) Layer

- This folder **constructs and connects**. It does not run, and it does not remember. Factories, observers, registrars, and the Homey-settings readers/writers that bind the `lib/` domain modules to the SDK live here; a file here builds something and hands it over. Nothing here has reuse value outside this app; it lives at the entry layer on purpose.

## No state (authoritative)

- **`setup/` holds nothing.** No mutable field, no module-level `let` or `var`, and no field holding a mutable container (`new Map()`, `new Set()`, an array or object literal, a `create*Store()` result — `readonly` pins the reference, not the contents, and a bare declaration filled in the constructor is caught at the assignment). Anything that changes as the app runs is a **component**: it belongs to the domain module that owns the concept, and setup builds it and hands it the collaborators it needs.
  - **Why.** State in the wiring layer is state with no owner. It sits ABOVE the layer boundaries `.dependency-cruiser.cjs` enforces, so anything wired can reach it, and it becomes a channel between modules that are forbidden to talk — with no import edge to show for it, so `arch:check` cannot see it. `appDeviceControlHelpers.ts` is the worked example. It used to HOLD the executor's stepped-command state; that state now belongs to `lib/executor/steppedCommandStore.ts` and is injected in. What the example still shows is the second half of the same defect: confirm/expire/prune are driven from setup inside `decorateSnapshotWithDeviceControl` — the plan-input producer — so a step command settles because the planner asked for its devices rather than because the executor observed materialization, and the commanded axis reaches the planner while `no-plan-to-executor` (error severity, incident inc_26449fb9 attached) sees no import to object to. Moving that lifecycle onto the executor's settle sweep is the open half (`TODO.md`).
  - **Allowed:** `private readonly deps` and readonly constructor parameter properties — a reference to something someone else owns; a class property initialized with an arrow function (a method bound to its receiver, as the `homey.app` façades need); `abstract` property declarations on `appRuntimeApi.ts` / `appHostApi.ts`, which declare storage `PelsApp` provides rather than holding it; module consts typed `ReadonlySet`/`ReadonlyMap` or SCREAMING_SNAKE constant tables; and locals inside a function, which die with the call frame.
  - **The composition root is `app.ts`**, not `setup/`. Handles to constructed services are held there (or on `AppContext`) as readonly fields — it already holds roughly two dozen.
  - Enforced by `npm run setup:stateless` (`scripts/check-setup-stateless.mjs`, in `ci:checks`). Files predating the rule are in `scripts/setup-stateless-allowlist.txt`, which budgets each one a declaration count. The budget may only shrink: adding state to a listed file fails the guard just as a new stateful file does, and a count left stale after a migration fails too. **Do not add a line to it, and do not raise a count.**

## Conventions (authoritative)

- One purpose per file, named for the concrete wiring it does. No grab-bag `setupHelpers.ts`.
- Each file exposes a class or a single `register*` / `init*` / `create*` / `wire*` function — no bags of utility functions. **One carve-out:** the settings-UI/widget endpoint handler files (`settingsUiApi.ts`, `settingsUiHomesApi.ts`, `settingsUiStarvationRescueApi.ts`, `settingsUiSmartTaskApi.ts`) each export the handler set for ONE endpoint family, because `api.ts` imports handlers by name. The cohesion rule still binds: a new endpoint family gets a new file, never an extra export on an unrelated one. **Second carve-out:** a per-module structured-log vocabulary file (`homeRuntime/homeRuntimeRegistryLogs.ts`), which holds one module's event names, levels and `detail` wording in one place so log audits keyed on them have a single source — the `lib/plan/planLogging.ts` precedent. It exists for headroom on a hot file, not as a unit of responsibility; it may only hold emitters for its own module, and it is not a licence for a general logging grab-bag.
- `setup/**` may import `lib/**` and `packages/**`; the reverse is forbidden (`no-lib-to-setup` dep-cruiser rule, `npm run arch:check`). `setup/**` must not import `packages/settings-ui/**` either (`no-backend-to-settings-ui`).
- **`homey.settings.get()` answers an unset key with `null`, not `undefined` — classify absence
  on both.** Gate on `raw === undefined || raw === null`, then confirm genuine absence against
  `getKeys()`: a key the list vouches for that still reads empty is a transient miss and must
  stay `unavailable`, not become a default. Gating on `=== undefined` alone makes the key-list
  cross-check unreachable on a real Homey while every test passes — that shipped in v2.20.0 as
  `readTemperatureControlDisabledDevicesSetting` pinning its policy at `unavailable`, which
  fenced setpoint control on every thermostat of every install that had never touched the
  toggle. `readTemperatureControlDisabledDevicesSetting` (`appSettingsHelpers.ts`) and
  `readConfiguredPowerSource` (`powerSourceSettings.ts`) are the reference readers.
  Where `null` is itself a stored value — the Main meter's "Automatic" — the read value cannot
  distinguish stored-null from a transient miss. The key list can prove only whether the key is
  written; a listed key plus a `null` value still needs producer-owned last-good state, a companion
  marker, or a bounded grace policy. See the outstanding TODO for `mainMeterSettings.ts` and
  `homeRuntime/homeOperatingMode.ts`, which still gate on `undefined` alone.
- **Configured meter ownership and sampled-meter provenance are different facts.** The
  `ui_homes_save` seam requires an explicit Main meter before any meter area can run, refuses the
  same explicit meter on both sides, and refuses switching Main back to Automatic while areas run.
  A valid current configuration therefore cannot assign an Annex/area meter to Main. The sampled
  fence in `homeMainMeterAuthority.ts` is defence for a different boundary: legacy or externally
  malformed persisted state, an in-flight sample while such state is repaired, a fresh restored
  sample whose meter identity did not survive restart, and adapter failures such as the outstanding
  `mainMeterSettings.ts` null-read defect above. Describe those states as **sample provenance being
  temporarily untrusted**, never as PELS confusing two valid configured owners. Fix a supported
  path at the dirty producer; do not weaken the save invariant or turn the defensive fence into a
  normal Multiple meters journey.
- **An extracted body re-asserts a boot-window invariant by throwing, never by defaulting.** Six
  `AppContext` services are optional while ordered startup constructs them. The lifecycle wiring
  calls `requireInitializedAppContext` before crossing into `InitializedAppContext`, whose service
  fields are all required. A narrower controller may assert only the service it needs —
  `AppHostApi.requirePriceCoordinator` is the reference. `?.` or `?? someDefault` must not turn a
  missing required service into a plausible business value. Use a narrow `Pick<AppContext, …>` only
  when absence is genuinely part of the upstream contract.
  `planService` has exactly ONE guard, `appInit/contextGuards.requirePlanService`; add call sites to
  that one rather than another private copy. The observed-state lane's boot window was closed rather
  than guarded: its plan-dependent listeners now register in their own startup step,
  `subscribePlanObservedState`, after `initPlanService`. **Keep that step after `initPlanService`, and
  do not fold it back into `initDeviceManager`** — the projection-feeding listeners stay with the
  transport, and splitting the two preserves projection-first registration order.
  Target-power reachability still uses `resolvePlanService` (`ready | not_wired`): its mutation hook
  is live with the transport and requests a rebuild through fire-and-forget `void`. A synchronous
  `require*` throw there escapes the promise `.catch`; assert only where the caller can surface the
  error, and resolve where it cannot.

## Boot path

- `app.ts` injects `Homey.App` into the setup façades; `AppRuntimeApi.onInit` delegates to
  `AppServiceWiring`, which consumes `setup/appInit.ts` — a thin barrel over `setup/appInit/`, one
  focused factory/registrar per file (`createPlanEngine`, `createPlanService`, `priceServices`,
  `createDailyBudgetService`, `registerAppFlowCards`, `deferredRecorders`, …). The barrel does not
  cover the whole directory: it re-exports the subset the setup façades (`appRuntimeApi.ts`,
  `appServiceWiring.ts`, `appSmartTaskApi.ts`) and the tests import, and the rest are imported
  directly by their own wiring sites — including the three `app.ts` reaches for itself, which do
  NOT go through the barrel. Keep the barrel's export surface stable; add new boot wiring as a new
  `setup/appInit/` file.
- Load-bearing root files:
  - `appLifecycleHelpers.ts` — `runStartupStep` / `startAppServices`: ordered, traced startup sequencing. The order is load-bearing where a step's listeners reach a service a later step constructs: `initDeviceManager` → `initHomeMembership` → `initCapacityGuard` → `initPlanEngine` → `initPlanService` → `subscribePlanObservedState`.
  - `powerSamplePipeline.ts` — `PowerSamplePipeline`: routes power samples into capacity tracking and plan-rebuild scheduling.
  - `backgroundTasksController.ts` — `BackgroundTasksController`: owns periodic tasks (perf logging, price-lowest triggers, deferred-objective lifecycle clock).
  - `settingsRepository.ts` — `SettingsRepository`: typed reads of persisted Homey settings at boot.
  - `settingsUiApi.ts` — the handlers `api.ts` delegates to for the settings-UI bootstrap/read/refresh endpoints. Two endpoint families have their own root files `api.ts` imports directly: `settingsUiHomesApi.ts` (`ui_homes` + the `ui_homes_save` ownership-write seam) and `settingsUiStarvationRescueApi.ts` (the overview device-card budget-exempt rescue), alongside the existing `settingsUiSmartTaskApi.ts`.
  - `appSmartTaskApi.ts` / `appSmartTaskPayloads.ts` — the smart-task (deferred-objective)
    preview+write lanes and the read-only UI payload assembly. `AppHostApi` keeps the thin delegating
    stubs because widget and settings-UI handlers reach them through `homey.app`.
  - `appRuntimeApi.ts` / `appHostApi.ts` — inherited runtime/lifecycle and Homey/widget/settings-API
    façades. `PelsApp` stays the concrete state/composition root; inherited methods preserve the
    external `homey.app` surface and receiver binding without keeping their bodies in `app.ts`.
  - `planRebuildIntentPolicy.ts` — `getAppPlanRebuildNowMs` plus the due-time/execution decisions `PlanRebuildScheduler` delegates back to the app.
  - `appSettingsHelpers.ts` — loads/normalizes capacity settings and reacts to settings changes.
  - `homeRuntime/` — per-home wiring (multi-home): the `HomeScope` closure bundle the plan factories consume, the pipeline factory, and the R7b capacity-only sub-home bundles (`homeRuntimeRegistry.ts` + `createHomeCapacityBundle.ts`, reconciled against `homes_config`; the main home never routes through the bundle factory).

## Adapter naming

- `*Adapter.ts` files (e.g. `priceDataAdapter.ts`, `dailyBudgetSettingsAdapter.ts`, `deviceDiagnosticsStateAdapter.ts`) implement typed store ports declared in `lib/` domain modules on top of `homey.settings`. The port type lives in the domain; only the adapter here knows about Homey.
- **An adapter here is I/O only.** It translates between `homey.settings` and the typed port and returns; it remembers nothing between calls. A port's stateful half — a cache, a `dirty` flag, a load-phase classification, an abandon-grace window — lives WITH the port in `lib/`, because that state is the domain's and the grace policy is a domain rule (`notes/persisted-settings-state.md`). "Adapter" is not a licence to hold state; see § "No state".

## What does not belong here

- Domain logic, planning/price math, UI strings, or anything a `lib/` module could own. If logic is reusable, push it down into `lib/` or `packages/` and keep only the wiring here.
- **State.** See § "No state" above — the rule, the reason, and what is allowed instead.
