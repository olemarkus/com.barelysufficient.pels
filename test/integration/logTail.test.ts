import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogTailRecorder } from '../../lib/diagnostics/logTailRecorder';
import {
  createLogTailStore, LOG_TAIL_MAX_LINES_PER_EVENT_HOUR, LOG_TAIL_MAX_ROWS,
} from '../../lib/diagnostics/logTailStore';
import { createHomeyDestination } from '../../lib/logging/homeyDestination';
import { createRootLogger } from '../../lib/logging/logger';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 10, 30);
const BUDGET = 256 * 1024;

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
  const attached = () => {
    const db = open();
    const store = createLogTailStore(db);
    const recorder = new LogTailRecorder();
    recorder.attach(store);
    return { db, store, recorder, logger: loggerWith(recorder) };
  };

  it('keeps info, warnings and errors as written, but not debug lines', () => {
    vi.useFakeTimers({ now: NOW });
    const { store, logger } = attached();
    logger.debug({ event: 'noisy_debug' });
    logger.info({ event: 'plan_rebuild_completed', homeId: 'main' });
    logger.warn({ event: 'meter_stale' });
    logger.error({ event: 'device_write_failed', deviceId: 'heater' });
    expect(store.read(NOW - HOUR_MS, NOW, BUDGET, [])).toEqual({
      lines: [
        { atMs: NOW, level: 'info', entry: { event: 'plan_rebuild_completed', homeId: 'main' } },
        { atMs: NOW, level: 'warn', entry: { event: 'meter_stale' } },
        { atMs: NOW, level: 'error', entry: { event: 'device_write_failed', deviceId: 'heater' } },
      ],
      overflow: [],
      leftOut: 0,
    });
  });

  it('keeps the lines of a boot written before the database opened', () => {
    vi.useFakeTimers({ now: NOW });
    const recorder = new LogTailRecorder();
    loggerWith(recorder).info({ event: 'app_initialized' });
    const store = createLogTailStore(open());
    recorder.attach(store);
    expect(store.read(NOW - HOUR_MS, NOW, BUDGET, []).lines.map((line) => line.entry.event)).toEqual(['app_initialized']);
  });

  it('cuts a flood per event and device per hour, counts what it cut, and leaves other devices alone', () => {
    vi.useFakeTimers({ now: NOW });
    const { store, logger } = attached();
    for (let index = 0; index < LOG_TAIL_MAX_LINES_PER_EVENT_HOUR + 7; index += 1) {
      logger.info({ event: 'binary_command_applied', deviceId: 'heater' });
    }
    logger.info({ event: 'binary_command_applied', deviceId: 'charger' });
    vi.setSystemTime(NOW + HOUR_MS);
    logger.info({ event: 'binary_command_applied', deviceId: 'heater' });
    const read = store.read(NOW - HOUR_MS, NOW + HOUR_MS, BUDGET, []);
    const devices = read.lines.map((line) => line.entry.deviceId);
    expect(devices.filter((device) => device === 'heater')).toHaveLength(LOG_TAIL_MAX_LINES_PER_EVENT_HOUR + 1);
    expect(devices).toContain('charger');
    expect(read.overflow).toEqual([
      { hourStartMs: NOW - (NOW % HOUR_MS), key: 'binary_command_applied|heater', dropped: 7 },
    ]);
  });

  it('resumes the hour\'s cap from what it kept before a restart', () => {
    vi.useFakeTimers({ now: NOW });
    const { db, store, logger } = attached();
    for (let index = 0; index < LOG_TAIL_MAX_LINES_PER_EVENT_HOUR; index += 1) logger.error({ event: 'crash_loop' });
    logger.error({ event: 'crash_loop' });
    const restarted = new LogTailRecorder();
    const restartedLogger = loggerWith(restarted);
    restartedLogger.error({ event: 'crash_loop' });
    restarted.attach(createLogTailStore(db));
    restartedLogger.error({ event: 'crash_loop' });
    const read = store.read(NOW - HOUR_MS, NOW, BUDGET, []);
    expect(read.lines).toHaveLength(LOG_TAIL_MAX_LINES_PER_EVENT_HOUR);
    expect(read.overflow).toEqual([{ hourStartMs: NOW - (NOW % HOUR_MS), key: 'crash_loop', dropped: 3 }]);
  });

  it.each([
    ['plan_rebuild_completed', { failed: false }, { failed: true }],
    ['realtime_capability_drift', { deviceId: 'heater', pelsEcho: true }, { deviceId: 'heater', pelsEcho: false }],
  ] as const)('keeps late protected evidence for %s after a flood', (event, ordinary, protectedEvidence) => {
    const start = NOW - (NOW % HOUR_MS);
    vi.useFakeTimers({ now: start });
    const { store, logger } = attached();
    for (let index = 0; index < 24; index += 1) logger.info({ event, ...ordinary });
    expect(store.read(start, start, BUDGET, []).lines).toHaveLength(16);

    vi.setSystemTime(start + HOUR_MS / 4);
    logger.info({ event, ...ordinary });
    expect(store.read(start, Date.now(), BUDGET, []).lines).toHaveLength(17);

    vi.setSystemTime(start + HOUR_MS - 1_000);
    logger.info({ event, ...ordinary });
    logger.info({ event, ...ordinary });
    logger.info({ event, ...ordinary });
    logger.info({ event, ...protectedEvidence });
    const { lines } = store.read(start, Date.now(), BUDGET, []);
    expect(lines).toHaveLength(LOG_TAIL_MAX_LINES_PER_EVENT_HOUR);
    expect(lines.at(-1)).toMatchObject({ atMs: Date.now(), entry: { event, ...protectedEvidence } });
  });

  it('carries unused alert quota forward without reserving an alert slot', () => {
    const start = NOW - (NOW % HOUR_MS);
    vi.useFakeTimers({ now: start + HOUR_MS / 4 });
    const { store, logger } = attached();
    const event = 'hard_cap_shortfall_sustained_alert_triggered';
    for (let index = 0; index < 24; index += 1) logger.info({ event });
    expect(store.read(start, Date.now(), BUDGET, []).lines).toHaveLength(18);
    vi.setSystemTime(start + 3 * HOUR_MS / 4);
    for (let index = 0; index < 3; index += 1) logger.info({ event });
    expect(store.read(start, Date.now(), BUDGET, []).lines).toHaveLength(LOG_TAIL_MAX_LINES_PER_EVENT_HOUR);
  });

  it('replays startup lines from both sides of an hour boundary against their original hour', () => {
    const boundary = NOW + HOUR_MS / 2;
    vi.useFakeTimers({ now: boundary - 1 });
    const { db, logger } = attached();
    for (let index = 0; index < LOG_TAIL_MAX_LINES_PER_EVENT_HOUR; index += 1) logger.info({ event: 'status' });
    const restarted = new LogTailRecorder();
    const restartedLogger = loggerWith(restarted);
    restartedLogger.info({ event: 'status' });
    vi.setSystemTime(boundary);
    restartedLogger.info({ event: 'status' });
    const store = createLogTailStore(db);
    restarted.attach(store);
    const read = store.read(boundary - HOUR_MS, boundary, BUDGET, []);
    expect(read.lines).toHaveLength(LOG_TAIL_MAX_LINES_PER_EVENT_HOUR + 1);
    expect(read.lines.at(-1)?.atMs).toBe(boundary);
    expect(read.overflow).toEqual([{ hourStartMs: boundary - HOUR_MS, key: 'status', dropped: 1 }]);
  });

  it('flushes overflow recorded inside another store transaction on the next write', () => {
    vi.useFakeTimers({ now: NOW });
    const { db, logger } = attached();
    for (let index = 0; index < LOG_TAIL_MAX_LINES_PER_EVENT_HOUR; index += 1) logger.info({ event: 'status' });
    db.transaction(() => {
      logger.info({ event: 'status' });
      logger.info({ event: 'status' });
    });
    logger.info({ event: 'after' });
    expect(createLogTailStore(db).read(NOW - HOUR_MS, NOW, BUDGET, []).overflow)
      .toEqual([{ hourStartMs: NOW - (NOW % HOUR_MS), key: 'status', dropped: 2 }]);
  });

  it('reads the newest lines that fit the budget and says how many older ones it left out', () => {
    vi.useFakeTimers({ now: NOW });
    const { store, logger } = attached();
    for (let index = 0; index < 10; index += 1) logger.info({ event: `line-${index}`, filler: 'x'.repeat(100) });
    const lineBytes = JSON.stringify({ event: 'line-0', filler: 'x'.repeat(100) }).length;
    const read = store.read(NOW - HOUR_MS, NOW, lineBytes * 3 + 5, []);
    expect(read.lines.map((line) => line.entry.event)).toEqual(['line-7', 'line-8', 'line-9']);
    expect(read.leftOut).toBe(7);
  });

  it('leaves out the lines of omitted events, spending the budget only on the lines it keeps', () => {
    vi.useFakeTimers({ now: NOW });
    const { store, logger } = attached();
    for (let index = 0; index < 4; index += 1) {
      logger.info({ event: `line-${index}`, filler: 'x'.repeat(100) });
      logger.info({ event: 'binary_command_applied', deviceId: 'heater', filler: 'x'.repeat(100) });
    }
    const lineBytes = JSON.stringify({ event: 'line-0', filler: 'x'.repeat(100) }).length;
    const read = store.read(NOW - HOUR_MS, NOW, lineBytes * 3 + 5, ['binary_command_applied']);
    expect(read.lines.map((line) => line.entry.event)).toEqual(['line-1', 'line-2', 'line-3']);
    // Only the kept event's oldest line counts as left out for size.
    expect(read.leftOut).toBe(1);
  });

  it('keeps a line logged inside another store\'s transaction for the next write', () => {
    vi.useFakeTimers({ now: NOW });
    const { db, store, logger } = attached();
    db.transaction(() => { logger.error({ event: 'userdata_row_quarantined' }); });
    logger.info({ event: 'after' });
    expect(store.read(NOW - HOUR_MS, NOW, BUDGET, []).lines.map((line) => line.entry.event))
      .toEqual(['userdata_row_quarantined', 'after']);
  });

  it('keeps the row ceiling, trimming in batches rather than with every line', () => {
    vi.useFakeTimers({ now: NOW });
    const db = open();
    const store = createLogTailStore(db);
    const rows = () => db.prepare('SELECT COUNT(*) AS rows FROM log_tail').get()?.rows;
    for (let index = 0; index < LOG_TAIL_MAX_ROWS + 250; index += 1) {
      store.append({ atMs: NOW, level: 30, key: 'line', line: `{"event":"line","index":${index}}` });
    }
    expect(rows()).toBeGreaterThan(LOG_TAIL_MAX_ROWS);
    expect(rows()).toBeLessThanOrEqual(LOG_TAIL_MAX_ROWS + 100);
    const newest = store.read(0, NOW, BUDGET, []).lines.at(-1)?.entry;
    expect(newest).toEqual({ event: 'line', index: LOG_TAIL_MAX_ROWS + 249 });
  });

  it('keeps two days, and survives the database closing under it', () => {
    vi.useFakeTimers({ now: NOW - 49 * HOUR_MS });
    const db = open();
    const store = createLogTailStore(db);
    store.append({ atMs: Date.now(), level: 30, key: 'old', line: '{"event":"old"}' });
    vi.setSystemTime(NOW);
    store.append({ atMs: NOW, level: 30, key: 'new', line: '{"event":"new"}' });
    expect(store.read(0, NOW, BUDGET, []).lines.map((line) => line.entry.event)).toEqual(['new']);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    expect(() => store.append({ atMs: NOW, level: 30, key: 'late', line: '{}' })).not.toThrow();
    expect(() => store.recordOverflow(NOW, 'late', 1)).not.toThrow();
  });
});
