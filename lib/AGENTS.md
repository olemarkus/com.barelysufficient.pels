# Runtime Code

## Layer boundaries

`lib/plan/` decides desired state and admission; `lib/observer/` supplies trusted observation; `lib/device/` owns transport and device-specific Homey operations; `lib/power/` owns meter truth; `lib/executor/` converges a decision onto observation; `lib/actuator/` is the managed-device write seam. Keep native-versus-Flow transport choices in the device owner. Avoid passing broad planner device shapes into executor modules; pass narrow executable intent and observation. The enforced import rules are in `.dependency-cruiser.cjs`.

Resolve external values at their owning boundary, including Homey settings absence and failures. Pass typed semantic outcomes inward and trust accepted in-process facts. See root `AGENTS.md` § "Clean and trusted interfaces between layers".

## TypeScript and comments

Follow the repository's strict TypeScript and ESLint configuration. Use clear types and small functions where they help ownership and review. Exported boundary contracts should state their owner and the invariant callers may rely on; internal helpers need comments only when their reason is not clear from code. Link to the governing note for a canonical quantity rather than copying its definition. Prefer symbol names over line numbers in cross-references.

## Logging

Use structured `getLogger(module)` events for normal runtime and error output. Use `getDebugEmitter(component, topic)` for debug events; a plain `.debug()` may be invisible in production. `npm run logging:no-legacy` and `notes/logging/README.md` define the enforced legacy ban.

## Homey SDK

When using a new SDK API, update `test/mocks/homey.ts`. An unset `settings.get()` key may return `null`; the owning reader distinguishes genuine absence from an unavailable read through `SettingsPort` and `getKeys()`, as described in `setup/AGENTS.md` § "External reads and startup". Keep Homey SDK types out of `packages/shared-domain/`.
