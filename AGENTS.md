# PELS — Agent Guide

PELS is a Homey Pro app that implements an hourly electricity capacity controller: it measures real-time power draw, compares it against a configurable capacity budget, and sheds/restores devices (EV chargers, thermostats, water heaters, etc.) to stay within the budget. Price awareness, daily soft budgets, and priority-based device swapping are layered on top.

This file is the canonical agent guide. `CLAUDE.md` files in this repo are one-line import stubs that make Claude Code load the sibling `AGENTS.md`; put new guidance here (or in the per-directory `AGENTS.md` files), never in a stub.

---

## Repository Layout

```
/
├── app.ts                    # Homey app entry point
├── api.ts                    # REST API handlers for the settings UI
├── app.json                  # Auto-generated from .homeycompose — do not edit directly
├── package.json              # npm workspace root (Node 22, npm 12)
├── vitest.config.*.mts       # vitest configs (80% coverage threshold)
├── eslint.config.mjs         # ESLint (strict, sonarjs, functional, unicorn)
├── .dependency-cruiser.cjs   # Enforced architecture boundary rules
├── .homeycompose/            # Source configs for app.json, capabilities, flows
├── lib/                      # Core runtime logic
├── setup/                    # App-wiring classes (factories, observers, registrars)
├── packages/                 # npm workspaces: contracts, shared-domain, settings-ui
├── flowCards/                # Homey Flow card registrations
├── drivers/                  # pels_insights virtual device driver
├── widgets/                  # plan_budget widget
├── settings/                 # Generated settings UI bundle — build output, not in git
├── test/                     # vitest test suites and mocks
├── docs/                     # VitePress documentation site
├── notes/                    # Internal engineering notes (invariants, design constraints)
└── .github/workflows/        # CI/CD pipelines
```

---

## Architecture

The codebase is strictly layered. `dependency-cruiser` enforces the rules at `npm run arch:check`.

```
Entry Points          app.ts, drivers/**, packages/settings-ui/src/script.ts
      ↓
App Wiring (stateless) setup/**, flowCards/**
      ↓
Domain Modules        lib/plan/**, lib/device/**, lib/observer/**, lib/executor/**, lib/objectives/**, lib/power/**, lib/price/**, lib/dailyBudget/**
      ↓
Shared Utilities      lib/utils/**, packages/contracts/src/**, packages/shared-domain/src/**
      ↓
Test Code             test/**, packages/settings-ui/test/**, packages/settings-ui/tests/**
```

**Hard rules (enforced):**
- No circular dependencies.
- Runtime code must not import test code.
- Runtime backend (`app.ts`, `lib/**`, `setup/**`, `flowCards/**`, `drivers/**`) must not import settings UI code.
- Settings UI must only consume shared contracts and shared-domain — never import runtime backend directly.
- Domain modules (`lib/device`, `lib/power`, `lib/objectives`, `lib/plan`, `lib/price`, `lib/dailyBudget`, `lib/observer`, `lib/executor`, `lib/actuator`) must not import `lib/app/**` (`no-domain-to-app-layer`).
- `setup/**` may import `lib/**` and `packages/**`; the reverse is forbidden by the `no-lib-to-setup` dep-cruiser rule.
- **The wiring layer holds no state.** `setup/**` gets no mutable field, no module-level `let` or `var`, no field holding a mutable container. It constructs and connects; anything that changes as the app runs is a component owned by a `lib/` module. State in the wiring layer sits above these boundaries, so it becomes a back-channel between modules forbidden to talk with no import edge for `arch:check` to see. Enforced by `npm run setup:stateless`; the shrinking allowlist of files predating the rule is `scripts/setup-stateless-allowlist.txt`. Full rule: `setup/AGENTS.md` § "No state".
- `flowCards/**` must not import `packages/settings-ui/**` or `drivers/**`.
- Accept code duplication if consolidation would violate an architectural boundary. Add a comment explaining the constraint.
- **A parameter object must be a domain object.** If a function takes an object, that object
  names a concept the model already holds and passes — not a bag assembled to shorten an argument
  list. An inline object-literal parameter type with 3+ properties is the bag's signature: it has
  no name, nothing else can hold it, and its first act is to destructure itself back into loose
  values. Enforced by `npm run params:no-bundles`, which parses the TypeScript AST so no layout
  evades it; the shrinking allowlist of files predating the rule is
  `scripts/param-bundle-allowlist.txt` (regenerate with `--seed`, never by hand), and its
  per-file counts may only go down. The
  inverse costs as much and no script can see it: taking a domain object you already hold and
  exploding it into loose scalars downstream, or narrowing it into a per-callee `Pick<>`. When you
  hold the object, pass the object. Full rule: the header of `scripts/check-param-bundles.mjs`.

