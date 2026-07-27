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
- `flowCards/**` must not import `packages/settings-ui/**` or `drivers/**`.
- Accept code duplication if consolidation would violate an architectural boundary. Add a comment explaining the constraint.

**Known transitional allowance:** `lib/utils/**` still has some imports from `lib/device`, `lib/power`, and `lib/plan` (`todo-tighten-utils-layering`). Tracked in `TODO.md`; do not expand.

**Validation belongs at the boundary (convention, not cruiser-enforced):**
- Every external/outer layer — Homey SDK reads, network fetches, the settings/persisted store, flow-card args, inbound API bodies, the clock — must validate and discriminate untrusted input into a strongly-typed, resolved value *before* handing it to an adjacent layer. Finiteness-gate numbers (`Number.isFinite`) and shape-guard objects. Use flat `null`/`undefined` only for genuine domain absence; API/settings absence, malformed data, or read failure must become an explicit semantic result rather than a nullable business value. Never let a raw `NaN`/`Infinity`/malformed/partial value flow inward into a sum, comparison, persisted write, or control decision.
- Adapters that read Homey/API/settings data own the complete classification of `undefined`, `null`, empty key lists, malformed values, and thrown errors. They must expose a typed semantic result (for example, `resolved | unavailable`) to adjacent layers; downstream domain/control code must not catch adapter exceptions, inspect SDK absence/error provenance, or reinterpret an unavailable read as a default. Tests for SDK weirdness belong at the adapter boundary; business tests inject semantic states.
- Downstream layers may then assume the typed invariant holds; they must not re-validate or branch on the input's source/provenance (the consumer-side dual — "Resolution belongs in the producer", `docs/architecture.md`).
- Transient external failures get an abandon-grace window, never a destructive reset of persisted state (`notes/persisted-settings-state.md`).
- Reference implementations: `lib/device/transport/managerFreshness.ts` (drops a non-finite realtime event — no write, no freshness bump) and `lib/device/managerEnergy.ts` (`asRecord` + `toFiniteNumber` resolve an untrusted live report to `null` on junk).

---

## Key Modules

### Runtime (`lib/`)

| Module | Purpose |
|--------|---------|
| `lib/plan/` | Core planning engine: builds, executes, and reconciles device plans |
| `lib/device/` | Observed device state and actuation transport (`DeviceTransport`) |
| `lib/observer/` | Observation freshness/trust, idle classification, pending binary commands |
| `lib/executor/` | Executes desired-state transitions (pending/retry/materialization) |
| `lib/objectives/` | Learned energy-rate profiles + deferred-objective (smart-task) stack |
| `lib/power/` | Power sampling and capacity tracking |
| `lib/price/` | Spot price fetching (Norwegian Nordpool), Homey Energy API integration, price levels |
| `lib/dailyBudget/` | Soft daily kWh budget constraints |
| `lib/app/` | Legacy wiring layer — sunsetting. New wiring goes in `setup/`; `lib/app/appContext.ts` (type definition) stays as the only long-term inhabitant. |
| `lib/utils/` | Pure helpers, type guards, math utilities, debug logging, settings keys |
| `lib/diagnostics/` | Per-device diagnostics recording |
| `lib/logging/` | Structured logging infrastructure: pino logger, AsyncLocalStorage context, Homey destination |

Runtime code conventions (TypeScript, structured logging, Homey SDK mocking) live in `lib/AGENTS.md`.

### App wiring (`setup/`)

`setup/` at the repo root is the honest home for app-wiring classes — factories, observers, registrars that construct and connect services. Conventions and the boot-path map live in `setup/AGENTS.md`. As remaining wiring migrates out of `lib/app/`, that directory sunsets; `lib/app/appContext.ts` (the shared `AppContext` type) stays.

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

