import {
  pricedShedGrace,
  resolveSoftOvershootDecision,
  unpricedShedGrace,
  type SoftOvershootDecision,
} from './planOvershoot';

const OVERSHOOT_ESCALATION_INTERVAL_MS = 30 * 1000;

/**
 * Over the grid import target: act at once. A grid breach bypasses the shed
 * grace (`docs/technical.md` § "Grid import limit"), and it times no soft
 * deficit, so it carries no deficit clock.
 */
const GRID_BREACH_DECISION: SoftOvershootDecision = { actionable: true, shedActionable: true, pendingSinceMs: null };

/** No limit is enabled this build: there is nothing to be over. */
const NO_LIMIT_DECISION: SoftOvershootDecision = { actionable: false, shedActionable: false, pendingSinceMs: null };

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

  /**
   * This build's soft-overshoot verdict, with the deficit clock carried across
   * builds: Capacity limit on, so the wait is priced against the period's
   * remaining allowance (`pricedShedGrace`).
   */
  decideSoft(
    headroomKw: number,
    hourRemainingKWh: number,
    restoreTransientPossible: boolean,
    nowTs: number,
  ): SoftOvershootDecision {
    return this.remember(resolveSoftOvershootDecision(
      headroomKw, pricedShedGrace(hourRemainingKWh), restoreTransientPossible, this.softPendingSinceMs, nowTs,
    ));
  }

  /**
   * The same verdict with Capacity limit off: no period prices the wait, so a
   * real deficit PELS may be driving gets the bounded maximum (`unpricedShedGrace`).
   */
  decideSoftUnpriced(headroomKw: number, restoreTransientPossible: boolean, nowTs: number): SoftOvershootDecision {
    return this.remember(resolveSoftOvershootDecision(
      headroomKw, unpricedShedGrace, restoreTransientPossible, this.softPendingSinceMs, nowTs,
    ));
  }

  /**
   * This build's verdict when the house is over its grid import target: shed
   * now, without the grace.
   *
   * It also ENDS the soft-deficit clock. The clock times one soft deficit — a
   * draw over the capacity or daily pace the grace is priced against — from the
   * first build that saw it. A grid-breach build never judges that deficit, and
   * its shed changes the draw the next soft decision reads, so carrying the
   * pre-breach start across the breach would claim a continuity no build
   * observed: a capacity deficit right after the breach would inherit the older
   * start and could skip the grace it is owed. The soft deficit that remains
   * once the house is back under its grid target is timed from the build that
   * first sees it.
   */
  decideGridBreach(): SoftOvershootDecision {
    return this.remember(GRID_BREACH_DECISION);
  }

  /**
   * This build's verdict when no limit is enabled (no binding pace at all):
   * nothing is over, and the soft-deficit clock ends, so a deficit after a
   * limit is turned back on is timed from its own first build.
   */
  decideWithoutLimit(): SoftOvershootDecision {
    return this.remember(NO_LIMIT_DECISION);
  }

  private remember(decision: SoftOvershootDecision): SoftOvershootDecision {
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
