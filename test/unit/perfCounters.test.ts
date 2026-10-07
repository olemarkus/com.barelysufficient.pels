import {
  addPerfDuration, getPerfSnapshot, getPerfSnapshotAndResetWindow, incPerfCounter, incPerfCounters,
} from '../../lib/utils/perfCounters';

describe('perfCounters', () => {
  it('increments counters and durations', () => {
    const before = getPerfSnapshot();

    incPerfCounter('perf.test.counter');
    incPerfCounter('perf.test.counter', 2);
    incPerfCounter('', 5);
    incPerfCounter('perf.test.counter', 0);

    addPerfDuration('perf.test.duration', 10);
    addPerfDuration('perf.test.duration', 5);
    addPerfDuration('', 20);
    addPerfDuration('perf.test.duration', Number.NaN);

    const after = getPerfSnapshot();
    const beforeCount = before.counts['perf.test.counter'] || 0;
    const afterCount = after.counts['perf.test.counter'] || 0;
    expect(afterCount).toBe(beforeCount + 3);

    const beforeDuration = before.durations['perf.test.duration'] || { totalMs: 0, maxMs: 0, count: 0 };
    const afterDuration = after.durations['perf.test.duration'];
    expect(afterDuration.count).toBe(beforeDuration.count + 3);
    expect(afterDuration.totalMs).toBeCloseTo(beforeDuration.totalMs + 15, 5);
    expect(afterDuration.maxMs).toBeGreaterThanOrEqual(beforeDuration.maxMs);
  });

  it('increments counters in a single batch', () => {
    const before = getPerfSnapshot();
    incPerfCounters([
      'perf.batch.counter',
      ['perf.batch.counter', 2],
      ['', 5],
      ['perf.batch.counter', Number.NaN],
    ]);
    const after = getPerfSnapshot();
    const beforeCount = before.counts['perf.batch.counter'] || 0;
    const afterCount = after.counts['perf.batch.counter'] || 0;
    expect(afterCount).toBe(beforeCount + 3);
  });

  it('keeps exported counts and nested durations independent of live updates', () => {
    incPerfCounter('perf.snapshot.counter', 2);
    addPerfDuration('perf.snapshot.duration', 10);
    const snapshot = getPerfSnapshot();

    incPerfCounter('perf.snapshot.counter', 3);
    addPerfDuration('perf.snapshot.duration', 20);
    expect(snapshot.counts['perf.snapshot.counter']).toBe(2);
    expect(snapshot.durations['perf.snapshot.duration']).toEqual({
      totalMs: 10, maxMs: 10, count: 1, windowMaxMs: 10,
    });

    snapshot.counts['perf.snapshot.counter'] = 1000;
    snapshot.durations['perf.snapshot.duration'].totalMs = 1000;
    const current = getPerfSnapshot();
    expect(current.counts['perf.snapshot.counter']).toBe(5);
    expect(current.durations['perf.snapshot.duration'].totalMs).toBe(30);
  });

  it('resets only window maxima after exporting an independent snapshot', () => {
    addPerfDuration('perf.window.duration', 20);
    addPerfDuration('perf.window.duration', 10);
    const snapshot = getPerfSnapshotAndResetWindow();
    expect(snapshot.durations['perf.window.duration']).toEqual({
      totalMs: 30, maxMs: 20, count: 2, windowMaxMs: 20,
    });
    expect(getPerfSnapshot().durations['perf.window.duration']).toEqual({
      totalMs: 30, maxMs: 20, count: 2, windowMaxMs: 0,
    });

    addPerfDuration('perf.window.duration', 5);
    expect(getPerfSnapshot().durations['perf.window.duration']).toEqual({
      totalMs: 35, maxMs: 20, count: 3, windowMaxMs: 5,
    });
    expect(snapshot.durations['perf.window.duration'].windowMaxMs).toBe(20);
  });

  it('preserves batch aggregation and ignores non-finite increments', () => {
    incPerfCounter('perf.cancel.counter', 7);
    incPerfCounters([
      ['perf.cancel.counter', -2], ['perf.cancel.counter', 2],
      ['perf.cancel.counter', Number.POSITIVE_INFINITY],
    ]);
    incPerfCounter('perf.cancel.counter', Number.NaN);
    expect(getPerfSnapshot().counts['perf.cancel.counter']).toBe(7);
  });

  it.each(['__proto__', 'constructor', 'toString'])('treats %s as an ordinary metric key', (key) => {
    incPerfCounter(key, 2);
    incPerfCounters([[key, 3]]);
    addPerfDuration(key, 10);
    addPerfDuration(key, 5);
    const snapshot = getPerfSnapshot();
    expect(snapshot.counts[key]).toBe(5);
    expect(snapshot.durations[key]).toEqual({ totalMs: 15, maxMs: 10, count: 2, windowMaxMs: 10 });
  });
});
