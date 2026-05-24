/**
 * Parity tests for the audit scenario fixtures.
 *
 * The browser stub (`packages/settings-ui/tests/e2e/fixtures/homey.stub.js`)
 * defines `BROWSER_AUDIT_SCENARIOS`; the unit-test helper
 * (`packages/settings-ui/test/helpers/auditScenarios.ts`) defines
 * `AUDIT_SCENARIO_NAMES` and `SCENARIO_FACTORIES`. They must mirror each
 * other so a single mental model covers both surfaces.
 *
 * This test enforces:
 * - Both surfaces expose the same scenario names in the same order.
 * - Every typed scenario produces a contract-shaped patch (compile-time
 *   safety covers most of this; the explicit assertions defend against
 *   accidental `as` casts being added in the future).
 * - Every browser scenario round-trips through `/ui_bootstrap` and all 16
 *   declared routes without throwing — the previous gap (where the stub had
 *   ~10 routes and the runtime declared 18) is regression-pinned here.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  AUDIT_SCENARIO_NAMES,
  AUDIT_SCENARIOS,
  buildAuditScenario,
} from './helpers/auditScenarios';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const stubPath = path.join(
  repoRoot,
  'packages',
  'settings-ui',
  'tests',
  'e2e',
  'fixtures',
  'homey.stub.js',
);

type BrowserStub = {
  listAuditScenarios: () => string[];
  applyAuditScenario: (name: string | null) => void;
  clearAuditScenario: () => void;
  getActiveAuditScenario: () => string | null;
  api: (
    method: string,
    uri: string,
    bodyOrCallback?: unknown,
    cb?: (err: Error | null, value?: unknown) => void,
  ) => void;
};

const loadBrowserStub = (): BrowserStub => {
  // `url` must be a real http(s) origin so JSDOM exposes `localStorage` — the
  // stub reads `localStorage.setItem('pels.settingsUi.overviewRedesignEnabled', 'true')`
  // at boot. An opaque origin (the default) throws SecurityError.
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const stubSource = readFileSync(stubPath, 'utf8');
  // Use the VM module instead of dom.window.eval to keep the stub execution
  // explicit and to satisfy the static-analysis ban on eval(). The stub is
  // an IIFE that mutates `window.Homey`, so we pass the JSDOM window in as
  // the global.
  const ctx = vm.createContext({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(stubSource, ctx, { filename: stubPath });
  const homey = (dom.window as unknown as { Homey?: { __stub?: unknown; api?: unknown } }).Homey;
  if (!homey || !homey.__stub) {
    throw new Error('Stub did not install window.Homey.__stub');
  }
  const stubApi = homey.__stub as {
    listAuditScenarios: () => string[];
    applyAuditScenario: (name: string | null) => void;
    clearAuditScenario: () => void;
    getActiveAuditScenario: () => string | null;
  };
  return {
    listAuditScenarios: stubApi.listAuditScenarios,
    applyAuditScenario: stubApi.applyAuditScenario,
    clearAuditScenario: stubApi.clearAuditScenario,
    getActiveAuditScenario: stubApi.getActiveAuditScenario,
    api: homey.api as BrowserStub['api'],
  };
};

const callApi = (
  stub: BrowserStub,
  method: string,
  uri: string,
): Promise<unknown> => new Promise((resolve, reject) => {
  stub.api(method, uri, (err: Error | null, value?: unknown) => {
    if (err) reject(err);
    else resolve(value);
  });
});

describe('audit scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expose the same scenario names on both surfaces', () => {
    const stub = loadBrowserStub();
    const browserNames = stub.listAuditScenarios();
    expect(browserNames).toEqual([...AUDIT_SCENARIO_NAMES]);
  });

  it.each(AUDIT_SCENARIO_NAMES)('typed scenario "%s" has a contract-shaped patch', (name) => {
    const scenario = buildAuditScenario(name);
    expect(typeof scenario.description).toBe('string');
    expect(scenario.description.length).toBeGreaterThan(0);
    if (scenario.dailyBudget !== undefined && scenario.dailyBudget !== null) {
      expect(scenario.dailyBudget.days).toBeDefined();
      expect(typeof scenario.dailyBudget.todayKey).toBe('string');
    }
    if (scenario.plan && scenario.plan.devices) {
      expect(Array.isArray(scenario.plan.devices)).toBe(true);
    }
    if (scenario.power) {
      expect(scenario.power).toHaveProperty('status');
    }
    if (scenario.deferredObjectiveActivePlans) {
      expect(scenario.deferredObjectiveActivePlans.version).toBe(1);
      expect(typeof scenario.deferredObjectiveActivePlans.plansByDeviceId).toBe('object');
    }
    if (scenario.deferredObjectiveHistory) {
      expect(scenario.deferredObjectiveHistory.version).toBe(1);
    }
  });

  it('exposes every typed scenario as a factory', () => {
    for (const name of AUDIT_SCENARIO_NAMES) {
      expect(typeof AUDIT_SCENARIOS[name]).toBe('function');
    }
  });

  it('round-trips each browser scenario through the bootstrap route without runtime errors', async () => {
    const stub = loadBrowserStub();
    for (const name of stub.listAuditScenarios()) {
      stub.applyAuditScenario(name);
      expect(stub.getActiveAuditScenario()).toBe(name);
      const bootstrap = await callApi(stub, 'GET', '/ui_bootstrap');
      expect(bootstrap).toBeTruthy();
      expect((bootstrap as { settings?: unknown }).settings).toBeDefined();
      expect((bootstrap as { plan?: unknown }).plan).toBeDefined();
      expect((bootstrap as { power?: unknown }).power).toBeDefined();
      expect((bootstrap as { prices?: unknown }).prices).toBeDefined();
      // Contract field — must be present after the bootstrap fix in this PR.
      expect((bootstrap as { deferredObjectiveActivePlans?: unknown }).deferredObjectiveActivePlans)
        .toBeDefined();
    }
    stub.clearAuditScenario();
    expect(stub.getActiveAuditScenario()).toBeNull();
  });

  it('rejects an unknown scenario name with a helpful message', () => {
    const stub = loadBrowserStub();
    expect(() => stub.applyAuditScenario('does-not-exist')).toThrow(/Unknown audit scenario/);
  });

  it('serves every declared route after a scenario is applied', async () => {
    const stub = loadBrowserStub();
    stub.applyAuditScenario('pressure');
    const routes: Array<[string, string]> = [
      ['GET', '/ui_bootstrap'],
      ['GET', '/ui_devices'],
      ['GET', '/ui_plan'],
      ['GET', '/ui_power'],
      ['GET', '/ui_prices'],
      ['GET', '/ui_device_diagnostics'],
      ['GET', '/ui_deferred_objective_history'],
      ['GET', '/daily_budget'],
      ['GET', '/homey_devices'],
      ['POST', '/ui_refresh_devices'],
      ['POST', '/ui_refresh_prices'],
      ['POST', '/ui_refresh_grid_tariff'],
      ['POST', '/ui_recompute_daily_budget'],
      ['POST', '/ui_reset_power_stats'],
      ['POST', '/settings_ui_log'],
      ['POST', '/log_homey_device'],
    ];
    for (const [method, uri] of routes) {
      await expect(callApi(stub, method, uri)).resolves.not.toBeNull();
    }
  });
});
