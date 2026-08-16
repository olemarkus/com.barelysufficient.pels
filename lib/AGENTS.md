# Runtime Code — Boundaries and Conventions

## Layer boundaries

- `lib/plan` owns desired state, planner reasons, and admission decisions. Planner code decides what state PELS wants, not how that state is applied to a Homey device.
- `lib/device/DeviceTransport` owns observed current state and device-specific actuation transport. Native stepped-load capabilities, stepped-load flow requests, synthetic capability reporting, and Homey write details belong behind this boundary.
- `lib/power` owns the whole-home meter, including what an untrustworthy reading
  means. It answers the planner in kW (`headroomKw(limitKw)`); freshness states
  and totals do not cross into `lib/plan`. See `lib/plan/AGENTS.md`.
- `lib/executor` owns execution of a desired-state transition: compare observed current state with desired state, issue the needed request, and handle pending, retry, wait, skip, and materialization behavior.
- Executor code must not decide whether the planner was allowed to choose a desired state, and it should not branch on planner reasons except through narrow executor-facing adapters while legacy boundaries are being retired.
- Avoid passing broad planner device shapes into executor modules. Prefer small executable action/state types that contain only identity, current observation, desired state, and execution metadata needed for the command path.
- Avoid adding native-vs-flow binary or stepped-load transport branches to planner or executor code. Put those choices in `DeviceTransport` or a `lib/device` helper owned by it. Planner and executor issue semantic binary/step/target commands only.

## TypeScript

- Strict mode everywhere (`noImplicitAny`, `strictNullChecks`, etc.). No `any`.
- Explicit return types where the type isn't obviously inferable.
- Functional patterns preferred: avoid mutation. ESLint `functional` plugin enforces this (with class exemptions).
- Max file size: 500 LOC. Max function size: 120 LOC. Max line length: 120 characters.
- Extract complex inline boolean logic into a dedicated, well-named helper function.
- In performance-sensitive loops, avoid creating new arrays on each iteration (no `reduce` with spread; use `push` or `for`).
- Lazy-load large dependencies not needed at startup.
- When parsing external output, normalise empty/unexpected results to `null`, not empty strings.
- Validate untrusted external input at the boundary before handing it inward: finiteness-gate numbers (`Number.isFinite`) and shape-guard objects so a raw `NaN`/`Infinity`/malformed value never reaches a sum, comparison, persisted write, or control decision. Express absence as `null`/`undefined` (or skip the write), never a fabricated `0`. References: `lib/device/transport/managerFreshness.ts`, `lib/device/managerEnergy.ts`. (Root `AGENTS.md` → "Clean and trusted interfaces between layers".)

## Doc comments

- Exported boundary types and module entry/hub files carry a docblock stating ownership, the invariants callers can rely on, and the governing note or doc. Pure internal helpers don't need one. House-style references: `lib/device/deviceObservation.ts`, `lib/price/combinedPricesReader.ts`.
- **When a governing note defines a canonical name for a quantity and the local identifier differs, say so where the quantity is produced** — name the canonical term, name the note, and let the note carry the definition. The pointer is what keeps a rename convergent instead of forking yet another local name, so add it even (especially) when you are not doing the rename in the change at hand. Do not paraphrase the definition into the comment; a copy drifts from the note exactly the way the names drifted in the first place. Reference: the safe-pace family (`notes/safe-pace-two-constraints.md`), pointed at from `lib/power/capacityModel.ts`, `lib/power/capacityGuard.ts`, `lib/plan/planBudget.ts`, `lib/plan/planUsage.ts`, and `lib/plan/planContext.ts`.
- Anchor cross-references on **symbol names, not line numbers**. A `file.ts:NN` citation in a note or comment is stale the next time anything above it moves — the safe-pace note's citations rotted twice in one week — and a stale pointer is worse than none, because it sends the reader somewhere confidently wrong.

## Logging

Logging uses a pino-based structured logger (`lib/logging/`). Logs are JSON objects routed through a Homey-aware destination.

- **New logs** go through the structured logger: use `logger.info()` for normal runtime events, `logger.error()` for error-sink events, and topic-gated structured debug emitters for structured debug payloads.
- **Debug logs** are gated by topic flags (`lib/utils/debugLogging.ts`): `plan`, `diagnostics`, `price`, `daily_budget`, `devices`, `settings`, `perf`.
- **Legacy prose logs** (`this.log()` / `this.logDebug(topic, ...)`) still exist and may be migrated incrementally. Do not add new ones.
- Never use `console.log`.
- When a helper is refactored to be more generic, make its log messages generic too.

## Homey SDK

- If runtime code uses a new Homey SDK API, update the mock at `test/mocks/homey.ts`, and keep
  its absence contract faithful — `settings.get()` on an unset key answers `null`. The rule for
  classifying that absence lives in `setup/AGENTS.md` (the settings adapters own it).
- Do not use Homey SDK types in `packages/shared-domain/` — that package must stay browser-safe.
- Flow cards are registered in `flowCards/registerFlowCards.ts`.
