/**
 * What one admitted whole-home reading says about whether to rebuild.
 *
 * Resolved ONCE, at the signal seam (`PlanRebuildThrottle.onSample`), and
 * passed down the decision chain as a unit. Every stage below reads a subset and forwards the
 * rest — which is precisely why it is one value and not a per-stage argument
 * list. Before this type, each stage redeclared the union of everything the
 * stages beneath it needed: the old power-sample entry declared 16 properties
 * and read none of them itself.
 *
 * Every field is present; numeric observations are finite. The scheduler is reached from inside the
 * tracker's `schedulePlanRebuild` callback, which the tracker core invokes only
 * after `saveState` has persisted an ADMITTED sample — so there is no "no
 * reading yet" case to model here. A nullable constraint means it is disabled,
 * never that a reading is missing. What a doubtful reading means was decided in
 * `lib/power` before this point (root `AGENTS.md` § Control Flow).
 */
export type PowerRebuildSignal = {
  /** The admitted sample's signed net home power, in watts. */
  currentPowerW: number;
  /** The tracker's latched whole-home total in kW, producer-resolved. */
  totalKw: number;
  /** The configured hard cap in kW — the delta threshold scales off it. */
  limitKw: number;
  /**
   * The reading's `powerLimitKw - totalKw`, `null` with no physical limit on.
   * Negative means over the physical limit, so a grid breach is always a tight
   * headroom too, which is what puts a steady grid breach under the tight-noop
   * backoff.
   */
  headroomKw: number | null;
  /** Producer-resolved `resolveShortfallThresholdKw`: `null` with Capacity limit off. */
  shortfallThresholdKw: number | null;
  isInShortfall: boolean;
  /** The draw against the shortfall threshold: the capacity period's hard-cap breach. */
  hardCapBreach: LimitBreach;
  /** The draw against the grid import target. */
  gridBreach: LimitBreach;
  /** The last plan is still converging, so power deltas are worth rebuilding on. */
  planConvergenceActive: boolean;
  /** The last plan proved nothing can be shed or restored. */
  unactionable: boolean;
};

/**
 * The draw against one limit line — the hard cap's shortfall threshold
 * (`hardCapBreach`) or the grid import target (`gridBreach`). Both use this one
 * shape and one escalation rule (`isBreachEscalated`).
 */
export type LimitBreach = {
  breached: boolean;
  deficitKw: number;
};

/**
 * How often the scheduler may rebuild: never within `minIntervalMs` of the last
 * rebuild, and never more than `maxIntervalMs` after it once a reading arrives.
 */
export type RebuildCadence = {
  minIntervalMs: number;
  maxIntervalMs: number;
};

/**
 * The whole-home reading and the thresholds it is judged against, as the caller
 * holds them. The throttle turns this plus the guard into a
 * `PowerRebuildSignal`; the derivation stays in the planner because deciding
 * what a breach or a tight headroom IS, is policy.
 */
export type AdmittedPowerReading = {
  gridImportLimitKw: number | null;
  currentPowerW: number;
  totalKw: number;
  limitKw: number;
  /**
   * The planner's live physical limit (`computePhysicalPowerLimit`): the lower
   * of the capacity pace and the grid import target, `null` with both off.
   */
  powerLimitKw: number | null;
  shortfallThresholdKw: number | null;
};

/**
 * What the last plan says about whether rebuilding can change anything. All
 * three come from the planner's own summary of its last plan and answer that
 * one question. `shortfallUnrecoverable` is the plan's half of the shortfall
 * throttle — "no controlled load left to act on"; the throttle ANDs it with its
 * own invalidation latch, which no longer round-trips out through the wiring.
 */
export type PlanRebuildPosture = {
  planConvergenceActive: boolean;
  unactionable: boolean;
  shortfallUnrecoverable: boolean;
};

export const resolveHeadroomTight = (headroomKw: number | null): boolean => headroomKw !== null && headroomKw <= 0;

/** The draw against one limit; a `null` limit (that limit off) is never breached. */
export const resolveLimitBreach = (
  totalKw: number,
  limitKw: number | null,
): LimitBreach => {
  const deficitKw = limitKw === null ? 0 : Math.max(0, totalKw - limitKw);
  return { breached: deficitKw > 0, deficitKw };
};
