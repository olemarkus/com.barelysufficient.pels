/**
 * @vitest-environment node
 *
 * Isolated test file for the {@link MAX_LOGGER_CACHE_SIZE} warn-once guard.
 * The module-level `moduleLoggerCache` and the warn-once flags persist for the
 * lifetime of a module instance, so every test imports a fresh copy of the
 * logger: each one starts from an empty cache with both flags un-armed, and the
 * tests do not depend on running in any particular order.
 */
import { PassThrough } from 'node:stream';

type LoggerModule = typeof import('../../lib/logging/logger.ts');
type ParsedLine = Record<string, unknown>;

const importFreshLogger = async (): Promise<LoggerModule> => {
  vi.resetModules();
  return import('../../lib/logging/logger.ts');
};

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
  let logger: LoggerModule;

  beforeEach(async () => {
    logger = await importFreshLogger();
    dest = new PassThrough();
    logger.setRootLogger(logger.createRootLogger(dest, 'warn'));
  });

  it('does not grow the cache when the same module string is requested repeatedly', () => {
    const first = logger.getLogger('cache-guard/stable');
    for (let index = 0; index < 5000; index += 1) {
      expect(logger.getLogger('cache-guard/stable')).toBe(first);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(0);
  });

  it('does not emit a warning while the cache is below the threshold', () => {
    // A handful of new distinct modules — far short of MAX_LOGGER_CACHE_SIZE
    // even when added on top of every module the logger's own import graph
    // resolves. Asserts the gate is keyed on the cap, not on every new module.
    for (let index = 0; index < 3; index += 1) {
      logger.getLogger(`cache-guard/under-${index}`);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(0);
  });

  it('emits the warning exactly once when distinct module strings cross the threshold', () => {
    // Walk well past the threshold to ensure both the crossing and the
    // post-crossing calls are observed.
    for (let index = 0; index < logger.MAX_LOGGER_CACHE_SIZE + 25; index += 1) {
      logger.getLogger(`cache-guard/cross-${index}`);
    }
    const warnings = cacheGrowthWarnings(dest);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning.threshold).toBe(logger.MAX_LOGGER_CACHE_SIZE);
    expect(typeof warning.cacheSize).toBe('number');
    expect(warning.cacheSize as number).toBeGreaterThan(logger.MAX_LOGGER_CACHE_SIZE);
    expect(typeof warning.latestModule).toBe('string');
    expect((warning.latestModule as string).startsWith('cache-guard/cross-')).toBe(true);
    expect(warning.module).toBe('logging/cache');
    expect(warning.level).toBe(40); // pino warn level
  });

  it('does not re-emit the warning after the threshold has been crossed even when more distinct modules are added', () => {
    // Step 1: cross the threshold and drain the one warning that produces.
    for (let index = 0; index <= logger.MAX_LOGGER_CACHE_SIZE; index += 1) {
      logger.getLogger(`cache-guard/aftermath-trigger-${index}`);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(1);

    // Step 2: many more distinct modules while the cache stays over the cap;
    // none should produce additional warnings.
    for (let index = 0; index < 50; index += 1) {
      logger.getLogger(`cache-guard/aftermath-${index}`);
    }
    expect(cacheGrowthWarnings(dest)).toHaveLength(0);
  });
});

describe('getDebugEmitter component cache guard', () => {
  let dest: PassThrough;
  let logger: LoggerModule;

  beforeEach(async () => {
    logger = await importFreshLogger();
    dest = new PassThrough();
    logger.setRootLogger(logger.createRootLogger(dest, 'warn'));
    logger.setDebugTopics(new Set(['plan']));
  });

  const componentWarnings = (stream: PassThrough): ParsedLine[] => (
    drain(stream).filter((line) => line.event === 'debug_component_cache_growth_exceeded')
  );

  it('does not warn while distinct components stay under the threshold', () => {
    for (let index = 0; index < 3; index += 1) {
      logger.getDebugEmitter(`debug-guard/under-${index}`, 'plan')({ event: 'probe' });
    }
    expect(componentWarnings(dest)).toHaveLength(0);
  });

  it('warns exactly once when distinct components cross the threshold', () => {
    for (let index = 0; index < logger.MAX_LOGGER_CACHE_SIZE + 25; index += 1) {
      logger.getDebugEmitter(`debug-guard/cross-${index}`, 'plan')({ event: 'probe' });
    }
    const warnings = componentWarnings(dest);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning.threshold).toBe(logger.MAX_LOGGER_CACHE_SIZE);
    expect(warning.module).toBe('logging/cache');
    expect((warning.latestComponent as string).startsWith('debug-guard/cross-')).toBe(true);
  });

  it('reuses one child per component rather than growing on every emit', () => {
    const emit = logger.getDebugEmitter('debug-guard/stable', 'plan');
    for (let index = 0; index < 500; index += 1) emit({ event: 'probe' });
    expect(componentWarnings(dest)).toHaveLength(0);
  });
});
