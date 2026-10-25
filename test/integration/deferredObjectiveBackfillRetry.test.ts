import { createEmptyActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeferredObjectiveLifecycleEmitter,
  createDeferredObjectivePlanHistoryRecorder,
  persistDeferredObjectiveObservationWatermark,
} from '../../setup/appInit';
import {
  DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
} from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';
import { buildTaskEvaluationSourceForTest, createAppContextMock } from '../helpers/appContextTestHelpers';
import { createInertEnergyDelivery } from '../helpers/deferredObjectiveWiringFixtures';
import { createPlanHistoryStore, type PlanHistoryStore } from '../../lib/objectives/deferredObjectives/planHistoryStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_ID = 'heater';

/**
 * Regression: a startup back-fill that a boot flake deferred must re-run in
 * session. Sequence under test (the exact silent-history-loss bug):
 *
 *  1. Boot with a transient empty `getKeys()` flake: `runStartupBackfill` cannot
 *     trust an empty roster, so it bails WITHOUT advancing the watermark, latching
 *     `deferredObjectiveBackfillPending`.
 *  2. In-session lifecycle tick: `getKeys()` now succeeds.
 *  3. The SAME tick's `observeDeferredObjectivePlanHistory` must back-fill the still-
 *     pending `(oldWatermark, now]` offline window BEFORE advancing the watermark —
 *     so the task's elapsed one-shot deadline is recorded in history, not silently
 *     skipped because the watermark jumped to now.
 *
 * Driven through the real recorder + lifecycle emitter seam; only the Homey SDK
 * boundary (settings get/set/unset/getKeys + clock) is faked.
 */