**Known transitional allowance:** `lib/utils/**` still has two imports from `lib/power` and `lib/plan` (`todo-tighten-utils-layering`, registered at warn severity in `.dependency-cruiser.cjs` — that rule is the tracking, there is no `TODO.md` entry). Both are type-only: `appTypeGuards.ts` → `PowerTrackerState`, `capacityHelpers.ts` → `ShedAction`/`ShedBehavior`. The `lib/device` edge is gone, and so is the last value import — `settingsHandlers.ts` → `CapacityGuard` went with the guard's settings mirror, since the capacity scalars now have one owner and nothing copies them. Do not expand the set.

**Clean and trusted interfaces between layers (convention, not cruiser-enforced):**

One rule, two faces (`docs/architecture.md` § "Clean and trusted interfaces between layers"): the side emitting a value across any layer boundary resolves and validates it first (*clean*); the side consuming it reads it directly, without defending (*trusted*). Trust is scoped to in-process handoffs — a value re-entering through an untrusted transport (network fetch, the Homey API bridge into the WebView, a persisted blob) is validated once by the receiving adapter, then trusted inward of that seam. Older comments cite the faces under their former names — "Validation belongs at the boundary" (clean, at the external-input edge) and "Resolution belongs in the producer" (trusted) — both mean this rule.

- Every external/outer layer — Homey SDK reads, network fetches, the settings/persisted store, flow-card args, inbound API bodies, the clock — must validate and discriminate untrusted input into a strongly-typed, resolved value *before* handing it to an adjacent layer. Finiteness-gate numbers (`Number.isFinite`) and shape-guard objects. Use flat `null`/`undefined` only for genuine domain absence; API/settings absence, malformed data, or read failure must become an explicit semantic result rather than a nullable business value. Never let a raw `NaN`/`Infinity`/malformed/partial value flow inward into a sum, comparison, persisted write, or control decision.
- Adapters that read Homey/API/settings data own the complete classification of `undefined`, `null`, empty key lists, malformed values, and thrown errors. They must expose a typed semantic result (for example, `resolved | unavailable`) to adjacent layers; downstream domain/control code must not catch adapter exceptions, inspect SDK absence/error provenance, or reinterpret an unavailable read as a default. Tests for SDK weirdness belong at the adapter boundary; business tests inject semantic states.
- Downstream layers may then assume the typed invariant holds; they must not re-validate or branch on the input's source/provenance. A hedging consumer (re-checked finiteness, presence-sniffing, a kept fallback derivation) is a symptom — fix the unclean interface upstream, not the hedge.
- A transient external failure is a **no-op**, not an event. The default treatment is to decide nothing and carry the last good value forward: a missing power sample keeps the last one, a missing device read keeps the last observation. What must never happen is fabricating a stand-in — an absent reading is not `0`, and reading it as one hands control a value more favourable than anything ever measured. The narrow case the abandon-grace exists for is *loading* persisted state: one corrupt or empty SDK read on startup must not wipe persisted history, so the persistence wrappers hold a grace window before abandoning it (`notes/persisted-settings-state.md`, `feedback_homey_sdk_unreliable`).
- Do not read the grace window as a licence to invent a third policy for live in-memory progress. Expiring, resetting, or re-earning a running timer because one read went missing is itself a destructive treatment of a transient gap, and it is usually worse than the no-op: on an irregular feed (`power_source = flow`, where a gap between events is ordinary cadence) a per-miss reset can mean the condition never completes at all.
- Reference implementations: `lib/device/transport/managerFreshness.ts` (drops a non-finite realtime event — no write, no freshness bump) and `lib/device/managerEnergy.ts` (`asRecord` + `toFiniteNumber` resolve an untrusted live report to `null` on junk).

---

## Key Modules

