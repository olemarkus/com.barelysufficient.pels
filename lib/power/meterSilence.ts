import type { Logger as PinoLogger } from '../logging/logger';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from './sampleFreshness';

export type MeterSilenceLogger = Pick<PinoLogger, 'info' | 'warn'>;

export type MeterSilenceMonitorDeps = {
  /** The home's tracker latch (`lastTimestamp`); absent = never sampled. */
  getLastSampleAtMs: () => number | undefined;
  nowMs: () => number;
  structuredLog: () => MeterSilenceLogger | undefined;
};

/**
 * The 10-minute meter-silence policy, one instance per home, for BOTH power
 * sources (owner ruling 2026-08-31, superseding the 2026-08-16 "no freshness
 * escalation" clause on the measurement gate — the "no fabricated reading"
 * half of that ruling stands).
 *
 * Owns two connected facts:
 * - the plan-build BLOCK: engaged once a home's meter has been silent past
 *   `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS` and the one shed pass has run,
 *   cleared by the next ADMITTED sample — the ingest moves the tracker
 *   latch this monitor reads, so nothing has to be pushed at it;
 * - the ONE fail-closed shed pass the silence window is owed: the escalation
 *   clock asks `shouldRunShedPass()`, runs the rebuild (the reading resolves
 *   to its silent-meter variant and the planner takes the shed-everything
 *   directive, `lib/plan/planBuilderSilentMeter.ts`), and reports
 *   `noteShedPassCompleted` — after which the block holds until data returns.
 *
 * The outage clock is the sample stamp, and nothing else (owner ruling
 * 2026-09-02): ten minutes without a reading is a ten-minute outage whether or
 * not this process was running for all of it. (The stamp a restart hands back
 * is the last PERSISTED one, up to a write-throttle window behind the last
 * sample after an unclean stop — an error that only ever reads the outage as
 * longer, i.e. towards shedding.) A stamp restored across a
 * restart therefore ages exactly as a live one does — already past the timeout
 * at boot, it is owed its pass at once; still inside it, the silence
 * completes here and is owed the pass then. The earlier
 * "restored silence is owed nothing" rule made older evidence of a dead meter
 * buy LESS protection than fresher evidence, and left the correlated failure
 * it worried about (a power blip rebooting Homey and killing the meter feed
 * together) running open exactly when the stamp was oldest. There is no
 * process-uptime grace either: that was `holdWhileStillWaiting`'s clock, and
 * it measured how long PELS had been watching rather than how long the meter
 * had been silent.
 *
 * What a restart does change is WHEN the first fail-closed shed lands: with
 * the block not engaged, any boot-time trigger (`startup_snapshot_bootstrap`,
 * a membership edge) builds fail-closed seconds after boot. That build sheds
 * but does not latch — only the escalation clock's own pass does, at its next
 * tick, and only once a full device read has committed and the write seam is
 * open — so the block follows the tick, never the boot trigger. This only
 * happens when the stamp was already past the timeout at boot, i.e. the meter
 * was silent for the full window BEFORE the platform went down — a Homey
 * firmware reboot of two or three minutes lands inside the window, and the
 * meter app has the rest of it to report before the silence completes. A sub-home's escalation clock refuses to age a
 * stamp whose meter source is not authorised at all
 * (`setup/homeRuntime/homeCapacityBundleReadiness.ts`); main's clock has no
 * such guard, so a main home whose meter stopped for good sheds once per
 * boot and then blocks — a dead meter is an outage, and the no-readings
 * banner is the owner's cue.
 *
 * "One shed pass" is one ESCALATION pass, and one that could shed: the
 * escalation clock refuses to spend it while no full device read has
 * committed or the write seam is fenced, so it stays owed and the next tick
 * retries (`setup/powerSampleFreshnessEscalation.ts`). While the pass is
 * owed the block is
 * deliberately not engaged, so a foreign trigger inside that window (a
 * settings write, a price hour) also builds fail-closed — a second identical
 * shed the executor no-ops, bounded by the shed cooldown. A home held in
 * dry-run never latches the pass (the escalation refuses non-actuating
 * outcomes), so its "block" never engages either — every trigger keeps
 * building fail-closed, which for a simulation is the honest output.
 *
 * The planner sees none of this: the wiring composes `isBlocked()` into the
 * one `planBuildGate` boolean, and the planner keeps asking its single
 * question with no reason attached (`lib/plan/planServiceDeps.ts`). No timer,
 * age, or freshness enum crosses that wall.
 *
 * A home that has NEVER sampled is not this monitor's case — the measurement
 * gate owns it ("no plan for a home whose meter never reported").
 */
export class MeterSilenceMonitor {
  /**
   * The sample timestamp the one shed pass was completed against. `0` = no
   * pass completed for the current silence (a real ingest stamp is a wall
   * clock, never 0), replacing the escalation closure's old nullable latch
   * one-for-one.
   */
  private shedPassDoneForTs = 0;

  private blockLogged = false;

  constructor(private readonly deps: MeterSilenceMonitorDeps) {}

  /**
   * The block, judged at READ time: silence past the timeout, and the one
   * shed pass already run against this stamp. Composed into `planBuildGate`
   * by the wiring.
   */
  isBlocked(): boolean {
    if (!this.silentPastTimeout()) {
      this.logBlockCleared();
      return false;
    }
    const blocked = this.shedPassDoneForTs === this.deps.getLastSampleAtMs();
    if (blocked && !this.blockLogged) {
      this.blockLogged = true;
      this.deps.structuredLog()?.warn({ event: 'meter_silence_block_engaged' });
    }
    return blocked;
  }

  /** Escalation protocol: is the one fail-closed pass still owed for this silence? */
  shouldRunShedPass(): boolean {
    return this.silentPastTimeout() && this.shedPassDoneForTs !== this.deps.getLastSampleAtMs();
  }

  /**
   * Latch the completed pass against the timestamp it was taken for, so a
   * sample racing in (which moves the timestamp) re-arms the protocol for the
   * NEXT silence instead of being swallowed by this one's latch.
   */
  noteShedPassCompleted(forTs: number): void {
    this.shedPassDoneForTs = forTs;
    this.deps.structuredLog()?.warn({ event: 'meter_silence_shed_pass_completed' });
  }

  private logBlockCleared(): void {
    if (!this.blockLogged) return;
    this.blockLogged = false;
    this.deps.structuredLog()?.info({ event: 'meter_silence_block_cleared' });
  }

  private silentPastTimeout(): boolean {
    const lastTs = this.deps.getLastSampleAtMs();
    // Never sampled: the measurement gate owns that answer, not this monitor.
    if (typeof lastTs !== 'number' || !Number.isFinite(lastTs)) return false;
    return this.deps.nowMs() - lastTs >= POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
  }
}
