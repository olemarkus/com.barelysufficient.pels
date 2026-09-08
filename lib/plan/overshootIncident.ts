import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';

const OVERSHOOT_ESCALATION_INTERVAL_MS = 30 * 1000;

/**
 * The overshoot incident the planner is in, if any — when it started, and when
 * shedding last acted on it. One per `PlanEngineState`, owned by the planner:
 * `OvershootTracker` opens and closes it from each build's soft-overshoot
 * verdict, the shedding pass asks it whether a sustained incident has earned
 * another pass and stamps the pass it takes, and the rebuild scheduler asks
 * whether one is open at all. In-memory: a restart starts outside any incident.
 *
 * The soft-overshoot deficit clock (`softPendingSinceMs`) lives here too: it is
 * the one piece of memory `resolveSoftOvershootDecision` carries between builds,
 * and it belongs to the same question ("is the house over, and for how long").
 */
/** The read a consumer that only asks "is one open?" is handed — the rebuild posture, not the mutators. */
export type OvershootIncidentRead = Pick<OvershootIncident, 'isActive'>;

export class OvershootIncident {
  private active = false;

  private startedMs: number | null = null;

  private lastEscalationMs: number | null = null;

  private lastMitigationMs: number | null = null;

  private softPendingSinceMs: number | null = null;

  isActive(): boolean {
    return this.active;
  }

  /** This build's soft-overshoot verdict, with the deficit clock carried across builds. */
  decideSoft(
    headroomKw: number,
    hourRemainingKWh: number,
    restoreTransientPossible: boolean,
    nowTs: number,
  ): SoftOvershootDecision {
    const decision = resolveSoftOvershootDecision(
      headroomKw, hourRemainingKWh, restoreTransientPossible, this.softPendingSinceMs, nowTs,
    );
    this.softPendingSinceMs = decision.pendingSinceMs;
    return decision;
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
