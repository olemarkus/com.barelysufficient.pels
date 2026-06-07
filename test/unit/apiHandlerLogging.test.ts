// Regression: every `ui_*` API handler used to be a bare `async` return. When
// the wrapped helper threw, Homey's transport surfaced a generic "Network
// request failed" on the client and the actual cause never reached
// `/tmp/pels` via the structured logger. The `withApiLogging` wrapper in
// `api.ts` now guarantees both: emit a structured `api_handler_failed` event on
// the server, rethrow so the client sees the real failure.

vi.mock('../../setup/settingsUiApi', () => ({
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

vi.mock('../../setup/appDebugHelpers', () => ({
  getHomeyDevicesForDebugFromApp: vi.fn(),
  logHomeyDeviceForDebugFromApp: vi.fn(),
}));

import api from '../../api';
import * as stubs from '../../setup/settingsUiApi';

type LoggerMock = { error: ReturnType<typeof vi.fn> };
type AppMock = { getApiStructuredLogger: ReturnType<typeof vi.fn> };
type HomeyMock = { app: AppMock };
type Handler = (ctx: { homey: HomeyMock }) => Promise<unknown>;

const buildHomey = (): { homey: HomeyMock; logger: LoggerMock } => {
  const logger: LoggerMock = { error: vi.fn() };
  return { homey: { app: { getApiStructuredLogger: vi.fn(() => logger) } }, logger };
};

const cases: Array<{
  handler: keyof typeof api;
  stub: keyof typeof stubs;
}> = [
  { handler: 'ui_bootstrap', stub: 'buildSettingsUiBootstrap' },
  { handler: 'ui_devices', stub: 'getSettingsUiDevicesPayload' },
  { handler: 'ui_plan', stub: 'getSettingsUiPlanPayload' },
  { handler: 'ui_power', stub: 'getSettingsUiPowerPayload' },
  { handler: 'ui_prices', stub: 'getSettingsUiPricesPayload' },
  { handler: 'ui_device_diagnostics', stub: 'getSettingsUiDeviceDiagnosticsPayload' },
  { handler: 'ui_deferred_objective_history', stub: 'getSettingsUiDeferredObjectivePlanHistoryPayload' },
  { handler: 'ui_recompute_daily_budget', stub: 'recomputeSettingsUiDailyBudget' },
];

const stubFor = (name: keyof typeof stubs): ReturnType<typeof vi.fn> => (
  stubs[name] as unknown as ReturnType<typeof vi.fn>
);

beforeEach(() => {
  for (const { stub } of cases) stubFor(stub).mockReset();
});

describe('api handler error logging', () => {
  it('falls back to console.error when the structured logger is not wired (restart window)', async () => {
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

  for (const { handler, stub } of cases) {
    it(`${handler}: rethrows handler errors and emits a structured api_handler_failed event before the client sees a transport failure`, async () => {
      const { homey, logger } = buildHomey();
      const cause = new Error(`${handler} blew up`);
      stubFor(stub).mockImplementation(() => { throw cause; });

      const fn = (api as Record<string, Handler>)[handler];
      await expect(fn({ homey })).rejects.toBe(cause);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ event: 'api_handler_failed', handler, err: cause }),
      );
    });

    it(`${handler}: passes through successful responses without logging`, async () => {
      const { homey, logger } = buildHomey();
      const result = { ok: true, handler };
      stubFor(stub).mockReturnValue(result);

      const fn = (api as Record<string, Handler>)[handler];
      await expect(fn({ homey })).resolves.toBe(result);
      expect(logger.error).not.toHaveBeenCalled();
    });
  }
});
