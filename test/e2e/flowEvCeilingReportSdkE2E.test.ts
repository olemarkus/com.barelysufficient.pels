/**
 * SDK-boundary e2e for a bridge Flow reporting an EV charger's draw.
 *
 * The production shape (SHS, 2026-10-01): an EV charger under the EV 1-phase
 * preset without built-in control. The owner's Flow reports the charger's power
 * through "Report stepped load power". A car draws a little under nominal, so
 * the reading sits just below a rung, and the card matches it to that rung.
 * The card then refreshes the device list, and a device poll refreshes it again
 * later; both re-read the charger without the report and must keep the rung.
 * The assertion is the charger card the owner sees: its level, not "Level
 * unknown".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_TARGET_POWER_REACHABILITY,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import api from '../../api';
import { buildEvTargetPowerProfileFingerprint } from '../../lib/device/targetPowerReachability';

const CHARGER_ID = 'flow-charger';

async function readChargerCard() {
  const payload = await api.ui_plan({ homey: mockHomeyInstance as never });
  return payload.plan?.devices?.find((device) => device.id === CHARGER_ID)?.status;
}

async function buildFlowCharger(drawW: number): Promise<MockDevice> {
  const charger = new MockDevice(
    CHARGER_ID,
    'Garage charger',
    ['measure_power', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  await charger.setCapabilityValue('measure_power', drawW);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  return charger;
}

function configureRuntime(): void {
  const enabled = { [CHARGER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 8);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [CHARGER_ID]: { enabled: true, preset: 'ev_charger_1_phase', max: 7_360 },
  });
}

function reportHomePower(totalW: number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    return originalGet(path);
  });
}

describe('bridge Flow EV power report (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
      ],
    });
    vi.setSystemTime(Date.UTC(2026, 8, 15, 4, 1, 52));
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps a report a little under a rung as that rung after refreshes', async () => {
    const charger = await buildFlowCharger(1_320);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime();
    reportHomePower(1_320 + 500);

    const app = createApp();
    await app.onInit();
    const reportPower = mockHomeyInstance.flow._actionCardListeners.report_stepped_load_power;
    if (!reportPower) throw new Error('Expected report_stepped_load_power to be registered.');
    const onSixAmps = { factText: 'Charging · level 6 A', rail: { labels: ['Off', '6 A'], activeIndex: 1 } };

    // The 6 A rung is 1380 W; a car on it reads about 1320 W.
    await expect(reportPower({ device: CHARGER_ID, power_w: '1320 W' })).resolves.toBe(true);
    expect(await readChargerCard()).toMatchObject(onSixAmps);

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await drainPending();
    expect(await readChargerCard()).toMatchObject(onSixAmps);
  });

  it('keeps a report a little over a rung as that rung after refreshes', async () => {
    const charger = await buildFlowCharger(4_614);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime();
    reportHomePower(4_614 + 500);

    const app = createApp();
    await app.onInit();
    const reportPower = mockHomeyInstance.flow._actionCardListeners.report_stepped_load_power;
    if (!reportPower) throw new Error('Expected report_stepped_load_power to be registered.');
    const onTwentyAmps = {
      factText: 'Charging · level 20 A',
      rail: { labels: ['Off', '6 A', '8 A', '10 A', '12 A', '14 A', '16 A', '20 A'], activeIndex: 7 },
    };

    // The 20 A rung is 4600 W; at 230.7 V a car on it reads 4614 W.
    await expect(reportPower({ device: CHARGER_ID, power_w: '4614 W' })).resolves.toBe(true);
    expect(await readChargerCard()).toMatchObject(onTwentyAmps);

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await drainPending();
    expect(await readChargerCard()).toMatchObject(onTwentyAmps);
  });

  it('reads a maximum saved just over a rung as that rung', async () => {
    const charger = await buildFlowCharger(6_449);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime();
    reportHomePower(6_449 + 500);
    // 28 A at about 233 V, learned before readings over a rung counted as that rung.
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_REACHABILITY, {
      [CHARGER_ID]: {
        profileFingerprint: buildEvTargetPowerProfileFingerprint({
          enabled: true, preset: 'ev_charger_1_phase', max: 7_360,
        }),
        maxReachedPowerW: 6_514,
        probeFailureCount: 37,
      },
    });

    const app = createApp();
    await app.onInit();
    const reportPower = mockHomeyInstance.flow._actionCardListeners.report_stepped_load_power;
    if (!reportPower) throw new Error('Expected report_stepped_load_power to be registered.');

    await expect(reportPower({ device: CHARGER_ID, power_w: '6449 W' })).resolves.toBe(true);
    const card = await readChargerCard();
    expect(card?.factText).toBe('Charging · level 28 A');
    expect(card?.rail?.labels).not.toContain('28.322a');
  });

  it('keeps a stated current just under an earned rung as its own step', async () => {
    const charger = await buildFlowCharger(5_635);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime();
    reportHomePower(5_635 + 500);

    const app = createApp();
    await app.onInit();
    const reportPower = mockHomeyInstance.flow._actionCardListeners.report_stepped_load_power;
    if (!reportPower) throw new Error('Expected report_stepped_load_power to be registered.');

    await expect(reportPower({ device: CHARGER_ID, power_w: '25 A' })).resolves.toBe(true);
    expect((await readChargerCard())?.factText).toBe('Charging · level 25 A');
    await expect(reportPower({ device: CHARGER_ID, power_w: '24.5 A' })).resolves.toBe(true);
    expect((await readChargerCard())?.factText).toBe('Charging · level 24.5a');
  });

  it('reads a measured draw between two rungs as the rung below', async () => {
    const charger = await buildFlowCharger(5_112);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    configureRuntime();
    reportHomePower(5_112 + 500);

    const app = createApp();
    await app.onInit();
    const reportPower = mockHomeyInstance.flow._actionCardListeners.report_stepped_load_power;
    if (!reportPower) throw new Error('Expected report_stepped_load_power to be registered.');

    await expect(reportPower({ device: CHARGER_ID, power_w: '5112 W' })).resolves.toBe(true);
    const card = await readChargerCard();
    expect(card?.factText).toBe('Charging · level 20 A');
    expect(card?.rail?.labels).not.toContain('22.226a');
  });
});
