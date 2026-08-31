/**
 * SDK-boundary e2e for EV target-power reachability.
 *
 * The charger is configured for 32 A and reports an exact 25 A target. PELS
 * admits the ordinary next ladder rung (28 A), but the Homey device silently
 * refuses to materialize that write and keeps reporting 25 A. Nothing inside
 * PELS is mocked: inputs are Homey settings, capabilities, whole-home power and
 * the clock; outputs are SDK writes, persisted settings, and `/ui_devices`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_TARGET_POWER_REACHABILITY,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import type {
  DecoratedDeviceSnapshot,
  TargetPowerReachabilityState,
} from '../../packages/contracts/src/types';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil, drainUntilCalledWith, drainPending } from '../utils/asyncDrain';

const CHARGER_ID = 'ev-charger';
const WATER_HEATER_ID = 'water-heater';
const CONFIRMED_POWER_W = 5_750; // exact 25 A at 230 V
const PROBE_POWER_W = 6_440; // next candidate: 28 A
const CHARGER_TARGET_POWER_PATH = `manager/devices/device/${CHARGER_ID}/capability/target_power`;
const WATER_HEATER_ONOFF_PATH = `manager/devices/device/${WATER_HEATER_ID}/capability/onoff`;

const buildCharger = async (): Promise<MockDevice> => {
  const charger = new MockDevice(
    CHARGER_ID,
    'EV charger',
    ['measure_power', 'target_power', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  charger.setCapabilityMetadata('target_power', {
    units: 'W', min: 0, max: 7_360, step: 230, setable: true,
  });
  await charger.setCapabilityValue('measure_power', CONFIRMED_POWER_W);
  await charger.setCapabilityValue('target_power', CONFIRMED_POWER_W);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  // The command is accepted by Homey, but neither device truth nor the API
  // echo changes. This is the real-world "refuses to settle" behavior.
  charger.configureCapabilityBehavior('target_power', {
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

const buildWaterHeater = async (): Promise<MockDevice> => {
  const heater = new MockDevice(WATER_HEATER_ID, 'Water heater', ['onoff', 'measure_power'], 'heater');
  heater.setSettings({ load: 700 });
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 700);
  return heater;
};

const configureRuntime = (): void => {
  const enabled = { [CHARGER_ID]: true, [WATER_HEATER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set('capacity_priorities', {
    Home: { [CHARGER_ID]: 1, [WATER_HEATER_ID]: 2 },
  });
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, { [CHARGER_ID]: true });
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [CHARGER_ID]: {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    },
  });
};

const reportHomePower = (totalW: number): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
};

const readReachability = (): TargetPowerReachabilityState | undefined => {
  const stored = mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_REACHABILITY) as unknown;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  return (stored as Record<string, TargetPowerReachabilityState>)[CHARGER_ID];
};

const readChargerFromUi = async (): Promise<DecoratedDeviceSnapshot> => {
  const payload = await api.ui_devices({ homey: mockHomeyInstance as never });
  const charger = payload.devices.find((device: DecoratedDeviceSnapshot) => device.id === CHARGER_ID);
  if (!charger) throw new Error('charger missing from /ui_devices');
  return charger;
};

describe('EV target-power reachability (SDK-boundary e2e)', () => {
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
    vi.setSystemTime(Date.UTC(2026, 7, 8, 20, 2, 0));
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

  it('learns 25 A after a refused 28 A probe, releases another device, and retries later', async () => {
    const [charger, waterHeater] = await Promise.all([buildCharger(), buildWaterHeater()]);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger, waterHeater]) });
    configureRuntime();
    reportHomePower(CONFIRMED_POWER_W + 700);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(
      putSpy,
      CHARGER_TARGET_POWER_PATH,
      { value: PROBE_POWER_W },
    );

    // A second device turns off only after the exploratory command is already
    // pending. Publish the changed SDK snapshot through the same settings seam
    // the settings UI uses for an explicit device refresh.
    waterHeater.setActualCapabilityValue('onoff', false, {
      emitCapabilityEvent: false,
      emitDeviceUpdate: false,
    });
    waterHeater.setActualCapabilityValue('measure_power', 0, {
      emitCapabilityEvent: false,
      emitDeviceUpdate: false,
    });
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await drainPending();
    expect(putSpy).not.toHaveBeenCalledWith(WATER_HEATER_ONOFF_PATH, { value: true });

    // The UI remains honest while the probe is outstanding: configured 32 A
    // is not exposed as reached, and the exact observed 25 A rung is retained.
    const probingUiDevice = await readChargerFromUi();
    expect(probingUiDevice.steppedLoadProfile?.steps.at(-1)).toMatchObject({
      id: '25a',
      planningPowerW: CONFIRMED_POWER_W,
    });
    expect(await charger.getCapabilityValue('target_power')).toBe(CONFIRMED_POWER_W);

    // Local target-power commands settle for 90 seconds. The refresh at that
    // deadline must classify silence as a failed probe and persist the proven
    // ceiling instead of leaving the restore attempt pending indefinitely.
    await vi.advanceTimersByTimeAsync(90_000);
    await drainUntil(() => readReachability()?.probeFailureCount === 1);
    const learned = readReachability();
    expect(learned).toMatchObject({
      maxReachedPowerW: CONFIRMED_POWER_W,
      probeFailureCount: 1,
    });
    expect(learned?.nextProbeAtMs).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(learned?.nextProbeAtMs).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);

    const settledUiDevice = await readChargerFromUi();
    expect(settledUiDevice.steppedLoadProfile?.steps.at(-1)?.id).toBe('25a');

    // The exploratory command may briefly sequence other restores, but it
    // cannot starve them: the unrelated heater reaches the SDK by settlement or
    // the following power cycle even though the charger never reaches 28 A.
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, WATER_HEATER_ONOFF_PATH, { value: true });
    expect(putSpy).toHaveBeenCalledWith(WATER_HEATER_ONOFF_PATH, { value: true });

    // The persisted due time drives a later background plan rebuild. The
    // planner still sees an ordinary next rung; no probe metadata crosses in.
    const firstProbeCalls = putSpy.mock.calls.filter(
      ([path, body]) => path === CHARGER_TARGET_POWER_PATH
        && (body as { value?: unknown })?.value === PROBE_POWER_W,
    ).length;
    const retryAtMs = learned?.nextProbeAtMs;
    if (retryAtMs === undefined) throw new Error('probe retry was not scheduled');
    await vi.advanceTimersByTimeAsync(Math.max(0, retryAtMs - Date.now()));
    await drainUntil(() => putSpy.mock.calls.filter(
      ([path, body]) => path === CHARGER_TARGET_POWER_PATH
        && (body as { value?: unknown })?.value === PROBE_POWER_W,
    ).length > firstProbeCalls);
    await drainPending();
  });
});
