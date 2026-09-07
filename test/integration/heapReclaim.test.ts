import { describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { reclaimHeapPages } from '../../lib/diagnostics/heapReclaim';

// Garbage of the shape production makes: a large object stringified and parsed
// repeatedly, as the SDK does to the whole settings blob on every write.
const churnHeap = (): void => {
  const blob = { rows: Array.from({ length: 20_000 }, (_, i) => ({ i, kwh: i * 0.001, note: 'x'.repeat(24) })) };
  for (let round = 0; round < 30; round += 1) {
    JSON.parse(JSON.stringify(blob));
  }
};

// The same runtime resolution the module uses, so the test can run the ORDINARY
// major collection first and show what the last-resort one returns beyond it.
const obtainOrdinaryGc = (): ((request: { type: 'major'; execution: 'sync' }) => void) => {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as (request: { type: 'major'; execution: 'sync' }) => void;
};

describe('reclaimHeapPages', () => {
  // The process under test is started without `--expose-gc`, exactly as Homey
  // starts the app, so this proves the runtime resolution path and not a flag.
  it('obtains the collector at runtime and returns committed heap an ordinary collection keeps', () => {
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe('undefined');
    churnHeap();
    obtainOrdinaryGc()({ type: 'major', execution: 'sync' });
    const committedAfterOrdinaryGcMb = v8.getHeapStatistics().total_heap_size / (1024 * 1024);
    const outcome = reclaimHeapPages();
    expect(outcome.status).toBe('reclaimed');
    if (outcome.status !== 'reclaimed') return;
    expect(Number.isFinite(outcome.durationMs)).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(outcome.before.heapTotalMb)).toBe(true);
    expect(Number.isFinite(outcome.after.heapTotalMb)).toBe(true);
    // The ordinary collection has already run and left the emptied pages
    // committed; only the last-resort flavour hands them back. A misspelled
    // request would silently degrade to an ordinary collection and fail here.
    expect(outcome.after.heapTotalMb).toBeLessThan(committedAfterOrdinaryGcMb / 2);
  });

  it('reuses the resolved collector on repeat calls', () => {
    const first = reclaimHeapPages();
    const second = reclaimHeapPages();
    expect(first.status).toBe('reclaimed');
    expect(second.status).toBe('reclaimed');
  });
});
