# Setup (App Wiring) Layer

- This folder is the wiring/adapter layer between the `app.ts` entry point and the `lib/` domain modules: factories, observers, registrars, and Homey-settings adapters that construct and connect services. Nothing here has reuse value outside this app; it lives at the entry layer on purpose.

## Conventions (authoritative)

- One purpose per file, named for the concrete wiring it does. No grab-bag `setupHelpers.ts`.
- Each file exposes a class or a single `register*` / `init*` / `create*` function — no bags of utility functions.
- Files larger than ~150 LOC are considered fat-fingered and should split.
- `setup/**` may import `lib/**` and `packages/**`; the reverse is forbidden (`no-lib-to-setup` dep-cruiser rule, `npm run arch:check`).

## Boot path

- `app.ts` `onInit` imports `setup/appInit.ts` — a thin barrel over `setup/appInit/` (14 focused factory/registrar files: `createPlanEngine`, `createPlanService`, `priceServices`, `createDailyBudgetService`, `registerAppFlowCards`, `deferredRecorders`, …). Keep the barrel's export surface stable; add new boot wiring as a new `setup/appInit/` file.
- Load-bearing root files:
  - `appLifecycleHelpers.ts` — `runStartupStep` / `startAppServices`: ordered, traced startup sequencing.
  - `powerSamplePipeline.ts` — `PowerSamplePipeline`: routes power samples into capacity tracking and plan-rebuild scheduling.
  - `backgroundTasksController.ts` — `BackgroundTasksController`: owns periodic tasks (perf logging, price-lowest triggers, deferred-objective lifecycle clock).
  - `settingsRepository.ts` — `SettingsRepository`: typed reads of persisted Homey settings at boot.
  - `settingsUiApi.ts` — the handlers `api.ts` delegates to for every settings-UI endpoint.
  - `appSettingsHelpers.ts` — loads/normalizes capacity settings and reacts to settings changes.

## Adapter naming

- `*Adapter.ts` files (e.g. `priceDataAdapter.ts`, `dailyBudgetSettingsAdapter.ts`, `deviceDiagnosticsStateAdapter.ts`) implement typed store ports declared in `lib/` domain modules on top of `homey.settings`. The port type lives in the domain; only the adapter here knows about Homey.

## What does not belong here

- Domain logic, planning/price math, UI strings, or anything a `lib/` module could own. If logic is reusable, push it down into `lib/` or `packages/` and keep only the wiring here.
