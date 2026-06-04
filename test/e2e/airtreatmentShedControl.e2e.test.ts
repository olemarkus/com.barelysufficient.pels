// SDK-boundary e2e for airtreatment / thermostat-class capacity shedding.
//
// Nothing internal is mocked. Devices and total home power both arrive through the
// real Homey Web API (`api.get` — the SDK seam): the device list on its path, and the
// `cumulative` energy total on `manager/energy/live`. The only assertions are on what
// PELS writes back through the SDK (`api.put` device-capability commands). No
// plan/target snapshot reads, no `computeDynamicSoftLimit` override.
//
// Counterpart to test/integration/airtreatmentDevices.integration.test.ts, which keeps
// the power-estimation / overshoot-normalisation classification cases.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

type DeviceOverrides = {
  id?: string;
  class?: string;
  capabilities?: string[];
  targetTemperature?: number;
  measurePower?: number;
  onoff?: boolean;
};

const buildTemperatureApiDevice = (o: DeviceOverrides = {}) => {
  const capabilities = o.capabilities ?? ['measure_power', 'measure_temperature', 'target_temperature', 'fan_mode'];
  const capabilitiesObj: Record<string, { id: string; value: unknown; units?: string; min?: number; max?: number; step?: number }> = {
    measure_power: { id: 'measure_power', value: o.measurePower ?? 245.73 },
    measure_temperature: { id: 'measure_temperature', value: 18, units: '°C' },
    target_temperature: { id: 'target_temperature', value: o.targetTemperature ?? 19, units: '°C', min: 10, max: 30, step: 0.5 },
    fan_mode: { id: 'fan_mode', value: 'home' },
  };
  if (capabilities.includes('onoff')) {
    capabilitiesObj.onoff = { id: 'onoff', value: o.onoff ?? true };
  }
  return {
    id: o.id ?? 'airtreatment-1',
    name: 'Nordic S4 REL',
    class: o.class ?? 'airtreatment',
    virtualClass: null,
    capabilities,
    capabilitiesObj,
    settings: {},
  };
};

// Stub the SDK boundary on the two wire paths the app actually GETs — the device list
// (`manager/devices/device`) and the `cumulative` home-power total
// (`manager/energy/live`) — and delegate every other path to the real mock so the stub
// can't mask an unexpected query.
const stubSdk = (devices: Record<string, unknown>, totalW: number) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: totalW } }] };
    }
    if (path === 'manager/devices/device') {
      return devices;
    }
    return originalGet(path);
  });
};

const enableCapacity = (deviceId: string, limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('managed_devices', { [deviceId]: true });
  mockHomeyInstance.settings.set('controllable_devices', { [deviceId]: true });
  mockHomeyInstance.settings.set('overshoot_behaviors', { [deviceId]: { action: 'turn_off' } });
};

const onoffWrites = (putSpy: ReturnType<typeof vi.spyOn>) =>
  putSpy.mock.calls.filter(([path]) => typeof path === 'string' && path.endsWith('/capability/onoff'));
const tempWrites = (putSpy: ReturnType<typeof vi.spyOn>) =>
  putSpy.mock.calls.filter(([path]) => typeof path === 'string' && path.includes('/capability/target_temperature'));

describe('Airtreatment capacity shedding (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sheds an airtreatment device by lowering target_temperature, never by onoff', async () => {
    enableCapacity('airtreatment-1', 1);
    stubSdk({ 'airtreatment-1': buildTemperatureApiDevice({ targetTemperature: 19, measurePower: 245.73 }) }, 5000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(cap('airtreatment-1', 'target_temperature'), { value: 16 });
    expect(onoffWrites(putSpy)).toHaveLength(0);
  });

  it('sheds a thermostat-class device without onoff by lowering target_temperature', async () => {
    enableCapacity('thermostat-1', 1);
    stubSdk({
      'thermostat-1': buildTemperatureApiDevice({
        id: 'thermostat-1',
        class: 'thermostat',
        capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
        targetTemperature: 12,
        measurePower: 245.73,
      }),
    }, 5000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(cap('thermostat-1', 'target_temperature'), { value: 10 });
    expect(onoffWrites(putSpy)).toHaveLength(0);
  });

  it('sheds an airtreatment device that exposes onoff by turning it off, never writing a temperature target', async () => {
    enableCapacity('airtreatment-onoff-1', 1);
    stubSdk({
      'airtreatment-onoff-1': buildTemperatureApiDevice({
        id: 'airtreatment-onoff-1',
        capabilities: ['onoff', 'measure_power', 'measure_temperature', 'target_temperature', 'fan_mode'],
        onoff: true,
        targetTemperature: 19,
        measurePower: 245.73,
      }),
    }, 5000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(cap('airtreatment-onoff-1', 'onoff'), { value: false });
    expect(tempWrites(putSpy)).toHaveLength(0);
  });
});
