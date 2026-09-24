/**
 * SDK-boundary e2e for built-in Easee charger current control.
 *
 * The production shape: an Easee charger (`no.easee` 2.0.5) has just started a
 * session, and the charger has reset its dynamic charger current to 32 A, which
 * the app publishes on `target_charger_current`. The owner runs the EV 1-phase
 * control mode with built-in control on, and the house is over the hard cap.
 *
 * Nothing internal is mocked. The charger and the home total arrive through the
 * Homey API seam; the assertion is the capability PELS writes back: a lower
 * whole-amp current on `target_charger_current`, and no stepped-load Flow
 * trigger, because no bridge Flow is needed.
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
import { drainPending, drainUntil } from '../utils/asyncDrain';
import api from '../../api';

const CHARGER_ID = 'easee-charger';
const CHARGER_CURRENT_PATH = `manager/devices/device/${CHARGER_ID}/capability/target_charger_current`;
const RESET_CURRENT_A = 32;
const RESET_POWER_W = RESET_CURRENT_A * 230;

async function buildEaseeCharger(): Promise<MockDevice> {
  const charger = new MockDevice(
    CHARGER_ID,
    'Elbillader',
    ['onoff', 'measure_power', 'target_charger_current', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  charger.setDriverIdentity({ ownerUri: 'homey:app:no.easee', driverId: 'homey:app:no.easee:charger' });
  charger.setCapabilityMetadata('target_charger_current', { units: 'A', min: 0, max: 40, step: 1, setable: true });
  await charger.setCapabilityValue('onoff', true);
  await charger.setCapabilityValue('target_charger_current', RESET_CURRENT_A);
  await charger.setCapabilityValue('measure_power', RESET_POWER_W);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  return charger;
}

function reportHomePower(totalW: number, withLegacyEaseeFlow: boolean): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    if (path === 'manager/flow/flow/') return {};
    if (path === 'manager/flow/advancedflow/') {
      return withLegacyEaseeFlow ? {
        // Production has these blocks in unrelated Flows. One such block used
        // to invalidate the whole inventory, hiding the charger's valid Flow.
        unrelated: { cards: { start: { type: 'start' }, delay: { type: 'delay' }, note: { type: 'note' } } },
        'legacy-easee-current': {
          name: 'Easee current',
          cards: {
            trigger: {
              id: 'homey:app:com.barelysufficient.pels:desired_stepped_load_changed',
              type: 'trigger',
            },
            write: {
              id: `homey:device:${CHARGER_ID}:setDynamicChargerCurrent`,
              type: 'action',
            },
          },
        },
      } : {};
    }
    return originalGet(path);
  });
}

function configureRuntime(nativeWiringEnabled: boolean): void {
  const enabled = { [CHARGER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 8);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  if (nativeWiringEnabled) mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, enabled);
  mockHomeyInstance.settings.set('overshoot_behaviors', { [CHARGER_ID]: { action: 'set_step' } });
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [CHARGER_ID]: { enabled: true, preset: 'ev_charger_1_phase', max: RESET_POWER_W },
  });
}

const SWITCH_PATH = `manager/devices/device/${CHARGER_ID}/capability/evcharger_charging`;

// The Easee cloud's answer to a dynamic current (Easee app 2.0.5): 0 A pauses
// the open session, and any current on a paused session resumes it.
// `evcharger_charging` is true only while charging. The current echoes at once;
// the mode change behind the plug state and the switch trails it, as it does in
// production (17-37 s), held back past two meter readings so PELS decides while
// it still reads the switch the old way.
const EASEE_MODE_CHANGE_DELAY_MS = 25_000;

type SimulatedEasee = {
  writesTo: (capabilityPath: string) => unknown[];
  setBackgroundW: (watts: number) => void;
  /** The owner setting the dynamic current in the Easee app. */
  setCurrentInApp: (currentA: number) => Promise<void>;
};