### Runtime (`lib/`)

| Module | Purpose |
|--------|---------|
| `lib/plan/` | Core planning engine: builds device plans and owns when to rebuild. Does not judge drift — see `lib/plan/AGENTS.md` for the one question it does ask |
| `lib/device/` | Observed device state and actuation transport (`DeviceTransport`) |
| `lib/observer/` | Observation freshness/trust, idle classification, pending binary commands |
| `lib/executor/` | Executes desired-state transitions (pending/retry/materialization) |
| `lib/objectives/` | Learned energy-rate profiles + deferred-objective (smart-task) stack |
| `lib/power/` | Power sampling and capacity tracking |
| `lib/price/` | Spot price fetching (Norwegian Nordpool), Homey Energy API integration, price levels |
| `lib/dailyBudget/` | Soft daily kWh budget constraints |
| `lib/app/` | Dissolved. Holds only `appContext.ts` (the shared `AppContext` type). Wiring lives in `setup/` (and Flow-card registration in `flowCards/`); nothing new belongs here. |
| `lib/utils/` | Pure helpers, type guards, math utilities, debug logging, settings keys |
| `lib/diagnostics/` | Per-device diagnostics recording |
| `lib/logging/` | Structured logging infrastructure: pino logger, AsyncLocalStorage context, Homey destination |

Runtime code conventions (TypeScript, structured logging, Homey SDK mocking) live in `lib/AGENTS.md`.

### App wiring (`setup/`)

`setup/` at the repo root is the honest home for app-wiring classes — factories, observers, registrars that construct and connect services, and then hold nothing. Conventions and the boot-path map live in `setup/AGENTS.md`. The migration out of `lib/app/` is complete: that directory is down to `appContext.ts` (the shared `AppContext` type).

### Packages (shared)

| Package | Purpose |
|---------|---------|
| `packages/contracts/src/` | Type contracts shared between runtime and settings UI |
| `packages/shared-domain/src/` | Browser-safe shared logic (price math, daily budget, utilities) |
| `packages/settings-ui/src/` | Settings UI source — compiled to the generated `settings/` bundle via esbuild (`npm run build:settings`) |

For settings-only work, start from `packages/settings-ui` and stay out of `app.ts`, `drivers/`, `flowCards/`, and `lib/` unless a missing contract blocks the task. For Settings UI Material Design work, use `@material/web` components when a matching component exists and fits the semantics. If Material Web is not a fit, reuse or create a shared PELS primitive built on the existing design tokens; do not add page-local custom chips, cards, buttons, or segmented controls.

---

## Development Workflows

### Build

```bash
npm run build               # Full build: tsc + settings UI + widgets + sanitize
npm run build:settings      # Build and sync settings UI only (syncs generated assets into settings/)
npm run build:widgets       # Build widget bundles/assets
npm run watch:settings      # Live rebuild of settings UI
```

When `.homeycompose/` changes, run `homey app validate` — this regenerates root `app.json`. Commit the generated file.

### Running Locally

**The only safe Homey CLI command is `homey app validate`.**
**Do not run** `homey app run`, `homey app install`, `homey app publish`, or any other Homey CLI command unless the user explicitly asks.

### Testing

Each runtime tier is its own fast lane with its own config (`vitest.config.{unit,integration,e2e,tz}.mts`); the lanes use isolated forks bounded to two local workers. Coverage is collected once, across all tiers, by `vitest.config.mts`.

```bash
npm run test:unit           # unit tier only (test/unit/, fast, no coverage)
npm run test:integration    # integration tier only (test/integration/, fast)
npm run test:e2e:runtime    # runtime SDK-boundary e2e tier only (test/e2e/, fast, 30s timeout)
npm run test:unit:tz        # timezone-sensitive lane, across several TZ values
npm run test:coverage       # all runtime tiers in one instrumented pass + 80% gate
npm run test:unit:ci        # alias entry for the coverage lane
npm run test:ui             # Settings UI vitest tests
npm run test:e2e            # Settings-UI Playwright E2E (chromium + firefox mobile); alias: test:e2e:ui
npm run test:e2e:capture    # Explicit local screenshot/documentation capture harnesses
npm run ci:full             # Complete CI: checks + runtime + settings UI + Playwright
```

