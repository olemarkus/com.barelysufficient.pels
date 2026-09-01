import type Homey from 'homey';
import type { Logger as PinoLogger } from 'pino';
import { startPerfLogger } from '../lib/diagnostics/perfLogging';
import { startResourceWarningListeners as startResourceWarnings } from '../lib/diagnostics/resourceWarnings';
import { installHeapSnapshotHandler } from '../lib/diagnostics/heapSnapshotHandler';
import { startPriceLowestTriggerChecker as startPriceLowestTriggers } from './appPriceLowestTrigger';
import type { DebugLoggingTopic } from '../packages/shared-domain/src/utils/debugLogging';
import type { StructuredDebugEmitter } from '../lib/logging/logger';
import type { CombinedHourlyPrice } from '../lib/price/priceTypes';
import { startDeferredObjectiveLifecycleClock } from './deferredObjectiveLifecycleClock';
import type { DeferredObjectiveLifecycleEmitter } from '../lib/objectives/deferredObjectives/lifecycleEmitter';
import type { WeatherCollector } from '../lib/weather/weatherCollector';
import type { TeardownRegistry } from '../lib/utils/teardownRegistry';

/**
 * Teardown order, stated rather than inferred. Registration order is startup
 * order and is NOT this order — the price trigger goes first and the weather
 * collector last, matching what `PelsApp.onUninit` has always done.
 */
const TEARDOWN_ORDER = [
  'priceLowestTrigger',
  'perfLog',
  'resourceWarnings',
  'heapSnapshot',
  'deferredObjectiveClock',
  'weatherCollector',
] as const;

type TeardownKey = (typeof TEARDOWN_ORDER)[number];

/** The app-shaped collaborators each background task needs handing to it. */
export type BackgroundTaskDeps = {
  homey: Homey.App['homey'];
  log: (...args: unknown[]) => void;
  logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  isDebugTopicEnabled: (topic: DebugLoggingTopic) => boolean;
  getStructuredDebugEmitter: (component: string, debugTopic: DebugLoggingTopic) => StructuredDebugEmitter;
  getNow: () => Date;
  getTimeZone: () => string;
  getCombinedHourlyPrices: () => CombinedHourlyPrice[];
};

/**
 * The collaborators plus the store the started tasks' stop callbacks live in.
 * The registry is `app.ts`'s — remembering those callbacks was the only state
 * this wiring held, so it belongs to the composition root and is handed back to
 * it by `createBackgroundTasks`.
 */
export type BackgroundTasksControllerDeps = BackgroundTaskDeps & {
  teardown: TeardownRegistry;
};

/**
 * Lives in `setup/` because it is wiring: it hands each task its app-shaped
 * deps (price coordinator, debug-topic strings, structured-debug emitter) and
 * names the teardown order. The tasks themselves live with their respective
 * concerns (`lib/diagnostics/**`, `setup/appPriceLowestTrigger`).
 *
 * It used to hold six `stop*?: () => void` fields, which was the only state it
 * had. Those live in an injected `TeardownRegistry` now
 * (`lib/utils/teardownRegistry.ts`) — the same shape as the `TimerRegistry`
 * beside it — so this class remembers nothing and `stopAll` reads as the
 * ordered list it always was.
 *
 * Tasks managed:
 * - resource-warning listeners (Homey process events)
 * - heap snapshot handler (debug topic gated)
 * - perf logger (30s cycle, cpu-spike notifications)
 * - price-lowest trigger checker (price flow trigger pump)
 *
 * Each `start*` method registers the task and stores its stop callback;
 * `stopAll()` cleans them up in the same order `PelsApp` used to. The
 * power-tracker pruning timer stays on `PelsApp` because it is coupled to
 * the shared `TimerRegistry`.
 */
export class BackgroundTasksController {
  constructor(private readonly deps: BackgroundTasksControllerDeps) {}

  /**
   * Stop whatever is held under `key`, THEN start the replacement.
   *
   * The order is the whole point, which is why `start` is a thunk rather than a
   * value. Passing `start()` as an argument would evaluate it first, and a stop
   * callback is often a method on a shared instance — `WeatherCollector.start()`
   * returns `() => this.stop()` on the collector itself — so the predecessor's
   * stop would tear down the run just started and leave the task dead.
   *
   * Two starters answer `undefined` when there is nothing to run: an unusable
   * Homey emitter, an absent weather collector. That means "hold nothing", not
   * "hold a no-op", so the key simply stays free.
   */
  private restart(key: TeardownKey, start: () => (() => void) | undefined): void {
    this.deps.teardown.clear(key);
    const stop = start();
    if (stop !== undefined) this.deps.teardown.register(key, stop);
  }

  startResourceWarningListeners(): void {
    this.restart('resourceWarnings', () => startResourceWarnings({ homey: this.deps.homey }));
  }

  installHeapSnapshotHandler(structuredLogger: PinoLogger): void {
    this.restart('heapSnapshot', () => installHeapSnapshotHandler({
      logger: structuredLogger.child({ component: 'heap' }),
    }));
  }

  startPerfLogging(): void {
    this.restart('perfLog', () => startPerfLogger({
      isEnabled: () => this.deps.isDebugTopicEnabled('perf'),
      logStructured: this.deps.getStructuredDebugEmitter('perf', 'perf'),
      error: (...args: unknown[]) => this.deps.error(...args),
      logCpuSpike: (...args: unknown[]) => this.deps.log(...args),
      intervalMs: 30 * 1000,
    }));
  }

  startPriceLowestTriggerChecker(): void {
    this.restart('priceLowestTrigger', () => startPriceLowestTriggers({
      getNow: () => this.deps.getNow(),
      getTimeZone: () => this.deps.getTimeZone(),
      getCombinedHourlyPrices: () => this.deps.getCombinedHourlyPrices(),
      getTriggerCard: (id) => this.deps.homey.flow.getTriggerCard(id),
      debugStructured: this.deps.getStructuredDebugEmitter('price', 'price'),
      error: (message, error) => this.deps.error(message, error),
    }));
  }

  startDeferredObjectiveLifecycleClock(emitter: DeferredObjectiveLifecycleEmitter): void {
    this.restart('deferredObjectiveClock', () => startDeferredObjectiveLifecycleClock({
      emitter,
      getNowMs: () => this.deps.getNow().getTime(),
    }));
  }

  /** (Re)starts the weather collector; safe to call again after a settings change. */
  startWeatherCollector(collector: WeatherCollector | undefined): void {
    this.restart('weatherCollector', () => collector?.start());
  }

  stopAll(): void {
    for (const key of TEARDOWN_ORDER) this.deps.teardown.clear(key);
  }
}

