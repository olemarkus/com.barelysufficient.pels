import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeferredObjectiveLifecycleEmitter,
  createDeferredObjectivePlanHistoryRecorder,
  persistDeferredObjectiveObservationWatermark,
} from '../../setup/appInit';
import {
  DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING,
  DEFERRED_OBJECTIVES_PERKEY_MIGRATED,
  DEFERRED_OBJECTIVES_SETTINGS,
} from '../../lib/utils/settingsKeys';
import type { DeferredObjectivePlanHistoryEntry } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type { AppContext } from '../../lib/app/appContext';
import { createAppContextMock } from '../helpers/appContextTestHelpers';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Regression: the startup back-fill must re-run after an in-session migration
 * retry. Sequence under test (the exact silent-history-loss bug):
 *
 *  1. Boot with a transient empty `getKeys()` flake: `migrateBlobToPerKeyIfNeeded`
 *     defers (marker stays unset) and `runStartupBackfill` bails WITHOUT advancing
 *     the watermark, latching `deferredObjectiveBackfillPending`.
 *  2. In-session lifecycle tick: `getKeys()` now succeeds → the migration completes
 *     (legacy blob copied to a per-device key, marker set).
 *  3. The SAME tick's `observeDeferredObjectivePlanHistory` must back-fill the still-
 *     pending `(oldWatermark, now]` offline window BEFORE advancing the watermark —
 *     so the migrated legacy task's elapsed one-shot deadline is recorded in history,
 *     not silently skipped because the watermark jumped to now.
 *
 * Driven through the real recorder + lifecycle emitter seam; only the Homey SDK
 * boundary (settings get/set/unset/getKeys + clock) is faked.
 */
