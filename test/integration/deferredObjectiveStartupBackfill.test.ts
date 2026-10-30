import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferredObjectivePlanHistoryRecorder } from '../../setup/appInit';
import {
  DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
} from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { createInertEnergyDelivery } from '../helpers/deferredObjectiveWiringFixtures';
import { createPlanHistoryStore, type PlanHistoryStore } from '../../lib/objectives/deferredObjectives/planHistoryStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_ID = 'heater';

/**
 * The startup back-fill records a task deadline that elapsed while PELS was
 * off: boot reads the stored tasks, back-fills the `(watermark, now]` offline
 * window into persisted history, and advances the watermark past it.
 *
 * Driven through the real recorder; only the Homey SDK boundary (settings
 * get/set/unset/getKeys + clock) is faked.
 */
describe('deferred-objective startup back-fill', () => {
  let store: Map<string, unknown>;
  // The plan history lives in the userdata database.
  let userdataDatabase: UserdataDatabase;
  let planHistoryStore: PlanHistoryStore;

  const buildCtx = (now: number): AppContext => {
    const homey = {
      settings: {
        get: vi.fn((key: string) => store.get(key)),
        set: vi.fn((key: string, value: unknown) => { store.set(key, value); }),
        unset: vi.fn((key: string) => { store.delete(key); }),
        getKeys: vi.fn(() => [...store.keys()]),
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

  it('records a task deadline that elapsed while PELS was off', () => {
    const bootMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    // Watermark sits a day back; the task's one-shot deadline elapsed inside the
    // (oldWatermark, boot] offline window.
    const oldWatermark = bootMs - 24 * HOUR_MS;
    const elapsedDeadlineMs = bootMs - 6 * HOUR_MS;
    store.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, oldWatermark);
    store.set(`${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${DEVICE_ID}`, {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      deadlineAtMs: elapsedDeadlineMs,
      targetTemperatureC: 65,
    });

    vi.setSystemTime(bootMs);
    createDeferredObjectivePlanHistoryRecorder(buildCtx(bootMs));

    const backfilled = (planHistoryStore.read()?.entries ?? []).filter(
      (entry) => entry.deviceId === DEVICE_ID && entry.deadlineAtMs === elapsedDeadlineMs,
    );
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]!.discoveredFrom).toBe('backfill');
    expect(store.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK)).toBe(bootMs);
  });
});