describe('deferred-objective back-fill retried after a boot-time key-list flake', () => {
  let store: Map<string, unknown>;
  let getKeysImpl: () => string[];
  // The plan history lives in the userdata database; one database spans the boots below.
  let userdataDatabase: UserdataDatabase;
  let planHistoryStore: PlanHistoryStore;

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
      },
    } as unknown as AppContext['homey'];
    return createAppContextMock({
      homey,
      getUserdataDatabase: () => userdataDatabase,
      getNow: () => new Date(now),
      getTimeZone: () => 'Europe/Oslo',
      // No managed devices this session: diagnostics are empty, so the only way the
      // task's elapsed deadline reaches history is the offline-window back-fill —
      // exactly the path under test.
      planService: {
        getPlanDevices: () => [],
        getStallEvidence: () => undefined,
        rebuildPlanFromCache: vi.fn(async () => undefined),
        evaluateHeadroomForDevice: vi.fn(() => null),
        syncLivePlanStateInline: vi.fn(() => false),
      } as unknown as AppContext['planService'],
      deferredObjectiveEnergyDelivery: createInertEnergyDelivery(),
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Map<string, unknown>();
    userdataDatabase = openUserdataDatabase(IN_MEMORY_DATABASE);
    planHistoryStore = createPlanHistoryStore(userdataDatabase);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // One enabled temperature task whose one-shot deadline elapsed while PELS was off.
  const storeElapsedTask = (deadlineAtMs: number): void => {
    store.set(`${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${DEVICE_ID}`, {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      deadlineAtMs,
      targetTemperatureC: 65,
    });
  };

  it('records the task\'s elapsed deadline that the boot back-fill deferred', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    // Watermark sits a day back; the task's one-shot deadline elapsed inside the
    // (oldWatermark, boot] offline window while PELS was off.
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    storeElapsedTask(elapsedDeadlineMs);

    // (1) Boot: empty getKeys() flake → the back-fill cannot trust the empty roster.
    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    ctx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: createEmptyActivePlans,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    // Boot back-fill bailed: watermark untouched, history empty, latch set.
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);
    expect(planHistoryStore.read()).toBeNull();
    expect(ctx.deferredObjectiveBackfillPending).toBe(true);

    // (2) + (3) In-session tick: getKeys() now succeeds, and
    // observeDeferredObjectivePlanHistory runs the pending back-fill before the
    // watermark advances.
    getKeysImpl = () => [...store.keys()];
    const tickMs = bootMs + 30_000;
    vi.setSystemTime(tickMs);
    const emitter = createDeferredObjectiveLifecycleEmitter(ctx, buildTaskEvaluationSourceForTest(ctx));
    emitter.tick(tickMs);

    // The task's elapsed deadline was back-filled into persisted history —
    // NOT silently skipped. This is the core regression assertion.
    const history = planHistoryStore.read();
    expect(history).toBeDefined();
    const backfilled = (history?.entries ?? []).filter(
      (entry) => entry.deviceId === DEVICE_ID
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
    storeElapsedTask(elapsedDeadlineMs);

    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    ctx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: createEmptyActivePlans,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    getKeysImpl = () => [...store.keys()];
    const emitter = createDeferredObjectiveLifecycleEmitter(ctx, buildTaskEvaluationSourceForTest(ctx));

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

  // P1#1: getKeys() flakes empty again on the latched tick. An empty key list must NOT be
  // mistaken for "zero enabled objectives" — that would advance the watermark and clear the
  // latch, permanently skipping the offline window (the silent-history-loss this guards).
  it('does not advance the watermark when getKeys() flakes empty on the latched tick', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    storeElapsedTask(elapsedDeadlineMs);

    // (1) Boot: empty getKeys() flake → latch set.
    getKeysImpl = () => [];
    vi.setSystemTime(bootMs);
    const ctx = buildCtx(bootMs);
    const recorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    ctx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: createEmptyActivePlans,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    expect(ctx.deferredObjectiveBackfillPending).toBe(true);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);

    // (2) Latched tick: getKeys() still flakes empty, so the back-fill's trustworthiness check
    // sees an empty list. This is the transient-empty flake the back-fill must NOT mistake for
    // "zero enabled objectives".
    const flakeTickMs = bootMs + 30_000;
    vi.setSystemTime(flakeTickMs);
    const emitter = createDeferredObjectiveLifecycleEmitter(ctx, buildTaskEvaluationSourceForTest(ctx));
    emitter.tick(flakeTickMs);

    // The empty-config read was untrustworthy: watermark NOT advanced, latch STILL set, no
    // history fabricated/dropped.
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(oldWatermark);
    expect(ctx.deferredObjectiveBackfillPending).toBe(true);
    expect(planHistoryStore.read()).toBeNull();

    // (3) Next healthy tick: getKeys() answers → the pending back-fill completes,
    // recording the task's elapsed deadline that the flake deferred.
    getKeysImpl = () => [...store.keys()];
    const healthyTickMs = flakeTickMs + 30_000;
    vi.setSystemTime(healthyTickMs);
    emitter.tick(healthyTickMs);

    const history = planHistoryStore.read();
    const backfilled = (history?.entries ?? []).filter(
      (entry) => entry.deviceId === DEVICE_ID
        && entry.deadlineAtMs === elapsedDeadlineMs,
    );
    expect(backfilled).toHaveLength(1);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK) as number)
      .toBeGreaterThan(oldWatermark);
    expect(ctx.deferredObjectiveBackfillPending).toBe(false);
  });

  // P1#2: a boot flake defers the back-fill (latch set). If the app restarts BEFORE the
  // first lifecycle tick runs the pending back-fill, onUninit must NOT advance the watermark
  // while the back-fill is still owed — otherwise the next boot skips the offline window.
  it('does not advance the watermark on uninit while a back-fill is pending', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;

    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    storeElapsedTask(elapsedDeadlineMs);

    // (1) Boot: empty getKeys() flake → latch set, watermark untouched.
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

    // (3) Next boot: getKeys() healthy → the startup back-fill runs over the STILL-OWED full
    // window, recording the task's elapsed deadline.
    getKeysImpl = () => [...store.keys()];
    const nextBootMs = uninitMs + 60_000;
    vi.setSystemTime(nextBootMs);
    const nextCtx = buildCtx(nextBootMs);
    const nextRecorder = createDeferredObjectivePlanHistoryRecorder(nextCtx);
    nextCtx.deferredObjectivePlanHistoryRecorder = nextRecorder;
    nextCtx.deferredObjectiveActivePlanRecorder = {
      getActivePlansSnapshot: createEmptyActivePlans,
      observe: vi.fn(),
      flushIfDirty: vi.fn(() => false),
      // The task's elapsed deadline fires `onDeadlineReached` → disarm →
      // `disableDeferredObjectiveInSettings`, which calls `clearForDevice`. Expose
      // it so that (now wired) lifecycle path runs cleanly instead of crashing.
      clearForDevice: vi.fn(),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'];

    const nextTickMs = nextBootMs + 30_000;
    vi.setSystemTime(nextTickMs);
    const nextEmitter = createDeferredObjectiveLifecycleEmitter(nextCtx, buildTaskEvaluationSourceForTest(nextCtx));
    nextEmitter.tick(nextTickMs);

    const history = planHistoryStore.read();
    const backfilled = (history?.entries ?? []).filter(
      (entry) => entry.deviceId === DEVICE_ID
        && entry.deadlineAtMs === elapsedDeadlineMs,
    );
    expect(backfilled).toHaveLength(1);
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK) as number)
      .toBeGreaterThan(oldWatermark);
    expect(nextCtx.deferredObjectiveBackfillPending).toBe(false);
  });
});