**Shared-machine resource safety.** Test entrypoints and test-only Git-hook
phases coordinate through one per-user Linux `flock` across every PELS
worktree. Builds, static checks, Homey validation/deploy commands, and non-test
hook phases do not acquire the lock. Do not bypass the npm scripts with raw
`npx vitest` or `playwright` commands. Vitest and local Playwright accept only
one or two workers through
`PELS_TEST_WORKERS` and `PELS_PLAYWRIGHT_WORKERS`; two is the default. In a
multi-agent session, the lead agent owns broad validation. Review agents run
read-only analysis or request a targeted run from the lead instead of launching
the full suite independently. Non-Linux hosts retain the worker caps but cannot
coordinate across worktrees because `flock` is unavailable.

**Test taxonomy.** Tests are classified into three tiers — **unit** (one pure function, no I/O), **integration** (one layer, only outward seams mocked via shared helpers), **e2e** (nothing internal mocked; driven through an external seam — Homey SDK for runtime e2e, the UI for Playwright e2e — and observed through that seam + structured logs, never parsed prose). Every spec lives in `test/unit/`, `test/integration/`, or `test/e2e/`; shared mocks/helpers/setup stay at `test/` root. jsdom widget-render specs are unit-tier and self-declare their environment via a `// @vitest-environment jsdom` pragma. Before adding or moving a test, read `notes/testing-taxonomy.md` (and `test/AGENTS.md` for the short rules); bump import depth when moving a spec, then run `knip`.

**Coverage threshold:** 80% across branches, functions, lines, statements, enforced by the `coverage` CI job (`npm run test:coverage`). Collected from `app.ts`, `api.ts`, `lib/**`, `setup/**`, `flowCards/**`, and `drivers/**`.

**Testing rules:**
- **Run targeted tests while developing; let the hooks run the suites.** While working on a change, run the specific specs for the code under development (e.g. `npm run test:unit -- test/unit/foo.test.ts`). Never run partial or full suites as a pre-commit/pre-push verification step — the pre-push hook (`scripts/pre-push-checks.mjs`) already runs change-aware runtime, timezone, and settings-UI lanes on every push, and CI runs the full set. A manual suite run right before push duplicates that work and contends for the shared per-user test `flock`.
- Unit tests must have a narrow, specific purpose — avoid adding broad checks already covered by integration or regression tests.
- Use shared, type-safe mock helpers instead of ad-hoc `as any` casts so mocks stay in sync with the production API — `@typescript-eslint/no-explicit-any` is an **error in every test tier**, runtime and settings-UI alike. For a deliberate partial stub, widen through `partialDouble` (`test/helpers/partialDouble.ts`); for a private member, use typed element access (`app['planEngine']`) so a production rename still breaks the spec. Runtime tests use the mock SDK in `test/mocks/homey.ts`; if a runtime change uses a new Homey SDK API, update that mock.
- **Deferred-objective / planner e2e simulate only the Homey SDK boundary** (device temperature/SoC, prices, clock) and drive the real bridge + recorder + admission — never mock PELS internals like `aheadOfHourMilestone` or the fresh/frozen dispatch. Mocking those confirms your assumptions instead of the system's behaviour (it once turned a non-existent cold-start "catastrophe" into a phantom P0). See `lib/objectives/deferredObjectives/AGENTS.md` and `test/e2e/deferredObjectiveColdStartSdkE2E.test.ts`.

### Linting and Checks

```bash
npm run lint                # ESLint entire codebase (zero warnings)
npm run arch:check          # dependency-cruiser architecture boundaries
npm run deadcode:check      # Unused exports detection
npm run typecheck:unused    # TypeScript unused symbols check
npm run ci:checks           # Full static analysis suite (all lints + typecheck + arch + deadcode), runs steps in parallel
```

---

## Control Flow

