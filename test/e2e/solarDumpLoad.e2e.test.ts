// SDK-boundary e2e for the binary "Run on solar surplus" dump-load posture:
// PELS holds an opted-in on/off device OFF, lifts the hold only while the home
// exports enough solar to cover its draw, and reclaims a manual ON.
//
// Nothing internal is mocked. Whole-home net power enters through the real Homey
// Energy poll (`api.get('manager/energy/live')` — the SDK seam, negative = the
// home exporting), drives the real producer stamp (`toPlanDevice.surplusOnly`) +
// surplus allocator + eligibility gate + standing hold + planner + executor, and
// the only thing asserted is what PELS writes back through the SDK
// (`api.put` of `onoff`). The device's expected draw comes from its `load`
// setting (1 kW) — the gate's overshoot-fit bar — so export must cover it.
//
// Counterpart to test/integration/surplusDumpLoadPlan.test.ts (the planner-layer
// integration suite that drives PlanBuilder directly).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
  POWER_TRACKER_STATE,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const DEVICE = 'pool-pump';
const LOAD_W = 1000; // 1 kW pump → engage bar = 1 + 0.25 reserve = 1.25 kW export

const buildPump = async (on: boolean) => {
  const device = new MockDevice(DEVICE, 'Pool pump', ['onoff', 'measure_power', 'meter_power'], 'socket');
  device.setSettings({ load: LOAD_W });
  await device.setCapabilityValue('onoff', on);
  await device.setCapabilityValue('measure_power', 0);
  return device;
};

// Mutable whole-home net power fed through the real Homey Energy poll.
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

const seedSettings = (surplusWilling: boolean) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  // Cap far above any draw here — capacity pressure never sheds in these tests.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  // The full valid blob entry the settings UI writes for the dump-load opt-in:
  // price-response off, zero deltas, only surplusWilling carries meaning.
  mockHomeyInstance.settings.set('price_optimization_settings', {
    [DEVICE]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling },
  });
  // A home that has exported before — the persisted evidence that makes the
  // surplus pool reachable, and therefore the precondition for the posture being
  // stamped at all (`resolveSurplusPoolReachable`). It is also the only state in
  // which the settings UI offers the opt-in this test seeds, so a run without it
  // would be testing a home that could not have reached this configuration.
  mockHomeyInstance.settings.set(POWER_TRACKER_STATE, {
    exportBuckets: { '2026-01-14T11:00:00.000Z': 2 },
  });
};

// N Homey Energy polls at the real 10 s cadence.
const advancePolls = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const onoffPuts = (putSpy: { mock: { calls: unknown[][] } }) => putSpy.mock.calls
  .filter(([path]) => path === cap(DEVICE, 'onoff'))
  .map(([, body]) => (body as { value?: boolean } | undefined)?.value);

describe('Solar dump-load posture (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (setup/planRebuildIntentPolicy.ts getAppPlanRebuildNowMs); a real-vs-fake split
    // intermittently strands the rebuild under CI load.
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

  it('drives the full lifecycle: reclaims a manual ON, turns on under export, back off when export collapses', async () => {
    // Phase 1 — the reconcile contract: the pump is ON (a manual switch flip)
    // while the home imports 1.5 kW. The standing hold sheds it through the
    // normal shed lane: PELS turns it OFF.
    const device = await buildPump(true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);
    homePowerW = 1500;
    wireHomePower();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePolls(6);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: false });
    expect(onoffPuts(putSpy)).toContain(false);
    expect(onoffPuts(putSpy)).not.toContain(true);

    // Phase 2 — engage: the sun comes out, exporting 3 kW (covers the 1 kW pump
    // + reserve). Past the 90 s settle window (and the restore cooldowns), the
    // hold lifts and the NORMAL restore lane turns the pump ON.
    putSpy.mockClear();
    homePowerW = -3000;
    await advancePolls(40); // ~400 s: settle + shed/restore cooldowns
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });
    expect(onoffPuts(putSpy)).toContain(true);

    // Phase 3 — release: the export collapses to sustained 1.5 kW import (past
    // the hard-off bar). One settle window later the eligibility releases, the
    // hold re-enters, and the shed lane turns the pump OFF again.
    putSpy.mockClear();
    homePowerW = 1500;
    await advancePolls(40);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: false });
    expect(onoffPuts(putSpy)).toContain(false);
  });

  it('never turns the pump on without surplus, and never touches a non-willing pump', async () => {
    // Willing pump, OFF, importing the whole time: the hold holds — no ON ever.
    const device = await buildPump(false);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);
    homePowerW = 1500;
    wireHomePower();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePolls(30);
    await drainPending();
    expect(onoffPuts(putSpy)).not.toContain(true);
  });

  it('never holds a non-willing on/off device off (no posture, no hold)', async () => {
    // Same pump, same import, but WITHOUT the opt-in: the standing hold must not
    // exist, so a running pump keeps running (no OFF command). (PELS restoring an
    // off managed device under headroom is pre-existing planner behaviour and not
    // under test here — the posture only ever ADDS the hold.)
    const device = await buildPump(true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(false);
    homePowerW = 1500;
    wireHomePower();

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePolls(30);
    await drainPending();
    expect(onoffPuts(putSpy)).not.toContain(false);
  });
});
