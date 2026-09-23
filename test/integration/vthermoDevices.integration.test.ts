import {
  mockHomeyInstance,
  setMockDrivers,
} from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN } from '../../lib/utils/settingsKeys';

vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'] });
const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const buildVThermoApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  onoff: boolean;
  targetTemperature: number;
  measureTemperature: number;
  class: string;
  capabilities: string[];
  load: number;
  energyValueOn: number;
}>) => {
  // Homey dates every capability value it reports.
  const lastUpdated = new Date().toISOString();
  return {
    id: overrides?.id ?? 'vthermo-1',
    name: overrides?.name ?? 'Virtual Thermostat',
    class: overrides?.class ?? 'thermostat',
    virtualClass: null,
    capabilities: overrides?.capabilities ?? [
      'onoff',
      'vt_onoff',
      'target_temperature',
      'measure_temperature',
    ],
    capabilitiesObj: {
      onoff: { id: 'onoff', value: overrides?.onoff ?? true, lastUpdated },
      target_temperature: {
        id: 'target_temperature',
        value: overrides?.targetTemperature ?? 22,
        units: '°C',
        min: 10,
        max: 30,
        lastUpdated,
      },
      measure_temperature: {
        id: 'measure_temperature',
        value: overrides?.measureTemperature ?? 21,
        units: '°C',
        lastUpdated,
      },
    },
    settings: {
      load: overrides?.load ?? 0,
      ...(overrides?.energyValueOn !== undefined ? { energy_value_on: overrides.energyValueOn } : {}),
    },
  };
};

describe('VThermo device integration', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it('keeps VThermo managed for price-only control but disables capacity control when no power capability exists', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('price_optimization_settings', {
      'vthermo-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
    });

    const app = createApp();
    await app.onInit();

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'vthermo-1': buildVThermoApiDevice(),
    });

    await app.refreshTargetDevicesSnapshot();

    const snapshot = getLatestTargetSnapshotForTests();
    const entry = snapshot.find((device) => device.id === 'vthermo-1');
    expect(entry).toBeDefined();
    expect(entry?.deviceClass).toBe('thermostat');
    expect(entry?.deviceType).toBe('temperature');
    expect(entry?.powerCapable).toBe(false);

    const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    const priceSettings = mockHomeyInstance.settings.get('price_optimization_settings') as Record<string, { enabled?: boolean }>;

    expect(managed['vthermo-1']).toBe(true);
    expect(controllable['vthermo-1']).toBe(false);
    expect(priceSettings['vthermo-1']?.enabled).toBe(true);
  });

  it('applies mode targets for VThermo even when it lacks power capabilities', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'vthermo-1': 19 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'vthermo-1': true });

    const app = createApp();
    await app.onInit();

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'vthermo-1': buildVThermoApiDevice({ targetTemperature: 22 }),
    });
    const setCapSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    await app.refreshTargetDevicesSnapshot();

    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(controllable['vthermo-1']).toBe(false);

    await app.planService.rebuildPlanFromCache('unknown');
    await flushPromises();
    expect(setCapSpy).toHaveBeenCalledWith(
      'manager/devices/device/vthermo-1/capability/target_temperature',
      { value: 19 },
    );
  });

  it('never switches on a supported thermostat that has no power reading, but still applies its mode target', async () => {
    // "Energy used when on" keeps it supported, so Power-limit control stays on,
    // but nothing measures its draw. Turning it on is a power decision, which
    // takes a reading; its setpoint is temperature logic and still applies.
    setMockDrivers({});
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'vthermo-1': 19 } });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'vthermo-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'vthermo-1': true });

    const app = createApp();
    await app.onInit();

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'vthermo-1': buildVThermoApiDevice({ onoff: false, targetTemperature: 22, energyValueOn: 1500 }),
    });
    const setCapSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    await app.refreshTargetDevicesSnapshot();

    const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
    expect(controllable['vthermo-1']).toBe(true);

    await app.planService.rebuildPlanFromCache('unknown');
    await flushPromises();
    expect(setCapSpy).toHaveBeenCalledWith(
      'manager/devices/device/vthermo-1/capability/target_temperature',
      { value: 19 },
    );
    expect(setCapSpy).not.toHaveBeenCalledWith(
      'manager/devices/device/vthermo-1/capability/onoff',
      { value: true },
    );
  });
});