1. **Measurement** — Power samples come from one of two modes: with `power_source = homey_energy`, the app polls Homey Energy every 10 seconds; with `power_source = flow`, samples are driven by incoming Flow events and may arrive at irregular intervals. `DeviceTransport` (`lib/device/deviceTransport.ts`) observes device state alongside it, and publishes a control-relevant change as a fact (`observedControlStateChanged`) — never as an instruction to the planner.
2. **Planning** — `PlanEngine` reads power, device states, and (optionally) prices → outputs a `DevicePlan` (shed / restore / keep per device). **A whole-home meter reading is what triggers a rebuild.** An observed device change is an ordinary input to that rebuild, not a trigger for one: the decision is a capacity decision, and a rebuild driven by a device event would run against a reading taken before the change. The reading that does see it arrives on its own cadence: every 10 s under `power_source = homey_energy`, and under `flow` whenever the owner's Flow fires, with the freshness clock re-requesting a rebuild every 10 s for as long as the last sample is still fresh. **A whole-home meter is a requirement, not a nicety.** Between the freshness threshold and the shed timeout an absent reading is a no-op — the last good reading carries forward and nothing re-plans merely because a sample got old. At the shed timeout (10 minutes with no reading) every home escalates **once**, for both sources: the planner runs one fail-closed pass and sheds rather than holding an "under cap" decision taken before the meter died, and the composed plan-build gate then blocks every further rebuild until an admitted sample returns (`setup/powerSampleFreshnessEscalation.ts`, `lib/power/meterSilence.ts`). That escalation needs its own clock precisely because a reading is the primary trigger: when the meter is what died, nothing else is guaranteed to fire. Staleness itself is a UI-only fact (the no-readings banner); the planner never sees a freshness label, only its single gate boolean and kW. The full set of triggers is `PLAN_REBUILD_TRIGGERS` (`lib/plan/planRebuildTrigger.ts`); the file lists them and says why an observation is not among them. A realtime EV state-of-charge report is an observation too — it no longer rebuilds, so an EV-boost threshold crossing is acted on at the next reading rather than on the report.
3. **Execution** — `PlanExecutor` converges observed state onto the plan's desired state: it applies targets (setTemperature, on/off, stepped dimming) whenever the two disagree. There is one actuation path — no privileged mode that re-applies a committed plan without re-deciding it.
4. **Adjustment** — Next cycle adapts to actual measured results.

**There is no separate reconciliation phase.** There used to be: a device whose observed state changed was compared against the committed plan and that plan was re-applied. A plan built before the observation has not been decided against it, and re-applying one caused a hard-cap breach in production (`TODO.md`, inc_26449fb9 — the re-assert beat the re-decide by 281 ms and wrote a step-up its own admission gate would have rejected). Drift is just a changed input: the planner may decide to put the device back, *or* to leave it where it landed and shed something else. Do not reintroduce an apply-without-decide path.

**A device observation may un-suppress a rebuild; it may not trigger one.** Two throttles skip rebuilds that provably cannot change anything — the unactionable throttle and the tight-noop backoff — and both derive that verdict from the device set as it was. A device that just turned on invalidates it, so an observed control-state change clears those suppressions (`invalidateRebuildSuppressionForObservation`). That changes *whether* the next reading decides, never *what* it decides from, so both honest answers stay available: the reading the planner then sees includes the drifted device, and it may put it back or leave it and shed something else. What it never does is re-apply a plan built before the observation.

Key timing:
- Shed cooldown: 60 seconds minimum between shed operations.
- Restore cooldown: 60–300 seconds (exponential back-off per restore attempt).
- Account for DST transitions in daily bucket logic — days can be 23 or 25 hours.

---

## Important Files to Read Before Modifying

| Area | Read first |
|------|-----------|
| Snapshot/realtime merge logic, device state trust | `lib/device/AGENTS.md` (invariants digest), `notes/state-management/` (design-of-record) |
| Starvation detection | `lib/diagnostics/AGENTS.md` (invariants digest), `notes/starvation/` |
| Capacity model internals | `docs/technical.md` |
| Safe pace (cap vs daily budget), budget exemption | `notes/safe-pace-two-constraints.md` |
| **Who owns a thermostat's setpoint, and what it restores to** | `notes/temperature-ownership.md` |
| **Reading or writing a persisted settings key** | `notes/settings-key-ownership.md` |
| Daily budget logic | `docs/daily-budget.md` |
| Flow card design | `docs/flow-cards.md` |
| EV car ↔ charger link probe | `notes/ev-car-link/README.md` |
| Architecture boundaries | `docs/architecture.md` |
| Open work and known issues | `TODO.md` |
| **UI labels, status strings, tab names** | `notes/ui-terminology.md` |
| **Overview hero design spec** | `notes/overview-hero-spec.md` |
| **Personas / who each surface serves** | `notes/personas.md` |

