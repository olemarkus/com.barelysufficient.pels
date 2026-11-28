import { getDebugEmitter } from '../logging/logger';
import type { GenerationReadResult } from './sources/generationPoll';

const emitDebug = getDebugEmitter('power', 'plan');

/**
 * Whether the home's solar panels are producing, as a settled answer.
 *
 * `unknown` until the whole-home feed has carried a production reading in
 * watts this run, and for as long as it never does (a home with no panels in
 * Homey, one that shows solar only through its meter's export, or one whose
 * production is unreadable). Consumers treat `unknown` as "may be producing":
 * PELS never invents a dark sky.
 */
export type SolarProductionState = 'producing' | 'not_producing' | 'unknown';

/**
 * Below this gross production (W) the panels count as stopped. It sits well
 * under the lowest step any charger offers (6 A on one phase is about 1.4 kW),
 * so no surplus that could start a charger is lost by calling it "stopped", and
 * well above the few tens of watts an idle inverter reports at night.
 */
export const SOLAR_STOPPED_BELOW_W = 100;

/**
 * Production must reach this (W) to count as producing again once stopped.
 * Twice the stop level, so readings wandering around 100 W at dusk or dawn
 * cannot flip the answer on every sample.
 */
export const SOLAR_PRODUCING_FROM_W = 200;

/**
 * How long production must stay below {@link SOLAR_STOPPED_BELOW_W} before the
 * panels count as stopped. A passing cloud at dusk lasts minutes, and the
 * planner's restore wait is 5 to 10 minutes, so a shorter hold would let a
 * charger start from the grid and be held for surplus again before it settled.
 */
export const SOLAR_STOPPED_HOLD_MS = 10 * 60 * 1000;

type BelowReason = 'below_stop_level' | 'no_generation_reported';

/**
 * The production phase of the home's whole-home feed, owned by the power layer
 * beside the surplus-pool reachability it complements: reachability says the
 * pool can ever open, this says whether the sun is feeding it now.
 *
 * Fed once per Main whole-home sample with the observer's fresh production
 * reading (the shape the generation poll resolves):
 * - `measured`: watts, compared with the levels above.
 * - `none`: Homey reported that nothing generates. Once the feed has reported
 *   watts this run, that is the panels going quiet at dusk, and it counts as
 *   below the stop level. Before any watts it says nothing: a home that shows
 *   solar only through its meter always reports this, sun or not.
 * - `unavailable`: no fresh reading. No evidence: the last accepted reading
 *   stands, and a stop hold that was already running keeps running.
 *
 * Held in memory only: after a restart the answer is `unknown` until the feed
 * reports watts again.
 */
export class SolarProductionPhase {
  private phase: SolarProductionState = 'unknown';

  private hasMeasuredWatts = false;

  private below: { sinceMs: number; reason: BelowReason } | null = null;

  observe(reading: GenerationReadResult, nowMs: number): void {
    if (reading.state === 'measured' && Number.isFinite(reading.watts)) {
      this.hasMeasuredWatts = true;
      this.accept(reading.watts, 'below_stop_level', nowMs);
    } else if (reading.state === 'none' && this.hasMeasuredWatts) {
      this.accept(0, 'no_generation_reported', nowMs);
    }
    this.settleStopHold(nowMs);
  }

  read(): SolarProductionState {
    return this.phase;
  }

  private accept(generationW: number, reason: BelowReason, nowMs: number): void {
    if (generationW < SOLAR_STOPPED_BELOW_W) {
      this.below ??= { sinceMs: nowMs, reason };
      return;
    }
    this.below = null;
    // Once stopped, only a clear return counts; until then any reading at or
    // above the stop level is production.
    if (this.phase === 'producing') return;
    if (this.phase === 'not_producing' && generationW < SOLAR_PRODUCING_FROM_W) return;
    this.transition('producing', this.phase === 'unknown' ? 'first_reading' : 'resumed', generationW);
  }

  private settleStopHold(nowMs: number): void {
    if (this.below === null || this.phase === 'not_producing') return;
    // A clock that stepped back restarts the hold rather than ending it early.
    if (nowMs < this.below.sinceMs) {
      this.below = { ...this.below, sinceMs: nowMs };
      return;
    }
    if (nowMs - this.below.sinceMs >= SOLAR_STOPPED_HOLD_MS) {
      this.transition('not_producing', this.below.reason, null);
    }
  }

  private transition(
    next: SolarProductionState,
    reason: BelowReason | 'first_reading' | 'resumed',
    generationW: number | null,
  ): void {
    const previous = this.phase;
    this.phase = next;
    emitDebug({
      event: 'solar_production_phase_changed', from: previous, to: next, reason, generationW,
    });
  }
}
