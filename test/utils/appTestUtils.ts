// Shared test utilities for app instance cleanup
// Use explicit .ts extension to avoid resolving app.json instead of app.ts.
// Static import goes through Vitest's esbuild transform, which handles `export =`.
import MyApp from '../../app.ts';
import { mockHomeyInstance } from '../mocks/homey';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { createTrackerStore, type TrackerStore } from '../../lib/power/trackerStore';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { createPriceCacheStore, type PriceCacheKey } from '../../lib/price/priceCacheStore';
import { createDailyBudgetStateStore } from '../../lib/dailyBudget/dailyBudgetStateStore';
import type { DailyBudgetState } from '../../lib/dailyBudget/dailyBudgetTypes';

let appInstances: MyApp[] = [];

type CreateAppOptions = {
  preserveStartupRestoreStabilization?: boolean;
  /**
   * Leave the home with NO meter measurement, so `PowerMeasurementGate` keeps
   * the plan-build gate shut. Only for suites that exercise the gate itself.
   *
   * The default seeds one, because a whole-home meter is a documented PELS
   * prerequisite (`docs/getting-started.md`) — a booted app that has never seen
   * a reading is a startup instant, not a steady state, and a suite that leaves
   * it that way is asserting against a home PELS does not claim to serve.
   */
  withoutPowerMeasurement?: boolean;
  /**
   * Where the userdata database lives for this app instance. Defaults to one
   * temp directory per test, deleted by `cleanupApps` after every test — the
   * `mockHomeyInstance.settings` analogue: two apps booted inside one test
   * (a restart) share it, and the next test starts empty.
   */
  userdataDatabase?: string;
};

let testUserdataDir: string | undefined;
const testUserdataDatabase = (): string => {
  testUserdataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pels-userdata-'));
  return path.join(testUserdataDir, 'pels.sqlite');
};
/** Drop the database and its directory so the next test boots on an empty store. */
const removeTestUserdataDatabase = (): void => {
  if (testUserdataDir === undefined) return;
  fs.rmSync(testUserdataDir, { recursive: true, force: true });
  testUserdataDir = undefined;
};

// A real, unremarkable reading: the house drawing nothing leaves full headroom,
// so seeding it opens the gate without steering any capacity decision. Suites
// that care about the total report their own over the top.
const SEEDED_TOTAL_POWER_KW = 0;

/**
 * Create an app instance and track it for cleanup.
 * Call cleanupApps() in afterEach to properly stop all intervals.
 */
export function createApp(options: CreateAppOptions = {}): MyApp {
  // Protected lifecycle members are reached via element access — the typed
  // escape hatch, so a rename in the app still breaks this seam loudly. The
  // wrap suppresses the startup restore-stabilization window, which the
  // public API does not expose.
  const app = new MyApp();
  // The database is opened at the first boot step, after construction, so
  // this override lands before anything reaches the file the production path
  // would open.
  app['openUserdataDatabase'] = () => openUserdataDatabase(
    options.userdataDatabase ?? testUserdataDatabase(),
  );
  if (!options.preserveStartupRestoreStabilization) {
    const originalInitPlanRuntime = app['initPlanRuntime'].bind(app);
    app['initPlanRuntime'] = () => {
      originalInitPlanRuntime();
      app.planEngine?.clearStartupRestoreStabilization(Date.now());
    };
  }
  if (!options.withoutPowerMeasurement) {
    // Seed at guard construction, not after `onInit`: rebuilds that run DURING
    // startup (the price-delta-on-startup path) would otherwise still find the
    // build gate shut. Same protected-member seam as the plan-engine wrap above.
    const originalInitCapacityGuard = app['initCapacityGuard'].bind(app);
    app['initCapacityGuard'] = () => {
      originalInitCapacityGuard();
      // BOTH halves of the latch, exactly as production ingest stamps them
      // (`recordPowerSampleForApp`): the reading resolver requires a stamped
      // sample behind every build, so the old value-only seed — a state real
      // ingest cannot produce — now fails loud instead of reading as held.
      // With a 0 kW seed the fresh sample steers nothing: headroom is full,
      // and suites that care about the total or its age stamp their own.
      app.powerTracker = {
        ...app.powerTracker,
        lastPowerW: SEEDED_TOTAL_POWER_KW * 1000,
        lastTimestamp: Date.now(),
      };
    };
  }
  appInstances.push(app);
  return app;
}

