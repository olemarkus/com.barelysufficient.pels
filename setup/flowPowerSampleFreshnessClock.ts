import type { PowerSource } from '../lib/power/powerSource';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../packages/shared-domain/src/powerFreshness';

const FLOW_POWER_SAMPLE_HOLD_REBUILD_INTERVAL_MS = 10 * 1000;
const FLOW_POWER_SAMPLE_FRESHNESS_TIMER = 'flowPowerSampleFreshness';
const FLOW_POWER_SOURCE_RETRY_INITIAL_MS = 1_000;
const FLOW_POWER_SOURCE_RETRY_MAX_MS = 60_000;
const FLOW_POWER_SOURCE_RETRY_MAX_EXPONENT = 6;
const registeredClocks = new WeakMap<TimerRegistry, FlowPowerSampleFreshnessClock>();

export type FlowPowerSampleFreshnessClockDeps = {
  timers: TimerRegistry;
  getNowMs: () => number;
  getPowerSource: () => PowerSource;
  requestPlanRebuild: (reason: string) => void;
  onPowerSourceReadError: (error: unknown) => void;
};

export function clearFlowPowerSampleFreshnessTimer(timers: TimerRegistry): void {
  timers.clear(FLOW_POWER_SAMPLE_FRESHNESS_TIMER);
}

export function registerFlowPowerSampleFreshnessClock(
  timers: TimerRegistry,
  clock: FlowPowerSampleFreshnessClock,
): void {
  registeredClocks.get(timers)?.stop();
  registeredClocks.set(timers, clock);
}

export function stopFlowPowerSampleFreshnessClock(timers: TimerRegistry): void {
  const clock = registeredClocks.get(timers);
  if (clock) {
    clock.stop();
    return;
  }
  clearFlowPowerSampleFreshnessTimer(timers);
}

export function syncFlowPowerSampleFreshnessClock(
  timers: TimerRegistry,
  sampleAtMs: number | null | undefined,
): void {
  registeredClocks.get(timers)?.syncLatestSample(sampleAtMs);
}

/**
 * Flow-source planning clock for the "hold last real sample" freshness policy.
 *
 * It never records power samples. It only asks the existing plan scheduler to
 * re-evaluate the current soft limit against the last real Flow sample while
 * that sample remains fresh, then emits the stale-hold and fail-closed
 * transition rebuilds if silence continues.
 */
export class FlowPowerSampleFreshnessClock {
  private lastSampleAtMs: number | null = null;

  private staleHoldRebuildRequested = false;

  private failClosedRebuildRequested = false;

  private sourceReadRetryAttempt = 0;

  constructor(private readonly deps: FlowPowerSampleFreshnessClockDeps) {}

  noteSample(sampleAtMs: number): void {
    this.trackSample(sampleAtMs, { requestElapsedTransitions: false });
  }

  syncLatestSample(sampleAtMs: number | null | undefined): void {
    if (typeof sampleAtMs !== 'number' || !Number.isFinite(sampleAtMs)) {
      this.stop();
      return;
    }

    this.trackSample(sampleAtMs, { requestElapsedTransitions: true });
  }

  private trackSample(
    sampleAtMs: number,
    options: { requestElapsedTransitions: boolean },
  ): void {
    if (!Number.isFinite(sampleAtMs)) return;
    const powerSource = this.tryReadPowerSource();
    if (powerSource === null) {
      if (!this.adoptSample(sampleAtMs)) return;
      this.scheduleSourceReadRetry();
      return;
    }
    this.sourceReadRetryAttempt = 0;
    if (powerSource !== 'flow') {
      this.stop();
      return;
    }
    if (!this.adoptSample(sampleAtMs)) return;

    if (options.requestElapsedTransitions && this.requestElapsedTransitions()) return;

    this.scheduleNext();
  }

  stop(): void {
    clearFlowPowerSampleFreshnessTimer(this.deps.timers);
    this.lastSampleAtMs = null;
    this.staleHoldRebuildRequested = false;
    this.failClosedRebuildRequested = false;
    this.sourceReadRetryAttempt = 0;
  }