describe('deferred-objective back-fill after an in-session migration retry', () => {
  let store: Map<string, unknown>;
  let getKeysImpl: () => string[];

  const buildCtx = (now: number): AppContext => {
    const homey = {
      settings: {
        get: vi.fn((key: string) => store.get(key)),
        set: vi.fn((key: string, value: unknown) => { store.set(key, value); }),
        unset: vi.fn((key: string) => { store.delete(key); }),
        getKeys: vi.fn(() => getKeysImpl()),
        on: vi.fn(),
        off: vi.fn(),
      },
      clock: {
        getTimezone: () => 'Europe/Oslo',
        getTimezoneOffset: () => -60,
      },
    } as unknown as AppContext['homey'];
    return createAppContextMock({
      homey,
      getNow: () => new Date(now),
      getTimeZone: () => 'Europe/Oslo',
      // No managed devices this session: diagnostics are empty, so the only way the
      // migrated legacy task's elapsed deadline reaches history is the offline-window
      // back-fill — exactly the path under test.
      planService: {
        getPlanDevices: () => [],
        getStallClassification: () => undefined,
        rebuildPlanFromCache: vi.fn(async () => undefined),
        evaluateHeadroomForDevice: vi.fn(() => null),
        syncLivePlanStateInline: vi.fn(() => false),
      } as unknown as AppContext['planService'],
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Map<string, unknown>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('records the migrated legacy task\'s elapsed deadline that the boot back-fill deferred', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    // Watermark sits a day back; the legacy task's one-shot deadline elapsed inside the
    // (oldWatermark, boot] offline window while PELS was off.
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    // Pre-upgrade legacy state: a single enabled temperature objective in the plural blob,
    // never yet migrated to a per-device key (marker unset).
    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    store.set(DEFERRED_OBJECTIVES_SETTINGS, {
      version: 1,
      objectivesByDeviceId: {
        'legacy-heater': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          deadlineAtMs: elapsedDeadlineMs,
          targetTemperatureC: 65,
        },
      },
    });

    // (1) Boot: empty getKeys() flake → migration defers, marker stays unset.
    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    ctx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: () => null,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The migrated task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    // Boot back-fill bailed: marker unset, watermark untouched, history empty, latch set.
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBeUndefined();
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);
    expect(store.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING)).toBeUndefined();
    expect(ctx.deferredObjectiveBackfillPending).toBe(true);

    // (2) + (3) In-session tick: getKeys() now succeeds. The lifecycle's
    // getDeferredObjectiveSettings retries the migration (marker gets set), then
    // observeDeferredObjectivePlanHistory runs the pending back-fill before the
    // watermark advances.
    getKeysImpl = () => [...store.keys()];
    const tickMs = bootMs + 30_000;
    vi.setSystemTime(tickMs);
    const emitter = createDeferredObjectiveLifecycleEmitter(ctx);
    emitter.tick(tickMs);

    // Migration completed: marker set, blob consumed, per-device key written.
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
    expect(store.get(DEFERRED_OBJECTIVES_SETTINGS)).toBeUndefined();
    expect(store.get('deferred_objective.legacy-heater')).toBeDefined();

    // The migrated task's elapsed deadline was back-filled into persisted history —
    // NOT silently skipped. This is the core regression assertion.
    const history = store.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING) as
      | { entries: DeferredObjectivePlanHistoryEntry[] }
      | undefined;
    expect(history).toBeDefined();
    const backfilled = (history?.entries ?? []).filter(
      (entry) => entry.deviceId === 'legacy-heater'
        && entry.deadlineAtMs === elapsedDeadlineMs,
    );
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]!.discoveredFrom).toBe('backfill');

    // Watermark advanced past the offline window; latch cleared (runs at most once).
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK) as number).toBeGreaterThan(oldWatermark);
    expect(ctx.deferredObjectiveBackfillPending).toBe(false);
  });

  it('does not re-run the back-fill on a second tick once it has completed', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    store.set(DEFERRED_OBJECTIVES_SETTINGS, {
      version: 1,
      objectivesByDeviceId: {
        'legacy-heater': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          deadlineAtMs: elapsedDeadlineMs,
          targetTemperatureC: 65,
        },
      },
    });

    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    ctx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: () => null,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The migrated task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    getKeysImpl = () => [...store.keys()];
    const emitter = createDeferredObjectiveLifecycleEmitter(ctx);

    const firstTickMs = bootMs + 30_000;
    vi.setSystemTime(firstTickMs);
    emitter.tick(firstTickMs);
    expect(ctx.deferredObjectiveBackfillPending).toBe(false);

    const backfillSpy = vi.spyOn(recorder, 'backfillFromConfig');
    const secondTickMs = firstTickMs + 30_000;
    vi.setSystemTime(secondTickMs);
    emitter.tick(secondTickMs);

    // No redundant re-scan: the latch is clear, so the second tick never calls back-fill.
    expect(backfillSpy).not.toHaveBeenCalled();
  });

  // P1#1: the marker becomes set on the latched tick, but `readAllObjectives` runs an
  // INDEPENDENT getKeys() that flakes empty. An empty key list must NOT be mistaken for
  // "zero enabled objectives" — that would advance the watermark and clear the latch,
  // permanently skipping the offline window (the silent-history-loss this PR fixes).
  it('does not advance the watermark when getKeys() flakes empty on the latched tick', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    store.set(DEFERRED_OBJECTIVES_SETTINGS, {
      version: 1,
      objectivesByDeviceId: {
        'legacy-heater': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          deadlineAtMs: elapsedDeadlineMs,
          targetTemperatureC: 65,
        },
      },
    });

    // (1) Boot: empty getKeys() flake → migration defers, marker unset, latch set.
    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    ctx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: () => null,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The migrated task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    expect(ctx.deferredObjectiveBackfillPending).toBe(true);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);

    // (2) Latched tick: getKeys() succeeds while the marker is unset (so the lifecycle's
    // migration runs: marker set, blob consumed, per-device key written), then flakes empty
    // for the REST of this tick once the marker is set — so the back-fill's own trustworthiness
    // check + readAllObjectives getKeys() see an empty list. This is the transient-empty flake
    // the back-fill must NOT mistake for "zero enabled objectives".
    getKeysImpl = () => (store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED) ? [] : [...store.keys()]);
    const flakeTickMs = bootMs + 30_000;
    vi.setSystemTime(flakeTickMs);
    const emitter = createDeferredObjectiveLifecycleEmitter(ctx);
    emitter.tick(flakeTickMs);

    // Migration completed, but the empty-config read was untrustworthy: watermark NOT
    // advanced, latch STILL set, no history fabricated/dropped.
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);
    expect(ctx.deferredObjectiveBackfillPending).toBe(true);
    expect(store.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING)).toBeUndefined();

    // (3) Next healthy tick: getKeys() stays truthy → the pending back-fill completes,
    // recording the migrated task's elapsed deadline that the flake deferred.
    getKeysImpl = () => [...store.keys()];
    const healthyTickMs = flakeTickMs + 30_000;
    vi.setSystemTime(healthyTickMs);
    emitter.tick(healthyTickMs);

    const history = store.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING) as
      | { entries: DeferredObjectivePlanHistoryEntry[] }
      | undefined;
    const backfilled = (history?.entries ?? []).filter(
      (entry) => entry.deviceId === 'legacy-heater'
        && entry.deadlineAtMs === elapsedDeadlineMs,
    );
    expect(backfilled).toHaveLength(1);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK) as number)
      .toBeGreaterThan(oldWatermark);
    expect(ctx.deferredObjectiveBackfillPending).toBe(false);
  });

  // P1#2: a boot flake defers the migration (latch set). If the app restarts BEFORE the
  // first lifecycle tick runs the pending back-fill, onUninit must NOT advance the watermark
  // while the back-fill is still owed — otherwise the next boot skips the offline window.
  it('does not advance the watermark on uninit while a back-fill is pending', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    store.set(DEFERRED_OBJECTIVES_SETTINGS, {
      version: 1,
      objectivesByDeviceId: {
        'legacy-heater': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          deadlineAtMs: elapsedDeadlineMs,
          targetTemperatureC: 65,
        },
      },
    });

    // (1) Boot: empty getKeys() flake → migration defers, latch set, watermark untouched.
    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    expect(ctx.deferredObjectiveBackfillPending).toBe(true);

    // (2) Restart BEFORE the first lifecycle tick: onUninit persists the watermark. The
    // recorder is clean (nothing back-filled yet), so the dirty check alone would advance
    // it — but the pending latch must bail.
    expect(recorder.isDirty()).toBe(false);
    const uninitMs = bootMs + 10_000;
    vi.setSystemTime(uninitMs);
    persistDeferredObjectiveObservationWatermark(ctx, recorder);

    // Watermark NOT advanced — the offline window is still owed for the next boot.
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);

    // (3) Next boot: getKeys() healthy → startup back-fill latches again (marker still unset
    // since the prior session deferred the migration), then the first lifecycle tick runs the
    // migration + pending back-fill over the STILL-OWED full window, recording the migrated
    // task's elapsed deadline.
    getKeysImpl = () => [...store.keys()];
    const nextBootMs = uninitMs + 60_000;
    vi.setSystemTime(nextBootMs);
    const nextCtx = buildCtx(nextBootMs);
    const nextRecorder = createDeferredObjectivePlanHistoryRecorder(nextCtx);
    nextCtx.deferredObjectivePlanHistoryRecorder = nextRecorder;
    nextCtx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: () => null,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The migrated task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    const nextTickMs = nextBootMs + 30_000;
    vi.setSystemTime(nextTickMs);
    const nextEmitter = createDeferredObjectiveLifecycleEmitter(nextCtx);
    nextEmitter.tick(nextTickMs);

    const history = store.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING) as
      | { entries: DeferredObjectivePlanHistoryEntry[] }
      | undefined;
    const backfilled = (history?.entries ?? []).filter(
      (entry) => entry.deviceId === 'legacy-heater'
        && entry.deadlineAtMs === elapsedDeadlineMs,
    );
    expect(backfilled).toHaveLength(1);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK) as number)
      .toBeGreaterThan(oldWatermark);
    expect(nextCtx.deferredObjectiveBackfillPending).toBe(false);
  });
});
