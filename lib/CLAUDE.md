# Runtime Code Conventions

## TypeScript

- Strict mode everywhere (`noImplicitAny`, `strictNullChecks`, etc.). No `any`.
- Explicit return types where the type isn't obviously inferable.
- Functional patterns preferred: avoid mutation. ESLint `functional` plugin enforces this (with class exemptions).
- Max file size: 500 LOC. Max function size: 120 LOC. Max line length: 120 characters.
- Extract complex inline boolean logic into a dedicated, well-named helper function.
- In performance-sensitive loops, avoid creating new arrays on each iteration (no `reduce` with spread; use `push` or `for`).
- Lazy-load large dependencies not needed at startup.
- When parsing external output, normalise empty/unexpected results to `null`, not empty strings.

## Logging

Logging uses a pino-based structured logger (`lib/logging/`). Logs are JSON objects routed through a Homey-aware destination.

- **New logs** go through the structured logger: `logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()`. Emit structured events with stable field names.
- **Debug logs** are gated by topic flags (`lib/utils/debugLogging.ts`): `plan`, `diagnostics`, `price`, `daily_budget`, `devices`, `settings`, `perf`.
- **Legacy prose logs** (`this.log()` / `this.logDebug(topic, ...)`) still exist and may be migrated incrementally. Do not add new ones.
- Never use `console.log`.
- When a helper is refactored to be more generic, make its log messages generic too.

## Homey SDK

- If runtime code uses a new Homey SDK API, update the mock at `test/mocks/homey.ts`.
- Do not use Homey SDK types in `packages/shared-domain/` — that package must stay browser-safe.
- Flow cards are registered in `flowCards/registerFlowCards.ts`.