Structured logging is canonical for new runtime logs (pino, `lib/logging/`); the rules live in `lib/AGENTS.md`.

---

## Per-directory agent docs

Module-scoped rules live in nested `AGENTS.md` files. Read the ones covering the directories your change touches:

| File | Scope |
|------|-------|
| `lib/AGENTS.md` | Runtime layer boundaries + TypeScript/logging/Homey-SDK conventions |
| `lib/plan/AGENTS.md` | Planner orientation map + boundaries |
| `lib/plan/shedding/AGENTS.md` | Shed-selection ownership |
| `lib/device/AGENTS.md` | Device transport orientation + device-state invariants digest |
| `lib/observer/AGENTS.md` | Observation freshness/trust orientation + quiescence rules |
| `lib/diagnostics/AGENTS.md` | Diagnostics orientation + starvation invariants digest |
| `lib/executor/AGENTS.md` | Executor-layer rules |
| `lib/planContract/AGENTS.md` | Contract purity rules |
| `lib/objectives/AGENTS.md` | Objectives orientation |
| `lib/objectives/deferredObjectives/AGENTS.md` | Two-clock design + e2e rules for smart tasks |
| `lib/price/AGENTS.md` | Price module orientation |
| `drivers/pels_insights/AGENTS.md` | Insights driver: capability declarations are an app-wide compatibility floor |
| `lib/dailyBudget/AGENTS.md` | Daily budget orientation |
| `setup/AGENTS.md` | App-wiring conventions + boot-path map |
| `test/AGENTS.md` | Test tier classification + placement |
| `notes/AGENTS.md` | Notes-layer conventions |
| `packages/settings-ui/AGENTS.md` | Settings UI package scope |
| `packages/settings-ui/src/ui/views/AGENTS.md` | View-layer (Preact) rules |

Each has a sibling one-line `CLAUDE.md` stub (`@AGENTS.md`) so Claude Code auto-loads it on file-touch; other agents should follow this table.

---

## CI/CD

GitHub Actions (`.github/workflows/test.yml`) runs on every push and PR:

1. **checks** — `npm run ci:checks` (all lints, architecture, dead code, typecheck) followed by `npm run build` and `npm run validate`.
2. **docs** — VitePress build validation.
3. **coverage** — `npm run test:coverage` executes all runtime tiers once in one instrumented pass (80% gate); legacy tier check names mirror this result until branch protection is migrated.
4. **timezone-tests** — `npm run test:unit:tz`.
5. **settings-ui-tests** — `npm run ci:test:settings-ui`.
6. **playwright** — full Chromium mobile coverage plus change-aware Firefox and narrow-layout smoke lanes; main runs every browser lane in full.

`docs.yml` deploys docs to GitHub Pages at `pels.barelysufficient.org` on every push to `main`.

---

## Review Lenses

Repo-specific review lenses exist for fan-out checks before opening a non-trivial PR — available as Claude Code subagents and as Codex skills under the same names. They are read-only and auto-approved. Use whichever match the diff surface; for sizeable PRs, dispatch the relevant ones in parallel alongside the `adversarial-review` skill.

| Lens | Trigger surface |
|-------|-----------------|
| `pels-layering-guardian` | `lib/plan/**`, `lib/device/**`, `lib/observer/**`, `lib/power/**`, `lib/price/**`, `lib/dailyBudget/**`, `lib/app/**`, `lib/utils/**`, `flowCards/**`, `drivers/**`, `packages/shared-domain/**` |
| `pels-m3-critic` | `packages/settings-ui/**`, any `*Chart*.ts` |
| `pels-ux-fit` | non-trivial view changes in `packages/settings-ui/src/ui/views/**` |
| `pels-copy-and-terminology` | `packages/settings-ui/**`, `packages/shared-domain/**` (UI strings, status labels, tooltips, copy helpers) |
| `pels-runtime-reality` | `lib/plan/**`, `lib/device/**`, `lib/power/**`, `lib/dailyBudget/**`, `lib/price/**`, `drivers/**`, persisted-state handling |

