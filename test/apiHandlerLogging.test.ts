// Regression: every `ui_*` API handler used to be a bare `async` return. When
// the wrapped helper threw, Homey's transport surfaced a generic "Network
// request failed" on the client and the actual cause never reached
// `/tmp/pels` via `app.error`. The `withApiLogging` wrapper in `api.ts` now
// guarantees both: log on the server, rethrow so the client sees the real
// failure.

vi.mock('../lib/app/settingsUiApi', () => ({
  buildSettingsUiBootstrap: vi.fn(),
  getSettingsUiDevicesPayload: vi.fn(),
  getSettingsUiPlanPayload: vi.fn(),
  getSettingsUiPowerPayload: vi.fn(),
  getSettingsUiPricesPayload: vi.fn(),
  getSettingsUiDeviceDiagnosticsPayload: vi.fn(),
  getSettingsUiDeferredObjectivePlanHistoryPayload: vi.fn(),
  recomputeSettingsUiDailyBudget: vi.fn(),
  previewSettingsUiDailyBudgetModel: vi.fn(),
  applySettingsUiDailyBudgetModel: vi.fn(),
  refreshSettingsUiDevices: vi.fn(),
  refreshSettingsUiPrices: vi.fn(),
  refreshSettingsUiGridTariff: vi.fn(),
  resetSettingsUiPowerStats: vi.fn(),
  logSettingsUiMessage: vi.fn(),
}));

vi.mock('../lib/app/appDebugHelpers', () => ({
  getHomeyDevicesForDebugFromApp: vi.fn(),
  logHomeyDeviceForDebugFromApp: vi.fn(),
}));

import api from '../api';
import * as stubs from '../lib/app/settingsUiApi';

type AppMock = { error: ReturnType<typeof vi.fn> };
type HomeyMock = { app: AppMock };
type Handler = (ctx: { homey: HomeyMock }) => Promise<unknown>;

const buildHomey = (): HomeyMock => ({ app: { error: vi.fn() } });

const cases: Array<{
  handler: keyof typeof api;
  stub: keyof typeof stubs;
  logName: string;
}> = [
  { handler: 'ui_bootstrap', stub: 'buildSettingsUiBootstrap', logName: 'api ui_bootstrap failed' },
  { handler: 'ui_devices', stub: 'getSettingsUiDevicesPayload', logName: 'api ui_devices failed' },
  { handler: 'ui_plan', stub: 'getSettingsUiPlanPayload', logName: 'api ui_plan failed' },
  { handler: 'ui_power', stub: 'getSettingsUiPowerPayload', logName: 'api ui_power failed' },
  { handler: 'ui_prices', stub: 'getSettingsUiPricesPayload', logName: 'api ui_prices failed' },
  { handler: 'ui_device_diagnostics', stub: 'getSettingsUiDeviceDiagnosticsPayload', logName: 'api ui_device_diagnostics failed' },
  { handler: 'ui_deferred_objective_history', stub: 'getSettingsUiDeferredObjectivePlanHistoryPayload', logName: 'api ui_deferred_objective_history failed' },
  { handler: 'ui_recompute_daily_budget', stub: 'recomputeSettingsUiDailyBudget', logName: 'api ui_recompute_daily_budget failed' },
];

const stubFor = (name: keyof typeof stubs): ReturnType<typeof vi.fn> => (
  stubs[name] as unknown as ReturnType<typeof vi.fn>
);

beforeEach(() => {
  for (const { stub } of cases) stubFor(stub).mockReset();
});

describe('api handler error logging', () => {
  it('falls back to console.error when homey.app is not wired (restart window)', async () => {
    const cause = new Error('bootstrap blew up before app was ready');
    stubFor('buildSettingsUiBootstrap').mockImplementation(() => { throw cause; });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // homey present but homey.app missing — this is the early-restart shape
      // where Homey hands the API a context before the app is constructed.
      await expect(
        (api as Record<string, (ctx: { homey: { app?: undefined } }) => Promise<unknown>>)
          .ui_bootstrap({ homey: {} as never }),
      ).rejects.toBe(cause);
      expect(consoleSpy).toHaveBeenCalledExactlyOnceWith('api ui_bootstrap failed', cause);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  for (const { handler, stub, logName } of cases) {
    it(`${handler}: rethrows handler errors and logs them via app.error before the client sees a transport failure`, async () => {
      const homey = buildHomey();
      const cause = new Error(`${handler} blew up`);
      stubFor(stub).mockImplementation(() => { throw cause; });

      const fn = (api as Record<string, Handler>)[handler];
      await expect(fn({ homey })).rejects.toBe(cause);
      expect(homey.app.error).toHaveBeenCalledExactlyOnceWith(logName, cause);
    });

    it(`${handler}: passes through successful responses without logging`, async () => {
      const homey = buildHomey();
      const result = { ok: true, handler };
      stubFor(stub).mockReturnValue(result);

      const fn = (api as Record<string, Handler>)[handler];
      await expect(fn({ homey })).resolves.toBe(result);
      expect(homey.app.error).not.toHaveBeenCalled();
    });
  }
});
