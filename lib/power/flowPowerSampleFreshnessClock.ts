import type { PowerSource } from './powerSource';
import type { TimerRegistry } from '../utils/timerRegistry';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';

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
 * Flow-source planning clock: the 10-second re-decide heartbeat while the last
 * Flow sample is still fresh (<60 s).
 *
 * It never records power samples, and it no longer owns any staleness
 * escalation: past the freshness threshold it simply keeps its schedule and
 * asks for nothing (the last reading carries forward), and the 10-minute mark
 * belongs to the unified silence policy — `installMainFreshnessEscalation`
 * runs for BOTH sources now, and `lib/power/meterSilence.ts` blocks planning
 * after its one fail-closed pass.
 */
export class FlowPowerSampleFreshnessClock {
  private lastSampleAtMs: number | null = null;

  private sourceReadRetryAttempt = 0;

  constructor(private readonly deps: FlowPowerSampleFreshnessClockDeps) {}

  noteSample(sampleAtMs: number): void {
    this.trackSample(sampleAtMs);
  }

  syncLatestSample(sampleAtMs: number | null | undefined): void {
    if (typeof sampleAtMs !== 'number' || !Number.isFinite(sampleAtMs)) {
      this.stop();
      return;
    }

    this.trackSample(sampleAtMs);
  }

  private trackSample(sampleAtMs: number): void {
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

    this.scheduleNext();
  }

  stop(): void {
    clearFlowPowerSampleFreshnessTimer(this.deps.timers);
    this.lastSampleAtMs = null;
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

    // Past the freshness threshold the clock keeps its schedule but asks for
    // nothing: the last reading carries forward, and there is no new decision
    // to take. The 10-minute silence mark is the unified escalation's job —
    // this clock owns only the fresh-window re-decide cadence.
    this.scheduleNext();
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
    // Past the fresh window there is nothing left for this clock to wake for.
    return null;
  }
}
