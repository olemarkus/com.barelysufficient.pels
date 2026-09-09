# Setup (App Wiring) Layer

- This folder **constructs and connects**. It does not run, and it does not remember. Factories, observers and registrars live here; a file here builds something and hands it over. Nothing here has reuse value outside this app; it lives at the entry layer on purpose.

## No domain logic (authoritative)

- **`setup/` wires. It decides nothing.** A file here constructs components, hands them their collaborators, and connects callbacks and subscriptions — that is the whole of it. It holds no state (§ "No state"), it declares no data structures, and it does no parsing, normalizing, validating, classifying, projecting, or arithmetic over domain values. If a line here answers a question about power, devices, prices, budgets, homes or plans, it is in the wrong file.
  - **Why. It is the same argument as § "No state", and it is no weaker for logic.** Logic in the wiring layer is logic with no owner. It sits ABOVE the boundaries `.dependency-cruiser.cjs` enforces, so it couples modules the nine `no-<domain>-to-peer` rules (plus `no-plan-to-device` and `no-plan-to-executor`) forbid to talk — with no import edge to show for it, so `arch:check` cannot see it. `setup/` may import every peer, so putting a thing here is always legal, and always-legal is not a reason. **A file that needs two domains at once is not cross-cutting code looking for a home; it is a concept nobody has named yet.** Name it and give it a module. The state rule's own worked example is what hoisting costs: `appDeviceControlHelpers.ts` drove executor state from inside the plan-input producer, so a command settled because the planner asked for its devices rather than because the executor observed materialization.
  - **Allowed:** `create*` / `wire*` / `register*` / `init*` functions whose body is construction and connection; a `Deps`/options type for such a function, which names this file's wiring signature rather than a domain concept; and handing an SDK handle to the module that will use it.
  - **`setup/` does not touch the SDK. It wires the SDK into modules.** It does not call `homey.settings.get()`, and it does not read a device, a Flow, a zone or the API. It passes the narrow structural port — `SettingsPort`, `FlowPort`, `ApiPort` in `lib/ports/homeyRuntime.ts` — to the `lib/` module that owns the concept, and that module does the read, the absence classification and the last-good policy. **`SettingsPort` exposes `get`/`set`/`unset` today, and not the `getKeys()` cross-check that § "Conventions" below requires to tell a never-written key from a transient miss.** The first reader that needs it adds `getKeys` to the canonical port and to its test doubles — never a second settings port, and never a cast around this one. The boundary still resolves the value before it travels inward (root `AGENTS.md` § "Clean and trusted interfaces between layers"); the boundary simply sits inside the owning module, where the port already keeps its stateful half.
  - **Not allowed, and each has a destination.** A domain service → its own `lib/` module, beside the port it implements. A projection or mapping between two domains' shapes → a neutral contract module; `lib/planContract/` is the built precedent, and its `AGENTS.md` already describes the pattern. A domain constant or vocabulary table → the module that owns the concept. A settings/SDK value classifier → the module that owns the key's meaning, reading through the `SettingsPort` this layer hands it. **Which module that is depends on who reads the key.** A key read by both the runtime and the settings UI puts its type and its read/write policy in `packages/shared-domain/src/settings/` — shared-domain is the lowest layer both may import, and one parser is what stops the two sides drifting into opposite policies for the same bytes (`notes/settings-key-ownership.md`, and `mode_device_targets` is the worked example of the drift). A runtime-only key belongs wholly to its `lib/` module. Transport and the meaning of absence stay with the reader either way, because only the runtime can cross-check `getKeys()`. This supersedes the older, hedged phrasing under § "What does not belong here"; there is no "if it is reusable" qualifier, because reuse was never the test.
  - **Two worked examples, both current.** `homeMembership.ts` is `HomeMembershipService implements HomeMembershipPort`: the port and the rule of record are 173 lines in `lib/home/membership.ts`, the service is 805 lines here, and the only thing keeping them apart is that the service also reads `lib/observer`. One concept, 83% of it outside its own module. `appInit/toPlanDevice.ts` is 771 lines and 12 `resolve*` functions mapping a snapshot device onto a plan device across observer, device and plan: that is the planner's input contract, the same shape as `lib/planContract/`, which was built for plan *decisions* and never extended to plan *inputs*.
  - **Baseline (characterised 2026-09-07 against `4d5a6488f`, `setup/` = 138 files, 24,687 lines, 282 KB of the 1.54 MB runtime bundle — 17.9% of it; the enforced counts below are re-seeded at 136 files as this guard merges).** 55 files / 14,256 lines (58%) import two or more peer domains; 62 files / 8,788 lines import one; only 21 files / 1,643 lines (7%) import none. Logic density — lines carrying arithmetic, a comparison, a ternary or a `map`/`filter`/`reduce`, over all lines — is 4% here against 4% in `lib/plan` and 5% in `lib/device`; by that measure this is not a wiring layer today. The exported verbs say the same: 54 `create*` and 6 `wire*`/`register*` against 26 `build*`, 25 `resolve*`, 3 `project*`, 3 `to*`, 2 `classify*`. **Two metrics, and both may only go down: files importing 2+ peer domains (55), and files importing from `'homey'` (33, against 2 that name a `lib/ports/homeyRuntime.ts` type instead).** A change that raises either is the violation, whatever else it does. `npm run setup:boundaries` enforces both against `scripts/setup-peer-allowlist.txt` and `scripts/setup-sdk-allowlist.txt`; the guard's header explains what each proxy can and cannot see.

