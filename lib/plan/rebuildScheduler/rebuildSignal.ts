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
 * Every field is present and finite. The scheduler is reached from inside the
 * tracker's `schedulePlanRebuild` callback, which the tracker core invokes only
 * after `saveState` has persisted an ADMITTED sample — so there is no "no
 * reading yet" case to model here, and no optional, nullable, or sentinel
 * member is permitted on it. What a doubtful reading means was decided in
 * `lib/power` before this point (root `AGENTS.md` § Control Flow).
 */
export type PowerRebuildSignal = {
  /** The admitted sample's signed net home power, in watts. */
  currentPowerW: number;
  /** The tracker's latched whole-home total in kW, producer-resolved. */
  totalKw: number;
  /** The configured hard cap in kW — the delta threshold scales off it. */
  limitKw: number;
  /** The planner's live hourly threshold (`computeDynamicSoftLimit`). */
  capacityPaceKw: number;
  /** `capacityPaceKw - totalKw`. Negative means over pace. */
  headroomKw: number;
  /** Producer-resolved `computeShortfallThreshold`. */
  shortfallThresholdKw: number;
  isInShortfall: boolean;
  hardCapBreach: HardCapBreach;
  /** The last plan is still converging, so power deltas are worth rebuilding on. */
  planConvergenceActive: boolean;
  /** The last plan proved nothing can be shed or restored. */
  unactionable: boolean;
};

export type HardCapBreach = {
  breached: boolean;
  deficitKw: number;
};

/**
 * How often the scheduler may rebuild. `stableMinIntervalMs` is the relaxed
 * floor used while no capacity boundary is active; the throttle collapses the
 * two into the effective minimum before the decision chain sees it.
 */
export type RebuildCadence = {
  minIntervalMs: number;
  stableMinIntervalMs: number;
  maxIntervalMs: number;
};

/**
 * The whole-home reading and the thresholds it is judged against, as the caller
 * holds them. The throttle turns this plus the guard into a
 * `PowerRebuildSignal`; the derivation stays in the planner because deciding
 * what a breach or a tight headroom IS, is policy.
 */
export type AdmittedPowerReading = {
  currentPowerW: number;
  totalKw: number;
  limitKw: number;
  capacityPaceKw: number;
  shortfallThresholdKw: number;
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

export const resolveHeadroomTight = (headroomKw: number): boolean => headroomKw <= 0;

export const resolveHardCapBreach = (
  totalKw: number,
  shortfallThresholdKw: number,
): HardCapBreach => {
  const deficitKw = Math.max(0, totalKw - shortfallThresholdKw);
  return { breached: deficitKw > 0, deficitKw };
};
