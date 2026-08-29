import type { PlanInputDevice } from '../planTypes';
import type { PlanEngineState, SurplusTrackingDecision } from '../planState';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { resolveBoostActive } from '../planBoost';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';

/**
 * Standing hold for the "Run on solar surplus" dump-load posture (PR-7).
 *
 * Ownership: this module — the single home for shedding selection
 * (`lib/plan/shedding/AGENTS.md`) — decides which binary dump loads are HELD
 * OFF this cycle. A device carrying the producer-resolved
 * `surplusOnly` posture (`PlanInputDevice.surplusOnly`, see
 * `resolveSurplusOnlyPosture`) is HELD unless it is eligible AND safe to run
 * on the CURRENT surplus (`isEligibleAndRunnable`), so:
 *
 * - Baseline is OFF: absent/unknown eligibility (including a fresh restart —
 *   the eligibility map is in-memory) resolves to held ⇒ off. Level-based and
 *   restart-safe by construction.
 * - The hold LIFTS only through the existing allocator + settle/dwell/hard-off
 *   gate (`resolveSurplusEligibility` → `admission/surplusAbsorb`), and the
 *   turn-on then rides the NORMAL restore lane (headroom admission, cooldowns).
 * - Re-entering the hold (eligibility released) puts the device back into the
 *   shed set, and the turn-off rides the NORMAL shed lane.
 *
 * Latched-eligible carve-out (Codex P2 on #1817): the allocator keeps
 * `eligible === true` through the release settle/dwell AFTER surplus is gone
 * (`admission/surplusAbsorb.advanceFlip`). If a device was marked eligible during
 * an export window but its ON never materialized (restore cooldown, missing
 * snapshot, pending flow-backed restore) and surplus then vanished, a bare
 * `eligible === true` check would suppress the hold while the device is still OFF
 * — letting the generic binary-restore lane turn it on from grid HEADROOM, not
 * solar, defeating the feature. So a still-OFF device is only released while
 * there is CURRENT surplus (no release pending — `pendingSinceMs === undefined`);
 * a device already running on surplus (`currentOn`) still rides the dwell so a
 * passing-cloud dip does not flap it off.
 *
 * `excludeIds` is the smart-task precedence set (plan-side, judges 2+3):
 * `forceShedSet ∪ deferredAvoidDeviceIds ∪ keys(deferredReleaseIntentByDeviceId)
 * ∪ admittedDeviceIds`. A device an active smart task governs is never
 * surplus-held, so the two standing postures cannot fight over one device.
 *
 * The per-device reason is the stable `awaitingSolarSurplus` code (no embedded
 * numbers/timestamps — rebuild-storm class, f1550cea); `normalizeShedReasons`
 * adopts it for held ids like the `deferredObjectiveAvoid` pattern, so a fresh
 * capacity/shortfall shed decision still wins the reason.
 */
export type SurplusHoldResult = {
  holdIds: Set<string>;
  reasonById: Map<string, DeviceReason>;
};

export function resolveSurplusHold(params: {
  devices: readonly PlanInputDevice[];
  // Read-only: consulted for `surplusEligibilityByDevice` only; this module
  // never writes engine state (the allocator owns the eligibility lifecycle).
  state: Pick<PlanEngineState, 'surplusEligibilityByDevice' | 'surplusTrackingByDevice'>;
  excludeIds: ReadonlySet<string>;
}): SurplusHoldResult {
  const holdIds = new Set<string>();
  const reasonById = new Map<string, DeviceReason>();
  for (const device of params.devices) {
    if (params.excludeIds.has(device.id)) continue;
    if (!isSurplusHeldDevice(device, params.state)) continue;
    holdIds.add(device.id);
    reasonById.set(device.id, { code: PLAN_REASON_CODES.awaitingSolarSurplus });
  }
  return { holdIds, reasonById };
}

