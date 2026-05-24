/**
 * @vitest-environment node
 *
 * Isolated test file for the {@link MAX_LOGGER_CACHE_SIZE} warn-once guard.
 * The module-level `moduleLoggerCache` persists for the lifetime of the
 * worker, so this suite needs to own the cache from a clean start — keeping
 * it in its own file means the forked vitest worker boots a fresh module
 * graph and we are not racing the assertions in `logger.test.ts` (which
 * registers other distinct module strings).
 *
 * Because the cache is module-scoped and not resettable, the tests in this
 * file are ordered: the "no warning under threshold" assertion runs first,
 * the threshold-crossing assertion runs second (and pushes the cache well
 * past the cap for the rest of the worker), and the warn-once assertion
 * runs last and only relies on the once-flag being re-armed and then
 * staying false.
 */
import { PassThrough } from 'node:stream';
import {
  MAX_LOGGER_CACHE_SIZE,
  __resetLoggerCacheGuardForTest,
  createRootLogger,
  getLogger,
  setRootLogger,
} from '../../lib/logging/logger';

type ParsedLine = Record<string, unknown>;

function drain(dest: PassThrough): ParsedLine[] {
  const raw = (dest.read() as Buffer | null)?.toString() ?? '';
  if (!raw) return [];
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ParsedLine);
}

const cacheGrowthWarnings = (dest: PassThrough): ParsedLine[] => (
  drain(dest).filter((line) => line.event === 'logger_cache_growth_exceeded')
);

describe('getLogger cache guard', () => {
  let dest: PassThrough;

  beforeEach(() => {
    dest = new PassThrough();
    setRootLogger(createRootLogger(dest, 'warn'));
    __resetLoggerCacheGuardForTest();
  });

  afterEach(() => {
    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  it('does not grow the cache when the same module string is requested repeatedly', () => {
    const first = getLogger('cache-guard/stable');
    for (let index = 0; index < 5000; index += 1) {
      expect(getLogger('cache-guard/stable')).toBe(first);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(0);
  });

  it('does not emit a warning while the cache is below the threshold', () => {
    // A handful of new distinct modules — far short of MAX_LOGGER_CACHE_SIZE
    // even when added on top of every other module the worker has already
    // resolved (this test file plus any imports). Asserts the gate is keyed
    // on the cap, not on every new module.
    for (let index = 0; index < 3; index += 1) {
      getLogger(`cache-guard/under-${index}`);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(0);
  });

  it('emits the warning exactly once when distinct module strings cross the threshold', () => {
    // Walk well past the threshold to ensure both the crossing and the
    // post-crossing calls are observed.
    for (let index = 0; index < MAX_LOGGER_CACHE_SIZE + 25; index += 1) {
      getLogger(`cache-guard/cross-${index}`);
    }
    const warnings = cacheGrowthWarnings(dest);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning.threshold).toBe(MAX_LOGGER_CACHE_SIZE);
    expect(typeof warning.cacheSize).toBe('number');
    expect(warning.cacheSize as number).toBeGreaterThan(MAX_LOGGER_CACHE_SIZE);
    expect(typeof warning.latestModule).toBe('string');
    expect((warning.latestModule as string).startsWith('cache-guard/cross-')).toBe(true);
    expect(warning.module).toBe('logging/cache');
    expect(warning.level).toBe(40); // pino warn level
  });

  it('does not re-emit the warning after the threshold has been crossed even when more distinct modules are added', () => {
    // The previous test already pushed the cache past the threshold, so the
    // guard flag should now be set. The beforeEach reset it back to false —
    // we exercise the gate again with more growth and assert it still does
    // not re-fire because the cache continues to be over the cap and the
    // once-flag is re-set by the very first new addition. We then drain and
    // ensure further growth produces no additional warnings.

    // Step 1: at least one new module to re-trip the gate so the flag flips
    // back to true.
    getLogger('cache-guard/aftermath-trigger');
    const triggerWarnings = cacheGrowthWarnings(dest);
    // The flag was reset in beforeEach, so this single new module above the
    // cap re-fires once.
    expect(triggerWarnings).toHaveLength(1);

    // Step 2: many more distinct modules; none should produce additional warnings.
    for (let index = 0; index < 50; index += 1) {
      getLogger(`cache-guard/aftermath-${index}`);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(0);
  });
});
