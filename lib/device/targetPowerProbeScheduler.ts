import type { Logger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { TimerRegistry } from '../utils/timerRegistry';

const DEFERRED_PROBE_RECHECK_MS = 60 * 1000;

export type DueTargetPowerProbe = {
  deviceId: string;
  dueAtMs: number;
};

/** Owns the independent retry and settlement clocks for target-power probes. */
export class TargetPowerProbeScheduler {
  private probeTimer?: ReturnType<typeof setTimeout>;
  private runningProbe?: ReturnType<typeof setTimeout>;
  private lastAttempt?: { probe: DueTargetPowerProbe; retryAtMs?: number };
  private settlementTimer?: ReturnType<typeof setTimeout>;
  private readonly settlementDueAtMs = new Set<number>();
  private stopped = true;

  constructor(private readonly deps: {
    timers: TimerRegistry;
    getNowMs: () => number;
    getNextProbe: () => DueTargetPowerProbe | undefined;
    hasPendingProbe: () => boolean;
    rebuildForDueProbe: (deviceId: string) => Promise<void>;
    refreshForSettlement: () => Promise<void>;
    getLogger: () => Logger;
  }) {}

  start(): void {
    this.stopped = false;
    this.scheduleProbe();
  }

  stop(): void {
    this.stopped = true;
    if (this.probeTimer) this.deps.timers.clear('targetPowerProbe');
    if (this.settlementTimer) this.deps.timers.clear('targetPowerProbeSettlement');
    this.probeTimer = undefined;
    this.runningProbe = undefined;
    this.lastAttempt = undefined;
    this.settlementTimer = undefined;
    this.settlementDueAtMs.clear();
  }

  scheduleSettlement(dueAtMs: number): void {
    if (this.stopped || !Number.isFinite(dueAtMs) || dueAtMs < 0) return;
    this.settlementDueAtMs.add(dueAtMs);
    this.scheduleNextSettlement();
  }

  scheduleProbe(): void {
    if (this.stopped || this.runningProbe !== undefined) return;
    if (this.probeTimer) this.deps.timers.clear('targetPowerProbe');
    this.probeTimer = undefined;
    const dueProbe = this.deps.getNextProbe();
    if (dueProbe === undefined) return;
    const previous = this.lastAttempt;
    const sameProbe = previous?.probe.deviceId === dueProbe.deviceId
      && previous.probe.dueAtMs === dueProbe.dueAtMs;
    if (sameProbe && this.deps.hasPendingProbe()) return;
    // A snapshot can re-arm the same overdue probe. Keep its original retry time.
    const retryAtMs = sameProbe ? previous.retryAtMs ?? dueProbe.dueAtMs : dueProbe.dueAtMs;
    const timer = setTimeout(async () => {
      if (this.probeTimer !== timer) return;
      this.deps.timers.clear('targetPowerProbe');
      this.probeTimer = undefined;
      this.runningProbe = timer;
      try {
        await this.deps.rebuildForDueProbe(dueProbe.deviceId);
      } catch (error) {
        this.deps.getLogger().error({
          event: 'target_power_probe_rebuild_failed',
          err: normalizeError(error),
        });
      } finally {
        // stop() discards this timer's ownership even if start() has since run.
        if (this.runningProbe === timer) {
          this.runningProbe = undefined;
          this.lastAttempt = this.deps.hasPendingProbe()
            ? { probe: dueProbe }
            : { probe: dueProbe, retryAtMs: this.deps.getNowMs() + DEFERRED_PROBE_RECHECK_MS };
          this.scheduleProbe();
        }
      }
    }, Math.max(retryAtMs - this.deps.getNowMs(), 0));
    this.probeTimer = this.deps.timers.registerTimeout('targetPowerProbe', timer);
  }

  private scheduleNextSettlement(): void {
    if (this.stopped) return;
    if (this.settlementTimer) this.deps.timers.clear('targetPowerProbeSettlement');
    this.settlementTimer = undefined;
    const dueAtMs = [...this.settlementDueAtMs].sort((left, right) => left - right)[0];
    if (dueAtMs === undefined) return;
    const timer = setTimeout(async () => {
      if (this.settlementTimer !== timer) return;
      this.deps.timers.clear('targetPowerProbeSettlement');
      this.settlementTimer = undefined;
      this.settlementDueAtMs.delete(dueAtMs);
      try {
        await this.deps.refreshForSettlement();
      } catch (error) {
        this.deps.getLogger().error({
          event: 'target_power_probe_settlement_refresh_failed',
          err: normalizeError(error),
        });
      } finally {
        if (!this.stopped) this.scheduleNextSettlement();
      }
    }, Math.max(0, dueAtMs - this.deps.getNowMs()));
    this.settlementTimer = this.deps.timers.registerTimeout('targetPowerProbeSettlement', timer);
  }
}
