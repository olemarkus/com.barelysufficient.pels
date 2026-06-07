# CLAUDE.md — PELS Codebase Guide

PELS is a Homey Pro app that implements an hourly electricity capacity controller: it measures real-time power draw, compares it against a configurable capacity budget, and sheds/restores devices (EV chargers, thermostats, water heaters, etc.) to stay within the budget. Price awareness, daily soft budgets, and priority-based device swapping are layered on top.

---

## Repository Layout

```
/
├── app.ts                    # Homey app entry point
├── api.ts                    # REST API handlers for the settings UI
├── app.json                  # Auto-generated from .homeycompose — do not edit directly
├── package.json              # npm workspace root (Node 22, npm 10.9.4)
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
├── settings/                 # Generated settings UI bundle (do not edit directly)
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
App Wiring/Adapters   setup/**, lib/app/** (sunsetting), flowCards/**
      ↓
Domain Modules        lib/core/**, lib/plan/**, lib/price/**, lib/dailyBudget/**
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
- Domain modules (`lib/core`, `lib/plan`, `lib/price`, `lib/dailyBudget`) must not import `lib/app/**`.
- `setup/**` may import `lib/**` and `packages/**`; the reverse is forbidden by the `no-lib-to-setup` dep-cruiser rule.
- `flowCards/**` must not import `packages/settings-ui/**` or `drivers/**`.
- Accept code duplication if consolidation would violate an architectural boundary. Add a comment explaining the constraint.

**Known transitional allowance:** `lib/utils/**` still has some imports from `lib/core` and `lib/plan`. Tracked in `TODO.md`; do not expand.

---

## Key Modules

### Runtime (`lib/`)

| Module | Purpose |
|--------|---------|
| `lib/plan/` | Core planning engine: builds, executes, and reconciles device plans |
| `lib/core/` | Device state management, power tracking, capacity guard |
| `lib/price/` | Spot price fetching (Norwegian Nordpool), Homey Energy API integration, price levels |
| `lib/dailyBudget/` | Soft daily kWh budget constraints |
| `lib/app/` | Legacy wiring layer — sunsetting. New wiring goes in `setup/`; `lib/app/appContext.ts` (type definition) stays as the only long-term inhabitant. |
| `lib/utils/` | Pure helpers, type guards, math utilities, debug logging, settings keys |
| `lib/diagnostics/` | Per-device diagnostics recording |
| `lib/logging/` | Structured logging infrastructure: pino logger, AsyncLocalStorage context, Homey destination |

### App wiring (`setup/`)

`setup/` at the repo root is the honest home for app-wiring classes — factories, observers, registrars that construct and connect services. These have no reuse value outside this app, so they live at the entry layer rather than masquerading as library code.

Conventions (reviewed at PR time):
- **One purpose per file**, named for the concrete wiring it does. No grab-bag `setupHelpers.ts`.
- **Each file exposes a class or a single `register*` / `init*` function** — no bags of utility functions.
- **Files larger than ~150 LOC are considered fat-fingered** and should split.
- `setup/**` may import `lib/**` and `packages/**`; **never the reverse** (enforced by the `no-lib-to-setup` rule in `.dependency-cruiser.cjs`).

As remaining wiring migrates out of `lib/app/`, that directory sunsets; `lib/app/appContext.ts` (the shared `AppContext` type) stays.

### Packages (shared)

| Package | Purpose |
|---------|---------|
| `packages/contracts/src/` | Type contracts shared between runtime and settings UI |
| `packages/shared-domain/src/` | Browser-safe shared logic (price math, daily budget, utilities) |
| `packages/settings-ui/src/` | Imperative DOM/TypeScript settings UI — compiled to `settings/script.js` via esbuild |

---

## Development Workflows

### Build

```bash
npm run build               # Full build: tsc + settings UI + widgets + sanitize
npm run build:settings      # Build and sync settings UI only
npm run build:widgets       # Build widget bundles/assets
npm run watch:settings      # Live rebuild of settings UI
```

When `.homeycompose/` changes, run `homey app validate` — this regenerates root `app.json`. Commit the generated file.

### Running Locally

**Safe Homey CLI command:** `homey app validate`.
**Do not run** `homey app run`, `homey app install`, or `homey app publish` unless the user explicitly asks.

### Testing

Each runtime tier is its own fast lane with its own config (`vitest.config.{unit,integration,e2e,tz}.mts`); the lanes run in **parallel isolated forks** (no shared `maxWorkers: 1`). Coverage is collected once, across all tiers, by `vitest.config.mts`.

```bash
npm run test:unit           # unit tier only (test/unit/, fast, no coverage)
npm run test:integration    # integration tier only (test/integration/, fast)
npm run test:e2e:runtime    # runtime SDK-boundary e2e tier only (test/e2e/, fast, 30s timeout)
npm run test:unit:tz        # timezone-sensitive lane, across several TZ values
npm run test:coverage       # all runtime tiers in one instrumented pass + 80% gate
npm run test:unit:ci        # alias entry for the coverage lane
npm run test:ui             # Settings UI vitest tests
npm run test:e2e            # Settings-UI Playwright E2E (chromium + firefox mobile); alias: test:e2e:ui
npm run ci:full             # Complete CI: checks + runtime + settings UI + Playwright
```

**Test taxonomy.** Tests are classified into three tiers — **unit** (one pure function, no I/O), **integration** (one layer, only outward seams mocked via shared helpers), **e2e** (nothing internal mocked; driven through an external seam — Homey SDK for runtime e2e, the UI for Playwright e2e — and observed through that seam + structured logs, never parsed prose). Every spec lives in `test/unit/`, `test/integration/`, or `test/e2e/` (the flat `test/*.test.ts` files were fully migrated); shared mocks/helpers/setup stay at `test/` root. jsdom widget-render specs are unit-tier and self-declare their environment via a `// @vitest-environment jsdom` pragma. A new spec lands in its tier folder; bump import depth when moving one, then run `knip`. Full reference: `notes/testing-taxonomy.md`.

**Coverage threshold:** 80% across branches, functions, lines, statements, enforced by the `coverage` CI job (`npm run test:coverage`). Collected from `app.ts`, `api.ts`, `lib/**`, `flowCards/**`, and `drivers/**`.

**Testing rules:**
- Unit tests must have a narrow, specific purpose — avoid adding broad checks already covered by integration or regression tests.
- Use shared, type-safe mock helpers instead of ad-hoc `as any` casts so mocks stay in sync with the production API.
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

1. **Measurement** — Power samples come from one of two modes: with `power_source = homey_energy`, the app polls Homey Energy every 10 seconds; with `power_source = flow`, samples are driven by incoming Flow events and may arrive at irregular intervals.
2. **Planning** — `PlanEngine` reads power, device states, and (optionally) prices → outputs a `DevicePlan` (shed / restore / keep per device).
3. **Execution** — `PlanExecutor` applies targets (setTemperature, on/off, stepped dimming).
4. **Reconciliation** — `DeviceTransport` (`lib/device/deviceTransport.ts`) syncs Homey state back, detects external changes.
5. **Adjustment** — Next cycle adapts to actual measured results.

Key timing:
- Shed cooldown: 60 seconds minimum between shed operations.
- Restore cooldown: 60–300 seconds (exponential back-off per restore attempt).
- Account for DST transitions in daily bucket logic — days can be 23 or 25 hours.

---

## Important Files to Read Before Modifying

| Area | Read first |
|------|-----------|
| Snapshot/realtime merge logic | `notes/state-management/` |
| Capacity model internals | `docs/technical.md` |
| Daily budget logic | `docs/daily-budget.md` |
| Flow card design | `docs/flow-cards.md` |
| Architecture boundaries | `docs/architecture.md` |
| Open work and known issues | `TODO.md` |
| **UI labels, status strings, tab names** | `notes/ui-terminology.md` |
| **Overview hero design spec** | `notes/overview-hero-spec.md` |
| **Personas / who each surface serves** | `notes/personas.md` |

---

## CI/CD

GitHub Actions (`.github/workflows/test.yml`) runs on every push and PR:

1. **checks** — `npm run ci:checks` (all lints, architecture, dead code, typecheck) followed by `npm run build` and `npm run validate`.
2. **docs** — VitePress build validation.
3. **unit-tests** / **integration-tests** / **e2e-tests** — the three runtime tiers, each its own parallel job (`npm run test:unit` / `test:integration` / `test:e2e:runtime`).
4. **timezone-tests** — `npm run test:unit:tz`.
5. **coverage** — `npm run test:coverage` (all tiers in one instrumented pass, 80% gate).
6. **settings-ui-tests** — `npm run ci:test:settings-ui`.
7. **playwright** — E2E matrix (chromium mobile + firefox mobile).

`docs.yml` deploys docs to GitHub Pages at `pels.barelysufficient.org` on every push to `main`.

---

## Review Subagents

User-level review agents are available for fan-out checks before opening a non-trivial PR. They are read-only (no Edit/Write) and auto-approved. Use whichever match the diff surface; for sizeable PRs, dispatch the relevant ones in parallel alongside the `adversarial-review` skill.

| Agent | Trigger surface |
|-------|-----------------|
| `pels-layering-guardian` | `lib/core/**`, `lib/plan/**`, `lib/price/**`, `lib/dailyBudget/**`, `lib/app/**`, `lib/utils/**`, `flowCards/**`, `drivers/**`, `packages/shared-domain/**` |
| `pels-m3-critic` | `packages/settings-ui/**`, any `*Chart*.ts` |
| `pels-ux-fit` | non-trivial view changes in `packages/settings-ui/src/ui/views/**` |
| `pels-copy-and-terminology` | `packages/settings-ui/**`, `packages/shared-domain/**` (UI strings, status labels, tooltips, copy helpers) |
| `pels-runtime-reality` | `lib/plan/**`, `lib/core/**`, `lib/dailyBudget/**`, `lib/price/**`, `drivers/**`, persisted-state handling |

Findings come back classified P0/P1/P2 — P0/P1 fix in the same PR; P2/P3 to `TODO.md`.

---

## Pull Request Guidelines

- Minimal changes: one issue/feature per PR.
- Squash to a single commit before submitting.
- Rebase off latest main before submitting.
- No whitespace-only reformatting.
- Tests must pass; add new tests for new logic.
- If `.homeycompose/` changed, include the regenerated `app.json`.
- To diff all changes on a branch with no common ancestor, use `git diff root^..localSha`.
