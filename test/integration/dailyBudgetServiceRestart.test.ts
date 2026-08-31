import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import { createDailyBudgetSettingsStore } from '../../setup/dailyBudgetSettingsAdapter';
import { createDailyBudgetStateStore } from '../../setup/dailyBudgetStateAdapter';
import type Homey from 'homey';
import { partialDouble } from '../helpers/partialDouble';

type AppHomey = Homey.App['homey'];
import type { PowerTrackerState } from '../../lib/power/tracker';

// Plain-restart invariant for the daily budget: a service reload over the
// persisted settings (the app-restart seam) must not reallocate the hour in
// progress. The unfreeze counterpart — a restart over a FROZEN blob — is the
// SDK e2e in test/e2e/dailyBudgetUnfreezeRestartSdkE2E.test.ts.

const TZ = 'Europe/Oslo';

// 2026-08-01 local day in Europe/Oslo (UTC+2): hour H local starts at (H-2):00Z.
const hourStartMs = (localHour: number): number => Date.UTC(2026, 7, 1, localHour - 2, 0, 0, 0);
const isoForLocalHour = (localHour: number): string => new Date(hourStartMs(localHour)).toISOString();

// Shared "Homey settings" DB with a faithful JSON roundtrip, so a second
// service instance loads exactly what the first persisted.
function buildSharedHomey(): { homey: AppHomey } {
  const db = new Map<string, string>();
  const homey = partialDouble<AppHomey>({
    settings: partialDouble<AppHomey['settings']>({
      get: (key: string) => (db.has(key) ? JSON.parse(db.get(key) as string) : null),
      set: (key: string, value: unknown) => {
        db.set(key, JSON.stringify(value));
      },
    }),
    clock: partialDouble<AppHomey['clock']>({ getTimezone: () => TZ }),
  });
  return { homey };
}

function buildTracker(usedThroughLocalHour19: number, hour20Usage: number): PowerTrackerState {
  const buckets: Record<string, number> = {};
  for (let hour = 0; hour < 20; hour += 1) {
    buckets[isoForLocalHour(hour)] = usedThroughLocalHour19 / 20;
  }
  buckets[isoForLocalHour(20)] = hour20Usage;
  return { buckets } as PowerTrackerState;
}

function buildService(homey: AppHomey, getTracker: () => PowerTrackerState): DailyBudgetService {
  return new DailyBudgetService({
    getTimeZone: () => TZ,
    log: () => undefined,
    getPowerTracker: getTracker,
    getPriceOptimizationEnabled: () => false,
    getCapacitySettings: () => ({ limitKw: 15, marginKw: 1 }),
    combinedPricesReader: { readStore: () => null },
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(homey),
    dailyBudgetStateStore: createDailyBudgetStateStore(homey),
  });
}

const todayPlanned = (service: DailyBudgetService): number[] => {
  const snapshot = service.getSnapshot();
  if (!snapshot) throw new Error('no snapshot');
  const today = snapshot.days[snapshot.todayKey];
  if (!today) throw new Error('no today payload');
  return today.buckets.plannedKWh;
};

describe('daily budget plan across a mid-hour restart', () => {
  it('preserves the current-hour allocation when the service reloads persisted state', () => {
    const { homey } = buildSharedHomey();
    createDailyBudgetSettingsStore(homey).write({
      enabled: true,
      dailyBudgetKWh: 44.1,
      priceShapingEnabled: true,
      controlledUsageWeight: 0,
      priceShapingFlexShare: 0.5,
    });

    let tracker = buildTracker(34, 0);
    const serviceA = buildService(homey, () => tracker);
    serviceA.loadSettings();
    serviceA.loadState();

    // Steady state in local hour 19, then the hourly transition into hour 20.
    serviceA.updateState({ nowMs: hourStartMs(19) + 30 * 60 * 1000 });
    serviceA.updateState({ nowMs: hourStartMs(20) + 30 * 1000 });
    const plannedAtLock = todayPlanned(serviceA)[20];

    // Intra-hour usage-driven rebuilds (>=0.05 kWh delta, >=5 min apart) with
    // throttled low-priority persists, like production between :00 and :39.
    const intraHourMinutes = [5, 15, 25, 35];
    intraHourMinutes.forEach((minute, index) => {
      tracker = buildTracker(34, 0.1 * (index + 1));
      serviceA.updateState({ nowMs: hourStartMs(20) + minute * 60 * 1000 });
    });
    const plannedBeforeRestart = todayPlanned(serviceA)[20];
    expect(plannedBeforeRestart).toBeCloseTo(plannedAtLock, 6);

    // Restart at :40 — a new service instance over the same persisted settings.
    tracker = buildTracker(34, 0.45);
    const serviceB = buildService(homey, () => tracker);
    serviceB.loadSettings();
    serviceB.loadState();
    serviceB.updateState({ nowMs: hourStartMs(20) + 40 * 60 * 1000 + 15 * 1000 });

    const plannedAfterRestart = todayPlanned(serviceB)[20];
    expect(plannedAfterRestart).toBeCloseTo(plannedBeforeRestart, 6);
  });
});
