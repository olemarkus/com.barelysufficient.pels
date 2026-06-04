# Testing Taxonomy

The canonical classification for every automated test in this repo. It exists so a new
test lands in the right tier without debate, and so the test commands partition the suite
along one clear seam.

There are exactly three tiers. They are distinguished by **what is real** and **how the
subject is driven and observed** — not by how many lines of production code happen to run.

## The two axes

A test is placed by answering two questions:

1. **Scope / what is real** — one function → one whole layer → the whole app.
2. **I/O surface** — is the subject driven and observed through a *direct call* (a function
   call, an internal return value), or only through a *real external seam* (the Homey SDK,
   the web API, the settings UI)?

Scope and I/O surface usually correlate, but the defining property of e2e is the I/O
surface, not the scope. State that first because it resolves the only genuine ambiguity
(the integration/e2e border).

## The three tiers

### unit — one pure function or method

- **Real:** the function under test only.
- **Driven / observed:** direct call, assert on the return value or a thrown error.
- **Mocks:** none, or trivial stubs. A unit test does **no I/O** — no SDK, no clock, no
  filesystem, no network. That purity is what makes it fast and is why it belongs in the
  fast lane.
- A function that reaches the SDK or the clock is **not** a unit test even if it is a single
  function — it is integration.

### integration — one layer, end to end

- **Real:** everything *inside* the layer (e.g. all of `lib/plan`, or planner + executor +
  reconciliation as one slice).
- **Driven / observed:** a direct call into the layer; assertions may read the layer's own
  outputs/returns.
- **Mocks:** only the layer's *outward seams* (SDK, price source, clock, persistence) — and
  only through the **shared type-safe mock helpers** (`test/mocks/**`, `test/helpers/**`),
  never ad-hoc `as any`. Mocking inside the seam defeats the point: it tests your wiring of
  the mock, not the layer.

### e2e — external seams only

- **Real:** all PELS code. **Nothing internal is mocked.**
- **Driven / observed:** in through a real external seam, out through the same seam plus
  **structured logs**. Two seam-families both count as e2e:
  - **runtime e2e** — drive through the Homey SDK boundary (device temperature/SoC, prices,
    the clock), observe through SDK reads + structured logs. Vitest. Lives in `test/e2e/`.
  - **ui e2e** — drive through the rendered settings UI, observe through the DOM. Playwright,
    in `packages/settings-ui` (`npm run test:e2e:ui`).
- **Mocks:** only the external boundary itself, and it is *simulated*, never mocked-internal.
  Simulating the SDK boundary (or stubbing a backend behind the real UI) is not mocking PELS
  code. See `lib/objectives/deferredObjectives/AGENTS.md` for the canonical runtime-e2e
  harness rules.

## Two hard rules for e2e observation

1. **Structured logs only — never parse prose.** Assert on structured log fields with stable
   names, capability values, or persisted state read back through the SDK. Do not grep human
   sentences out of log text.
2. **If you can't observe it as structured output, that's an observability gap — fix the
   product, don't reach inside.** When an e2e test needs to assert on something that isn't
   exposed as a structured field / capability / persisted value, add the structured output.
   This rule turns the testing constraint into pressure for better structured logging, which
   we want regardless. Reading persisted state back through the SDK counts as the same seam
   and is allowed.

## The border cases (memorize these)

- Spans 2–3 layers but you **call an internal function** to drive it or assert on an internal
  return → **integration**, not e2e.
- Same span but driven purely **SDK-in / SDK + logs-out** → **e2e**.
- One function that touches the **clock or SDK** → **integration**, not unit.
- "Whole app" is a *consequence* of the external-seam rule for e2e, not its definition.

## Reshaping an integration test into e2e: only where there's an observable effect

A common temptation is to treat every `createApp` + `getLatestTargetSnapshotForTests` /
`getLatestPlanSnapshotForTests` spec as "an e2e wearing integration clothes." It usually
isn't. The deciding question is **does the scenario produce an externally observable effect?**

- **Control / effect behaviour** (shed turns a device off, a command is issued, a capability is
  written, a notification fires) → **reshapeable to e2e.** Drive the input through the SDK seam
  (e.g. report total power via the real `getEnergyLiveReport` poll, not by reaching into
  `powerSamplePipeline.recordPowerSample`), and assert on the SDK effect (`api.put(...)`) +
  structured logs. Drop the snapshot/plan reads. See
  `test/e2e/onoffShedControl.e2e.test.ts` (extracted from the on/off integration spec).
- **Classification / estimation internals** (which power source PELS picked, `expectedPowerKw`,
  whether a device is included in the snapshot) where the scenario **takes no action** → **stays
  integration.** There is no SDK effect or distinctive log to observe, so a "pure black-box"
  rewrite would have to *fabricate* observability (add production logs just to test). Don't —
  that's the tail wagging the dog. The on/off integration spec keeps exactly these cases.

