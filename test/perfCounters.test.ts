import { addPerfDuration, getPerfSnapshot, incPerfCounter, incPerfCounters } from '../lib/utils/perfCounters';

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
});
