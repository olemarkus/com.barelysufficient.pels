// SDK-boundary e2e: PRODUCTION parity on the `flow` power source.
//
// THE GAP: production (`totalGenerated.W`) is a channel of Homey Energy, not of
// whichever source delivers net. On `homey_energy` the whole-home poll
// co-samples the two from one report. On `flow` net arrives through the
// `report_power_usage` card and NOTHING read production at all — so a home whose
// meter is only representable via a Flow (a split import/export AMS, which
// Homey Energy cannot express as signed net at all — `test-devices` Run D)
// reported export but never production. Measured before this change:
//
//     power_source     PELS net    export accrued    production accrued
//     homey_energy     0           0.000000 kWh      0.116713 kWh
//     flow             −5961       0.151947 kWh      0.000000 kWh
//
// WHAT THIS PROVES, through the SDK boundary only (the energy report and the
// Flow action card in, the persisted tracker out — no internal reaches):
//   1. a flow home with a generator accrues production;
//   2. repeated Flow reports between polls do NOT inflate it (the failure this
//      design is most likely to have);
// The freshness bound itself (a reading older than the window is dropped, never
// inherited) is pinned precisely in `test/unit/generationFreshness.test.ts`;
// re-asserting it here would only add clock-jumping flakiness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const GENERATION_W = 7000;
const CAP_KW = 20;

const flushDetached = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

const sumBuckets = (buckets: Record<string, number> | undefined): number => (
  Object.values(buckets ?? {}).reduce((sum, value) => sum + value, 0)
);

// The live energy report the companion poll reads. `generationW: null` models a
// report with no generator at all.
const driveEnergyReport = (initial: { generationW: number | null }) => {
  const state = { ...initial };
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const report: { items: unknown[]; totalGenerated?: { W: number } } = { items: [] };
      if (state.generationW !== null) {
        report.totalGenerated = { W: state.generationW };
        report.items.push({ type: 'generator', values: { W: state.generationW } });
      }
      return report;
    }
    return originalGet(path);
  });
  return (next: { generationW: number | null }) => { Object.assign(state, next); };
};

const seedFlowHome = async (params: { withSolarDevice: boolean }) => {
  const heater = new MockDevice('heater', 'Workshop heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 2000);
  const devices = [heater];
  if (params.withSolarDevice) {
    const pv = new MockDevice('pv', 'Solar roof', ['measure_power', 'meter_power'], 'solarpanel');
    await pv.setCapabilityValue('measure_power', GENERATION_W);
    devices.push(pv);
  }
  setMockDrivers({ d: new MockDriver('d', devices) });

  mockHomeyInstance.settings.set('power_source', 'flow');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAP_KW);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { heater: true });
  mockHomeyInstance.settings.set('managed_devices', { heater: true });
};

const readTracker = (): PowerTrackerState | null => (
  mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null
);

describe('production parity on the flow power source (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 5, 19, 12, 0, 0));
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

  it('accrues production from Flow-reported samples once the companion poll supplies it', async () => {
    await seedFlowHome({ withSolarDevice: true });
    driveEnergyReport({ generationW: GENERATION_W });

    const app = createApp();
    await app.onInit();

    const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    // Exporting 5 kW under 7 kW of production: the situation Run D measured, in
    // which Homey Energy reports net 0 and PELS-on-flow reported no production.
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushDetached();
      await reportPowerUsage({ power: -5000 });
      await flushDetached();
    }

    await drainUntil(() => typeof readTracker()?.lastPowerW === 'number');
    const tracker = readTracker();

    // Net is still the Flow's signed value — production never displaces it.
    expect(tracker?.lastPowerW).toBe(-5000);
    // …and production is now co-sampled, so the Solar card has a Produced figure.
    expect(tracker?.lastGenerationW).toBe(GENERATION_W);
    expect(sumBuckets(tracker?.generationBuckets)).toBeGreaterThan(0);

    // DELIBERATE BEHAVIOUR CHANGE, pinned here so it cannot happen by accident:
    // gross consumption is now `net + generation` on this home, where it used to
    // fall back to the export floor (managed draw, background pinned at 0). The
    // 2 kW heater on a −5 kW net under 7 kW of production leaves 2 kW of gross,
    // so background is a measured 0 rather than an unknown one — and the same
    // gross feeds daily-budget attribution, and through it safe pace.
    expect(tracker?.lastControlledPowerW).toBe(2000);
    expect(tracker?.lastUncontrolledPowerW).toBe(0);
  });

  it('does not inflate production when Flow reports outpace the poll', async () => {
    // The flow card can fire far more often than the 10 s poll, so many samples
    // share one held reading. Accrual integrates over the interval between
    // samples rather than summing per sample, so six reports per poll must
    // accrue the same energy as one — this is where a regression would hide.
    // Asserted against the physical integral (generation x elapsed wall clock)
    // rather than against a second window, so the guard does not depend on two
    // harness windows being exactly the same length.
    await seedFlowHome({ withSolarDevice: true });
    driveEnergyReport({ generationW: GENERATION_W });

    const app = createApp();
    await app.onInit();
    const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;

    // Warm up until production is actually held, so the measured window below
    // starts from a steady state rather than from the first poll landing.
    for (let warmup = 0; warmup < 12; warmup += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushDetached();
      await reportPowerUsage({ power: -5000 });
      await flushDetached();
    }
    await drainUntil(() => readTracker()?.lastGenerationW === GENERATION_W);

    const startedAtMs = Date.now();
    const accruedAtStart = sumBuckets(readTracker()?.generationBuckets);
    for (let poll = 0; poll < 10; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushDetached();
      for (let r = 0; r < 6; r += 1) {
        await reportPowerUsage({ power: -5000 });
        await flushDetached();
      }
    }
    await drainUntil(() => typeof readTracker()?.lastPowerW === 'number');

    const elapsedMs = Date.now() - startedAtMs;
    const accrued = sumBuckets(readTracker()?.generationBuckets) - accruedAtStart;
    const expectedKWh = (GENERATION_W * elapsedMs) / 3_600_000 / 1000;
    // Six-fold double counting would land at ~6x; a tolerant band still catches
    // it while ignoring which side of a poll boundary the last sample fell on.
    expect(accrued).toBeGreaterThan(expectedKWh * 0.5);
    expect(accrued).toBeLessThan(expectedKWh * 1.5);
  });
});