/**
 * Is this device currently held by a surplus posture? THE single definition,
 * shared by {@link resolveSurplusHold} (which turns it into shed-set membership
 * and a reason) and by the plan-side keep-invariant predicate
 * `isSurplusOnlyHoldShed` in `planDevices.ts` (which must not count a
 * solar-held device as capacity pressure clamping unrelated stepped loads).
 *
 * Those two used to be hand-mirrored, with a comment demanding they stay
 * "EXACTLY" in step — and they had already drifted once: the plan side used a
 * raw `eligible !== true` proxy, missed the release-pending window, and let a
 * pump waiting for solar clamp unrelated stepped loads to their lowest step.
 * Adding a third modality to two hand-mirrored predicates would be inviting the
 * same bug back, so there is now one.
 *
 * Excludes the smart-task precedence set only at the call sites that have it —
 * this predicate answers the posture question alone.
 */
export const isSurplusHeldDevice = (
  device: PlanInputDevice,
  state: Pick<PlanEngineState, 'surplusEligibilityByDevice' | 'surplusTrackingByDevice'>,
): boolean => {
  if (device.surplusOnly === true) {
    return !isEligibleAndRunnable(device, state.surplusEligibilityByDevice[device.id]);
  }
  if (device.surplusTracking) {
    return isTrackingStopped(device, state.surplusTrackingByDevice[device.id]);
  }
  return false;
};

/**
 * A surplus-TRACKING device is held exactly when the allocator decided it stops.
 *
 * It asks the DECISION, never a step id, and an ABSENT decision is not a stop —
 * absence means the allocator had no answer (not a stepped load, not
 * commandable, no runnable rung), and reading it as a stop would shed an
 * unplugged charger for want of sun it was never going to draw.
 *
 * The hold says only THAT the device stops. Where it parks is the configured
 * shed action's answer, resolved on the ordinary shed path, so a solar stop and
 * a capacity stop land in the same place.
 */
const isTrackingStopped = (
  device: PlanInputDevice,
  decision: SurplusTrackingDecision | undefined,
): boolean => {
  if (decision?.kind !== 'stopped') return false;
  if (!isSteppedLoadDevice(device)) return false;
  // A boost outranks the surplus posture, and THIS is where that has to be
  // honoured — not only in the keep and restore ceiling paths. Those run after
  // materialization has read the shed set, so a device held here is already
  // `plannedState: 'shed'` and the restore candidate predicates reject it,
  // leaving their boost bypasses unreachable. Without this a low-battery
  // charger sits off until the sun returns, which is the opposite of what a
  // boost is for.
  return !resolveBoostActive(device);
};

// Suppress the hold ONLY when the device is eligible AND safe to run on the
// current surplus:
//   - already ON (running/absorbing) → ride the settle/dwell so a passing-cloud
//     dip does not flap it off, even while its release is pending;
//   - still OFF → only when there is CURRENT surplus, i.e. no release is pending
//     (`pendingSinceMs === undefined`; the allocator SETS it the moment surplus
//     falls short and CLEARS it while surplus covers the draw). A still-OFF device
//     whose `eligible` is merely latched through the release window with surplus
//     gone stays HELD — it must not be turned on from grid headroom by the generic
//     restore lane before its ON has materialized on real export.
// A non-binary surplusOnly device is invariant-impossible (candidacy requires a
// binary control capability); it defensively reads `currentOn` as false.
// Exported so the plan-side keep-invariant predicate (`isSurplusOnlyHoldShed` in
// planDevices.ts) mirrors this EXACT condition — a device held here for surplus
// (still-off + release-pending, or not eligible) must not be counted as capacity
// pressure that clamps unrelated stepped loads.
export const isEligibleAndRunnable = (
  device: PlanInputDevice,
  entry: PlanEngineState['surplusEligibilityByDevice'][string] | undefined,
): boolean => {
  if (entry?.eligible !== true) return false;
  const currentOn = isBinaryPlanDevice(device) ? device.currentOn : false;
  return currentOn || entry.pendingSinceMs === undefined;
};
