# Test Layer

Runtime (vitest) tests live here. The full classification is `notes/testing-taxonomy.md` —
read it before adding or moving a test. Short version:

## Where does a new test go?

Answer two questions: **what is real**, and **how is the subject driven/observed**.

- `test/unit/` — one **pure** function/method. No I/O, no SDK, no clock. Direct call,
  assert the return. (A single function that touches the SDK or clock is *integration*, not
  unit.)
- `test/integration/` — one **layer** end to end. Mock only the layer's outward seams, and
  only via the shared helpers in `test/mocks/**` and `test/helpers/**` — never ad-hoc
  `as any`.
- `test/e2e/` — **runtime e2e**: nothing internal mocked; drive through the Homey SDK
  boundary (device temp/SoC, prices, clock), observe through SDK reads + **structured logs**.
  Never parse prose; if you can't assert via a structured field/capability/persisted value,
  add the structured output instead of reaching inside. See
  `lib/objectives/deferredObjectives/AGENTS.md` for the canonical harness.
  (UI e2e is Playwright and lives in `packages/settings-ui`, not here.)

## Shared infrastructure stays at the root

`test/mocks/`, `test/helpers/`, `test/utils/`, and `test/setup.ts` are tier-agnostic and
stay at `test/` root. The mock SDK is `test/mocks/homey.ts` — if a runtime change uses a new
Homey SDK API, update that mock.

## Moving a spec into a tier folder bumps import depth

There are no path aliases. Relocating a spec from `test/` to `test/<tier>/` breaks its
relative imports — fix them mechanically:

- `'../X'` → `'../../X'`
- `'./X'` → `'../X'`

(The bare `homey` import and other vitest aliases resolve absolutely and need no change.)

## Running a single tier

```
npm run test:unit            # test/unit/ only (fast)
npm run test:integration     # test/integration/ only (fast)
npm run test:e2e:runtime     # test/e2e/ only (fast, 30s timeout)
npm run test:unit:tz         # test/tz/ timezone lane
npm run test:coverage        # all tiers in one pass + 80% coverage gate
```

Every spec is classified into a tier folder; there are no flat `test/*.test.ts` specs left. A
new spec lands directly in its tier folder (see `notes/testing-taxonomy.md`).
