jest.mock('../src/ui/homey', () => ({
  callApi: jest.fn().mockResolvedValue(undefined),
}));

describe('settings UI network failure logging', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-05T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits stable structured fields and tracks consecutive failures across a success boundary', async () => {
    const { callApi } = jest.requireMock('../src/ui/homey') as { callApi: jest.Mock };
    const {
      isSettingsUiNetworkFailureLogged,
      withSettingsUiNetworkFailureTracking,
    } = require('../src/ui/logging') as typeof import('../src/ui/logging');

    const meta = {
      component: 'settings-ui',
      event: 'refresh',
      endpoint: '/ui_prices',
      refreshLoop: 'refreshPrices',
      message: 'Failed to load prices',
    };

    await withSettingsUiNetworkFailureTracking(meta, async () => undefined);

    jest.setSystemTime(new Date('2026-04-05T10:00:05.000Z'));
    let firstError: unknown;
    try {
      await withSettingsUiNetworkFailureTracking(meta, async () => {
        throw new TypeError('fetch failed');
      });
    } catch (error) {
      firstError = error;
    }

    expect(isSettingsUiNetworkFailureLogged(firstError)).toBe(true);

    const firstPayload = callApi.mock.calls[0][2] as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      level: 'error',
      message: 'Failed to load prices',
      detail: 'fetch failed',
      context: 'refreshPrices',
      component: 'settings-ui',
      event: 'refresh',
      endpoint: '/ui_prices',
      refreshLoop: 'refreshPrices',
      errorType: 'TypeError',
      consecutiveFailureCount: 1,
      timeSinceLastSuccessMs: 5000,
    });

    jest.setSystemTime(new Date('2026-04-05T10:00:09.000Z'));
    let secondError: unknown;
    try {
      await withSettingsUiNetworkFailureTracking(meta, async () => {
        throw new TypeError('fetch failed again');
      });
    } catch (error) {
      secondError = error;
    }

    expect(isSettingsUiNetworkFailureLogged(secondError)).toBe(true);

    const secondPayload = callApi.mock.calls[1][2] as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      message: 'Failed to load prices',
      detail: 'fetch failed again',
      component: 'settings-ui',
      event: 'refresh',
      endpoint: '/ui_prices',
      refreshLoop: 'refreshPrices',
      errorType: 'TypeError',
      consecutiveFailureCount: 2,
      timeSinceLastSuccessMs: 9000,
    });
  });
});