Findings come back classified P0/P1/P2 — P0/P1 fix in the same PR; P2/P3 to `TODO.md`.

A finding only earns a `TODO.md` entry if it clears the **Entry Bar** in that file's header: it
names where the defect is, what change closes it, and how you would know it is done. A finding that
cannot say all three is not a backlog item — fix it now, settle the question, or drop it. A durable
constraint (rather than a change someone will make) belongs in the governing `AGENTS.md` or the code
it constrains.

---

## Pull Request Guidelines

- Minimal changes: one issue/feature per PR.
- Squash to a single commit before submitting.
- Rebase off latest main before submitting.
- No whitespace-only reformatting.
- Tests must pass; add new tests for new logic.
- If `.homeycompose/` changed, include the regenerated `app.json`.
- To diff all changes on a branch with no common ancestor, use `git diff root^..localSha`.

---

## UI terminology (short rules)

**Before writing any UI label, status string, tab name, help text, or doc:** read `notes/ui-terminology.md`. It defines the canonical user-facing vocabulary for all of PELS. Say what happens, not what the planner does internally.

**Change these** — they are jargon:

| Avoid | Use instead |
|---|---|
| shed | limited / paused / lowered / turned off |
| restore | resume |
| headroom | available power |
| controlled/uncontrolled load | managed / background usage |
| soft margin | safety margin |

**Leave these alone** — they are established with users:

`budget`, `daily budget`, `capacity` (in settings context), `managed`, `priority`, `mode`

**Do NOT rename internal code identifiers, test fixtures, or log strings** — only user-visible text changes.

### Hero bar labels

| Concept | Label |
|---|---|
| Current instantaneous draw | Power now |
| Dynamic kW threshold (any source) | Safe pace now |
| Fixed user-configured ceiling | Hard cap |
| kWh used so far this hour | Energy used this hour |
| kWh allowed for this hour | Budget this hour |
| Projected end-of-hour kWh | Projected this hour |

The "Safe pace now" tick uses a single label regardless of whether the binding constraint is capacity-based or daily-budget-based. The Power-now **subline** names the source in visible text (`Safe pace now 1.9 kW · set by today's budget`) — device cards no longer repeat the binding ceiling, so the hero is the only place the owner reads it, and a hover tooltip is unreachable in the touch WebView.

### Device card reason lines

A device card's one reason line says **what that device needs**, never which ceiling limits the house (the hero states that once). Held-on-power cards read `Waiting to resume — 0.8 kW more needed`, and once the hold has run long enough to count as held back, `Held 2 h — 0.8 kW more needed` — the elapsed time is the device's own fact, and the only one that explains why that card carries `Let it run now` and its neighbours do not. Holds that power cannot lift (smart task, solar surplus, external off, stepped fairness, countdowns, **and a spent hourly budget**) keep their own cause — that cause is the only honest thing left to say, and for the spent-hour hold it is necessarily an hour-level fact, because no amount of freed power admits the device. Source of truth: `resolveHeldCardReasonLine` in `packages/shared-domain/src/planCardReasonLine.ts`, shared by all three card variants. Full ladder and the retired-strings list: `notes/ui-terminology.md` § "Device cards say what a device needs".

### Chips vs reason lines

Chips stay short — canonical chip labels like `Limited`, `Resuming`, `Above safe pace` (see `notes/ui-terminology.md` for the full set).
Reason lines (below chip or in tooltip) may be a short sentence: `Waiting to resume — 0.8 kW more needed`, `Held 2 h — 0.8 kW more needed`.
Do not put sentences in chips.

### Terms that stay internal (do not surface in normal UI)

`shed`, `restore`, `headroom`, `headroom cooldown`, `swap`, `shortfall`, `backoff`, `invariant`, `soft limit`, `controlled`, `uncontrolled`

---

## Out-of-scope review topics

Automated reviewers (Codex, Copilot, Gemini Code Assist) must not comment on:

- ARIA attributes, roles, or landmarks
- Screen-reader support and other assistive-technology-specific behaviors

**Reason:** the user-facing UI runs only inside Homey's WebView, which does not expose accessibility APIs to assistive technologies. Comments targeting those APIs are not actionable here. Sighted-user concerns — semantic HTML element choice, color contrast, and keyboard navigation — remain in scope and welcome.
