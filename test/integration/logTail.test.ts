import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogTailRecorder } from '../../lib/diagnostics/logTailRecorder';
import { createLogTailStore, LOG_TAIL_MAX_LINES_PER_EVENT_HOUR } from '../../lib/diagnostics/logTailStore';
import { createHomeyDestination } from '../../lib/logging/homeyDestination';
import { createRootLogger } from '../../lib/logging/logger';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 10, 30);

describe('the log PELS keeps for problem reports', () => {
  const databases: UserdataDatabase[] = [];
  const open = (): UserdataDatabase => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    databases.push(db);
    return db;
  };
  afterEach(() => {
    vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
  });

  const loggerWith = (recorder: LogTailRecorder) => createRootLogger(
    createHomeyDestination({ log: vi.fn(), error: vi.fn() }, (level, line) => recorder.observe(level, line)), 'debug',
  );

  it('keeps info, warnings and errors as written, but not debug lines', () => {
    vi.useFakeTimers({ now: NOW });
    const store = createLogTailStore(open());
    const recorder = new LogTailRecorder();
    recorder.attach(store);
    const logger = loggerWith(recorder);
    logger.debug({ event: 'noisy_debug' });
    logger.info({ event: 'plan_rebuild_completed', homeId: 'main' });
    logger.warn({ event: 'meter_stale' });
    logger.error({ event: 'device_write_failed', deviceId: 'heater' });
    expect(store.read(NOW - HOUR_MS, NOW)).toEqual({
      lines: [
        { atMs: NOW, level: 'info', entry: { event: 'plan_rebuild_completed', homeId: 'main' } },
        { atMs: NOW, level: 'warn', entry: { event: 'meter_stale' } },
        { atMs: NOW, level: 'error', entry: { event: 'device_write_failed', deviceId: 'heater' } },
      ],
      overflow: [],
    });
  });

  it('keeps the lines of a boot written before the database opened', () => {
    vi.useFakeTimers({ now: NOW });
    const recorder = new LogTailRecorder();
    loggerWith(recorder).info({ event: 'app_initialized' });
    const store = createLogTailStore(open());
    recorder.attach(store);
    expect(store.read(NOW - HOUR_MS, NOW).lines.map((line) => line.entry.event)).toEqual(['app_initialized']);
  });

  it('cuts a flooding event per hour and counts what it cut', () => {
    vi.useFakeTimers({ now: NOW });
    const store = createLogTailStore(open());
    const recorder = new LogTailRecorder();
    recorder.attach(store);
    const logger = loggerWith(recorder);
    for (let index = 0; index < LOG_TAIL_MAX_LINES_PER_EVENT_HOUR + 7; index += 1) logger.error({ event: 'flood' });
    logger.info({ event: 'other' });
    vi.setSystemTime(NOW + HOUR_MS);
    logger.error({ event: 'flood' });
    const read = store.read(NOW - HOUR_MS, NOW + HOUR_MS);
    expect(read.lines.filter((line) => line.entry.event === 'flood')).toHaveLength(LOG_TAIL_MAX_LINES_PER_EVENT_HOUR + 1);
    expect(read.lines.some((line) => line.entry.event === 'other')).toBe(true);
    expect(read.overflow).toEqual([{ hourStartMs: NOW - (NOW % HOUR_MS), event: 'flood', dropped: 7 }]);
  });

  it('keeps two days, and survives the database closing under it', () => {
    vi.useFakeTimers({ now: NOW - 49 * HOUR_MS });
    const db = open();
    const store = createLogTailStore(db);
    store.append({ atMs: Date.now(), level: 30, event: 'old', line: '{"event":"old"}' });
    vi.setSystemTime(NOW);
    store.append({ atMs: NOW, level: 30, event: 'new', line: '{"event":"new"}' });
    expect(store.read(0, NOW).lines.map((line) => line.entry.event)).toEqual(['new']);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    expect(() => store.append({ atMs: NOW, level: 30, event: 'late', line: '{}' })).not.toThrow();
  });
});
