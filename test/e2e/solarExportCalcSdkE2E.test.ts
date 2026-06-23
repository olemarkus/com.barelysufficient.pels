// SDK-boundary e2e: energy-bucket CALCULATION correctness while solar EXPORTS.
//
// THE BUG: on the `homey_energy` source, `manager/energy/live` `cumulative.W` is NET
// grid power, which goes NEGATIVE during export. That value is stored unclamped as
// `lastPowerW` and the next sample integrates it into the TOTAL energy bucket
// (lib/power/tracker.ts) with no floor — so an export hour SUBTRACTS kWh, driving the
// billed total bucket negative. The controlled/uncontrolled/exempt buckets are already
// clamped; only the total is not. The cap path correctly keeps the signed net.
//
// THE FIX UNDER TEST: floor the total-bucket WRITE at >= 0 (billed kWh can't decrease)
// while leaving `lastPowerW` and the capacity guard on signed net (export still grows
// headroom). Non-solar / flow homes are unaffected (flow rejects power < 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, OPERATING_MODE_SETTING, OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const POLL_MS = 10_000;
const EV_DRAW_W = 2000;
const CAP_KW = 20;

type PlanRebuildEvent = { event?: string; totalKw?: number };

const driveHomeEnergy = (initial: { netW: number; generationW?: number }) => {
  let state = initial;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const report: { items: unknown[]; totalGenerated?: { W: number } } = {
        items: [{ type: 'cumulative', values: { W: state.netW } }],
      };
      if (typeof state.generationW === 'number') {
        report.totalGenerated = { W: state.generationW };
        report.items.push({ type: 'generator', values: { W: state.generationW } });
      }
      return report;
    }
    return originalGet(path);
  });
  return (next: { netW: number; generationW?: number }) => { state = next; };
};

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

describe('energy-bucket correctness under solar export (SDK-boundary e2e)', () => {
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

  it('never writes negative kWh into the total energy bucket under export, but the cap keeps signed net', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    vi.setSystemTime(hourStartMs + 5 * 60 * 1000);
    const bucketKey = new Date(hourStartMs).toISOString();

    const ev = new MockDevice('ev', 'EV charger', ['onoff', 'measure_power', 'meter_power'], 'socket');
    await ev.setCapabilityValue('onoff', true);
    await ev.setCapabilityValue('measure_power', EV_DRAW_W);
    setMockDrivers({ d: new MockDriver('d', [ev]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAP_KW);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { ev: true });
    mockHomeyInstance.settings.set('managed_devices', { ev: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { ev: 1 } });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { ev: { action: 'turn_off' } });

    // Export: solar 4.5 kW, household ~3 kW -> net = -1.5 kW (exporting 1.5 kW).
    driveHomeEnergy({ netW: -1500, generationW: 4500 });

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

    // Several polls so the negative net is integrated into the prior hour bucket.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => {
      const t = mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null;
      return typeof t?.lastPowerW === 'number';
    });

    const tracker = mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null;
    const totalBucket = tracker?.buckets?.[bucketKey] ?? 0;
    const capView = [...planEvents].reverse().find((e) => typeof e.totalKw === 'number');

    // Billed total kWh must never go negative from an export hour.
    expect(totalBucket).toBeGreaterThanOrEqual(-1e-9); // RED today: goes negative
    // But the capacity path must still see the true signed net import (export grows headroom).
    expect(tracker?.lastPowerW).toBeLessThan(0); // net import preserved (negative = exporting)
    expect(capView?.totalKw).toBeCloseTo(-1.5, 2); // cap sees signed net, NOT clamped
  });
});
