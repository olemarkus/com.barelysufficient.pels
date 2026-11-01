import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../../contracts/src/deferredObjectivePlanHistory.ts';
import { SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH } from '../../contracts/src/settingsUi/paths.ts';
import {
  invalidateDeferredObjectiveHistoryRead,
  readDeferredObjectiveHistory,
} from '../src/ui/deferredObjectiveHistoryRead.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { createHomeyMock } from './helpers/homeyApiMock.ts';

const emptyHistory = (): SettingsUiDeferredObjectivePlanHistoryPayload => ({ version: 1, entriesByDeviceId: {} });

const pendingHistory = () => {
  let resolve!: (payload: SettingsUiDeferredObjectivePlanHistoryPayload) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SettingsUiDeferredObjectivePlanHistoryPayload>((resolveRead, rejectRead) => {
    resolve = resolveRead;
    reject = rejectRead;
  });
  return { promise, resolve, reject };
};

const serveHistory = (handler: () => Promise<SettingsUiDeferredObjectivePlanHistoryPayload>) => {
  const read = vi.fn(handler);
  setHomeyClient(createHomeyMock({
    apiHandlers: { [`GET ${SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH}`]: read },
  }));
  return read;
};

afterEach(() => {
  invalidateDeferredObjectiveHistoryRead();
  setHomeyClient(null);
});

describe('shared Overview and recommendation history read', () => {
  it('shares an outstanding archive request and reads again after it settles', async () => {
    const pending = pendingHistory();
    const read = serveHistory(() => pending.promise);
    const overview = readDeferredObjectiveHistory('overview');
    const recommendations = readDeferredObjectiveHistory('recommendations');
    const payload = emptyHistory();
    pending.resolve(payload);

    await expect(overview).resolves.toBe(payload);
    await expect(recommendations).resolves.toBe(payload);
    expect(read).toHaveBeenCalledTimes(1);

    const freshPayload = emptyHistory();
    read.mockResolvedValue(freshPayload);
    await expect(readDeferredObjectiveHistory('overview')).resolves.toBe(freshPayload);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('releases a failed request so a later reader can recover', async () => {
    const pending = pendingHistory();
    const read = serveHistory(() => pending.promise);
    const overview = readDeferredObjectiveHistory('overview');
    const recommendations = readDeferredObjectiveHistory('recommendations');
    const failures = Promise.all([
      expect(overview).rejects.toThrow('History unavailable'),
      expect(recommendations).rejects.toThrow('History unavailable'),
    ]);
    pending.reject(new Error('History unavailable'));
    await failures;
    expect(read).toHaveBeenCalledTimes(1);

    const payload = emptyHistory();
    read.mockResolvedValue(payload);
    await expect(readDeferredObjectiveHistory('overview')).resolves.toBe(payload);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['task change', 'same owner refresh'] as const)(
    'starts a fresh read after %s and keeps it when the old read settles', async (trigger) => {
      const previous = pendingHistory();
      const current = pendingHistory();
      const read = serveHistory(() => previous.promise);
      const oldRead = readDeferredObjectiveHistory('overview');
      if (trigger === 'task change') invalidateDeferredObjectiveHistoryRead();
      read.mockImplementation(() => current.promise);
      const freshRead = readDeferredObjectiveHistory(trigger === 'task change' ? 'recommendations' : 'overview');

      previous.resolve(emptyHistory());
      await oldRead;
      const joinedRead = readDeferredObjectiveHistory(trigger === 'task change' ? 'overview' : 'recommendations');
      const freshPayload = emptyHistory();
      current.resolve(freshPayload);
      await expect(freshRead).resolves.toBe(freshPayload);
      await expect(joinedRead).resolves.toBe(freshPayload);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
});
