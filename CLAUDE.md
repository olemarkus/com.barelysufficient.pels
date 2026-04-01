# CLAUDE.md — PELS Codebase Guide

PELS is a Homey Pro app that implements an hourly electricity capacity controller: it measures real-time power draw, compares it against a configurable capacity budget, and sheds/restores devices (EV chargers, thermostats, water heaters, etc.) to stay within the budget. Price awareness, daily soft budgets, and priority-based device swapping are layered on top.

---

## Repository Layout

```
/
├── app.ts                    # Homey app entry point (~1030 lines)
├── api.ts                    # REST API handlers for the settings UI
├── app.json                  # Auto-generated from .homeycompose — do not edit directly
├── package.json              # npm workspace root (Node 22, npm 10.9.4)
├── tsconfig.json             # TypeScript config (targets Node 22)
├── jest.config.cjs           # Jest config (80% coverage threshold)
├── eslint.config.mjs         # ESLint (strict, sonarjs, functional, unicorn)
├── .dependency-cruiser.cjs   # Enforced architecture boundary rules
├── .homeycompose/            # Source configs for app.json, capabilities, flows
├── lib/                      # Core runtime logic (~143 TypeScript files)
├── packages/                 # npm workspaces: contracts, shared-domain, settings-ui
├── flowCards/                # Homey Flow card registrations
├── drivers/                  # pels_insights virtual device driver
├── widgets/                  # plan_budget widget
├── settings/                 # Generated settings UI bundle (do not edit directly)
├── test/                     # Jest test suites and mocks
├── docs/                     # VitePress documentation site
├── scripts/                  # Build utilities
├── notes/                    # Internal engineering notes
└── .github/workflows/        # CI/CD pipelines
```

---

## Architecture

The codebase is strictly layered. `dependency-cruiser` enforces the rules at `npm run arch:check`.

```
Entry Points          app.ts, api.ts, drivers/**, packages/settings-ui/src/script.ts
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

**Known transitional allowance:** `lib/utils/**` still has some imports from `lib/core` and `lib/plan`. This is tracked in `TODO.md` and should not be expanded.

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

### Packages (shared)

| Package | Purpose |
|---------|---------|
| `packages/contracts/src/` | Type contracts shared between runtime and settings UI |
| `packages/shared-domain/src/` | Browser-safe shared logic (price math, daily budget, utilities) |
| `packages/settings-ui/src/` | React settings UI — compiled to `settings/script.js` via esbuild |

---

## Development Workflows

### Build

```bash
npm run build               # Full build: tsc + settings UI + widgets + sanitize
npm run build:settings      # Build and sync settings UI only
npm run build:widgets       # Build widget HTML
npm run watch:settings      # Live rebuild of settings UI
```

When `.homeycompose/` changes, run `homey app validate` — this regenerates root `app.json`. Commit the generated file.

### Running Locally

```bash
npm run start               # Build settings/widgets then `homey app run --remote`
npm run start:local         # Same but runs locally (not remote)
npm run validate            # homey app validate + packaging checks
```

**Safe Homey CLI commands:** `homey app validate`, `homey app run --remote`.
**Do not run** `homey app install` or `homey app publish` unless the user explicitly asks.

### Testing

```bash
npm run test:unit           # Fast Jest suite (skips .ts compilation)
npm run test:unit:ci        # Full Jest suite with coverage
npm run test:unit:tz        # Timezone-sensitive tests
npm run test:ui             # Settings UI Jest tests
npm run test:e2e            # Playwright E2E (chromium + firefox mobile)
npm run ci:full             # Complete CI: checks + runtime + settings UI + Playwright
```

**Coverage threshold:** 80% across branches, functions, lines, statements. Collected from `app.ts`, `lib/**`, `flowCards/**`, `drivers/**`.

### Linting and Checks

```bash
npm run lint                # ESLint entire codebase (zero warnings)
npm run lint:runtime        # ESLint runtime code only
npm run lint:css            # Stylelint
npm run lint:html           # HTML validate
npm run arch:check          # dependency-cruiser architecture boundaries
npm run deadcode:check      # Unused exports detection
npm run typecheck:unused    # TypeScript unused symbols check
npm run ci:checks           # Full static analysis suite (build + all lints + arch)
```

Pre-commit hooks (Husky + lint-staged) run ESLint + `tsc --noEmit` on every `.ts` change, and stylelint/html-validate on CSS/HTML.

---

## Code Conventions

### TypeScript

- Strict mode everywhere (`noImplicitAny`, `strictNullChecks`, etc.).
- No `any` — ESLint enforces this.
- Explicit return types where the type isn't obviously inferable.
- Functional patterns preferred: avoid mutation, use immutable data structures. ESLint `functional` plugin enforces this (with class exemptions).
- Max file size: 500 LOC. Max function size: 120 LOC.
- Max line length: 120 characters.

### Logging

- `this.log()` — user-visible operational logs (shown in Homey app manager).
- `this.logDebug()` — debug-only logs (gated by debug flag).
- Never use `console.log` in runtime code.

### Settings UI

- Source lives in `packages/settings-ui/src/`.
- Compiled output goes to `settings/script.js` — **never edit `settings/` files directly**.
- Build with `npm run build:settings` or `npm run watch:settings`.
- The UI communicates with the app backend exclusively via the REST API defined in `api.ts` and typed in `packages/contracts/src/`.
- For settings-only work, stay in `packages/settings-ui/` and `packages/contracts/src/`. Only touch `app.ts`, `lib/`, etc. if a missing contract forces it.

### Homey SDK

- If runtime code uses a new Homey SDK API, update the mock at `test/mocks/homey.ts`.
- Do not use Homey SDK types in `packages/shared-domain/` — that package must stay browser-safe.
- Flow cards are registered in `flowCards/registerFlowCards.ts`.

### `.homeycompose/`

- Capabilities defined in `.homeycompose/capabilities/`.
- Flow card definitions in `.homeycompose/flow/`.
- After any change to `.homeycompose/`, run `homey app validate` and commit the updated `app.json`.

---

## Control Flow

1. **Measurement** — Power samples collected from Homey devices at 10-second intervals.
2. **Planning** — `PlanEngine` reads power, device states, and (optionally) prices → outputs a `DevicePlan` (shed / restore / keep per device).
3. **Execution** — `PlanExecutor` applies targets (setTemperature, on/off, stepped dimming).
4. **Reconciliation** — `DeviceManager` syncs Homey state back, detects external changes (user manually overriding a device).
5. **Adjustment** — Next cycle adapts to actual measured results.

Key timing parameters:
- Shed cooldown: 60 seconds minimum between shed operations.
- Restore cooldown: 60–300 seconds (exponential back-off per restore attempt).
- Hour-boundary logic handles transitions between capacity hours.

---

## Important Files to Read Before Modifying

| Area | Read first |
|------|-----------|
| Snapshot/realtime merge logic | `notes/` (state trust, freshness, drift/reconcile pitfalls) |
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

Nightly `docs.yml` deploys docs to GitHub Pages at `pels.barelysufficient.org`.

---

## Pull Request Guidelines

- Minimal changes: one issue/feature per PR.
- Squash to a single commit before submitting.
- Rebase off latest main before submitting.
- No whitespace-only reformatting.
- Tests must pass; add new tests for new logic.
- If `.homeycompose/` changed, include the regenerated `app.json`.
