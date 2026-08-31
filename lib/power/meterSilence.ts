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
 * Owns three connected facts:
 * - the plan-build BLOCK: engaged once a home's meter has been silent past
 *   `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS`, cleared by the next ADMITTED sample
 *   (the pipeline pushes `noteSampleAdmitted` on the same ingest that moves
 *   the tracker latch);
 * - the ONE fail-closed shed pass the silence window is owed: the escalation
 *   clock asks `shouldRunShedPass()`, runs the rebuild (the reading resolver
 *   answers it in synthesized kW), and reports `noteShedPassCompleted` — after
 *   which the block holds until data returns;
 * - the RESTART rule: a timestamp restored across a restart that is already
 *   past the timeout blocks immediately and is owed NO shed pass. A boot-time
 *   blind shed is exactly what the old restart grace existed to prevent;
 *   blocking until this process's first admitted sample extends the
 *   measurement gate's own philosophy instead of re-planning on watts sampled
 *   before this process existed. A restored timestamp still INSIDE the
 *   timeout is different: the silence completes in this process, watching a
 *   meter that was alive minutes ago, so the crossing is an ordinary live
 *   silence and IS owed its pass — freezing the pre-restart posture with no
 *   fail-closed shed is how a correlated failure (a power blip rebooting
 *   Homey and killing the meter feed together) leaves the house running open.
 *
 * "One shed pass" is one ESCALATION pass: while the pass is owed the block is
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
  private admittedThisProcess = false;

  /**
   * True once this process has SEEN the meter inside the freshness window —
   * an admitted sample, or a restored timestamp still inside the timeout at
   * a read. Either way the silence crossing then happens in this process
   * watching a live-ish meter, and the crossing is owed its one shed pass.
   * Only a timestamp already past the timeout at every read of this process
   * keeps this false — the ruled restart case that is owed nothing.
   */
  private sawFreshThisProcess = false;

  /**
   * The sample timestamp the one shed pass was completed against. `0` = no
   * pass completed for the current silence (a real ingest stamp is a wall
   * clock, never 0), replacing the escalation closure's old nullable latch
   * one-for-one.
   */
  private shedPassDoneForTs = 0;

  private blockLogged = false;

  constructor(private readonly deps: MeterSilenceMonitorDeps) {}

  /** Wired from the pipeline's ADMITTED-sample ingest — never from a raw read. */
  noteSampleAdmitted(): void {
    this.admittedThisProcess = true;
    if (this.blockLogged) {
      this.blockLogged = false;
      this.deps.structuredLog()?.info({ event: 'meter_silence_block_cleared' });
    }
  }

  /**
   * The block, judged at READ time: silence past the timeout, and either the
   * silence predates this process (restart — no pass owed) or the one shed
   * pass has already run. Composed into `planBuildGate` by the wiring.
   */
  isBlocked(): boolean {
    if (!this.silentPastTimeout()) {
      if (this.blockLogged) {
        this.blockLogged = false;
        this.deps.structuredLog()?.info({ event: 'meter_silence_block_cleared' });
      }
      return false;
    }
    const blocked = !this.crossedSilenceThisProcess()
      || this.shedPassDoneForTs === this.deps.getLastSampleAtMs();
    if (blocked && !this.blockLogged) {
      this.blockLogged = true;
      this.deps.structuredLog()?.warn({
        event: 'meter_silence_block_engaged',
        reasonCode: this.crossedSilenceThisProcess() ? 'shed_pass_completed' : 'restored_silence',
      });
    }
    return blocked;
  }

  /** Escalation protocol: is the one fail-closed pass still owed for this silence? */
  shouldRunShedPass(): boolean {
    if (!this.silentPastTimeout() || !this.crossedSilenceThisProcess()) return false;
    return this.shedPassDoneForTs !== this.deps.getLastSampleAtMs();
  }

  /** Did the silence COMPLETE in this process (vs. predating it entirely)? */
  private crossedSilenceThisProcess(): boolean {
    return this.admittedThisProcess || this.sawFreshThisProcess;
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

  private silentPastTimeout(): boolean {
    const lastTs = this.deps.getLastSampleAtMs();
    // Never sampled: the measurement gate owns that answer, not this monitor.
    if (typeof lastTs !== 'number' || !Number.isFinite(lastTs)) return false;
    const silent = this.deps.nowMs() - lastTs >= POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    // A fresh read latches the in-process witness: the escalation clock and
    // the composed gate both evaluate this on a sub-minute cadence, so a
    // restored-but-fresh timestamp is observed here long before it can age
    // past the timeout.
    if (!silent) this.sawFreshThisProcess = true;
    return silent;
  }
}
