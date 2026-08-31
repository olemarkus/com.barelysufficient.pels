// SDK-boundary e2e for the surplus-TRACKING posture: PELS parks an opted-in
// stepped charger on the rung its solar surplus covers, climbs it as export
// grows, and drops it back as export collapses.
//
// Nothing internal is mocked. Whole-home net power enters through the real Homey
// Energy poll (`api.get('manager/energy/live')` — the SDK seam, negative = the
// home exporting) and drives the real producer stamp
// (`toPlanDevice.surplusTracking`) → surplus allocator → eligibility gate →
// ceiling clamp → planner → executor. The only thing asserted is what PELS
// writes back through the SDK: `api.put` of `target_power` in watts.
//
// The ladder is the real EV 1-phase preset, so its rungs are the real ones —
// 6 A = 1380 W is the floor, and there is nothing between that and off. When the
// export cannot fund that floor the charger STOPS, and where it parks is the
// configured shed action's answer, not this feature's.
//
// Counterparts: test/integration/surplusTrackingCeiling.test.ts (planner layer,
// which clamp wins) and test/unit/surplusTracking.test.ts (the allocator).
//
// What this tier actually pins, verified by mutation probe: the RESTORE-lane
// gate (`admitStepUnderSurplusCeiling`). A charger starting from idle climbs
// through restore, one rung per admitted cycle, so that is the gate standing
// between it and the grid here — disabling it alone makes the first case fail.
// The keep-path clamp (`clampToSurplusCeiling`) governs a device already sitting
// ABOVE its allocation, which never arises from a cold start; the integration
// suite drives that case directly. Both are load-bearing, at different moments,
// and neither tier covers the other's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
  POWER_TRACKER_STATE,
} from '../../lib/utils/settingsKeys';
import { drainPending } from '../utils/asyncDrain';

const CHARGER = 'ev-charger';
const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const buildCharger = async (drawW: number): Promise<MockDevice> => {
  const charger = new MockDevice(
    CHARGER,
    'EV charger',
    ['measure_power', 'target_power', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  charger.setCapabilityMetadata('target_power', {
    units: 'W', min: 0, max: 7_360, step: 230, setable: true,
  });
  await charger.setCapabilityValue('measure_power', drawW);
  await charger.setCapabilityValue('target_power', drawW);
  await charger.setCapabilityValue('evcharger_charging', true);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  return charger;
};

let homePowerW = 0;
const wireHomePower = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: homePowerW } }] };
    }
    return originalGet(path);
  });
};

const seedSettings = (params: { surplusWilling: boolean }) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  // Cap far above any draw here — capacity pressure never sheds in these tests,
  // so the only thing that can move the charger is the surplus ceiling.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 20);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [CHARGER]: true });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [CHARGER]: true });
  mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, { [CHARGER]: true });
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    [CHARGER]: { enabled: true, preset: 'ev_charger_1_phase', max: 7_360 },
  });
  // The blob the settings UI writes for a tracking opt-in: price-response off,
  // zero deltas, only the surplus fields carrying meaning.
  mockHomeyInstance.settings.set('price_optimization_settings', {
    [CHARGER]: {
      enabled: false,
      cheapDelta: 0,
      expensiveDelta: 0,
      surplusWilling: params.surplusWilling,
    },
  });
  // A home that has exported before — the persisted evidence that makes the
  // surplus pool reachable, and so the precondition for the posture being
  // stamped at all. It is also the only state in which the settings UI offers
  // the opt-in this test seeds.
  mockHomeyInstance.settings.set(POWER_TRACKER_STATE, {
    exportBuckets: { '2026-01-14T11:00:00.000Z': 4 },
  });
};

const advancePolls = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const targetPowerPuts = (putSpy: { mock: { calls: unknown[][] } }): number[] => putSpy.mock.calls
  .filter(([path]) => path === cap(CHARGER, 'target_power'))
  .map(([, body]) => (body as { value?: number } | undefined)?.value)
  .filter((value): value is number => typeof value === 'number');

const chargingPuts = (putSpy: { mock: { calls: unknown[][] } }): boolean[] => putSpy.mock.calls
  .filter(([path]) => path === cap(CHARGER, 'evcharger_charging'))
  .map(([, body]) => (body as { value?: boolean } | undefined)?.value)
  .filter((value): value is boolean => typeof value === 'boolean');

describe('Solar surplus tracking (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler
    // reads its clock via Date.now(); a real-vs-fake split intermittently
    // strands the rebuild under CI load.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    homePowerW = 0;
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

  it('never commands the charger above what the sun covers', async () => {
    // Exporting 2.5 kW while the charger idles. The pool buys at most the rung
    // under 2.5 − 0.25 reserve = 2.25 kW, which on the real EV 1-phase ladder is
    // 8 A (1840 W). Anything above that would be charging on grid power, which
    // is precisely what this feature exists to prevent.
    const charger = await buildCharger(0);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    seedSettings({ surplusWilling: true });
    homePowerW = -2500;
    wireHomePower();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePolls(40);
    await drainPending();

    const commanded = targetPowerPuts(putSpy);
    expect(commanded).not.toHaveLength(0);
    expect(commanded.every((watts) => watts <= 1840)).toBe(true);
  });

  it('stops the charger when export cannot reach 6 A', async () => {
    // 0.8 kW of export: below the 1380 W ladder floor, so nothing funds a rung
    // and the charger stops rather than importing the difference.
    // Built at a running rung so a command IS required to stop it — asserting
    // `every(w => w < 1380)` on an empty list would pass without PELS acting.
    const charger = await buildCharger(2760);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    seedSettings({ surplusWilling: true });
    // The charger is already pulling 2760 W, so a home with only 0.8 kW of TRUE
    // surplus reads +1960 W at the meter. The pool reconstructs to 0.8 kW once
    // its own draw is added back — under the 1380 W ladder floor either way.
    homePowerW = 1960;
    wireHomePower();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePolls(40);
    await drainPending();

    // WHERE it stops is the configured shed action's answer, not this feature's.
    // No shed behaviour is seeded, so the default `turn_off` applies — and for
    // this charger that is its BINARY handle. The EV preset ladder deliberately
    // carries no 0 W rung (its lowest is the 6 A step), so the current axis
    // parks there and is inert while the charger is off.
    //
    // This is the whole point of routing the stop through the shed action: the
    // solar path asks only THAT the device stop, and a device with an off
    // handle gets turned off, exactly as a capacity shed would do it.
    expect(chargingPuts(putSpy)).toContain(false);
    expect(targetPowerPuts(putSpy).every((watts) => watts <= 1380)).toBe(true);
  });

  it('leaves a charger that never opted in free to use the whole cap', async () => {
    // The byte-identical case: with no opt-in there is no posture, no ceiling,
    // and the charger runs to available power exactly as it always has. This is
    // what keeps the feature inert for every existing install.
    const charger = await buildCharger(0);
    setMockDrivers({ driverA: new MockDriver('driverA', [charger]) });
    seedSettings({ surplusWilling: false });
    homePowerW = -800;
    wireHomePower();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePolls(40);
    await drainPending();

    // Not constrained to the 0.8 kW of export: with a 20 kW cap and no ceiling
    // the charger climbs its ladder. Asserted as a positive — an empty command
    // list used to satisfy this too, so a total failure to act read as a pass.
    const commanded = targetPowerPuts(putSpy);
    expect(commanded).not.toHaveLength(0);
    expect(commanded.some((watts) => watts >= 1380)).toBe(true);
  });
});
