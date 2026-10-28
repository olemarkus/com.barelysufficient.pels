import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { LatchedMeterReading } from '../power/lastTotalPower';
import type { MeasuredPower, PlanContext } from './planContext';
import type { SoftOvershootDecision } from './planOvershoot';
import type { StorageShedTerm } from './shedding/types';
import { PacingGrace } from './pacingGrace';

const OVERSHOOT_ESCALATION_INTERVAL_MS = 30 * 1000;

/**
 * The overshoot incident the planner is in, if any — when it started, and when
 * shedding last acted on it. One per `PlanEngineState`, owned by the planner:
 * `OvershootTracker` opens and closes it from each build's soft-overshoot
 * verdict, the shedding pass asks it whether a sustained incident has earned
 * another pass and stamps the pass it takes, and the rebuild scheduler asks
 * whether one is open at all. In-memory: a restart starts outside any incident.
 *
 * Its pacing grace keeps the episode clock and period exposure allowance;
 * clearing a short pressure episode never replenishes that allowance.
 */
/** The read a consumer that only asks "is one open?" is handed — the rebuild posture, not the mutators. */
export type OvershootIncidentRead = Pick<OvershootIncident, 'isActive'>;

export class OvershootIncident {
  private active = false;

  private startedMs: number | null = null;

  private lastEscalationMs: number | null = null;

  private lastMitigationMs: number | null = null;

  private readonly pacingGrace = new PacingGrace();

  isActive(): boolean {
    return this.active;
  }

  /** One measured pacing decision, independent of activation attribution. */
  decidePacing(
    context: PlanContext,
    power: MeasuredPower,
    settings: PowerLimitSettings,
    storage: StorageShedTerm,
    shortfallThresholdKw: number | null,
    reading: LatchedMeterReading,
  ): SoftOvershootDecision {
    return this.pacingGrace.decide(context, power, settings, storage, shortfallThresholdKw, reading);
  }

  /** Open the incident: the house just went over. */
  enter(nowTs: number): void {
    this.active = true;
    this.startedMs = nowTs;
    this.lastEscalationMs = null;
    this.lastMitigationMs = null;
  }

  /** Close the incident: the house is back under. Answers how long it ran, never negative. */
  clear(nowTs: number): number {
    const durationMs = this.startedMs === null ? 0 : Math.max(0, nowTs - this.startedMs);
    this.active = false;
    this.startedMs = null;
    this.lastEscalationMs = null;
    this.lastMitigationMs = null;
    return durationMs;
  }

  /**
   * A shedding pass acted. Stamped whether or not an incident is open (the
   * silent-meter pass sheds without one); the next `enter` resets it.
   */
  noteMitigation(nowTs: number): void {
    this.lastMitigationMs = nowTs;
  }

  /** A shedding pass escalated on a reading it had already acted on. */
  noteEscalation(nowTs: number): void {
    this.lastEscalationMs = nowTs;
  }

  /**
   * Whether a sustained incident has earned another shedding pass on the SAME
   * reading: it has run for at least the escalation interval, and so has the
   * gap since shedding last acted (mitigated, escalated, or opened it).
   */
  shouldEscalate(nowTs: number): boolean {
    if (this.startedMs === null) return false;
    if (nowTs - this.startedMs < OVERSHOOT_ESCALATION_INTERVAL_MS) return false;
    const lastAttemptMs = this.lastMitigationMs ?? this.lastEscalationMs ?? this.startedMs;
    return nowTs - lastAttemptMs >= OVERSHOOT_ESCALATION_INTERVAL_MS;
  }
}
