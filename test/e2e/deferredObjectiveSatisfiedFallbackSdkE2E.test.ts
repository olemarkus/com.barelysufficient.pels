/**
 * SDK-boundary e2e for early smart-task satisfaction. Homey-observed SoC and
 * charging state drive the real diagnostic bridge, lifecycle clock, wiring,
 * and actuator. No PELS internal is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';

const CHARGER_ID = 'cap-off-charger';
const CHARGING_PATH = `manager/devices/device/${CHARGER_ID}/capability/evcharger_charging`;
const NOW_MS = Date.UTC(2026, 7, 12, 8, 0, 0);

const buildCharger = async (
  chargingState: 'plugged_in_charging' | 'plugged_in' = 'plugged_in_charging',
): Promise<MockDevice> => {
  const charger = new MockDevice(
    CHARGER_ID,
    'Cap-off charger',
    ['measure_power', 'measure_battery', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  await charger.setCapabilityValue('measure_power', 7_000);
  await charger.setCapabilityValue('measure_battery', 40);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', chargingState);
  // Homey accepts the pause while the charger's telemetry lags behind. This
  // makes the next lifecycle tick exercise the real retry path.
  charger.configureCapabilityBehavior('evcharger_charging', {
    onApiWrite: {
      accept: true,
      updateActual: false,
      updateApi: false,
      emitCapabilityEvent: false,
      emitDeviceUpdate: false,
    },
  });
  return charger;
};

const configureRuntime = (): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 20);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [CHARGER_ID]: true });
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [CHARGER_ID]: false });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [CHARGER_ID]: 1 } });
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, { [CHARGER_ID]: true });
  mockHomeyInstance.settings.set(`deferred_objective.${CHARGER_ID}`, {
    enabled: true,
    kind: 'ev_soc',
    enforcement: 'soft',
    targetPercent: 80,
    deadlineAtMs: NOW_MS + 3 * 60 * 60 * 1000,
  });
};

describe('satisfied smart-task fallback (SDK-boundary e2e)', () => {
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
    vi.setSystemTime(NOW_MS);
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

  it('pauses at target, retries laggy telemetry, stays enabled, then settles idempotently', async () => {
    const charger = await buildCharger();
    setMockDrivers({ ev: new MockDriver('ev', [charger]) });
    configureRuntime();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await drainPending();
    expect(putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH)).toHaveLength(0);

    // The only progress input is a new Homey capability observation.
    await charger.setCapabilityValue('measure_battery', 80);
    await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    expect(putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH)).toHaveLength(1);
    expect(mockHomeyInstance.settings.get(`deferred_objective.${CHARGER_ID}`)).toMatchObject({
      enabled: true,
    });

    // The charger still reports charging, but the pending window
    // (CONTROL_COMMAND_CONFIRMATION_MS, 90 s) prevents overlapping writes
    // while the first request may still materialize.
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    expect(putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH)).toHaveLength(1);

    // Keep SoC fresh at the Homey boundary while the charging-state echo stays
    // laggy. Once the pending window expires, the next clock tick retries.
    await vi.advanceTimersByTimeAsync(31_000);
    await charger.setCapabilityValue('measure_battery', 80);
    await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
    expect(putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH)).toHaveLength(2);

    // Confirm fallback at the SDK boundary. Once observation catches up, later
    // lifecycle ticks issue no further pause while the task remains enabled.
    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_paused');
    await charger.setCapabilityValue('measure_power', 0);
    await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    expect(putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH)).toHaveLength(2);
    expect(mockHomeyInstance.settings.get(`deferred_objective.${CHARGER_ID}`)).toMatchObject({
      enabled: true,
    });
  });

  it('pauses permission-armed EVs even when charging activity is not active', async () => {
    const charger = await buildCharger();
    setMockDrivers({ ev: new MockDriver('ev', [charger]) });
    configureRuntime();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await drainPending();
    expect(putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH)).toHaveLength(0);

    await charger.setCapabilityValue('measure_battery', 80);
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in');
    await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();

    const pauseWrites = putSpy.mock.calls.filter(([path]) => path === CHARGING_PATH);
    expect(pauseWrites).toHaveLength(1);
    expect(pauseWrites[0]?.[1]).toMatchObject({ value: false });
  });
});
