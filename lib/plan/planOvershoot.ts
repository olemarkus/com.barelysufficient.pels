import {
  SHED_GRACE_HEADROOM_FRACTION,
  SHED_GRACE_MAX_MS,
  SOFT_OVERSHOOT_DEADBAND_KW,
  SOFT_OVERSHOOT_PERSIST_MS,
} from './planConstants';

const MS_PER_HOUR = 60 * 60 * 1000;

export type SoftOvershootDecision = {
  /**
   * The deficit is real rather than rounding noise. Drives overshoot
   * bookkeeping and attribution, which must record what happened the moment it
   * is observed — the backoff ladder cannot learn from an overshoot that was
   * never attributed.
   */
  actionable: boolean;
  /**
   * ...and it has persisted long enough that acting is worth what acting costs.
   * Only this gates shedding. The two are separate because observing an
   * overshoot and destroying comfort over it are different decisions, and the
   * evidence says PELS was making the second one far too eagerly.
   */
  shedActionable: boolean;
  pendingSinceMs: number | null;
};

/**
 * How long a deficit must persist before shedding on it.
 *
 * The window is priced, not clocked: it is exactly the time this deficit needs
 * to consume the energy we are willing to slip. That gives the property worth
 * relying on — **the energy at risk while waiting is bounded at
 * `SHED_GRACE_HEADROOM_FRACTION` of the remaining hourly budget, whatever the
 * size of the deficit.** A bigger overshoot burns the allowance faster and so
 * buys a shorter grace; a nearly-spent hour buys none.
 *
 * Why this exists: the cap is an hourly mean, so a deficit is a rate and not yet
 * a fact about the hour. In 42 h of production logs every one of the four
 * `hard_cap_shortfall_detected` incidents fired in an hour that finished 18-35%
 * under budget, on transients worth 10-35 Wh against 830-1650 Wh of slack that
 * actually remained — and the sheds they triggered switched off a water heater
 * and two thermostats, which cannot lower an hourly mean by deferring load
 * inside the same hour. PELS already applied persistence on the *alert* path —
 * `hard_cap_shortfall_sustained_alert_triggered` fired once for those four
 * detections, so whatever the owner had configured as its threshold, three were
 * judged too brief to mention. This is the same judgement on the path that
 * actually acts. (That alert's threshold is per-Flow user configuration, so it
 * supplies the principle here, not the number — see SHED_GRACE_MAX_MS.)
 *
 * Returns 0 — shed now — when the hour's budget is gone, so this can only ever
 * delay a shed while the hour still has room to absorb it. The exhausted-hour
 * case is additionally covered upstream: `buildSheddingPlan` ORs
 * `hourlyBudgetExhausted` into its actionable flag.
 */
export function resolveShedGraceMs(params: {
  deficitKw: number;
  hourRemainingKWh: number;
}): number {
  const { deficitKw, hourRemainingKWh } = params;
  if (!Number.isFinite(deficitKw) || deficitKw <= 0) return 0;

  const tolerableKWh = Math.max(0, hourRemainingKWh) * SHED_GRACE_HEADROOM_FRACTION;
  if (tolerableKWh <= 0) return 0;

  return Math.min(SHED_GRACE_MAX_MS, (tolerableKWh / deficitKw) * MS_PER_HOUR);
}

/** How long a deficit of this size may wait before shedding — priced or unpriced. */
type ShedGraceForDeficit = (deficitKw: number) => number;

/** Capacity limit on: the wait is priced against the period's remaining allowance (`resolveShedGraceMs`). */
export const pricedShedGrace = (hourRemainingKWh: number): ShedGraceForDeficit => (
  (deficitKw) => resolveShedGraceMs({ deficitKw, hourRemainingKWh })
);

/**
 * Capacity limit off: no capacity period binds this cycle, so nothing prices
 * the wait, and a real deficit gets the bounded maximum, `SHED_GRACE_MAX_MS` —
 * the same answer a wide-open period gives a small deficit. The remaining
 * period energy is still a fact (tracking continues), but no limit spends it.
 *
 * The deficit is the daily budget's, the one soft pace left — a soft
 * constraint paced per bucket and never held back at a period boundary
 * (`computeDailyUsageSoftLimit`), so the cost the priced grace bounds does not
 * arise. Or it is the grid pace's, in one case: a battery hand-back debit
 * (`StorageShedTerm.netCreditKw` below zero) can put the adjusted headroom
 * under the grid target before the meter shows a grid breach. That deficit gets
 * this grace too, until the meter shows the breach and the grid path sheds at
 * once (`PlanBuilder.decideOvershoot`). Either way it is a grace only for a
 * deficit PELS may itself be driving (`resolveSoftOvershootDecision`), so it
 * never widens to a sustained overshoot.
 */
export const unpricedShedGrace: ShedGraceForDeficit = (deficitKw) => (
  Number.isFinite(deficitKw) && deficitKw > 0 ? SHED_GRACE_MAX_MS : 0
);

/**
 * `restoreTransientPossible` is true only when this deficit is plausibly a
 * transient PELS itself caused — an activation attempt is open, meaning a
 * device was restored moments ago and has not settled. The grace is
 * deliberately scoped to that case. It must NOT widen to every deficit: a
 * sustained overshoot with no pending activation is simply real and should be
 * acted on at once. (The silent-meter pass never prices a wait — it takes its
 * shed directive without this decision.)
 *
 * `pendingSinceMs` is the deficit clock the previous decision answered, carried
 * by `OvershootIncident`; null when the last build was under, was a grid breach,
 * or had no limit to be over (`OvershootIncident.decideGridBreach` /
 * `decideWithoutLimit` end the clock).
 *
 * `graceFor` is `pricedShedGrace` with Capacity limit on, `unpricedShedGrace`
 * with it off — the builder's choice (`PlanBuilder.decideOvershoot`).
 */
export function resolveSoftOvershootDecision(
  headroomKw: number,
  graceFor: ShedGraceForDeficit,
  restoreTransientPossible: boolean,
  previousPendingSinceMs: number | null,
  nowTs: number,
): SoftOvershootDecision {
  if (headroomKw >= 0) {
    return { actionable: false, shedActionable: false, pendingSinceMs: null };
  }

  const deficitKw = -headroomKw;
  const pendingSinceMs = previousPendingSinceMs ?? nowTs;
  const elapsedMs = nowTs - pendingSinceMs;

  // A rounding-scale deficit is noise until it proves otherwise — unchanged.
  if (deficitKw < SOFT_OVERSHOOT_DEADBAND_KW) {
    const settled = elapsedMs >= SOFT_OVERSHOOT_PERSIST_MS;
    return { actionable: settled, shedActionable: settled, pendingSinceMs };
  }

  // Above the deadband the overshoot is real immediately, and is recorded as
  // such. Only the decision to act on it waits, and only while the deficit could
  // still be a restore PELS itself is driving.
  const graceMs = restoreTransientPossible ? graceFor(deficitKw) : 0;
  return { actionable: true, shedActionable: elapsedMs >= graceMs, pendingSinceMs };
}
