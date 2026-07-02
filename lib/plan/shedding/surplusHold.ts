import type { PlanInputDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import { isBinaryPlanDevice } from '../planBinaryDevice';
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
  state: Pick<PlanEngineState, 'surplusEligibilityByDevice'>;
  excludeIds: ReadonlySet<string>;
}): SurplusHoldResult {
  const holdIds = new Set<string>();
  const reasonById = new Map<string, DeviceReason>();
  for (const device of params.devices) {
    if (device.surplusOnly !== true) continue;
    if (params.excludeIds.has(device.id)) continue;
    if (isEligibleAndRunnable(device, params.state.surplusEligibilityByDevice[device.id])) continue;
    holdIds.add(device.id);
    reasonById.set(device.id, { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null });
  }
  return { holdIds, reasonById };
}

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
const isEligibleAndRunnable = (
  device: PlanInputDevice,
  entry: PlanEngineState['surplusEligibilityByDevice'][string] | undefined,
): boolean => {
  if (entry?.eligible !== true) return false;
  const currentOn = isBinaryPlanDevice(device) ? device.currentOn : false;
  return currentOn || entry.pendingSinceMs === undefined;
};
