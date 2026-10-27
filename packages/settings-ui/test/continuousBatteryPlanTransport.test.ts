import { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG as defaults } from '../../shared-domain/src/settings/continuousBatteryPlan.ts';

const callApi = vi.fn();
const getApiReadModel = vi.fn();
const getSettingFresh = vi.fn();
const setSetting = vi.fn();
const invalidateApiCache = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({ callApi, getApiReadModel, getSettingFresh, setSetting, invalidateApiCache }));
const { loadContinuousBatteryPlan, saveContinuousBatteryPlanConfig } = await import('../src/ui/deviceDetail/continuousBatteryPlanTransport.ts');

const key = 'continuous_battery_plan';
const config = { ...defaults, enabled: true, priceUnit: 'EUR' };
const waiting = { status: 'waiting', config, reason: 'prices_unavailable' };

beforeEach(() => {
  callApi.mockReset().mockResolvedValue({ priceTimeline: { state: 'ready', priceUnit: 'EUR' } });
  getApiReadModel.mockReset().mockResolvedValue({ inverterDevices: [], continuousBatteryPlans: { battery: waiting } });
  getSettingFresh.mockReset().mockResolvedValue({});
  setSetting.mockReset().mockResolvedValue(undefined);
  invalidateApiCache.mockClear();
});

test('reads the owner result from the existing shared device read model', async () => {
  expect(await loadContinuousBatteryPlan('battery')).toEqual(waiting);
  expect(getApiReadModel).toHaveBeenCalledExactlyOnceWith('/ui_devices');
  expect(callApi).not.toHaveBeenCalled();
});

test.each([
  { continuousBatteryPlans: {} },
  { continuousBatteryPlans: { battery: waiting }, homeScope: { state: 'unavailable' } },
  { continuousBatteryPlans: { battery: { ...waiting, config: { ...config, usableCapacityKWh: Number.NaN } } } },
])('refuses an unavailable or malformed device read rather than showing planning off', async (payload) => {
  getApiReadModel.mockResolvedValue(payload);
  await expect(loadContinuousBatteryPlan('battery')).rejects.toThrow('unavailable');
});

test('does not resolve inherited map entries as battery plans', async () => {
  getApiReadModel.mockResolvedValue({ continuousBatteryPlans: Object.create({ battery: waiting }) });
  await expect(loadContinuousBatteryPlan('battery')).rejects.toThrow('unavailable');
});

test('preserves invisible settings entries and invalidates the existing device cache after save', async () => {
  const hidden = { ...defaults, usableCapacityKWh: 17, priceUnit: 'øre' };
  getSettingFresh.mockResolvedValue({ invisible: hidden });
  expect(await saveContinuousBatteryPlanConfig('battery', config)).toEqual(config);
  expect(getSettingFresh).toHaveBeenCalledExactlyOnceWith(key);
  expect(setSetting).toHaveBeenCalledExactlyOnceWith(key, { invisible: hidden, battery: config });
  expect(callApi).toHaveBeenCalledExactlyOnceWith('GET', '/ui_prices');
  expect(invalidateApiCache).toHaveBeenCalledWith('/ui_devices');
});

test('confirms a null first read with uncached owner bootstrap before the first save', async () => {
  getSettingFresh.mockResolvedValue(null);
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_bootstrap'
    ? { settings: { [key]: {} } } : { priceTimeline: { state: 'ready', priceUnit: 'EUR' } });
  await saveContinuousBatteryPlanConfig('battery', config);
  expect(callApi).toHaveBeenCalledWith('GET', '/ui_bootstrap');
  expect(getApiReadModel).not.toHaveBeenCalled();
  expect(setSetting).toHaveBeenCalledWith(key, { battery: config });
});

test('a fresh owner map after a WebView miss preserves entries not shown in the roster', async () => {
  getSettingFresh.mockResolvedValue(undefined);
  callApi.mockResolvedValue({ settings: { [key]: { invisible: { ...defaults, priceUnit: 'EUR' } } } });
  await saveContinuousBatteryPlanConfig('battery', { ...config, enabled: false });
  expect(setSetting).toHaveBeenCalledWith(key, {
    invisible: { ...defaults, priceUnit: 'EUR' }, battery: { ...config, enabled: false },
  });
});

test.each([null, undefined, { battery: { ...config, roundTripEfficiency: 0 } }])(
  'refuses an unavailable owner bootstrap map after a null fresh read', async (ownerMap) => {
    getSettingFresh.mockResolvedValue(null);
    callApi.mockResolvedValue({ settings: { [key]: ownerMap } });
    await expect(saveContinuousBatteryPlanConfig('battery', config)).rejects.toThrow('unavailable');
    expect(setSetting).not.toHaveBeenCalled();
  },
);

test('a malformed fresh map does not fall back to bootstrap or an earlier accepted map', async () => {
  getSettingFresh.mockResolvedValue({ invisible: { enabled: true } });
  await expect(saveContinuousBatteryPlanConfig('battery', config)).rejects.toThrow('could not be read');
  expect(callApi).not.toHaveBeenCalled();
  expect(setSetting).not.toHaveBeenCalled();
});

test('refuses a second enabled battery without changing the complete map', async () => {
  getSettingFresh.mockResolvedValue({ invisible: config });
  await expect(saveContinuousBatteryPlanConfig('battery', config)).rejects.toThrow('other battery plan');
  expect(setSetting).not.toHaveBeenCalled();
});

test('checks the live unit before enabling and preserves old economics when disabling', async () => {
  callApi.mockResolvedValue({ priceTimeline: { state: 'ready', priceUnit: 'øre' } });
  await expect(saveContinuousBatteryPlanConfig('battery', config)).rejects.toThrow('price unit changed');
  expect(setSetting).not.toHaveBeenCalled();
  callApi.mockClear();
  await saveContinuousBatteryPlanConfig('battery', { ...config, enabled: false });
  expect(callApi).not.toHaveBeenCalled();
  expect(setSetting).toHaveBeenCalledWith(key, { battery: { ...config, enabled: false } });
});
