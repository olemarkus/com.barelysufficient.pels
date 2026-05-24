# Browser Homey Stub — Audit Scenario Framework

The settings UI runs in a browser inside Homey's WebView and talks to a small
Homey SDK via `window.Homey`. For Playwright tests, screenshot audits, and
local development we replace that SDK with a stub
(`packages/settings-ui/tests/e2e/fixtures/homey.stub.js`) that fabricates
responses for every declared API route.

**Audit scenarios** are named, coherent overrides that flip the SDK-boundary
responses to render a specific UI state on demand.

## Six built-in scenarios

| Name | Intent |
|------|--------|
| `normal` | Baseline. Matches the stub's long-standing defaults. |
| `pressure` | Capacity guard active; soft limit exceeded; two devices planned to shed. |
| `over-budget` | Daily budget exhausted; over-budget chip should appear. |
| `missing-price` | Price feed unavailable; all price arrays null. |
| `empty-history` | No smart-task history; past-tasks zero state. |
| `dense-device` | Twelve controllable thermostats; scroll/density stress. |

## Architectural rule: audit state lives at the SDK boundary

Scenarios are applied by varying what `Homey.api(...)` returns. No scenario
flag flows into a UI component. Toggling scenarios re-paints by re-firing the
bootstrap fetch; the UI under audit is identical to production.

In code: `runtimeOverrides.scenarioPatch` in `homey.stub.js` is consulted by
the resolvers (`buildPowerPayload`, `resolveDailyBudgetPayload`,
`resolveActivePlansPayload`, `resolveDeferredObjectiveHistoryPayload`,
`resolveDeviceDiagnosticsPayload`, `buildPlanPayload`) before falling back
to baseline. Scenarios that need a settings value (e.g. `over-budget`) write
into the stub's `settings` map so `Homey.get(key)` reads see the right value.

## Usage from a Playwright test

```ts
// Boot-time:
await page.addInitScript(() => {
  (window as any).__PELS_HOMEY_STUB__ = { scenario: 'pressure' };
});

// Mid-test:
await page.evaluate(() => {
  (window as any).Homey.__stub.applyAuditScenario('over-budget');
});

// Inspect / clear:
await page.evaluate(() => (window as any).Homey.__stub.listAuditScenarios());
await page.evaluate(() => (window as any).Homey.__stub.getActiveAuditScenario());
await page.evaluate(() => (window as any).Homey.__stub.clearAuditScenario());
```

## Usage from a Vitest unit test

```ts
import { buildAuditScenario } from '../helpers/auditScenarios';
import { installHomeyMock } from '../helpers/homeyApiMock';

const scenario = buildAuditScenario('pressure');
installHomeyMock({
  settings: scenario.settings ?? {},
  uiState: {
    dailyBudget: scenario.dailyBudget,
    deferredObjectiveActivePlans: scenario.deferredObjectiveActivePlans,
    deferredObjectiveHistory: scenario.deferredObjectiveHistory,
    plan: scenario.plan,
    power: scenario.power,
  },
});
```

`uiState` flows through the same `buildUiBootstrap` resolvers the helper
already uses, so override points are identical to the browser stub's.

## Add a new scenario

1. Add the name to `AUDIT_SCENARIO_NAMES` in
   `packages/settings-ui/test/helpers/auditScenarios.ts`.
2. Add a factory entry to `SCENARIO_FACTORIES` returning a
   `BootstrapAuditScenario` using the typed contracts
   (`SettingsUiBootstrap`, `SettingsUiPlanSnapshot`, …). No `as any` casts.
3. Mirror the same name in `BROWSER_AUDIT_SCENARIOS` in
   `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`.
4. Add a row in the table above.

The parity test `packages/settings-ui/test/auditScenarios.test.ts` will fail
if step 3 or the description is missing.

## Route coverage

The browser stub serves every route declared in `app.json` (verified by
`auditScenarios.test.ts > serves every declared route after a scenario is
applied`). When you add a new `app.json#api` entry, add a matching handler
in `homey.stub.js#apiHandlers` and in
`packages/settings-ui/test/helpers/homeyApiMock.ts#DEFAULT_HOMEY_API_HANDLER_FACTORIES`.
The `homeyApiMock` Vitest suite catches a missing helper entry first.
