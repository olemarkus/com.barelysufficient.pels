import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_BOOTSTRAP_KEYS,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH,
  SETTINGS_UI_REFRESH_DEVICES_PATH,
} from '../../contracts/src/settingsUiApi.ts';
import { UNMANAGED_RESERVE_MODE } from '../../contracts/src/dailyBudgetConstants.ts';
import { createHomeyMock, getUnhandledDeclaredHomeyApiRoutes, type MockHomeyClient } from './helpers/homeyApiMock';

const callHomeyApi = async (
  homey: MockHomeyClient,
  method: string,
  uri: string,
  body?: unknown,
): Promise<unknown> => new Promise((resolve, reject) => {
  homey.api(method, uri, body, (err: Error | null, value: unknown) => {
    if (err) {
      reject(err);
      return;
    }
    resolve(value);
  });
});

describe('homeyApiMock', () => {
  it('provides a mock handler for every route declared in app.json', () => {
    expect(getUnhandledDeclaredHomeyApiRoutes()).toEqual([]);
  });

  it('builds bootstrap settings from the production key list', async () => {
    const deviceControlProfiles = {
      'device-1': { model: 'stepped_load', steps: [] },
    };
    const homey = createHomeyMock({
      settings: {
        device_control_profiles: deviceControlProfiles,
        device_driver_overrides: { 'device-1': 'driver-override' },
      },
    });

    const result = await callHomeyApi(homey, 'GET', SETTINGS_UI_BOOTSTRAP_PATH);

    expect(result).toEqual(expect.objectContaining({
      settings: expect.objectContaining({
        device_control_profiles: deviceControlProfiles,
        device_driver_overrides: { 'device-1': 'driver-override' },
      }),
    }));
    expect(Object.keys((result as { settings: Record<string, unknown> }).settings))
      .toEqual([...SETTINGS_UI_BOOTSTRAP_KEYS]);
  });

  it('normalizes the daily budget preview request body as preview settings', async () => {
    const homey = createHomeyMock({
      settings: {
        daily_budget_enabled: false,
        daily_budget_kwh: 30,
        daily_budget_price_shaping_enabled: false,
      },
    });
    const body = {
      enabled: true,
      dailyBudgetKWh: 24,
      priceShapingEnabled: true,
      priceShapingFlexShare: 1.5,
    };

    const result = await callHomeyApi(homey, 'POST', SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH, body);

    expect(result).toEqual(expect.objectContaining({
      settings: {
        enabled: true,
        dailyBudgetKWh: 24,
        priceShapingEnabled: true,
        controlledUsageWeight: UNMANAGED_RESERVE_MODE,
        priceShapingFlexShare: 1,
      },
    }));
    expect((result as { settings: Record<string, unknown> }).settings).not.toHaveProperty('method');
    expect((result as { settings: Record<string, unknown> }).settings).not.toHaveProperty('uri');
    expect((result as { settings: Record<string, unknown> }).settings).not.toHaveProperty('daily_budget_kwh');
  });

  it('rejects enabled daily budget preview requests outside production bounds', async () => {
    const homey = createHomeyMock();

    await expect(callHomeyApi(homey, 'POST', SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH, {
      enabled: true,
      dailyBudgetKWh: 5,
    })).rejects.toThrow('Daily budget must be between 20 and 360 kWh.');
  });

  describe('device endpoints', () => {
    it('serves zero devices from /ui_devices when none are configured', async () => {
      const homey = createHomeyMock();

      await expect(callHomeyApi(homey, 'GET', SETTINGS_UI_DEVICES_PATH))
        .resolves.toEqual({ devices: [] });
    });

    it('serves the explicit uiState.devices array from /ui_devices', async () => {
      const homey = createHomeyMock({
        uiState: {
          devices: [
            { id: 'dev-1', name: 'Heater', targets: [], currentOn: true },
            { id: 'dev-2', name: 'EV', targets: [], currentOn: false },
          ],
        },
      });

      const result = await callHomeyApi(homey, 'GET', SETTINGS_UI_DEVICES_PATH);

      expect(result).toEqual({
        devices: [
          { id: 'dev-1', name: 'Heater', targets: [], currentOn: true },
          { id: 'dev-2', name: 'EV', targets: [], currentOn: false },
        ],
      });
    });

    it('returns the same explicit array shape from /ui_refresh_devices', async () => {
      const homey = createHomeyMock({
        uiState: {
          devices: [{ id: 'dev-1', name: 'Heater', targets: [], currentOn: true }],
        },
      });

      await expect(callHomeyApi(homey, 'POST', SETTINGS_UI_REFRESH_DEVICES_PATH))
        .resolves.toEqual({
          devices: [{ id: 'dev-1', name: 'Heater', targets: [], currentOn: true }],
        });
    });

    it('falls back to target_devices_snapshot when uiState.devices is omitted (deprecated)', async () => {
      const homey = createHomeyMock({
        settings: {
          target_devices_snapshot: [
            { id: 'legacy-1', name: 'Legacy', targets: [], currentOn: true },
          ],
        },
      });

      await expect(callHomeyApi(homey, 'GET', SETTINGS_UI_DEVICES_PATH))
        .resolves.toEqual({
          devices: [
            { id: 'legacy-1', name: 'Legacy', targets: [], currentOn: true },
          ],
        });
    });

    it('prefers explicit uiState.devices over target_devices_snapshot setting', async () => {
      const homey = createHomeyMock({
        settings: {
          target_devices_snapshot: [
            { id: 'should-be-ignored', name: 'Legacy', targets: [], currentOn: true },
          ],
        },
        uiState: {
          devices: [
            { id: 'served', name: 'Live', targets: [], currentOn: false },
          ],
        },
      });

      await expect(callHomeyApi(homey, 'GET', SETTINGS_UI_DEVICES_PATH))
        .resolves.toEqual({
          devices: [
            { id: 'served', name: 'Live', targets: [], currentOn: false },
          ],
        });
    });
  });
});
