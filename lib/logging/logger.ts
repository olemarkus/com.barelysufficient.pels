import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import { Writable } from 'node:stream';
import { getCurrentContext, runWithContext } from './alsContext';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';

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
 * (setup/appInit.ts) which always supplies both emitters — a unit test
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
    // `pid`/`hostname` are pino's default `base`. Neither is meaningful here —
    // the app is one process on one Homey — and `createHomeyDestination` used
    // to parse every serialized line back to JSON purely to strip them again.
    // Not emitting them removes both the write and that half of the strip.
    base: null,
    mixin: () => ({ ...getCurrentContext() }),
  },
  destination,
);

export const withRebuildContext = <T>(rebuildId: string, fn: () => T): T => (
  runWithContext({ rebuildId }, fn)
);

/**
 * Destination for the bootstrap root, which discards everything.
 *
 * `level: 'silent'` alone is not enough. A child may raise its own level above
 * its parent's — {@link getDebugEmitter} creates one at `debug` precisely so it
 * can outrank the `info` root — and pino's default destination is fd 1. Without
 * this sink, any debug emit landing before {@link setRootLogger} runs would go
 * to the process's real stdout rather than through the Homey destination, in
 * test lanes that run `silent: true` and would not say where it came from.
 */
const discardDestination = new Writable({ write(_chunk, _encoding, done) { done(); } });

/**
 * Process-wide root logger that {@link getLogger} dispenses module children
 * from. Defaults to silent so test imports never crash; production wires the
 * real root via {@link setRootLogger} at app startup.
 */
let rootLogger: PinoLogger = pino({ level: 'silent' }, discardDestination);

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
  debugComponentWarningEmitted = false;
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

/* ------------------------------------------------------------------------ *
 * Topic-gated debug channel
 * ------------------------------------------------------------------------ */

/**
 * Debug topics the owner has switched on, as a process-wide fact.
 *
 * The set is derived from a persisted setting (`buildDebugLoggingTopics`) and
 * changes whenever the owner toggles a topic, so {@link getDebugEmitter} reads
 * it per call rather than capturing it. Defaulting to empty is load-bearing:
 * a debug child is created at `level: 'debug'`, which emits even when the root
 * is `silent`, so before {@link setDebugTopics} runs this gate is the only
 * thing keeping a stray emit out of a test's stdout.
 */
let enabledDebugTopics: Set<DebugLoggingTopic> = new Set();

/**
 * Publish the enabled debug topics. Called from the one place that already
 * rebuilds the set — at startup and on every settings change — so a toggle
 * takes effect without reconstructing any emitter.
 *
 * The set is copied rather than aliased, so publishing is a single observable
 * act and a caller cannot later mutate what the gate reads behind its back.
 */
export const setDebugTopics = (topics: ReadonlySet<DebugLoggingTopic>): void => {
  enabledDebugTopics = new Set(topics);
};

/**
 * The published set, for the app's `debugLoggingTopics` accessor to expose.
 *
 * This exists so the topic set has ONE owner. Several consumers still read
 * `ctx.debugLoggingTopics` and close over `.has(topic)` — the scheduler
 * telemetry observer, background tasks, the plan/overview/diagnostics/daily-
 * budget debug predicates — and if that field were a second copy, a caller
 * that set it would enable their expensive payload building while the
 * emitter's gate stayed shut: cost paid, nothing emitted. Reading it from here
 * keeps the two answers the same one. New callers should ask
 * {@link isDebugTopicEnabled} instead.
 */
export const getDebugTopics = (): Set<DebugLoggingTopic> => enabledDebugTopics;

/**
 * Whether `topic` is switched on. Use this to skip work that only exists to
 * build a debug payload — a signature, a JSON dump, a derived summary. Calling
 * {@link getDebugEmitter}'s emitter with the topic off is already free; this is
 * for the cost *before* the call.
 */
export const isDebugTopicEnabled = (topic: DebugLoggingTopic): boolean => (
  enabledDebugTopics.has(topic)
);

const debugChildByRoot = new WeakMap<PinoLogger, Map<string, PinoLogger>>();
let debugComponentWarningEmitted = false;

/**
 * Resolves the live debug child for `component` against the current root, at
 * `level: 'debug'` — the root runs at `info`, so a plain child would drop every
 * debug line. Cached per `(root, component)` for the same reason
 * {@link liveChild} is: `.child()` is not free, and this path runs tens of
 * thousands of times an hour with the busy topics on.
 */
const liveDebugChild = (component: string): PinoLogger => {
  let perRoot = debugChildByRoot.get(rootLogger);
  if (!perRoot) {
    perRoot = new Map();
    debugChildByRoot.set(rootLogger, perRoot);
  }
  let child = perRoot.get(component);
  if (!child) {
    child = rootLogger.child({ component }, { level: 'debug' });
    perRoot.set(component, child);
    // Same soft cap and same reason as {@link getLogger}'s: every production
    // caller passes a literal, so crossing it means something is interpolating
    // a runtime value into the component name and will grow this map without
    // bound. Warn once — on a 160 MB device an unbounded child map is not a
    // theoretical cost — and note that a stray component also silently splits
    // the log into a bucket nobody filters on.
    if (!debugComponentWarningEmitted && perRoot.size > MAX_LOGGER_CACHE_SIZE) {
      debugComponentWarningEmitted = true;
      rootLogger.warn(
        {
          event: 'debug_component_cache_growth_exceeded',
          cacheSize: perRoot.size,
          threshold: MAX_LOGGER_CACHE_SIZE,
          latestComponent: component,
          module: 'logging/cache',
        },
        'getDebugEmitter component cache exceeded soft cap; a caller is likely '
        + 'interpolating runtime values into the component name',
      );
    }
  }
  return child;
};

/**
 * Returns a topic-gated structured debug emitter — the channel the owner
 * actually reads, and the ambient counterpart to {@link getLogger}.
 *
 * Prefer this over threading a `debugStructured` emitter down through
 * parameter objects: an intermediate that only forwards the emitter has to
 * declare it, and that declaration is the propagation problem `getLogger`
 * exists to avoid.
 *
 * `component` and `topic` are separate on purpose and must stay that way.
 * `topic` is what the owner switches on in settings; `component` is what they
 * filter the log by, and the two do not line up — `devices` events are emitted
 * under `devices`, `reconcile`, and `snapshot`, and Flow-card settings events
 * are `component: 'flow'` on topic `settings`.
 */
export const getDebugEmitter = (
  component: string,
  topic: DebugLoggingTopic,
): StructuredDebugEmitter => (payload) => {
  if (!enabledDebugTopics.has(topic)) return;
  // Some producers name their own component in the payload. Resolve it here
  // rather than spreading it over the child's binding: that writes `component`
  // to the wire twice and leaves JSON last-key-wins to settle it, which is a
  // parser detail rather than a contract.
  const { component: payloadComponent, ...rest } = payload;
  const resolved = typeof payloadComponent === 'string' ? payloadComponent : component;
  liveDebugChild(resolved).debug({ ...rest, debugTopic: topic });
};
