// SDK-boundary e2e for the binary "Run on solar surplus" dump-load posture on
// the `flow` power source: PELS holds an opted-in on/off device OFF, lifts the
// hold only while the home exports enough to cover its draw, and puts it back.
//
// WHY THIS EXISTS: the posture used to be gated to `homey_energy` in
// `resolveSurplusPostureForDevice`, on the premise that "no surplus signal
// exists" on flow. That premise rested entirely on the Flow card rejecting
// negative watts. It no longer does, and the measured surplus pool is
// `-signedNetKw` (`composeSurplusPool`) with no production term anywhere — so
// the gate had nothing left to protect. This spec is the evidence for that
// claim: the SAME lifecycle the Homey Energy counterpart proves, driven entirely
// through the Flow action card.
//
// Nothing internal is mocked. Whole-home net power enters through the real
// `report_power_usage` card (the SDK seam, negative = the home exporting),
// drives the real producer stamp (`toPlanDevice.surplusOnly`) + surplus
// allocator + eligibility gate + standing hold + planner + executor, and the
// only thing asserted is what PELS writes back through the SDK (`api.put` of
// `onoff`). Expected draw comes from the device's `load` setting (1 kW) — the
// gate's overshoot-fit bar — so export must cover it.
//
// Counterpart to test/e2e/solarDumpLoad.e2e.test.ts (same lifecycle, Homey
// Energy poll).
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

const seedSettings = (surplusWilling: boolean) => {
  mockHomeyInstance.settings.set('power_source', 'flow');
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

const flushDetached = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

// The flow source has no 10 s poll to piggyback on, so the reading is
// re-reported on the same cadence the Homey Energy counterpart polls at.
const reportForPolls = async (powerW: number, count: number): Promise<void> => {
  const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
  for (let i = 0; i < count; i += 1) {
    await reportPowerUsage({ power: powerW });
    await flushDetached();
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const onoffPuts = (putSpy: { mock: { calls: unknown[][] } }) => putSpy.mock.calls
  .filter(([path]) => path === cap(DEVICE, 'onoff'))
  .map(([, body]) => (body as { value?: boolean } | undefined)?.value);

describe('Solar dump-load posture on the flow power source (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now(); a real-vs-fake split strands the rebuild.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
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
    // normal shed lane: PELS turns it OFF. Before this change the posture was
    // never stamped on flow, so no hold existed and nothing happened here.
    const device = await buildPump(true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await reportForPolls(1500, 6);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: false });
    expect(onoffPuts(putSpy)).toContain(false);
    expect(onoffPuts(putSpy)).not.toContain(true);

    // Phase 2 — engage: the sun comes out, exporting 3 kW (covers the 1 kW pump
    // + reserve). Past the 90 s settle window (and the restore cooldowns), the
    // hold lifts and the NORMAL restore lane turns the pump ON.
    putSpy.mockClear();
    await reportForPolls(-3000, 40); // ~400 s: settle + shed/restore cooldowns
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });
    expect(onoffPuts(putSpy)).toContain(true);

    // Phase 3 — release: the export collapses to sustained 1.5 kW import (past
    // the hard-off bar). One settle window later the eligibility releases, the
    // hold re-enters, and the shed lane turns the pump OFF again.
    putSpy.mockClear();
    await reportForPolls(1500, 40);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: false });
    expect(onoffPuts(putSpy)).toContain(false);
  });

  it('never turns the pump on without surplus, and never touches a non-willing pump', async () => {
    // Willing pump, OFF, importing the whole time: the hold holds — no ON ever.
    const device = await buildPump(false);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await reportForPolls(1500, 30);
    await drainPending();
    expect(onoffPuts(putSpy)).not.toContain(true);
  });

  it('never holds a willing pump off when the home has NEVER exported', async () => {
    // The upgrade regression, at the SDK seam. A flow install whose Flow predates
    // signed watts reports only non-negative watts, so the whole-home net never
    // goes negative: measured export is impossible and the curtailment estimator
    // stays dormant. The surplus pool is <= 0 forever.
    //
    // Without the reachability gate the posture is stamped anyway and the
    // standing hold turns this pump OFF and keeps it off for good — no
    // time-based escape, no UI recourse. It must keep running instead.
    const device = await buildPump(true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);
    // The distinguishing fact: no export has ever been recorded.
    mockHomeyInstance.settings.set(POWER_TRACKER_STATE, {});

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await reportForPolls(1500, 30);
    await drainPending();
    expect(onoffPuts(putSpy)).not.toContain(false);
  });

  it('arms the posture as soon as the home reports its first export', async () => {
    // The other half of the gate: the same install after the owner fixes their
    // Flow to send `import − export`. One negative sample is enough evidence
    // that the feed can express export — waiting for the 1 kWh export-price
    // floor would leave the feature apparently dead for ~20 minutes.
    const device = await buildPump(true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);
    mockHomeyInstance.settings.set(POWER_TRACKER_STATE, {});

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    // A brief export, far under 1 kWh, then back to importing: the pool is now
    // known to be reachable, so the hold applies and the pump is turned off.
    await reportForPolls(-2000, 3);
    await reportForPolls(1500, 30);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: false });
    expect(onoffPuts(putSpy)).toContain(false);
  });

  it('never holds a non-willing on/off device off (no posture, no hold)', async () => {
    // Same pump, same import, but WITHOUT the opt-in: the standing hold must not
    // exist, so a running pump keeps running (no OFF command).
    const device = await buildPump(true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(false);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await reportForPolls(1500, 30);
    await drainPending();
    expect(onoffPuts(putSpy)).not.toContain(false);
  });
});
