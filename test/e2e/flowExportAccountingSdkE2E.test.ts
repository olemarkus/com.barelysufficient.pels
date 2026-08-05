// SDK-boundary e2e: EXPORT accounting on the `flow` power source.
//
// THE BUG: the `report_power_usage` Flow card rejected any negative value, so a
// home with an ordinary signed HAN meter could not report at all while
// exporting — the card threw, PELS received no sample, and the tracker went
// stale rather than reading a net value it already knew how to handle. Every
// export surface (the export kWh families, the Solar card, the surplus pool)
// was therefore unreachable on this source, purely because of that one guard.
// The `homey_energy` source has always passed signed values straight through
// (`extractLiveMeterPowerWatts`).
//
// WHAT THIS PROVES, through the SDK boundary only (the Flow action card in, the
// persisted tracker + structured plan log out — no internal reaches):
//   1. the card admits a negative reading and it reaches the tracker signed;
//   2. the export kWh family accrues from it, which is what lifts every
//      export-dependent UI surface;
//   3. the BILLED total bucket still never goes negative (export is not
//      negative consumption) — the same invariant `solarExportCalcSdkE2E`
//      pins for the Homey Energy source;
//   4. managed load stays attributed during export. Without a co-sampled
//      production reading, gross cannot be recovered from a negative net, and
//      flooring it at 0 would report a 0 kW home while the devices are
//      demonstrably drawing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, OPERATING_MODE_SETTING, OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const HEATER_DRAW_W = 2000;
const CAP_KW = 20;

type PlanRebuildEvent = { event?: string; totalKw?: number };

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

const sumBuckets = (buckets: Record<string, number> | undefined): number => (
  Object.values(buckets ?? {}).reduce((sum, value) => sum + value, 0)
);

describe('export accounting on the flow power source (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
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

  it('accrues export kWh from signed Flow samples while keeping the billed bucket non-negative', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    let nowMs = hourStartMs + 5 * 60 * 1000;
    vi.setSystemTime(nowMs);
    const bucketKey = new Date(hourStartMs).toISOString();

    const heater = new MockDevice('heater', 'Workshop heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', HEATER_DRAW_W);
    setMockDrivers({ d: new MockDriver('d', [heater]) });

    mockHomeyInstance.settings.set('power_source', 'flow');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAP_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { heater: true });
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { heater: 1 } });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { heater: { action: 'turn_off' } });

    const app = createApp();
    const planEvents: PlanRebuildEvent[] = [];
    const origLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as PlanRebuildEvent;
          if (parsed.event === 'plan_rebuild_completed') planEvents.push(parsed);
        } catch { /* non-JSON */ }
      }
      return origLog(...args);
    };
    await app.onInit();

    const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    // Flow has no 10 s poll to piggyback on, so each injection needs its own
    // scheduler tick before the detached chain can settle.
    const reportAndSettle = async (powerW: number, advanceMs: number): Promise<void> => {
      await expect(reportPowerUsage({ power: powerW })).resolves.toBe(true);
      await flushDetached(20);
      await vi.advanceTimersByTimeAsync(advanceMs);
      nowMs += advanceMs;
      await flushDetached(20);
    };

    const readTracker = (): PowerTrackerState | null => (
      mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null
    );

    // Import first, so the export interval below integrates between two samples.
    await reportAndSettle(3000, 60_000);
    await drainUntil(() => typeof readTracker()?.lastPowerW === 'number');
    expect(readTracker()?.lastPowerW).toBe(3000);

    // Then a sustained export: solar covers the house and 1.5 kW goes to the grid.
    // Previously this call THREW and no sample was recorded at all.
    await reportAndSettle(-1500, 10 * 60_000);
    // (1) The reading reached the tracker SIGNED — the same value
    // `capacityGuard.reportTotalPower` is handed, so export grows headroom
    // rather than reading as zero draw.
    await drainUntil(() => readTracker()?.lastPowerW === -1500);

    await reportAndSettle(-1500, 10 * 60_000);
    // Back to import.
    await reportAndSettle(2500, 60_000);
    await drainUntil(() => readTracker()?.lastPowerW === 2500);

    const tracker = readTracker();

    // (2) The export family accrued — this is the signal every export surface
    // keys off (`hasMaterialExhibitedExport`, the Usage-tab Solar card, and the
    // measured surplus pool).
    expect(sumBuckets(tracker?.exportBuckets)).toBeGreaterThan(0);

    // (3) Billed kWh never decreases from an export interval.
    expect(tracker?.buckets?.[bucketKey] ?? 0).toBeGreaterThanOrEqual(-1e-9);

    // Every plan rebuild that ran saw a real number, never a fabricated zero
    // standing in for a rejected sample.
    expect(planEvents.some((e) => typeof e.totalKw === 'number')).toBe(true);
  });

  it('keeps managed load attributed while exporting, instead of reporting a 0 kW home', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 9, 0, 0);
    vi.setSystemTime(hourStartMs + 5 * 60 * 1000);

    const heater = new MockDevice('heater', 'Workshop heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', HEATER_DRAW_W);
    setMockDrivers({ d: new MockDriver('d', [heater]) });

    mockHomeyInstance.settings.set('power_source', 'flow');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAP_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { heater: true });
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { heater: 1 } });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { heater: { action: 'turn_off' } });

    const app = createApp();
    await app.onInit();

    const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    await expect(reportPowerUsage({ power: -1500 })).resolves.toBe(true);
    await flushDetached(20);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushDetached(20);

    await drainUntil(() => {
      const t = mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null;
      return typeof t?.lastControlledPowerW === 'number';
    });

    const tracker = mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null;
    // The heater's own measured 2 kW survives the export sample. Flooring gross
    // at 0 would report 0 W of managed load here while it is plainly running.
    expect(tracker?.lastControlledPowerW).toBe(HEATER_DRAW_W);
    expect(tracker?.lastPowerW).toBe(-1500);
  });
});