Every entry point above serializes against the other worktrees on this machine — see
[One heavy run at a time](#one-heavy-run-at-a-time-the-machine-wide-test-lock).

**Test taxonomy.** Tests are classified into three tiers — **unit** (one pure function, no I/O), **integration** (one layer, only outward seams mocked via shared helpers), **e2e** (nothing internal mocked; driven through an external seam — Homey SDK for runtime e2e, the UI for Playwright e2e — and observed through that seam + structured logs, never parsed prose). Every spec lives in `test/unit/`, `test/integration/`, or `test/e2e/`; shared mocks/helpers/setup stay at `test/` root. jsdom widget-render specs are unit-tier and self-declare their environment via a `// @vitest-environment jsdom` pragma. Before adding or moving a test, read `notes/testing-taxonomy.md` (and `test/AGENTS.md` for the short rules); bump import depth when moving a spec, then run `knip`.

**Coverage threshold:** 80% across branches, functions, lines, statements, enforced by the `coverage` CI job (`npm run test:coverage`). Collected from `app.ts`, `api.ts`, `lib/**`, `flowCards/**`, and `drivers/**`.

**Testing rules:**
- Unit tests must have a narrow, specific purpose — avoid adding broad checks already covered by integration or regression tests.
- Use shared, type-safe mock helpers instead of ad-hoc `as any` casts so mocks stay in sync with the production API. Runtime tests use the mock SDK in `test/mocks/homey.ts`; if a runtime change uses a new Homey SDK API, update that mock.
- **Deferred-objective / planner e2e simulate only the Homey SDK boundary** (device temperature/SoC, prices, clock) and drive the real bridge + recorder + admission — never mock PELS internals like `aheadOfHourMilestone` or the fresh/frozen dispatch. Mocking those confirms your assumptions instead of the system's behaviour (it once turned a non-existent cold-start "catastrophe" into a phantom P0). See `lib/objectives/deferredObjectives/AGENTS.md` and `test/e2e/deferredObjectiveColdStartSdkE2E.test.ts`.

### One heavy run at a time (the machine-wide test lock)

Several PELS worktrees are usually live on the same 8-core box. Vitest forks per tier and
Playwright adds browser projects, so **two concurrent runs starve each other and fail in ways
that are indistinguishable from real regressions** — timeouts, crash-shaped errors, and even
plain assertion failures on an unmodified base. Every heavy entry point therefore runs under a
machine-wide advisory mutex (`scripts/with-test-lock.mjs`, `scripts/lib/test-lock.mjs`).

**Serializing is faster than sharing.** Measured 2026-07-26 on the maintainer's 8-core box,
same command, same commit: `npm run ci:checks` took **156 s** on a clear machine and **543 s**
with one other worktree mid-suite, 3.5x slower. A Playwright matrix took 21 min under
contention against a usual 8, and produced 29 failures, every one of which passed in isolation.
Queueing behind someone else's run is not a fairness tax you pay for reliability; it finishes
sooner in wall-clock too. (Figures are one-off and will drift as the suite grows; the ordering
is the durable part.)

- **Locked:** every vitest lane (`test:unit`, `test:integration`, `test:e2e:runtime`,
  `test:unit:tz`, `test:coverage`, `test:unit:ci`), `test:ui`, the Playwright entry points
  (`test:e2e`, `test:e2e:ui`, `ci:test:playwright*`), the aggregates (`ci`, `ci:full`,
  `ci:test:runtime`), `ci:checks`, and **both git hooks**. `ci:checks` is in because its 16-way
  parallel tsc/eslint/knip fan-out saturates the box just as hard as a vitest tier, only for
  less time — and re-entrancy makes it free inside `ci` and the hooks.
- **Not locked:** `npm run build`, `homey app validate`, docs builds. Short, mostly
  single-process. `ci:full` deliberately builds *before* it takes the lock, so the exclusive
  window others queue behind covers only the test work.
- **The lock wraps entry points, not every possible invocation.** A direct `npx vitest …`, or
  an internal step script such as `ci:steps` or `hooks:pre-commit`, runs whatever it runs; the
  wrapped `npm run` scripts are the contract. Use them.
- **A commit and a push are test runs.** `.husky/pre-commit` runs `vitest related` per tier via
  lint-staged, and `.husky/pre-push` fans out `ci:checks` plus every tier in parallel. Both take
  the lock for the whole hook, so **committing while someone else's suite runs will wait**. That
  is intended: it is what stops the pre-push gate from being eroded into `--no-verify`.

**Waiting is the default.** A blocked run prints who holds the lock — worktree, script label,
pid, and how long it has been running — then repeats every 30 s, so you can decide whether to
wait or intervene. Ctrl-C aborts. After `PELS_TEST_LOCK_TIMEOUT_MS` (default 60 min) it gives up
with exit code **75**, deliberately not `1`, so a lock timeout never reads as a test failure.

```bash
npm run test:lock:status             # who holds the lock right now (or "free")
npm run test:lock:release            # break-glass: drop a record whose run is gone
PELS_TEST_LOCK=0 npm run test:unit   # escape hatch: skip the lock entirely
```

**Re-entrancy:** the holder exports its lock token in the environment, and every child process
inherits it, so nested invocations (`ci` → `ci:checks`, the pre-push hook → four parallel tiers)
pass straight through instead of blocking on their own ancestor. A run whose inherited token no
longer matches the live record acquires normally rather than assuming a hold it does not have.

**Stale locks:** the lock is a per-uid record under `/tmp` — deliberately *not* `os.tmpdir()`,
which follows `TMPDIR`, and agent sessions here export a per-session scratchpad `TMPDIR` that
would give each of them a private lock and silently switch the mutex off. Pure Node, no
`flock(1)`, so macOS behaves like Linux. A holder is taken over when its pid stops answering
`kill(pid, 0)` *and* its record is at least one heartbeat old, when its record is unreadable
*and* has not been touched for 2 min, or when its heartbeat alone has been silent for 2 min —
that last rule is what covers pid reuse. A crashed or SIGKILLed run therefore cannot wedge the
machine, **with one exception**: nothing can distinguish a live, still-beating wrapper from a
healthy long run, so such a holder is never taken over, however pointless its hold has become.

That exception is reachable. If a supervisor kills the *shim* pid rather than the process group
(`node` here is a Volta shim that forwards neither SIGTERM nor SIGHUP), the real wrapper is
orphaned and keeps beating a lock nobody is waiting on. `npm run test:lock:release` is the
break-glass for exactly this, and it names the pid to stop first.

**Releasing means nothing is left running.** The wrapper puts the command in its own session
(`detached` is `setsid`, so a new process group *and* a new session), signals the *group* on
SIGINT/SIGTERM/SIGHUP, then, once the command exits, waits for the group to drain — escalating
SIGTERM then SIGKILL — before it releases. Without that, killing `-- npm run ci:steps`
non-interactively stops npm while the vitest workers under it keep running, and the lock goes
free next to a live suite. What the new session costs:

- The command no longer shares this terminal's foreground group, so **Ctrl-C** reaches it via
  the wrapper's forwarding rather than from the TTY directly, and a terminal **hangup** likewise
  only arrives if the wrapper is alive to forward it.
- **Ctrl-Z suspends the wrapper only.** The shell hands back the prompt while the run keeps
  saturating the box and holding the lock. Stop a run with Ctrl-C, not Ctrl-Z.
- The command cannot open `/dev/tty`, so nothing under the lock may prompt through the
  controlling terminal (an ssh passphrase, `sudo`, a git credential fallback). Reading fd 0 is
  unaffected, as are TTY detection and colour.
- Anything that calls `setsid` for *itself* leaves the group and is out of reach — including a
  nested wrapper, which puts *its* command in a further session. Each wrapper drains its own
  group, so `npm run ci` is covered layer by layer; only SIGKILLing an inner wrapper escapes.

**Do not replace this with a `ps` grep.** Two properties make it work, and process-sniffing has
neither. It **acquires atomically**: the record is staged and then `link()`ed into place, which
fails outright when the lock is held, so there is no observe-then-act window where two waiters
both conclude the box is free and start (hand-coordinating by `ps` failed exactly that way twice
in one evening — and once with a `ps` check taken 250 s before the run, on a box confirmed idle,
which siblings then joined mid-run). Taking an abandoned record over never empties the lock path
either: the stealer pins the entry with `link()`, checks it is still the inode it judged, and
`rename()`s its own record over it in one step, so no ordinary waiter can slip into a gap. Two
waiters that judge the *same* record abandoned in the same instant remain a two-syscall
preemption, not an excluded case — POSIX exposes no compare-and-swap on a directory entry.
And it **names a holder**, so a waiter can tell a sibling worktree's suite from machine noise;
"wait until `ps` looks quiet" is unsatisfiable on a box that is near-continuously busy, whereas
"wait for this named run to release" always terminates.

**CI is a no-op.** GitHub runners are isolated, so serializing there would only slow the matrix;
the lock detects `CI` and skips. `PELS_TEST_LOCK=1` forces it back on if you need to test it there.

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
| Snapshot/realtime merge logic, device state trust | `lib/device/AGENTS.md` (invariants digest), `notes/state-management/` (design-of-record) |
| Starvation detection | `lib/diagnostics/AGENTS.md` (invariants digest), `notes/starvation/` |
| Capacity model internals | `docs/technical.md` |
| Safe pace (cap vs daily budget), budget exemption | `notes/safe-pace-two-constraints.md` |
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
3. **unit-tests** / **integration-tests** / **e2e-tests** — the three runtime tiers, each its own parallel job (`npm run test:unit` / `test:integration` / `test:e2e:runtime`).
4. **timezone-tests** — `npm run test:unit:tz`.
5. **coverage** — `npm run test:coverage` (all tiers in one instrumented pass, 80% gate).
6. **settings-ui-tests** — `npm run ci:test:settings-ui`.
7. **playwright** — E2E matrix (`chromium-mobile-width`, `firefox-mobile-width`, `chromium-narrow-width`).

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

The "Safe pace now" tick uses a single label regardless of whether the binding constraint is capacity-based or daily-budget-based. The tooltip explains the source.

### Chips vs reason lines

Chips stay short — canonical chip labels like `Limited`, `Resuming`, `Above safe pace` (see `notes/ui-terminology.md` for the full set).
Reason lines (below chip or in tooltip) may be a short sentence: `by today's daily budget`.
Do not put sentences in chips.

### Terms that stay internal (do not surface in normal UI)

`shed`, `restore`, `headroom`, `headroom cooldown`, `swap`, `shortfall`, `backoff`, `invariant`, `soft limit`, `controlled`, `uncontrolled`

---

## Out-of-scope review topics

Automated reviewers (Codex, Copilot, Gemini Code Assist) must not comment on:

- ARIA attributes, roles, or landmarks
- Screen-reader support and other assistive-technology-specific behaviors

**Reason:** the user-facing UI runs only inside Homey's WebView, which does not expose accessibility APIs to assistive technologies. Comments targeting those APIs are not actionable here. Sighted-user concerns — semantic HTML element choice, color contrast, and keyboard navigation — remain in scope and welcome.
