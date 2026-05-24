import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { Writable } from 'node:stream';
import { getCurrentContext, runWithContext } from './alsContext';

export type { Logger } from 'pino';
export type StructuredDebugEmitter = (payload: Record<string, unknown>) => void;

/**
 * Cross-cutting logger bundle every consumer takes. Structured-only:
 * the legacy prose loggers (`log`/`logDebug`/`error`) are being removed
 * per consumer as part of the Phase 4 RuntimeContext narrowing. New code
 * must emit through `structuredLog` (info/error/etc. via JSON payloads)
 * or `debugStructured` (topic-gated JSON debug events).
 *
 * Topic-specific `*DebugStructured` emitters stay separate — those belong
 * on the domain context for the concern they instrument, not on the
 * cross-cutting bundle.
 *
 * Both inner fields are optional so test harnesses can omit logging
 * entirely. The production contract is established by `createPlanService`
 * (lib/app/appInit.ts) which always supplies both emitters — a unit test
 * passing `{}` is not evidence the call site is safe.
 */
export type Loggers = {
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
};

export const createRootLogger = (destination: Writable, level = 'info'): pino.Logger => pino(
  {
    level,
    timestamp: false,
    mixin: () => ({ ...getCurrentContext() }),
  },
  destination,
);

export const withRebuildContext = <T>(rebuildId: string, fn: () => T): T => (
  runWithContext({ rebuildId }, fn)
);

/**
 * Process-wide root logger that {@link getLogger} dispenses module children
 * from. Defaults to silent so test imports never crash; production wires the
 * real root via {@link setRootLogger} at app startup.
 */
let rootLogger: PinoLogger = pino({ level: 'silent' });

/**
 * Replace the process-wide root logger. Called once from `app.ts` after
 * `createRootLogger(...)`. Tests that want to capture log output can call
 * this with a pino logger backed by a `PassThrough` destination.
 *
 * Existing {@link getLogger} references remain valid — they are late-bound
 * proxies that re-resolve to the live root on every call.
 */
export const setRootLogger = (logger: PinoLogger): void => {
  rootLogger = logger;
};

const moduleLoggerCache = new Map<string, PinoLogger>();
const childByRoot = new WeakMap<PinoLogger, Map<string, PinoLogger>>();

/**
 * Soft cap on distinct `module` strings seen by {@link getLogger}. Today every
 * production caller passes a string literal, so the cache is bounded by the
 * static set of callsites (≈38 as of 2026-05). The threshold is set well above
 * that to leave headroom for new modules and incidental test churn — crossing
 * it is a strong signal that something is interpolating runtime values (e.g.
 * `getLogger(`device-${id}`)`) and will grow the cache unboundedly. We only
 * warn once so the caller sees the issue without flooding the log; the cache
 * itself is unbounded by design (a hard cap could break call paths that
 * legitimately reach the threshold during tests).
 */
export const MAX_LOGGER_CACHE_SIZE = 64;
let cacheGrowthWarningEmitted = false;

/**
 * Test-only: reset the warn-once flag so a single test process can exercise
 * the threshold-crossing path more than once. Not part of the public runtime
 * surface — production never re-arms.
 */
export const __resetLoggerCacheGuardForTest = (): void => {
  cacheGrowthWarningEmitted = false;
};

/**
 * Resolves the live child logger for `module` against the current root.
 * Cached per `(root, module)` pair: pino's `.child()` is non-trivial to
 * re-invoke per log call, and caching also lets accessor writes (e.g.
 * `logger.level = 'debug'`) persist for the lifetime of the current root.
 */
const liveChild = (module: string): PinoLogger => {
  let perRoot = childByRoot.get(rootLogger);
  if (!perRoot) {
    perRoot = new Map();
    childByRoot.set(rootLogger, perRoot);
  }
  let child = perRoot.get(module);
  if (!child) {
    child = rootLogger.child({ module });
    perRoot.set(module, child);
  }
  return child;
};

/**
 * Returns a pino-compatible logger for `module`. The returned object is a
 * late-binding proxy: each method call re-resolves to the cached child of
 * the current process-wide root, with a stable `module` binding. ALS context
 * (`rebuildId`, etc.) from {@link withRebuildContext} is automatically
 * mixed in by the root's mixin.
 *
 * Late binding is intentional. A naive `rootLogger.child({ module })` would
 * snapshot whatever root happened to exist at call time — and because
 * `app.ts`'s import chain runs before `onInit` calls `setRootLogger`, every
 * module-scope `const logger = getLogger(...)` would silently bind to the
 * default silent root and stay there forever. The proxy avoids that trap.
 *
 * Property writes (e.g. `logger.level = 'debug'`) are forwarded to the
 * cached child for the current root. Property reads of accessor properties
 * (e.g. pino's `level`/`levelVal`) bind `this` to the live child rather
 * than the proxy, so pino's internal-state lookups stay valid.
 *
 * Prefer this over receiving a logger through deps. It eliminates the
 * propagation problem (every layer redeclaring `structuredLog?`/`logDebug?`)
 * by treating logging as an ambient capability — analogous to Go's
 * `context.Context` for request-scoped values, with ALS providing the
 * implicit-propagation mechanism.
 */
export const getLogger = (module: string): PinoLogger => {
  const cached = moduleLoggerCache.get(module);
  if (cached) return cached;

  const proxy = new Proxy({} as PinoLogger, {
    get(_target, prop) {
      const live = liveChild(module);
      const value = Reflect.get(live, prop, live) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(live)
        : value;
    },
    set(_target, prop, value) {
      const live = liveChild(module);
      return Reflect.set(live, prop, value, live);
    },
  });
  moduleLoggerCache.set(module, proxy);

  // Emit a single warning when the cache outgrows the soft cap. Allocation is
  // gated behind the size check + the once-flag so the steady-state cost is a
  // single comparison per new module string.
  if (!cacheGrowthWarningEmitted && moduleLoggerCache.size > MAX_LOGGER_CACHE_SIZE) {
    cacheGrowthWarningEmitted = true;
    rootLogger.warn(
      {
        event: 'logger_cache_growth_exceeded',
        cacheSize: moduleLoggerCache.size,
        threshold: MAX_LOGGER_CACHE_SIZE,
        latestModule: module,
        module: 'logging/cache',
      },
      'getLogger module cache exceeded soft cap; a caller is likely interpolating runtime values into the module name',
    );
  }

  return proxy;
};
