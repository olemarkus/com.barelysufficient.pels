// SDK-boundary e2e for the daily-budget unfreeze/restart regression: a boot over
// a persisted FROZEN daily-budget state (exactly what a previous session leaves
// behind when the day ran hot and the app was restarted — or what the running
// app holds when usage drops back under the allowance) must NOT reallocate the
// hour in progress. The pre-fix behaviour nulled the current-hour lock on
// unfreeze, so the first rebuild re-spread `budget - used` across ALL remaining
// hours and collapsed the current hour to `used + a marginal share`.
//
// Nothing internal is mocked. The frozen state, plan, and power history enter as
// persisted Homey settings; whole-home power enters through the real Homey
// Energy poll; the clock is the faked SDK clock. The only observations are what
// PELS persists back through the settings seam (`daily_budget_state`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DAILY_BUDGET_STATE,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainPending } from '../utils/asyncDrain';

const HOUR_MS = 60 * 60 * 1000;
// 2026-07-25 in Europe/Oslo (UTC+2): local day starts 2026-07-24T22:00Z.
const DAY_START_UTC_MS = Date.UTC(2026, 6, 24, 22, 0, 0);
const DATE_KEY = '2026-07-25';
// Boot lands 39 minutes into local hour 20 — deep in the hour, like the field
// restarts that reproduced the collapse.
const BOOT_MS = DAY_START_UTC_MS + 20 * HOUR_MS + 39 * 60 * 1000;
const CURRENT_BUCKET_START_MS = DAY_START_UTC_MS + 20 * HOUR_MS;
// The freeze started during local hour 18, so the persisted lock is two hours
// stale — no rebuild ran across the 19:00 and 20:00 transitions while frozen.
const STALE_LOCK_MS = DAY_START_UTC_MS + 18 * HOUR_MS;

const DAILY_BUDGET_KWH = 44;
const CURRENT_HOUR_PLANNED_KWH = 2;

// Plan: 2.1 kWh for hours 0-19 (cum 42 <= budget), 2 for the current hour, and a
// distinctive tail so the post-unfreeze re-spread of FUTURE hours is visible.
const seededPlan = (): number[] => [
  ...Array.from({ length: 20 }, () => 2.1),
  CURRENT_HOUR_PLANNED_KWH,
  3,
  0.3,
  0.2,
];

// Usage: 2.0 kWh in each past hour (40 used), 0.4 so far in the current hour.
// Cumulative use (40.4) is back UNDER the plan's allowance (~43.3 at 20:39), so
// the first boot update unfreezes.
const seedPowerTracker = (): void => {
  const buckets: Record<string, number> = {};
  for (let hourIndex = 0; hourIndex < 20; hourIndex += 1) {
    buckets[new Date(DAY_START_UTC_MS + hourIndex * HOUR_MS).toISOString()] = 2.0;
  }
  buckets[new Date(CURRENT_BUCKET_START_MS).toISOString()] = 0.4;
  mockHomeyInstance.settings.set('power_tracker_state', {
    lastTimestamp: BOOT_MS - 30_000,
    buckets,
  });
};

const seedSettings = (): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('daily_budget_enabled', true);
  mockHomeyInstance.settings.set('daily_budget_kwh', DAILY_BUDGET_KWH);
  mockHomeyInstance.settings.set('daily_budget_price_shaping_enabled', false);
  mockHomeyInstance.settings.set(DAILY_BUDGET_STATE, {
    dateKey: DATE_KEY,
    dayStartUtcMs: DAY_START_UTC_MS,
    plannedKWh: seededPlan(),
    frozen: true,
    lastPlanBucketStartUtcMs: STALE_LOCK_MS,
  });
  seedPowerTracker();
};

// Whole-home power through the real Homey Energy poll: a calm 600 W evening.
const wireHomePower = (): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 600 } }] };
    }
    return originalGet(path);
  });
};

const readPersistedState = (): {
  frozen?: boolean;
  lastPlanBucketStartUtcMs?: number | null;
  plannedKWh?: number[];
} => mockHomeyInstance.settings.get(DAILY_BUDGET_STATE) ?? {};

const advancePolls = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

describe('daily budget unfreeze across restart (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now(); a real-vs-fake split desyncs the day context.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(BOOT_MS);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('unfreezes at boot without reallocating the hour in progress', async () => {
    seedSettings();
    wireHomePower();

    const app = createApp();
    await app.onInit();
    await drainPending();
    // Ride out the low-priority persist throttle (10 min) so the post-unfreeze
    // rebuild's plan write demonstrably lands in the settings seam.
    await advancePolls(70);
    await drainPending();

    const persisted = readPersistedState();
    // Unfrozen, and the current-hour lock points at the hour in progress —
    // not null, not the stale frozen-era hour.
    expect(persisted.frozen).toBe(false);
    expect(persisted.lastPlanBucketStartUtcMs).toBe(CURRENT_BUCKET_START_MS);
    // The hour in progress kept its planned allocation.
    expect(persisted.plannedKWh?.[20]).toBeCloseTo(CURRENT_HOUR_PLANNED_KWH, 6);
    // Future hours DID re-spread the remaining budget (the rebuild ran): the
    // distinctive seeded tail is gone.
    const tail = [persisted.plannedKWh?.[21], persisted.plannedKWh?.[22], persisted.plannedKWh?.[23]];
    expect(tail).not.toEqual([3, 0.3, 0.2]);
    // Past hours are untouched history.
    expect(persisted.plannedKWh?.[0]).toBeCloseTo(2.1, 6);
  });
});
