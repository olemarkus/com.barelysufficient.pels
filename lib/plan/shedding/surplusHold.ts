import type { PlanInputDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { resolveBoostActive } from '../planBoost';
import { isSteppedLoadOffStep } from '../../utils/deviceControlProfiles';
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
  /**
   * The rung a surplus-held TRACKING device is decided at — always one of its
   * off steps. Merged into the shedding plan's `shedStepTargets`, because shed
   * materialization reads the DECIDED rung and falls back to the device's
   * configured shed floor only when no rung was decided.
   *
   * Without it a `set_step` tracker is commanded to its lowest ACTIVE rung —
   * 6 A on a charger — while its card reads "Waiting for solar surplus". A
   * binary dump load never needed this (its shed is off either way); a stepped
   * one does, and getting it wrong means importing from the grid under a label
   * saying the opposite.
   */
  stepTargetById: Map<string, string>;
};

export function resolveSurplusHold(params: {
  devices: readonly PlanInputDevice[];
  // Read-only: consulted for `surplusEligibilityByDevice` only; this module
  // never writes engine state (the allocator owns the eligibility lifecycle).
  state: Pick<PlanEngineState, 'surplusEligibilityByDevice' | 'surplusTrackingStepByDevice'>;
  excludeIds: ReadonlySet<string>;
}): SurplusHoldResult {
  const holdIds = new Set<string>();
  const reasonById = new Map<string, DeviceReason>();
  const stepTargetById = new Map<string, string>();
  for (const device of params.devices) {
    if (params.excludeIds.has(device.id)) continue;
    if (!isSurplusHeldDevice(device, params.state)) continue;
    holdIds.add(device.id);
    reasonById.set(device.id, { code: PLAN_REASON_CODES.awaitingSolarSurplus });
    const ceilingStepId = params.state.surplusTrackingStepByDevice[device.id];
    if (device.surplusTracking === true && ceilingStepId !== undefined) {
      stepTargetById.set(device.id, ceilingStepId);
    }
  }
  return { holdIds, reasonById, stepTargetById };
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
  state: Pick<PlanEngineState, 'surplusEligibilityByDevice' | 'surplusTrackingStepByDevice'>,
): boolean => {
  if (device.surplusOnly === true) {
    return !isEligibleAndRunnable(device, state.surplusEligibilityByDevice[device.id]);
  }
  if (device.surplusTracking === true) {
    return isTrackingClampedToOff(device, state.surplusTrackingStepByDevice[device.id]);
  }
  return false;
};

/**
 * A surplus-TRACKING device is held exactly when its allocated ceiling is an off
 * rung — the `'off'` floor policy's answer to "there is not enough sun". Under
 * the `'minimum'` policy the ceiling is the ladder floor instead, so the device
 * keeps running and is never held: it is limited, not waiting, and the card must
 * not tell the owner otherwise.
 *
 * Note this asks the CEILING, not eligibility. A tracking device's eligibility
 * governs whether it may climb above its floor; the hold is about whether it
 * runs at all, and the allocator has already folded the floor policy into the
 * one answer. Reading eligibility here instead would hold a `'minimum'` device
 * that is deliberately still drawing.
 */
const isTrackingClampedToOff = (
  device: PlanInputDevice,
  ceilingStepId: string | undefined,
): boolean => {
  if (ceilingStepId === undefined) return false;
  if (!isSteppedLoadDevice(device)) return false;
  // A boost outranks the surplus posture, and THIS is where that has to be
  // honoured — not only in the keep and restore ceiling paths. Those run after
  // materialization has read the shed set, so a device held here is already
  // `plannedState: 'shed'` and the restore candidate predicates reject it,
  // leaving their boost bypasses unreachable. Without this a low-battery
  // charger sits off until the sun returns, which is the opposite of what a
  // boost is for.
  if (resolveBoostActive(device)) return false;
  return isSteppedLoadOffStep(device.steppedLoadProfile, ceilingStepId);
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
