# PELS

Repo-wide instructions only:

- Root is the Homey app root. The only safe Homey CLI command is `homey app validate`. Do not run `homey app run`, `homey app install`, `homey app publish`, or any other Homey CLI command unless the user explicitly asks.
- The settings UI source lives in `packages/settings-ui`. Generated deployable assets sync into `settings/` via `npm run build:settings`.
- Shared browser-safe modules for the settings UI live in `packages/contracts/src` and `packages/shared-domain/src`.
- For settings-only work, start from `packages/settings-ui` and stay out of `app.ts`, `drivers/`, `flowCards/`, and `lib/` unless a missing contract blocks the task.
- Runtime code uses TypeScript with strict mode and Jest with the mock SDK in `test/mocks/homey.ts`. If a runtime change uses a new Homey SDK API, update that mock.
- When `.homeycompose` changes, `homey app validate` updates root `app.json`; include that generated change.
- Runtime logging should be structured. New operational/runtime logs should go through the pino
  structured logger path instead of adding new prose `this.log()` / `this.logDebug()` messages.
  Existing prose logs are legacy and may be migrated incrementally, but new work should emit
  structured events with stable field names. Debug-topic flags should gate whether debug-level
  logging is emitted, not whether logging is structured.
- Internal engineering notes for Homey state trust, freshness, and drift/reconcile pitfalls live under `notes/`. Read those before changing snapshot/realtime merge logic.