  private runTick(): void {
    this.deps.timers.clear(FLOW_POWER_SAMPLE_FRESHNESS_TIMER);
    const powerSource = this.tryReadPowerSource();
    if (powerSource === null) {
      this.scheduleSourceReadRetry();
      return;
    }
    this.sourceReadRetryAttempt = 0;
    if (powerSource !== 'flow') {
      this.stop();
      return;
    }
    if (this.lastSampleAtMs === null) return;

    const ageMs = Math.max(0, this.deps.getNowMs() - this.lastSampleAtMs);
    if (ageMs < POWER_SAMPLE_STALE_THRESHOLD_MS) {
      this.deps.requestPlanRebuild('flow_power_sample_hold');
      this.scheduleNext();
      return;
    }

    if (ageMs < POWER_SAMPLE_STALE_SHED_TIMEOUT_MS) {
      if (!this.staleHoldRebuildRequested) {
        this.staleHoldRebuildRequested = true;
        this.deps.requestPlanRebuild('flow_power_sample_stale_hold');
      }
      this.scheduleNext();
      return;
    }

    if (!this.failClosedRebuildRequested) {
      this.failClosedRebuildRequested = true;
      this.deps.requestPlanRebuild('flow_power_sample_fail_closed');
    }
  }

  private requestElapsedTransitions(): boolean {
    if (this.lastSampleAtMs === null) return false;

    const ageMs = Math.max(0, this.deps.getNowMs() - this.lastSampleAtMs);
    if (ageMs >= POWER_SAMPLE_STALE_SHED_TIMEOUT_MS) {
      this.failClosedRebuildRequested = true;
      this.deps.requestPlanRebuild('flow_power_sample_fail_closed');
      return true;
    }

    if (ageMs >= POWER_SAMPLE_STALE_THRESHOLD_MS) {
      this.staleHoldRebuildRequested = true;
      this.deps.requestPlanRebuild('flow_power_sample_stale_hold');
    }

    return false;
  }

  private scheduleNext(): void {
    if (this.lastSampleAtMs === null) return;

    const ageMs = Math.max(0, this.deps.getNowMs() - this.lastSampleAtMs);
    const delayMs = this.resolveNextDelayMs(ageMs);
    if (delayMs === null) return;

    const timer = setTimeout(() => this.runTick(), delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.deps.timers.registerTimeout(FLOW_POWER_SAMPLE_FRESHNESS_TIMER, timer);
  }

  private adoptSample(sampleAtMs: number): boolean {
    if (this.lastSampleAtMs !== null && sampleAtMs < this.lastSampleAtMs) return false;
    this.lastSampleAtMs = sampleAtMs;
    this.staleHoldRebuildRequested = false;
    this.failClosedRebuildRequested = false;
    return true;
  }

  private tryReadPowerSource(): PowerSource | null {
    try {
      return this.deps.getPowerSource();
    } catch (error) {
      this.deps.onPowerSourceReadError(error);
      return null;
    }
  }

  private scheduleSourceReadRetry(): void {
    if (this.lastSampleAtMs === null) return;
    const exponent = Math.min(
      this.sourceReadRetryAttempt,
      FLOW_POWER_SOURCE_RETRY_MAX_EXPONENT,
    );
    const delayMs = Math.min(
      FLOW_POWER_SOURCE_RETRY_INITIAL_MS * (2 ** exponent),
      FLOW_POWER_SOURCE_RETRY_MAX_MS,
    );
    this.sourceReadRetryAttempt = Math.min(
      this.sourceReadRetryAttempt + 1,
      FLOW_POWER_SOURCE_RETRY_MAX_EXPONENT,
    );
    const timer = setTimeout(() => this.runTick(), delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.deps.timers.registerTimeout(FLOW_POWER_SAMPLE_FRESHNESS_TIMER, timer);
  }

  private resolveNextDelayMs(ageMs: number): number | null {
    if (ageMs < POWER_SAMPLE_STALE_THRESHOLD_MS) {
      return Math.max(0, Math.min(
        FLOW_POWER_SAMPLE_HOLD_REBUILD_INTERVAL_MS,
        POWER_SAMPLE_STALE_THRESHOLD_MS - ageMs,
      ));
    }
    if (ageMs < POWER_SAMPLE_STALE_SHED_TIMEOUT_MS && !this.failClosedRebuildRequested) {
      return Math.max(0, POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - ageMs);
    }
    return null;
  }
}
