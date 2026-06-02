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
export const isAheadOfHourMilestone = (params: {
  energyNeededKWh: number;
  committedHours: readonly DeferredObjectiveActivePlanHourV1[];
  nowMs: number;
}): boolean => {
  const { energyNeededKWh, committedHours, nowMs } = params;
  if (!Number.isFinite(energyNeededKWh) || energyNeededKWh < 0) return false;

  // Hours strictly after the current clock hour. Use the floored clock-hour
  // boundary (never the live plan's earliest hour) for the elapsed/current
  // split — see reference_live_plan_earliest_hour_not_current. The boundary is an
  // absolute-ms hour edge, so a 23/25-hour DST day does not mis-partition it.
  const nextHourStartMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS + ONE_HOUR_MS;
  let futureCommittedKWh = 0;
  for (const hour of committedHours) {
    if (hour.startsAtMs >= nextHourStartMs) {
      futureCommittedKWh += Math.max(0, hour.plannedKWh);
    }
  }
  if (futureCommittedKWh <= 0) return false;

  return energyNeededKWh <= futureCommittedKWh * (1 - MILESTONE_AHEAD_MARGIN);
};
