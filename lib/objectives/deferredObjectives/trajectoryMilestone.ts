import type { DeferredObjectiveActivePlanHourV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';

const ONE_HOUR_MS = 60 * 60 * 1000;

// Fraction by which the still-needed energy must sit below the committed future
// energy before we release the current hour. A small relative, rate-free margin
// (~2%) that biases toward heating ("early is safer") and absorbs jitter at the
// threshold; the downstream shed/restore cooldowns (60–300 s) are the backstop
// against any residual control flap (the flag itself is stateless per cycle to
// keep the recorder insulated — no two-sided latch here).
const MILESTONE_AHEAD_MARGIN = 0.02;

// True when the device is already at/above the committed plan's end-of-this-hour
// trajectory milestone — i.e. the buffered energy still needed to reach target is
// already covered by the energy the LATER committed hours will deliver:
//
//   ahead  ⟺  energyNeededKWh ≤ futureCommittedKWh × (1 − MILESTONE_AHEAD_MARGIN)
//
// Both sides are in the SAME buffered-energy currency: `energyNeededKWh` is the
// buffered floor (`mean + k·SE`) for the current measured `remainingUnits`
// (recomputed every cycle from the RAW reading, so a hot-water draw-off raises it
// and re-engages heating), and `futureCommittedKWh` is the energy the committed
// plan booked for the hours after the current one — also sized at the buffered
// rate. Comparing buffered-to-buffered keeps it rate-consistent: there is no
// division by a learned rate, so no mean-vs-buffered bias, and a rate drift
// between commit and now only shifts the comparison in the safe direction (a
// device running slower than committed needs more energy ⇒ harder to release).
//
// This is the unit-trajectory comparison the design intends, expressed in energy:
// the committed plan is the milestone, the measured-driven `energyNeededKWh` is
// the current position, and `futureCommittedKWh` (frozen within the hour, settled
// at :58) is the stable reference — so capacity arbitration jerking the mid-hour
// trajectory around cannot chatter it. See
// notes/deferred-load-objectives/execution-adaptation.md work item 2.
//
// Conservative `false` when `energyNeededKWh` is non-finite/negative or when there
// is no committed future energy (no commitment, or only the current/past hours
// are booked) — in either case keep heating.
//
// PREFERS the UNIT trajectory when the commitment carries persisted
// `plannedUnitMilestone` values: it compares the live measured value directly
// against the plan's per-hour unit milestone, so the decision never divides
// committed energy by a drifting live rate (kWh and units diverge under leakage /
// a wrong learned rate). Falls back to the energy comparison above for legacy
// commitments (or hours booked before a rate/anchor was available), so behaviour
// is unchanged for those. See notes/deferred-load-objectives/execution-adaptation.md.
export const isAheadOfHourMilestone = (params: {
  energyNeededKWh: number;
  // Live measured progress in the objective's own unit (°C / %). Drives the
  // preferred unit-based comparison. Optional/back-compat: absent → energy gate.
  measuredValue?: number | null;
  committedHours: readonly DeferredObjectiveActivePlanHourV1[];
  nowMs: number;
}): boolean => {
  const byUnit = resolveAheadByUnitMilestone(params);
  if (byUnit !== null) return byUnit;
  return resolveAheadByEnergy(params);
};

// Hours strictly after the current clock hour. Use the floored clock-hour boundary
// (never the live plan's earliest hour) for the elapsed/current split — see
// reference_live_plan_earliest_hour_not_current. The boundary is an absolute-ms
// hour edge, so a 23/25-hour DST day does not mis-partition it.
const nextHourStart = (nowMs: number): number => Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS + ONE_HOUR_MS;

// Unit-trajectory comparison (preferred). Returns `null` when it cannot apply
// (no live measured value, or no persisted milestone on the current/elapsed
// hours) so the caller falls back to energy.
//
// SINGLE-milestone compare — `ahead ⟺ measured ≥ THIS hour's frozen milestone`
// (and there ARE future committed hours to finish the rest). We deliberately do
// NOT subtract two milestones: hours get first-committed at different `:58`
// revisions, each anchored at the device's measured value AT THAT revision (the
// commitment floor preserves old hours across replans — see
// `mergeHoursPreservingCommitment`). Each hour's milestone is an internally-
// consistent ABSOLUTE target value ("be at X by the end of this hour"), so
// comparing the live measured value against ONE of them is always valid; but
// subtracting two hours' milestones would mix anchors and produce nonsense. The
// `MILESTONE_AHEAD_MARGIN` bias is unnecessary here: the milestone is the
// END-of-hour target and we check it against measured at the START of the hour,
// which already requires being a full booked hour ahead before releasing
// (early-is-safer); the shed/restore cooldowns absorb threshold jitter.
const resolveAheadByUnitMilestone = (params: {
  measuredValue?: number | null;
  committedHours: readonly DeferredObjectiveActivePlanHourV1[];
  nowMs: number;
}): boolean | null => {
  const { measuredValue, committedHours, nowMs } = params;
  if (typeof measuredValue !== 'number' || !Number.isFinite(measuredValue)) return null;
  const boundaryMs = nextHourStart(nowMs);
  // This hour's frozen target = the end-of-hour milestone of the LATEST committed
  // hour that has already started (the current hour, or — when the current hour is
  // deferred to 0 kWh and not booked — the prior hour, whose end-of-hour milestone
  // equals the current target because this hour adds nothing).
  let latestStartedHour: DeferredObjectiveActivePlanHourV1 | null = null;
  let futureBookedKWh = 0;
  for (const hour of committedHours) {
    if (hour.startsAtMs >= boundaryMs) {
      futureBookedKWh += Math.max(0, hour.plannedKWh);
      continue;
    }
    if (latestStartedHour === null || hour.startsAtMs > latestStartedHour.startsAtMs) {
      latestStartedHour = hour;
    }
  }
  // Use THAT hour's own milestone. If it is missing (booked before a rate/anchor
  // existed), fall back to the energy gate rather than substituting a stale EARLIER
  // hour's lower milestone — which would understate the target and mis-release.
  const currentHourMilestone = latestStartedHour?.plannedUnitMilestone;
  if (typeof currentHourMilestone !== 'number' || !Number.isFinite(currentHourMilestone)) return null;
  if (futureBookedKWh <= 0) return false; // no future committed hours to defer into → keep heating
  return measuredValue >= currentHourMilestone;
};

// Legacy energy comparison: `energyNeededKWh ≤ futureCommittedKWh × (1 − margin)`,
// both in the buffered-energy currency. Used when the commitment has no persisted
// unit milestones (older records, or hours booked before a rate was learned).
const resolveAheadByEnergy = (params: {
  energyNeededKWh: number;
  committedHours: readonly DeferredObjectiveActivePlanHourV1[];
  nowMs: number;
}): boolean => {
  const { energyNeededKWh, committedHours, nowMs } = params;
  if (!Number.isFinite(energyNeededKWh) || energyNeededKWh < 0) return false;
  const boundaryMs = nextHourStart(nowMs);
  let futureCommittedKWh = 0;
  for (const hour of committedHours) {
    if (hour.startsAtMs >= boundaryMs) futureCommittedKWh += Math.max(0, hour.plannedKWh);
  }
  if (futureCommittedKWh <= 0) return false;
  return energyNeededKWh <= futureCommittedKWh * (1 - MILESTONE_AHEAD_MARGIN);
};
