/**
 * SDK-boundary regression for an inactive stepped EV blocking an unrelated
 * water heater from resuming.
 *
 * The production shape is reproduced entirely through Homey inputs: an
 * unplugged, higher-priority EV retains its 6 A target-power setting while an
 * off, lower-priority water heater is waiting. Whole-home power leaves enough
 * capacity for both loads. The only assertion is the resulting Homey
 * capability command; planner state and reason strings stay unobserved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntilCalledWith } from '../utils/asyncDrain';

const EV_ID = 'ev-charger';
const WATER_HEATER_ID = 'water-heater';
const WATER_HEATER_ONOFF_PATH = `manager/devices/device/${WATER_HEATER_ID}/capability/onoff`;
const EV_CHARGING_PATH = `manager/devices/device/${EV_ID}/capability/evcharger_charging`;

async function buildInactiveSteppedEv(
  chargingState: 'plugged_out' | 'plugged_in' = 'plugged_out',
): Promise<MockDevice> {
  const device = new MockDevice(
    EV_ID,
    'BilLader (5E)',
    [
      'measure_power',
      'target_power',
      'evcharger_charging',
      'evcharger_charging_state',
    ],
    'evcharger',
  );
  device.setCapabilityMetadata('target_power', {
    min: 0,
    max: 11_040,
    step: 690,
    setable: true,
  });
  await device.setCapabilityValue('measure_power', 0);
  await device.setCapabilityValue('target_power', 4_140);
  await device.setCapabilityValue('evcharger_charging', false);
  await device.setCapabilityValue('evcharger_charging_state', chargingState);
  return device;
}

async function buildWaterHeater(): Promise<MockDevice> {
  const device = new MockDevice(
    WATER_HEATER_ID,
    'Varmtvann',
    ['onoff', 'measure_power'],
    'heater',
  );
  device.setSettings({ load: 3_200 });
  await device.setCapabilityValue('onoff', false);
  await device.setCapabilityValue('measure_power', 0);
  return device;
}

function reportHomePower(totalW: number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
}

function configureCapacity(limitKw = 9.2): void {
  const enabledDevices = { [EV_ID]: true, [WATER_HEATER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabledDevices);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabledDevices);
  mockHomeyInstance.settings.set('capacity_priorities', {
    Home: { [EV_ID]: 1, [WATER_HEATER_ID]: 2 },
  });
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, { [EV_ID]: true });
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [EV_ID]: { enabled: true, preset: 'ev_charger_3_phase' },
  });
}

describe('inactive stepped EV and water-heater restore (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'clearTimeout',
        'clearInterval',
        'clearImmediate',
      ],
    });
    vi.setSystemTime(Date.UTC(2026, 6, 24, 5, 55, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resumes the water heater when the higher-priority EV is unplugged', async () => {
    const [ev, waterHeater] = await Promise.all([
      buildInactiveSteppedEv(),
      buildWaterHeater(),
    ]);
    setMockDrivers({ driverA: new MockDriver('driverA', [ev, waterHeater]) });
    configureCapacity();
    reportHomePower(900);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(
      putSpy,
      WATER_HEATER_ONOFF_PATH,
      { value: true },
    );

    expect(putSpy).toHaveBeenCalledWith(
      WATER_HEATER_ONOFF_PATH,
      { value: true },
    );
    expect(putSpy).not.toHaveBeenCalledWith(EV_CHARGING_PATH, { value: true });
  });

  it('falls through to the water heater when the connected EV rejects resume', async () => {
    const [ev, waterHeater] = await Promise.all([
      buildInactiveSteppedEv('plugged_in'),
      buildWaterHeater(),
    ]);
    ev.configureCapabilityBehavior('evcharger_charging', { onApiWrite: { accept: false } });
    setMockDrivers({ driverA: new MockDriver('driverA', [ev, waterHeater]) });
    configureCapacity(5.1);
    reportHomePower(900);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, WATER_HEATER_ONOFF_PATH, { value: true });

    expect(putSpy).toHaveBeenCalledWith(EV_CHARGING_PATH, { value: true });
    expect(putSpy).toHaveBeenCalledWith(WATER_HEATER_ONOFF_PATH, { value: true });
  });

  it('falls through after 90 seconds when the EV accepts resume without charging evidence', async () => {
    const [ev, waterHeater] = await Promise.all([
      buildInactiveSteppedEv('plugged_in'),
      buildWaterHeater(),
    ]);
    ev.configureCapabilityBehavior('evcharger_charging', {
      onApiWrite: {
        accept: true,
        updateActual: false,
        updateApi: false,
        emitCapabilityEvent: false,
        emitDeviceUpdate: false,
      },
    });
    setMockDrivers({ driverA: new MockDriver('driverA', [ev, waterHeater]) });
    configureCapacity(5.1);
    reportHomePower(900);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, EV_CHARGING_PATH, { value: true });
    expect(putSpy).not.toHaveBeenCalledWith(WATER_HEATER_ONOFF_PATH, { value: true });
    await vi.advanceTimersByTimeAsync(79_999);
    expect(putSpy).not.toHaveBeenCalledWith(WATER_HEATER_ONOFF_PATH, { value: true });
    await vi.advanceTimersByTimeAsync(1);
    await drainUntilCalledWith(putSpy, WATER_HEATER_ONOFF_PATH, { value: true });

    expect(putSpy).toHaveBeenCalledWith(WATER_HEATER_ONOFF_PATH, { value: true });
  });
});