So a reshape often **splits** a spec: the effect-producing cases move to `e2e/`; the
classification cases stay in `integration/`. Don't force-convert a whole file.

### Device-suite disposition (worked example)

Surveying the seven device integration suites against this rule:

| Suite | Outcome |
|---|---|
| `onoff`, `heatpump`, `airtreatment` | **Reshaped** — capacity shedding writes an observable capability (`onoff:false` / lowered `target_temperature`). Effect cases → `test/e2e/*ShedControl.e2e.test.ts`. |
| `airconditioning`, `flowBacked`, `unsupported` | **Stay integration** — classification/estimation only; no scenario takes a commandable action. |
| `vthermo` | **Stays integration** — its one effect case is price-only mode-setpoint application, not capacity shedding. |
| `ev` | **Stays integration** — the charger command log is already device-observable, but the suite's purpose is shed→cooldown→restore *hysteresis*, which it tests by manipulating `planEngine.state.lastRecoveryMs` / `capacityGuard.setSheddingActive` and asserting `plannedState`. That is intrinsically white-box (the `plan.test.ts` category). |

So even across a whole family, the reshape touched 3 of 7 suites — the count of genuinely
e2e-able specs is "scenarios with an observable effect," which is much smaller than "specs
that spin up the app via the SDK mock."

## Folder layout

```
test/
  unit/          unit-tier vitest specs
  integration/   integration-tier vitest specs
  e2e/           runtime (SDK-boundary) e2e vitest specs
  mocks/         shared SDK + contract mocks (tier-agnostic)
  helpers/       shared builders/fixtures (tier-agnostic)
  utils/         shared test utilities (tier-agnostic)
  setup.ts       global vitest setup
  tz/            timezone-sensitive specs
```

`mocks/`, `helpers/`, `utils/`, `setup.ts` are **shared infrastructure** and stay at the
`test/` root regardless of tier.

UI e2e is the exception to the folder rule: it lives in `packages/settings-ui` (Playwright),
because it drives the built UI bundle, not the runtime.

### Moving a file into a tier folder bumps its import depth

There are **no path aliases** — test files import production code with relative paths
(`../lib/...`, `../packages/...`, `./mocks/...`). Moving a file from `test/` down into
`test/<tier>/` breaks every relative import. The mechanical fix when relocating a spec:

- `'../X'` → `'../../X'`
- `'./X'` → `'../X'`

The bare `homey` import and other vitest aliases resolve absolutely (config-relative) and are
unaffected.

## Commands

| Command | Tier / scope | Engine |
|---|---|---|
| `npm run test:integration` | `test/integration/` only | vitest (fast, no coverage) |
| `npm run test:e2e:runtime` | `test/e2e/` only (SDK-boundary) | vitest (fast, no coverage) |
| `npm run test:e2e:ui` (alias of `test:e2e`) | settings-UI e2e | Playwright |
| `npm run test:unit` | **all** vitest specs, fast | vitest (fast) — see note |
| `npm run test:unit:ci` | **all** vitest specs + coverage | vitest (coverage-gated) |
| `npm run test:unit:tz` | `test/tz/` timezone specs | vitest |

The aggregate runners (`test:unit`, `test:unit:ci`) glob `test/**/*.test.ts` recursively, so
they keep running every spec regardless of which tier folder it sits in — the suite stays
green throughout the incremental migration below.

**End-state intent:** once the migration completes and every spec lives under a tier folder,
`test:unit` narrows to `test/unit/`, and the three tier commands partition the runtime suite
cleanly. Until then `test:unit` keeps its legacy "run the whole fast vitest suite" meaning to
avoid silently skipping un-migrated specs. Do not re-scope it early.

## Migration status (incremental)

The taxonomy was adopted in waves:

1. Folder scaffolding + the already-named specs (`*.integration.test.ts`, `*.unit.test.ts`,
   `deferredObjective*E2E`).
2. The *obviously-classified* specs: app/SDK-harness tests (`createApp`, `mockHomeyInstance`,
   `setMockDrivers`, `MockDevice`) → `integration/`; specs importing exactly one concrete
   production file with no SDK mock → `unit/`; `*E2E`-named → `e2e/`.

~165 flat `test/*.test.ts` specs remain — the ones whose tier needs per-file judgment
(multi-subsystem imports without the app harness, SDK-mock-but-no-app, and the
environment-special `*Browser.test.ts` / `settings-ui.test.ts` / `*.perf.test.ts`, which are
pinned by explicit include lists in the dom/perf vitest configs and need those lists updated
when moved). They migrate opportunistically — when you touch a spec, move it into its tier
folder (bumping import depth per the rule above, then `knip` to catch type-only-import depth
errors) as part of the same change. Tracked in `TODO.md`.

When in doubt about a flat spec's tier, apply the two border-case rules above; if it still
isn't obvious, it is probably an integration test wearing a unit test's clothes.
