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

export type BackgroundTasksControllerDeps = {
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
 * Lives in `setup/` because the only concern this class owns is "remember
 * the four stop handles so `PelsApp` can call them in `onUninit`." It owns
 * no domain value any other module queries — if it were deleted, `PelsApp`
 * would regrow four `stop*?: () => void` fields, not domain knowledge. The
 * four tasks themselves live with their respective concerns
 * (`lib/diagnostics/**`, `setup/appPriceLowestTrigger`); this class is
 * the wiring that hands them their app-shaped deps (price coordinator,
 * debug-topic strings, structured-debug emitter) and aggregates teardown.
 *
 * Tasks managed:
 * - resource-warning listeners (Homey process events)
 * - heap snapshot handler (debug topic gated)
 * - perf logger (30s cycle, cpu-spike notifications)
 * - price-lowest trigger checker (price flow trigger pump)
 *
 * Each `start*` method registers the task and stores its stop callback;
 * `stopAll()` cleans them up in the same order `PelsApp` used to. The
 * heartbeat and power-tracker pruning timers stay on `PelsApp` because
 * they're either no-ops (heartbeat) or coupled to the shared
 * `TimerRegistry` (pruning).
 */
export class BackgroundTasksController {
  private stopPriceLowestTrigger?: () => void;
  private stopPerfLog?: () => void;
  private stopResourceWarnings?: () => void;
  private stopHeapSnapshot?: () => void;
  private stopDeferredObjectiveClock?: () => void;

  constructor(private readonly deps: BackgroundTasksControllerDeps) {}

  startResourceWarningListeners(): void {
    if (this.stopResourceWarnings) this.stopResourceWarnings();
    this.stopResourceWarnings = startResourceWarnings({
      homey: this.deps.homey,
      error: (...args: unknown[]) => this.deps.error(...args),
    });
  }

  installHeapSnapshotHandler(structuredLogger: PinoLogger): void {
    this.stopHeapSnapshot = installHeapSnapshotHandler({
      logger: structuredLogger.child({ component: 'heap' }),
    });
  }

  startPerfLogging(): void {
    this.stopPerfLog = startPerfLogger({
      isEnabled: () => this.deps.isDebugTopicEnabled('perf'),
      logStructured: this.deps.getStructuredDebugEmitter('perf', 'perf'),
      error: (...args: unknown[]) => this.deps.error(...args),
      logCpuSpike: (...args: unknown[]) => this.deps.log(...args),
      intervalMs: 30 * 1000,
    });
  }

  startPriceLowestTriggerChecker(): void {
    if (this.stopPriceLowestTrigger) this.stopPriceLowestTrigger();
    this.stopPriceLowestTrigger = startPriceLowestTriggers({
      getNow: () => this.deps.getNow(),
      getTimeZone: () => this.deps.getTimeZone(),
      getCombinedHourlyPrices: () => this.deps.getCombinedHourlyPrices(),
      getTriggerCard: (id) => this.deps.homey.flow.getTriggerCard(id),
      debugStructured: this.deps.getStructuredDebugEmitter('price', 'price'),
      error: (message, error) => this.deps.error(message, error),
    });
  }

  startDeferredObjectiveLifecycleClock(emitter: DeferredObjectiveLifecycleEmitter): void {
    if (this.stopDeferredObjectiveClock) this.stopDeferredObjectiveClock();
    this.stopDeferredObjectiveClock = startDeferredObjectiveLifecycleClock({
      emitter,
      getNowMs: () => this.deps.getNow().getTime(),
      error: (message, error) => this.deps.error(message, error),
    });
  }

  stopAll(): void {
    this.stopPriceLowestTrigger?.();
    this.stopPerfLog?.();
    this.stopResourceWarnings?.();
    this.stopHeapSnapshot?.();
    this.stopDeferredObjectiveClock?.();
  }
}
