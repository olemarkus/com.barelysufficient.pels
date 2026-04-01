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
npm run validate            # homey app validate + packaging checks
```

Do not run `npm run start` or `npm run start:local` — these invoke `homey app run`, which is not a safe command.

**Safe Homey CLI command:** `homey app validate`.
**Do not run** `homey app run`, `homey app install`, or `homey app publish` unless the user explicitly asks.

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

## Notes — Invariants and Business Logic

The `notes/` directory contains engineering notes that describe invariants, planned features, and design constraints that **must be preserved** when modifying the relevant subsystems. Read the relevant note before touching the listed areas.

---

### `notes/state-management/` — Device State Invariants

**The single most important rule:** PELS must keep these five concepts strictly separate at all times:

| Concept | Meaning |
|---------|---------|
| `planned` | What the current plan wants |
| `commanded` | What PELS most recently asked Homey/device to do |
| `observed` | What trusted telemetry most recently says the device is doing |
| `effective planning` | What the planner should conservatively assume right now |
| `pending` | Requested but not yet confirmed |

**Most bugs in this area come from collapsing two of these into one.**

#### Source trust order

| Question | Trust order |
|----------|-------------|
| "What did PELS ask for?" | 1. local command state → 2. pending command records |
| "What is the freshest observed value?" | 1. recent realtime event → 2. recent snapshot → 3. unknown/stale |
| "Did the command succeed?" | 1. confirming telemetry — timeout expiry = unknown, NOT success |

For planner assumptions: use conservative still-on/still-high for shed decisions; pending state may justify "requested, unconfirmed" for restore decisions. For hard-cap safety, trust whole-home power over per-device attribution.

#### Hard invariants

- A local write (`setCapabilityValue`) is proof PELS requested a change — it is **not** proof the device converged.
- Binary `onoff` confirmation is **not** full convergence. Power draw and final behavior may still lag.
- A full snapshot refresh can be **older** than a recent realtime event or local write — never let it silently roll state backward.
- Fallback/estimated power is a planning input, not measured telemetry. Keep the distinction explicit.
- Fresh trusted observations must eventually win over local-write assumptions, older snapshots, and fallback estimates.
- "No confirmation yet" means pending/unknown — **never** treat it as success.

#### Rules when changing reconcile or merge logic

- Drift comparison must be against **plan state**, not the last stored snapshot value.
- Realtime updates must update the observed view before drift evaluation uses that field.
- Reapply must target plan state, not the observed transition direction.
- Never let an older full fetch erase a fresher local or realtime observation without evidence it is newer.
- Preserve pending command state until confirmation or timeout.
- If an equivalent command is already pending, suppress duplicate reapply unless retry policy explicitly allows it.
- Logs must distinguish: observed transition / planned target / commanded/pending target.

---

### `notes/starvation/` — Temperature Device Starvation (Planned Feature)

> This feature is **not yet implemented**. This note defines the intended design. Do not implement partial versions that deviate from these rules.

**Scope:** managed temperature-driven devices only (room thermostats, water heaters). Not EV chargers or generic binary loads.

**Core constraint:** starvation is orthogonal metadata — it must **never** change planner decisions (shed order, restore order, priority). It is detection only.

Key invariants:
- A device in `keep` must **not** become starved merely because it is heating slowly after a target increase.
- Starvation is always evaluated against the **intended normal target**, never against a temporary shed target.
- Entry requires 15 minutes of continuous qualifying suppression — not a single-cycle check.
- Non-counting states (cooldown, keep, restore, inactive, etc.) pause accumulation; they do not add starvation time.
- `capacity control off` must **clear and reset** starvation entirely.
- Exit requires temperature above the exit threshold for 10 continuous minutes (hysteresis — partial recovery does not clear starvation).
- Duration-threshold flow triggers must fire **once per episode per threshold**, not every planning cycle.
- Accumulated duration must be tracked explicitly — a single start timestamp is insufficient because paused periods must not count.

Counting suppression reasons (do add starvation time): `shed due to capacity`, `shed due to daily budget`, `shed due to hourly budget`, shortfall, swap pending/out, insufficient headroom, shedding active.

Non-counting reasons (do not add time, but keep starved state latched): cooldown, headroom cooldown, restore throttled, activation backoff, inactive, keep, restore, capacity control off.

---

### `notes/daily-budget-auto-adjust/` — Auto-Adjust Daily Budget (Planned Feature)

> This feature is **not yet implemented**. This note defines the intended design constraints.

**Purpose:** increase tomorrow's effective daily budget based on recent eligible exempted energy from completed days, to prevent the planner from chasing thermal demand too aggressively after starvation-driven exemptions.

**Hard constraints — must not be violated:**

- Tomorrow's budget = `baseBudget + autoBudgetCorrection`. Never `yesterdayEffectiveBudget + correction` — correction must always be relative to the **configured base**, not compounded from yesterday's already-adjusted value.
- Correction source is **eligible exempted kWh from completed days** — not starved minutes, not starved device count, not arbitrary percentage bumps. Duration is not energy.
- In v1, only `starvation_policy` exemptions are eligible. Manual, flow-driven, and ad hoc exemptions are excluded by default.
- Hourly capacity protection is **completely unaffected** — this is a daily budget policy feature only.
- Exempted energy still behaves as uncontrolled in the daily-budget split.
- Ignore the current incomplete day — compute at day rollover from finalized values only.
- Data model must keep `baseDailyBudgetKwh`, `autoBudgetCorrectionKwh`, and `effectiveDailyBudgetKwh` as **separate fields**.

---

## Pull Request Guidelines

- Minimal changes: one issue/feature per PR.
- Squash to a single commit before submitting.
- Rebase off latest main before submitting.
- No whitespace-only reformatting.
- Tests must pass; add new tests for new logic.
- If `.homeycompose/` changed, include the regenerated `app.json`.
