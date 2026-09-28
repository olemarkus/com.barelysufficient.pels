# Runtime Tests

Use `notes/testing-taxonomy.md` for test placement. A unit spec exercises one pure function without I/O or clock; an integration spec exercises one layer with outward seams mocked; a runtime e2e spec drives the real stack through the Homey SDK boundary and observes SDK output or structured logs. UI browser tests live under `packages/settings-ui/`.

Use shared helpers in `test/mocks/` and `test/helpers/`, including `partialDouble` for deliberate partial stubs. Avoid ad-hoc `any` and mocks of PELS internals in runtime e2e. Update `test/mocks/homey.ts` when production begins using another SDK API.

Run focused specs through root npm entrypoints with `PELS_TEST_WORKERS=1 PELS_PLAYWRIGHT_WORKERS=1`; do not invoke raw Vitest or Playwright. Hooks and CI own broad suites. When moving a spec into `test/<tier>/`, adjust relative import depth. If an SDK-bound `createApp` e2e uses fake timers, include `performance` in the faked clock so the rebuild scheduler and `Date` advance together.
