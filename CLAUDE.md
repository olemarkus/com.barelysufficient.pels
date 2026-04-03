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
├── jest.config.cjs           # Jest config (80% coverage threshold)
├── eslint.config.mjs         # ESLint (strict, sonarjs, functional, unicorn)
├── .dependency-cruiser.cjs   # Enforced architecture boundary rules
├── .homeycompose/            # Source configs for app.json, capabilities, flows
├── lib/                      # Core runtime logic
├── packages/                 # npm workspaces: contracts, shared-domain, settings-ui
├── flowCards/                # Homey Flow card registrations
├── drivers/                  # pels_insights virtual device driver
├── widgets/                  # plan_budget widget
├── settings/                 # Generated settings UI bundle (do not edit directly)
├── test/                     # Jest test suites and mocks
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
App Wiring/Adapters   lib/app/**, flowCards/**
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
- Runtime backend (`app.ts`, `lib/**`, `flowCards/**`, `drivers/**`) must not import settings UI code.
- Settings UI must only consume shared contracts and shared-domain — never import runtime backend directly.
- Domain modules (`lib/core`, `lib/plan`, `lib/price`, `lib/dailyBudget`) must not import `lib/app/**`.
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
| `lib/app/` | Wiring layer: initializes services, registers flow cards, handles settings API |
| `lib/utils/` | Pure helpers, type guards, math utilities, debug logging, settings keys |
| `lib/diagnostics/` | Per-device diagnostics recording |
| `lib/logging/` | Structured logging infrastructure: pino logger, AsyncLocalStorage context, Homey destination |

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

```bash
npm run test:unit           # Fast Jest suite (no coverage, lighter config)
npm run test:unit:ci        # Full Jest suite with coverage
npm run test:unit:tz        # Timezone-sensitive tests
npm run test:ui             # Settings UI Jest tests
npm run test:e2e            # Playwright E2E (chromium + firefox mobile)
npm run ci:full             # Complete CI: checks + runtime + settings UI + Playwright
```

**Coverage threshold:** 80% across branches, functions, lines, statements. Collected from all `*.ts` files under `<rootDir>` (excluding `test/**`, `settings/**`, `packages/**`), which includes root entry points (`app.ts`, `api.ts`), `lib/**`, `flowCards/**`, and `drivers/**`.

**Testing rules:**
- Unit tests must have a narrow, specific purpose — avoid adding broad checks already covered by integration or regression tests.
- Use shared, type-safe mock helpers instead of ad-hoc `as any` casts so mocks stay in sync with the production API.

### Linting and Checks

```bash
npm run lint                # ESLint entire codebase (zero warnings)
npm run arch:check          # dependency-cruiser architecture boundaries
npm run deadcode:check      # Unused exports detection
npm run typecheck:unused    # TypeScript unused symbols check
npm run ci:checks           # Full static analysis suite (build + all lints + arch)
```

---

## Control Flow

1. **Measurement** — Power samples come from one of two modes: with `power_source = homey_energy`, the app polls Homey Energy every 10 seconds; with `power_source = flow`, samples are driven by incoming Flow events and may arrive at irregular intervals.
2. **Planning** — `PlanEngine` reads power, device states, and (optionally) prices → outputs a `DevicePlan` (shed / restore / keep per device).
3. **Execution** — `PlanExecutor` applies targets (setTemperature, on/off, stepped dimming).
4. **Reconciliation** — `DeviceManager` syncs Homey state back, detects external changes.
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

---

## CI/CD

GitHub Actions (`.github/workflows/test.yml`) runs on every push and PR:

1. **checks** — `npm run ci:checks` (build, all lints, architecture, dead code, typecheck).
2. **docs** — VitePress build validation.
3. **runtime-tests** — `npm run ci:test:runtime` (Jest + timezone tests).
4. **settings-ui-tests** — `npm run ci:test:settings-ui`.
5. **playwright** — E2E matrix (chromium mobile + firefox mobile).

`docs.yml` deploys docs to GitHub Pages at `pels.barelysufficient.org` on every push to `main`.

---

## Pull Request Guidelines

- Minimal changes: one issue/feature per PR.
- Squash to a single commit before submitting.
- Rebase off latest main before submitting.
- No whitespace-only reformatting.
- Tests must pass; add new tests for new logic.
- If `.homeycompose/` changed, include the regenerated `app.json`.
- To diff all changes on a branch with no common ancestor, use `git diff root^..localSha`.
