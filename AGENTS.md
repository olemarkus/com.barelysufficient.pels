# PELS

Repo-wide instructions only:

- Root is the Homey app root. The only safe Homey CLI command is `homey app validate`. Do not run `homey app run`, `homey app install`, `homey app publish`, or any other Homey CLI command unless the user explicitly asks.
- The settings UI source lives in `packages/settings-ui`. Generated deployable assets sync into `settings/` via `npm run build:settings`.
- Shared browser-safe modules for the settings UI live in `packages/contracts/src` and `packages/shared-domain/src`.
- For settings-only work, start from `packages/settings-ui` and stay out of `app.ts`, `drivers/`, `flowCards/`, and `lib/` unless a missing contract blocks the task.
- Runtime code uses TypeScript with strict mode and Jest with the mock SDK in `test/mocks/homey.ts`. If a runtime change uses a new Homey SDK API, update that mock.
- When `.homeycompose` changes, `homey app validate` updates root `app.json`; include that generated change.
- Runtime logging is structured (pino, `lib/logging/`). New logs go through `logger.info/warn/error/debug()` with stable field names. Legacy `this.log()` / `this.logDebug()` calls exist but must not be added to. Debug topics in `lib/utils/debugLogging.ts` gate whether debug events fire.
- Internal engineering notes for Homey state trust, freshness, and drift/reconcile pitfalls live under `notes/`. Read those before changing snapshot/realtime merge logic.
