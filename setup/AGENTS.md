# Setup (App Wiring) Layer

- This folder is the wiring/adapter layer between the `app.ts` entry point and the `lib/` domain modules: factories, observers, registrars, and Homey-settings adapters that construct and connect services. Nothing here has reuse value outside this app; it lives at the entry layer on purpose.

## Conventions (authoritative)

- One purpose per file, named for the concrete wiring it does. No grab-bag `setupHelpers.ts`.
- Each file exposes a class or a single `register*` / `init*` / `create*` / `wire*` function — no bags of utility functions. **One carve-out:** the settings-UI/widget endpoint handler files (`settingsUiApi.ts`, `settingsUiHomesApi.ts`, `settingsUiStarvationRescueApi.ts`, `settingsUiSmartTaskApi.ts`) each export the handler set for ONE endpoint family, because `api.ts` imports handlers by name. The cohesion rule still binds: a new endpoint family gets a new file, never an extra export on an unrelated one. **Second carve-out:** a per-module structured-log vocabulary file (`homeRuntime/homeRuntimeRegistryLogs.ts`), which holds one module's event names, levels and `detail` wording in one place so log audits keyed on them have a single source — the `lib/plan/planLogging.ts` precedent. It exists for headroom on a hot file, not as a unit of responsibility; it may only hold emitters for its own module, and it is not a licence for a general logging grab-bag.
- `setup/**` may import `lib/**` and `packages/**`; the reverse is forbidden (`no-lib-to-setup` dep-cruiser rule, `npm run arch:check`). `setup/**` must not import `packages/settings-ui/**` either (`no-backend-to-settings-ui`).
- **An extracted body may re-assert a boot-window invariant by throwing, never by defaulting.** Six `AppContext` members are optional (`priceCoordinator`, `dailyBudgetService`, `deviceManager`, `planEngine`, `planService`, `deviceDiagnosticsService`) while `PelsApp` declares them definite, so a body moved out of `app.ts` behind `ctx: AppContext` inherits a nullability the original never had. `?.` or `?? someDefault` there silently converts a wiring bug into a plausible-looking value and violates the resolution-in-producer rule. Assert instead — `AppSmartTaskApi.requirePriceRateLabel` is the reference — or narrow the constructor to a `Pick<AppContext, …>` when every member you need is genuinely optional upstream too (`AppSmartTaskPayloads`).

## Boot path

- `app.ts` `onInit` imports `setup/appInit.ts` — a thin barrel over `setup/appInit/` (30 focused factory/registrar files: `createPlanEngine`, `createPlanService`, `priceServices`, `createDailyBudgetService`, `registerAppFlowCards`, `deferredRecorders`, …). Keep the barrel's export surface stable; add new boot wiring as a new `setup/appInit/` file.
- Load-bearing root files:
  - `appLifecycleHelpers.ts` — `runStartupStep` / `startAppServices`: ordered, traced startup sequencing.
  - `powerSamplePipeline.ts` — `PowerSamplePipeline`: routes power samples into capacity tracking and plan-rebuild scheduling.
  - `backgroundTasksController.ts` — `BackgroundTasksController`: owns periodic tasks (perf logging, price-lowest triggers, deferred-objective lifecycle clock).
  - `settingsRepository.ts` — `SettingsRepository`: typed reads of persisted Homey settings at boot.
  - `settingsUiApi.ts` — the handlers `api.ts` delegates to for the settings-UI bootstrap/read/refresh endpoints. Two endpoint families have their own root files `api.ts` imports directly: `settingsUiHomesApi.ts` (`ui_homes` + the `ui_homes_save` ownership-write seam) and `settingsUiStarvationRescueApi.ts` (the overview device-card budget-exempt rescue), alongside the existing `settingsUiSmartTaskApi.ts`.
  - `appSmartTaskApi.ts` / `appSmartTaskPayloads.ts` — the smart-task (deferred-objective) preview+write lanes and the read-only UI payload assembly. `app.ts` keeps thin delegating stubs because the widget host API and the settings-UI handlers reach them through `homey.app`.
  - `planRebuildIntentPolicy.ts` — `getAppPlanRebuildNowMs` plus the due-time/execution decisions `PlanRebuildScheduler` delegates back to the app.
  - `appSettingsHelpers.ts` — loads/normalizes capacity settings and reacts to settings changes.
  - `homeRuntime/` — per-home wiring (multi-home): the `HomeScope` closure bundle the plan factories consume, the pipeline factory, and the R7b capacity-only sub-home bundles (`homeRuntimeRegistry.ts` + `createHomeCapacityBundle.ts`, reconciled against `homes_config`; the main home never routes through the bundle factory).

## Adapter naming

- `*Adapter.ts` files (e.g. `priceDataAdapter.ts`, `dailyBudgetSettingsAdapter.ts`, `deviceDiagnosticsStateAdapter.ts`) implement typed store ports declared in `lib/` domain modules on top of `homey.settings`. The port type lives in the domain; only the adapter here knows about Homey.

## What does not belong here

- Domain logic, planning/price math, UI strings, or anything a `lib/` module could own. If logic is reusable, push it down into `lib/` or `packages/` and keep only the wiring here.