function simulateEasee(charger: MockDevice): SimulatedEasee {
  const applyChargerMode = async (charging: boolean): Promise<void> => {
    await charger.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in_paused');
    await charger.setCapabilityValue('evcharger_charging', charging);
  };
  const followCurrent = async (currentA: number): Promise<void> => {
    await charger.setCapabilityValue('measure_power', currentA * 230);
    setTimeout(() => { void applyChargerMode(currentA > 0); }, EASEE_MODE_CHANGE_DELAY_MS);
  };
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    if (path === CHARGER_CURRENT_PATH) await followCurrent((body as { value: number }).value);
  });
  let backgroundW = 0;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const chargerW = Number(charger.getActualCapabilityValue('measure_power') ?? 0);
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + chargerW } }] };
    }
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    return originalGet(path);
  });
  return {
    writesTo: (capabilityPath) => putSpy.mock.calls
      .filter(([path]) => path === capabilityPath)
      .map(([, body]) => (body as { value?: unknown }).value),
    setBackgroundW: (watts) => { backgroundW = watts; },
    setCurrentInApp: async (currentA) => {
      await charger.setCapabilityValue('target_charger_current', currentA);
      await followCurrent(currentA);
    },
  };
}

async function buildChargingEasee(): Promise<MockDevice> {
  const charger = await buildEaseeCharger();
  await charger.setCapabilityValue('target_charger_current', 6);
  await charger.setCapabilityValue('measure_power', 6 * 230);
  return charger;
}