## No state (authoritative)

- **`setup/` holds nothing.** No mutable field, no module-level `let` or `var`, and no field holding a mutable container (`new Map()`, `new Set()`, an array or object literal, a `create*Store()` result — `readonly` pins the reference, not the contents, and a bare declaration filled in the constructor is caught at the assignment). Anything that changes as the app runs is a **component**: it belongs to the domain module that owns the concept, and setup builds it and hands it the collaborators it needs.
  - **Why.** State in the wiring layer is state with no owner. It sits ABOVE the layer boundaries `.dependency-cruiser.cjs` enforces, so anything wired can reach it, and it becomes a channel between modules that are forbidden to talk — with no import edge to show for it, so `arch:check` cannot see it. `appDeviceControlHelpers.ts` is the worked example, and it is now closed. It used to HOLD the executor's stepped-command state (moved to `lib/executor/steppedCommandStore.ts`) and to DRIVE that state's lifecycle from inside `decorateSnapshotWithDeviceControl` — the plan-input producer — so a command settled because the planner asked for its devices rather than because the executor observed materialization. Settling now happens in `lib/executor/syncSteppedCommands.ts`, called where the binary axis's sweep is called. **The decorator is a pure projection: it resolves the device's ladder and writes it onto the device, and nothing else.** Keep it that way — a read of the plan input that mutates is how the commanded axis reached the planner with no import for `no-plan-to-executor` to object to, and it is why two sites (`appInit/wireHomeMembership.ts`, `appInit/createGenerationPollSource.ts`) once had to route around `latestTargetSnapshot`.
  - **Allowed:** `private readonly deps` and readonly constructor parameter properties — a reference to something someone else owns; a class property initialized with an arrow function (a method bound to its receiver, as the `homey.app` façades need); `abstract` property declarations on `appRuntimeApi.ts` / `appHostApi.ts`, which declare storage `PelsApp` provides rather than holding it; module consts typed `ReadonlySet`/`ReadonlyMap` or SCREAMING_SNAKE constant tables; and locals inside a function, which die with the call frame. These are allowances against *state*, not against domain knowledge: a `ReadonlySet` or SCREAMING_SNAKE table encoding a domain vocabulary (settings keys, mode names, thresholds, step grids) still fails § "No domain logic" and belongs to the module that owns the concept. What may stay is a table describing this file's own wiring.
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
  `readConfiguredPowerSource` (`powerSourceSettings.ts`) are the reference readers. They are reference for *what* a settings reader must classify, and § "No domain logic" does not weaken one word of it. Where the reader *lives* does move: a new one goes in the `lib/` module that owns the key and reads through a `SettingsPort` that `setup/` hands it. Nothing about the classification itself changes — and this passage travels with the readers when they go.
  Where `null` is itself a stored value, the read value cannot distinguish stored-null from a
  transient miss. The key list can prove only whether the key is written; a listed key plus a
  `null` value still needs producer-owned last-good state, a companion marker, or a bounded grace
  policy. (The Main meter's retired "Automatic" was the canonical case; `mainMeterSettings.ts`
  now reads every non-string as semantic `unavailable`. The boot-time sole-meter adoption
  (`lib/power/soleMeterAdoption.ts`, constructed and started by `soleMeterAdoption.ts` here) is
  the one runtime writer of that key, and it is bounded on purpose: it writes only when Homey
  lists exactly one id-bearing whole-home meter — in the live report and the device registry —
  on two reads 30 s apart, only through the save seam, never Flow, with no marker (the condition
  clears itself once a meter is stored), never over readings the tracker has ever admitted (read from the
  tracker store; a store that cannot be read decides nothing), and it parses no persisted key
  beyond the two the seam writes. Its predecessor keyed "fresh install" on the mere PRESENCE of
  `power_tracker_state` and lost to the tracker's first prune on every boot.
  Everything else is the owner's pick in Limits & safety.)
  `homeRuntime/homeOperatingMode.ts` has not had the same treatment: it still
  gates on `undefined` alone.
- **Configured meter ownership and sampled-meter provenance are different facts.** The
  `ui_homes_save` seam requires an explicit Main meter before any meter area can run and refuses
  the same explicit meter on both sides (there is no Automatic to switch back to).
  A valid current configuration therefore cannot assign an Annex/area meter to Main. The sampled
  fence in `homeMainMeterAuthority.ts` is defence for a different boundary: legacy or externally
  malformed persisted state, an in-flight sample while such state is repaired, a fresh restored
  sample whose meter identity did not survive restart, and transient adapter failures. Describe
  those states as **sample provenance being
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

## Adapter naming (superseded, migrating out)

- The `*Adapter.ts` pattern here — 10 files (`dailyBudgetSettingsAdapter.ts`, `capacitySettingsStoreAdapter.ts`, …) — predates § "No domain logic". Each implements a typed store port on top of `homey.settings`, which makes `setup/` the layer that reads the SDK: exactly what the rule says it must not be. **Do not add another.** A new store port is implemented in the `lib/` module that declares it, taking a `SettingsPort` from `lib/ports/homeyRuntime.ts`; `setup/` hands the port over and nothing else. The 32 `setup/` files importing from `'homey'` are the migration surface (40 before the price lane moved, 37 before the tracker and weather stores followed it, 34 before the diagnostics store did, 33 before the status left settings).
- **The invariant these files carry survives the move unchanged.** The I/O half remembers nothing between calls, and a port's stateful half — a cache, a `dirty` flag, a load-phase classification, an abandon-grace window — lives WITH the port in `lib/`, because that state is the domain's and the grace policy is a domain rule (`notes/persisted-settings-state.md`). "Adapter" is not a licence to hold state; see § "No state".

## What does not belong here

- **Domain logic.** See § "No domain logic" above — the rule, the reason, the allowed shapes, and where each disallowed shape goes. Vocabulary used in both the browser and Node belongs in `packages/shared-domain/**`; UI-only strings stay with their browser consumer, and runtime-only vocabulary stays with its owning `lib/` module.
- **State.** See § "No state" above — the rule, the reason, and what is allowed instead.
