import type CapacityGuard from '../lib/power/capacityGuard';
import type { HomeId } from '../lib/utils/settingsKeys';
import type { Logger as PinoLogger } from '../lib/logging/logger';

/**
 * The wiring-layer answer to "may the planner build a plan right now?".
 *
 * PELS does not build a plan for a home whose meter has never reported. The
 * alternative is worse: a plan built with no measurement has to model the
 * absence, and that absence then travels — a nullable total, or a
 * `kind: 'unknown'` variant — into every consumer of a value that is otherwise
 * always real. Gating keeps the planner's power vocabulary made of numbers
 * (root `AGENTS.md` → "Clean and trusted interfaces between layers", and the
 * 2026-08-16 ruling that `lib/plan` holds no concept of staleness).
 *
 * This is NOT a freshness gate. Once a meter has reported once, the gate stays
 * open for the rest of that meter's life and a later dropout is handled where it
 * belongs — `lib/power` decides what a stale reading means and answers the
 * planner in kW. The gate shuts again only when the measurement itself goes
 * away: an in-place meter swap (`CapacityGuard.resetLastTotalPower`) puts the
 * bundle back to "no reading from THIS meter yet".
 *
 * The planner sees only `isOpen()` and never learns what it is waiting on.
 *
 * **A home that never reports stays planless, and that is the answer.** Owner
 * ruling 2026-08-16: a home whose meter never reports is effectively
 * unmanageable, and leaving it as it is beats turning the whole house off. So
 * there is deliberately no escalation here — no "shed blind after N gated
 * cycles", no fabricated reading. The warning below is the whole response, and
 * it names the configured source so the owner can fix the actual cause.
 */
export type PowerMeasurementGateOptions = {
  homeId: HomeId;
  getCapacityGuard: () => CapacityGuard | undefined;
  logger: () => Pick<PinoLogger, 'info' | 'warn'> | undefined;
  /**
   * How long a home may sit gated before it is worth telling the operator. A
   * Homey Energy home opens the gate within a poll (10 s); a home on the flow
   * power source opens it only when its flow first fires, which may be never if
   * the flow was never built — that is the case this warning exists for.
   */
  warnAfterMs: number;
  nowMs: () => number;
  /**
   * The configured power source, so the warning names the right cause. Under
   * `flow` a silent home means the flow never fired; under `homey_energy` it
   * means the selected meter is not reporting. Asserting the flow cause for
   * both is wrong for most homes, and this line is the only diagnostic an
   * operator gets.
   */
  getPowerSource: () => string | null;
};

export class PowerMeasurementGate {
  private openedAtMs: number | null = null;

  private gatedSinceMs: number | null = null;

  private warned = false;

  constructor(private readonly options: PowerMeasurementGateOptions) {}

  isOpen(): boolean {
    const open = this.options.getCapacityGuard()?.hasPowerMeasurement() === true;
    if (open) {
      this.noteOpen();
      return true;
    }
    this.noteShut();
    return false;
  }

  private noteOpen(): void {
    if (this.openedAtMs !== null) return;
    const nowMs = this.options.nowMs();
    this.openedAtMs = nowMs;
    const waitedMs = this.gatedSinceMs === null ? 0 : nowMs - this.gatedSinceMs;
    this.gatedSinceMs = null;
    this.warned = false;
    this.options.logger()?.info({
      event: 'home_power_measurement_first_sample',
      homeId: this.options.homeId,
      waitedMs,
    });
  }

  private noteShut(): void {
    // A previously-open gate that shuts is a meter swap, not a cold start: reset
    // the timer so the warning measures the NEW meter's silence.
    if (this.openedAtMs !== null) {
      this.openedAtMs = null;
      this.gatedSinceMs = null;
      this.warned = false;
    }
    const nowMs = this.options.nowMs();
    if (this.gatedSinceMs === null) {
      this.gatedSinceMs = nowMs;
      return;
    }
    if (this.warned || nowMs - this.gatedSinceMs < this.options.warnAfterMs) return;
    this.warned = true;
    const powerSource = this.options.getPowerSource();
    this.options.logger()?.warn({
      event: 'home_bundle_gated_no_power_sample',
      homeId: this.options.homeId,
      gatedForMs: nowMs - this.gatedSinceMs,
      powerSource,
      detail: powerSource === 'flow'
        ? 'no meter reading yet; no plan is built for this home until one arrives — '
          + 'the flow that reports power usage to PELS has never fired'
        : 'no meter reading yet; no plan is built for this home until one arrives — '
          + 'the selected whole-home meter is not reporting',
    });
  }
}
