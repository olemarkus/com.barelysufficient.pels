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
    getLogger: () => Logger | undefined;
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
    this.settlementTimer = undefined;
    this.settlementDueAtMs.clear();
  }

  scheduleSettlement(dueAtMs: number): void {
    if (this.stopped || !Number.isFinite(dueAtMs) || dueAtMs < 0) return;
    this.settlementDueAtMs.add(dueAtMs);
    this.scheduleNextSettlement();
  }

  scheduleProbe(minimumDelayMs = 0): void {
    if (this.stopped) return;
    if (this.probeTimer) this.deps.timers.clear('targetPowerProbe');
    this.probeTimer = undefined;
    const dueProbe = this.deps.getNextProbe();
    if (dueProbe === undefined) return;
    const timer = setTimeout(async () => {
      if (this.probeTimer !== timer) return;
      this.deps.timers.clear('targetPowerProbe');
      this.probeTimer = undefined;
      try {
        await this.deps.rebuildForDueProbe(dueProbe.deviceId);
      } catch (error) {
        this.deps.getLogger()?.error({
          event: 'target_power_probe_rebuild_failed',
          err: normalizeError(error),
        });
      } finally {
        if (!this.stopped && !this.deps.hasPendingProbe()) {
          this.scheduleProbe(DEFERRED_PROBE_RECHECK_MS);
        }
      }
    }, Math.max(minimumDelayMs, dueProbe.dueAtMs - this.deps.getNowMs(), 0));
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
        this.deps.getLogger()?.error({
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
