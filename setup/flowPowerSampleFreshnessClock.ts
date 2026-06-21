import type { PowerSource } from '../lib/power/powerSource';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../packages/shared-domain/src/powerFreshness';

const FLOW_POWER_SAMPLE_HOLD_REBUILD_INTERVAL_MS = 10 * 1000;
const FLOW_POWER_SAMPLE_FRESHNESS_TIMER = 'flowPowerSampleFreshness';

export type FlowPowerSampleFreshnessClockDeps = {
  timers: TimerRegistry;
  getNowMs: () => number;
  getPowerSource: () => PowerSource;
  requestPlanRebuild: (reason: string) => void;
};

export function clearFlowPowerSampleFreshnessTimer(timers: TimerRegistry): void {
  timers.clear(FLOW_POWER_SAMPLE_FRESHNESS_TIMER);
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

  constructor(private readonly deps: FlowPowerSampleFreshnessClockDeps) {}

  noteSample(sampleAtMs: number): void {
    if (this.deps.getPowerSource() !== 'flow') {
      this.stop();
      return;
    }
    if (!Number.isFinite(sampleAtMs)) return;
    if (this.lastSampleAtMs !== null && sampleAtMs < this.lastSampleAtMs) return;

    this.lastSampleAtMs = sampleAtMs;
    this.staleHoldRebuildRequested = false;
    this.failClosedRebuildRequested = false;
    this.scheduleNext();
  }

  stop(): void {
    clearFlowPowerSampleFreshnessTimer(this.deps.timers);
    this.lastSampleAtMs = null;
    this.staleHoldRebuildRequested = false;
    this.failClosedRebuildRequested = false;
  }

  private runTick(): void {
    this.deps.timers.clear(FLOW_POWER_SAMPLE_FRESHNESS_TIMER);
    if (this.deps.getPowerSource() !== 'flow') {
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

  private scheduleNext(): void {
    if (this.lastSampleAtMs === null || this.deps.getPowerSource() !== 'flow') return;

    const ageMs = Math.max(0, this.deps.getNowMs() - this.lastSampleAtMs);
    const delayMs = this.resolveNextDelayMs(ageMs);
    if (delayMs === null) return;

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