describe('built-in Easee charger current (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      // `performance` too: the plan-rebuild scheduler reads the monotonic
      // clock, so leaving it real strands a queued rebuild (test/AGENTS.md).
      toFake: [
        'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
      ],
    });
    // Early in an empty hourly bucket, 9.36 kW is above the safe pace toward
    // the 8 kWh hard cap. Late in the hour the unused energy allowance would
    // legitimately let that instantaneous draw continue.
    vi.setSystemTime(Date.UTC(2026, 8, 15, 4, 1, 52));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._triggerCardTriggers = {};
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lowers the charger current on target_charger_current without a bridge Flow', async () => {
    const charger = await buildEaseeCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime(true);
    // The 32 A reset plus 2 kW of background load, against an 8 kW hard cap.
    reportHomePower(RESET_POWER_W + 2_000, false);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    const chargerCurrentWrites = (): number[] => putSpy.mock.calls
      .filter(([path]) => path === CHARGER_CURRENT_PATH)
      .map(([, body]) => (body as { value?: unknown }).value)
      .filter((value): value is number => typeof value === 'number');
    await drainUntil(() => chargerCurrentWrites().length > 0);

    const [firstWrite] = chargerCurrentWrites();
    expect(Number.isInteger(firstWrite)).toBe(true);
    expect(firstWrite).toBeLessThan(RESET_CURRENT_A);
    expect(mockHomeyInstance.flow._triggerCardTriggers.desired_stepped_load_changed ?? []).toEqual([]);
  });

  it('pauses at 0 A and resumes by current, never through the charging switch', async () => {
    const charger = await buildChargingEasee();
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime(true);
    mockHomeyInstance.settings.set('overshoot_behaviors', {});

    const easee = simulateEasee(charger);
    easee.setBackgroundW(9_000);
    const { writesTo } = easee;
    const MODE_CHANGE_DELAY_MS = EASEE_MODE_CHANGE_DELAY_MS;

    const app = createApp();
    await app.onInit();
    // 1.38 kW of charging on top of 9 kW of other load, against an 8 kW hard cap.
    for (let tick = 0; tick < 30 && !writesTo(CHARGER_CURRENT_PATH).includes(0); tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await drainUntil(() => writesTo(CHARGER_CURRENT_PATH).includes(0));
    const pausedAt = writesTo(CHARGER_CURRENT_PATH).lastIndexOf(0);

    // Still over the cap while the switch echo is in flight and after it lands:
    // nothing may put current back on offer and resume the session.
    await vi.advanceTimersByTimeAsync(MODE_CHANGE_DELAY_MS + 20_000);
    await drainPending();
    expect(charger.getActualCapabilityValue('evcharger_charging_state')).toBe('plugged_in_paused');
    expect(writesTo(CHARGER_CURRENT_PATH).slice(pausedAt + 1).filter((currentA) => currentA !== 0)).toEqual([]);

    // The other load goes away; the paused charger gets its current back.
    easee.setBackgroundW(1_000);
    const resumed = (): boolean => writesTo(CHARGER_CURRENT_PATH).slice(
      writesTo(CHARGER_CURRENT_PATH).lastIndexOf(0) + 1,
    ).some((currentA) => typeof currentA === 'number' && currentA >= 6);
    for (let tick = 0; tick < 60 && !resumed(); tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await drainUntil(resumed);
    await vi.advanceTimersByTimeAsync(MODE_CHANGE_DELAY_MS);
    await drainPending();

    // Back on at the lowest charging current, not the charger's maximum, and
    // never by starting a session: the switch was not written in either direction.
    const resumeWrites = writesTo(CHARGER_CURRENT_PATH).slice(pausedAt + 1).filter((currentA) => currentA !== 0);
    expect(resumeWrites[0]).toBe(6);
    expect(writesTo(SWITCH_PATH)).toEqual([]);
    expect(charger.getActualCapabilityValue('evcharger_charging_state')).toBe('plugged_in_charging');
  });

  it('puts current back when the owner sets 0 A in the Easee app', async () => {
    const charger = await buildChargingEasee();
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime(true);
    mockHomeyInstance.settings.set('overshoot_behaviors', {});
    const easee = simulateEasee(charger);
    easee.setBackgroundW(1_000);

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    const writesBefore = easee.writesTo(CHARGER_CURRENT_PATH).length;

    // Plenty of room, so PELS wants the charger running: 0 A set by hand is
    // the switch going off outside PELS, and PELS decides about it again.
    await easee.setCurrentInApp(0);
    const putBack = (): boolean => easee.writesTo(CHARGER_CURRENT_PATH)
      .slice(writesBefore)
      .some((currentA) => typeof currentA === 'number' && currentA >= 6);
    for (let tick = 0; tick < 60 && !putBack(); tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await drainUntil(putBack);

    // Back at a charging level PELS chose (it was ramping up when the owner
    // stepped in), by current alone: the switch was never written.
    const putBackA = easee.writesTo(CHARGER_CURRENT_PATH).slice(writesBefore).find((currentA) => currentA !== 0);
    expect(putBackA).toBeGreaterThanOrEqual(6);
    expect(easee.writesTo(SWITCH_PATH)).toEqual([]);
    await vi.advanceTimersByTimeAsync(EASEE_MODE_CHANGE_DELAY_MS);
    await drainPending();
    expect(charger.getActualCapabilityValue('evcharger_charging_state')).toBe('plugged_in_charging');
  });

  it('keeps an existing Easee bridge Flow authoritative after upgrade', async () => {
    const charger = await buildEaseeCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime(false);
    reportHomePower(RESET_POWER_W + 2_000, true);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();

    const reportStep = mockHomeyInstance.flow._actionCardListeners.report_stepped_load_power;
    if (!reportStep) throw new Error('Expected report_stepped_load_power to be registered.');
    await expect(reportStep({ device: CHARGER_ID, power_w: `${RESET_POWER_W} W` })).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntil(() => (
      (mockHomeyInstance.flow._triggerCardTriggers.desired_stepped_load_changed ?? []).length > 0
    ));

    expect(putSpy.mock.calls.filter(([path]) => path === CHARGER_CURRENT_PATH)).toEqual([]);
    const legacyFlowRequests = mockHomeyInstance.flow._triggerCardTriggers.desired_stepped_load_changed ?? [];
    expect(legacyFlowRequests.length).toBeGreaterThan(0);
    expect(legacyFlowRequests.every((request) => (
      request.state !== undefined && request.state.deviceId === CHARGER_ID
    ))).toBe(true);

    const payload = await api.ui_devices({ homey: app.homey });
    expect(payload.devices.find((device) => device.id === CHARGER_ID)).toMatchObject({
      controlAdapter: { activationAvailable: true, activationEnabled: false },
      flowConflict: { conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'Easee current' },
    });

    // The old return lane remains accepted while native current observation is disabled.
    await expect(reportStep({ device: CHARGER_ID, power_w: '1380 W' })).resolves.toBe(true);
  });
});
