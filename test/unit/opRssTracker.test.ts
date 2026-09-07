import {
  __resetRssSupportProbeForTests,
  drainOpRssWindow,
  recordOpRssDelta,
  safeRss,
} from '../../lib/utils/opRssTracker';

const enoent = (): never => {
  const err: NodeJS.ErrnoException = new Error(
    'ENOENT: no such file or directory, uv_resident_set_memory',
  );
  err.code = 'ENOENT';
  err.errno = -2;
  err.syscall = 'uv_resident_set_memory';
  throw err;
};

// `safeRss` reads `process.memoryUsage.rss()` — the one number — so the double
// carries that method beside the whole-object form.
const memoryUsageWith = (rss: () => number): typeof process.memoryUsage => Object.assign(
  () => ({ rss: rss(), heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  { rss },
) as unknown as typeof process.memoryUsage;

describe('opRssTracker.safeRss', () => {
  const originalMemoryUsage = process.memoryUsage;

  beforeEach(() => {
    __resetRssSupportProbeForTests();
    drainOpRssWindow();
  });

  afterEach(() => {
    process.memoryUsage = originalMemoryUsage;
    __resetRssSupportProbeForTests();
  });

  it('returns null when process.memoryUsage throws ENOENT (Homey libuv quirk)', () => {
    process.memoryUsage = memoryUsageWith(enoent);
    expect(safeRss()).toBeNull();
  });

  it('returns rss bytes when the read succeeds', () => {
    process.memoryUsage = memoryUsageWith(() => 123_456_789);
    expect(safeRss()).toBe(123_456_789);
  });

  it('caches unsupported probe so repeated calls do not re-throw', () => {
    const spy = vi.fn(enoent);
    process.memoryUsage = memoryUsageWith(spy);
    expect(safeRss()).toBeNull();
    expect(safeRss()).toBeNull();
    expect(safeRss()).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('opRssTracker delta recording under failure', () => {
  const originalMemoryUsage = process.memoryUsage;

  beforeEach(() => {
    __resetRssSupportProbeForTests();
    drainOpRssWindow();
  });

  afterEach(() => {
    process.memoryUsage = originalMemoryUsage;
    __resetRssSupportProbeForTests();
  });

  it('recordOpRssDelta is a no-op when either sample is null', () => {
    recordOpRssDelta('key', null, 100);
    recordOpRssDelta('key', 100, null);
    recordOpRssDelta('key', null, null);
    expect(drainOpRssWindow()).toEqual({});
  });

  it('seeds maxBytes from the first sample so all-negative deltas report the actual peak', () => {
    const MB = 1024 * 1024;
    recordOpRssDelta('shrink_op', 10 * MB, 8 * MB);
    recordOpRssDelta('shrink_op', 8 * MB, 5 * MB);
    const window = drainOpRssWindow();
    expect(window.shrink_op.count).toBe(2);
    // Peak (least-negative) delta observed: -2 MB. Without the fix this would be 0.
    expect(window.shrink_op.maxMb).toBeCloseTo(-2, 5);
  });

  it('drops the sample at the call-site pattern when memoryUsage throws', () => {
    process.memoryUsage = memoryUsageWith(enoent);
    const before = safeRss();
    const after = safeRss();
    recordOpRssDelta('plan_build_ms', before, after);
    expect(drainOpRssWindow()).toEqual({});
  });
});