/**
 * Seed the tracker the app under test will hydrate at boot: the store's rows
 * in the database `createApp` opens, written before `onInit` reads them.
 */
export function seedStoredPowerTrackerForTests(state: PowerTrackerState, homeId: string = 'main'): void {
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    createTrackerStore(database).replace(homeId, state);
  } finally {
    database.close();
  }
}

/**
 * The tracker as the app under test has persisted it — the store's rows, not
 * a settings key. `null` while nothing has been persisted for the home.
 */
export function getStoredPowerTrackerForTests(homeId: string = 'main'): PowerTrackerState | null {
  const app = mockHomeyInstance.app as { getTrackerStore?: () => TrackerStore } | null;
  try {
    const store = app?.getTrackerStore?.();
    if (store !== undefined) return store.load(homeId);
  } catch {
    // The app has torn down (its database is closed): read the file it wrote.
  }
  if (testUserdataDir === undefined) return null;
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    return createTrackerStore(database).load(homeId);
  } finally {
    database.close();
  }
}

/**
 * A price cache as the app under test has stored it — the price cache's row in
 * the database `createApp` opens, not a settings key. `null` while none is cached.
 */
export function getStoredPriceCacheForTests(key: PriceCacheKey): unknown {
  if (testUserdataDir === undefined) return null;
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    return createPriceCacheStore(database).read(key);
  } finally {
    database.close();
  }
}

/**
 * Seed the daily-budget state the app under test will load at boot: the
 * store's rows in the database `createApp` opens, written before `onInit`.
 */
export function seedStoredDailyBudgetStateForTests(state: DailyBudgetState): void {
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    createDailyBudgetStateStore(database).write(state);
  } finally {
    database.close();
  }
}

/**
 * The daily-budget state as the app under test has persisted it, the store's
 * rows rather than a settings key. Empty while nothing has been persisted.
 */
export function getStoredDailyBudgetStateForTests(): DailyBudgetState {
  if (testUserdataDir === undefined) return {};
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    return createDailyBudgetStateStore(database).read() ?? {};
  } finally {
    database.close();
  }
}

export function getLatestTargetSnapshotForTests(): TargetDeviceSnapshot[] {
  const app = mockHomeyInstance.app as { latestTargetSnapshot?: unknown } | null;
  return Array.isArray(app?.latestTargetSnapshot) ? app.latestTargetSnapshot as TargetDeviceSnapshot[] : [];
}

/**
 * The TRANSPORT's snapshot, not the plan-input view above.
 *
 * Since stage 6 of the snapshot decomposition `latestTargetSnapshot` is the
 * descriptor joined with the observer's record, so it carries no transport
 * binding (`binaryCapabilityId` and kin) — those are how the transport reaches
 * the device, not something a plan device is entitled to know. A spec asserting
 * what PARSE produced reads them here instead.
 */
export function getTransportSnapshotForTests(): TargetDeviceSnapshot[] {
  const app = mockHomeyInstance.app as { deviceManager?: { getSnapshot?: () => unknown } } | null;
  const snapshot = app?.deviceManager?.getSnapshot?.();
  return Array.isArray(snapshot) ? snapshot as TargetDeviceSnapshot[] : [];
}

/** The UI/runtime join of DeviceReads inventory with accepted Observer state. */
export function getDeviceSurfacesForTests(): DeviceSurfaces[] {
  const app = mockHomeyInstance.app as { getDeviceSurfaces?: () => unknown } | null;
  const surfaces = app?.getDeviceSurfaces?.();
  return Array.isArray(surfaces) ? surfaces as DeviceSurfaces[] : [];
}

/**
 * Clean up all tracked app instances by calling onUninit().
 * Should be called in afterEach().
 */
export async function cleanupApps(): Promise<void> {
  for (const app of appInstances) {
    if (app && typeof app.onUninit === 'function') {
      try {
        await app.onUninit();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  appInstances = [];
  mockHomeyInstance.app = null;
  removeTestUserdataDatabase();
}
