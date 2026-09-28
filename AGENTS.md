# PELS — Agent Guide

PELS is a Homey Pro app that controls hourly electricity capacity. It reads whole-home power, plans which managed devices to limit or resume, and executes those plans. Price, daily budget, and smart-task features build on that loop.

Use this file for project-wide rules. Read a nested `AGENTS.md` when doing substantive work in its directory; use the linked design notes when the task touches their subject. `CLAUDE.md` files are import stubs and must not receive new guidance.

## Workflow

- Work in a dedicated git worktree and keep the primary checkout clean. Match the process to the requested outcome: use `$pr-lifecycle-manager` for end-to-end PR work or an existing PR, and make scoped local changes directly in the task worktree.
- Handle contained work directly. Use specialist skills or agents only for relevant expertise, and parallel agents only for substantial independent work or when requested.
- Review feedback is a hypothesis. Trace a claimed failure through production producers and reachable inputs before changing contracts. Fix the owning layer, and use a focused regression check when behavior changed.

## Architecture

`app.ts`, `api.ts`, drivers, and the settings UI are entry points. `setup/` and `flowCards/` wire the runtime. `lib/planInput/` projects owner-resolved inputs into `lib/plan/`. Domain modules own runtime behavior; `packages/contracts/` and `packages/shared-domain/` hold genuine shared contracts and behavior. See `docs/architecture.md` and the nearest module `AGENTS.md` for details.

### Hard rules

- Respect the dependency rules in `.dependency-cruiser.cjs`. Runtime backend code cannot import settings UI code. Settings UI consumes contracts and shared-domain, not runtime backend modules. `setup/` may import domain modules; domain modules cannot import `setup/`.
- `setup/` constructs and connects. It owns no mutable runtime state, domain decisions, or SDK reads. Put those with the owning `lib/` module. `lib/planInput/` is the narrow, one-way integration seam for planner input; peer domains do not import it.
- `lib/actuator/` is the only seam for managed-device control writes. A driver's publication of its own capabilities is separate. See `notes/state-management/actuator-write-seam.md`.
- Put code in `packages/shared-domain/` only when real browser and Node consumers need it. Browser-only logic stays with the UI; backend-only logic stays with its owning runtime module. A forbidden peer import is a signal to revisit ownership.
- Pass an existing domain object as an object. Do not assemble anonymous parameter bundles merely to shorten an argument list. `npm run params:no-bundles` checks one syntactic case; see the header of `scripts/check-param-bundles.mjs` for the ownership rule.
- New runtime logs use structured logging in `lib/logging/`. Use `getDebugEmitter(component, topic)` for debug events. `npm run logging:no-legacy` enforces the legacy ban; details are in `notes/logging/README.md`.

### Packages (shared)

`packages/contracts/` shares types; `packages/shared-domain/` holds logic with real browser and Node consumers; `packages/settings-ui/` owns browser-only code. The placement rule above governs new modules.

## Clean and trusted interfaces between layers

Resolve untrusted Homey, network, API, settings, persisted, flow-card, and clock inputs at their owning boundary. Validate shape and finite numbers, then pass a typed semantic result inward. Distinguish genuine domain absence from an unavailable or malformed external read. Consumers trust resolved in-process values; they do not revalidate them or invent stand-ins. A transient missing sample leaves the last accepted observation in place. See `docs/architecture.md` § "Clean and trusted interfaces between layers" and `notes/persisted-settings-state.md`.

## Control Flow

Measurement feeds planning, which decides desired state; execution converges observed state onto that decision. A whole-home meter reading is the normal trigger for a plan rebuild. Device observations update planner input and may clear a rebuild throttle, but do not themselves trigger a rebuild or reapply an old plan. On a meter outage the power owner performs the one-time fail-closed escalation; the planner then waits for a new reading. Device observation trust belongs to `lib/observer/`, meter trust to `lib/power/`. See `lib/plan/AGENTS.md`, `lib/observer/AGENTS.md`, and `lib/plan/planRebuildTrigger.ts` before changing that flow.

Execution uses the actuator seam and has no apply-without-decide reconciliation path.

## Working in this repository

- `app.json` and `settings/` are generated. Change `.homeycompose/` or `packages/settings-ui/src/` respectively. After `.homeycompose/` changes, run `homey app validate` and commit the regenerated `app.json`.
- `homey app validate` is the only Homey CLI command authorized by default. Run, install, and publish commands require an explicit user request.
- For UI work, use Material Web when a matching component fits; otherwise use a shared PELS primitive and existing design tokens. Read `notes/ui-terminology.md` when changing user-facing wording.
- For settings keys, use `notes/settings-key-ownership.md`; for planner capacity and safe pace, use `docs/technical.md` and `notes/safe-pace-two-constraints.md`; for test placement, use `notes/testing-taxonomy.md`.
- `TODO.md` is a mutable backlog, not a stable reference. Do not cite its entries from code or other docs; add only actionable items with a location, closing change, and completion criterion.

### Device card reason lines

State what the device needs in its reason line; the overview hero states house-level limits. `notes/ui-terminology.md` holds canonical text and exceptions.

## Testing rules

Choose checks for the behavior changed. Documentation and copy changes need no runtime tests. Use focused npm test entrypoints and exact spec filters during development; hooks and CI run broader suites. Do not repeat a passing run without a new change or unresolved risk.

Tests and test-running hooks use a shared lock across PELS worktrees. Invoke npm scripts rather than raw Vitest or Playwright. Agents set `PELS_TEST_WORKERS=1 PELS_PLAYWRIGHT_WORKERS=1` for test, commit, and push commands. Serialize heavy tests, builds, checks, and browser capture in a multi-agent session; the lead owns validation. On OOM or a killed worker, stop the process tree you own and diagnose before another run.

Useful focused entrypoints: `npm run test:unit -- <spec>`, `npm run test:integration -- <spec>`, `npm run test:e2e:runtime -- <spec>`, and `npm run test:ui -- <spec>`. CI and push hooks own coverage, broad static checks, and browser suites unless the user asks for a local run. `test/AGENTS.md` describes tier placement and mocks.
