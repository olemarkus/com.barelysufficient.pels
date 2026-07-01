import type { PlanEngineState, SurplusEligibilityState } from '../planState';
import { RESTORE_ADMISSION_RESERVE_KW } from '../planConstants';
import { getLogger } from '../../logging/logger';

const logger = getLogger('plan/surplus-absorb');

// Local guard — kept off lib/utils so this admission module stays self-contained
// (per the lib/plan ↛ lib/utils path rule).
const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

/**
 * Surplus-absorb eligibility gate — "reverse admission".
 *
 * Ownership: the per-device settle/dwell state machine that decides whether a
 * *willing* device may raise its target to self-consume exported solar. Mirrors
 * the activation-backoff gate shape — state keyed per-device in `PlanEngineState`,
 * a `sync…` reader returning a flat decision, no cross-device coordination.
 *
 * The "how much surplus does this device get" decision is NOT made here — it is
 * made by the priority-greedy allocator in `planSurplusAbsorb.ts`, which reserves
 * the whole-home export budget across all willing devices (so two devices cannot
 * both engage on the same surplus and oscillate). This gate consumes the flat
 * `availableSurplusKw` the allocator hands it and runs only the timing logic.
 *
 * Invariants callers rely on:
 * - Eligibility gates on the allocated surplus FITTING the device's expected
 *   draw (`availableSurplus >= expectedDraw + reserve`): the overshoot-fit guard,
 *   so a raise never tips the home into import. Admission against the *surplus*
 *   budget rather than headroom — hence "reverse admission".
 * - Engage (`+reserve`) and release (bare expected draw) use an asymmetric band,
 *   so the reserve doubles as hysteresis — there is no separate deadband.
 * - A flip requires the condition to persist for the settle window AND the
 *   current state to have held the minimum dwell: the chatter / passing-cloud
 *   guard, reusing the observer settle's timestamp-window shape rather than a
 *   bespoke tick counter.
 * - `availableSurplusKw === null` (power unknown / stale) yields "no surplus",
 *   which can only release or block engage — never raise blind.
 * - Hard-off (release direction only): when the caller flags the release
 *   condition as unambiguous (`hardOff` — power signal lost, or sustained
 *   whole-home import beyond `SURPLUS_ABSORB_HARD_OFF_IMPORT_KW`) and it has
 *   been sustained for a full settle window, the release skips the min dwell.
 *   The settle confirmation always applies, and the bypass term never applies
 *   in the engage direction. The dwell keeps guarding the ordinary dip
 *   (surplus collapsed but the home is not clearly importing).
 * - Release aftermath is cause-asymmetric. A `dwell_elapsed` release drops the
 *   settled-off entry (as every release historically did), so a recovery after
 *   a passing cloud may re-engage after a single settle window. A `hard_off`
 *   release RETAINS the settled-off entry until its dwell floor expires, so
 *   the next engage owes the full off-state min dwell. A sustained hard-off at
 *   release time classifies the release `hard_off` even when the dwell has
 *   also elapsed — precedence matters, or a lift engaged longer than the dwell
 *   would escape retention. That retention bounds the measured-feedback limit
 *   cycle: a device whose engaged draw exceeds its off-state estimate by more
 *   than reserve + hard-off bar manufactures its own sustained import and
 *   hard-offs itself; without the owed dwell it would re-engage every settle
 *   window (~200 s period at ~50% import duty).
 */

// Engage when the allocated surplus covers expected draw plus this reserve;
// release at the bare expected draw. The reserve band is the hysteresis. Reuses
// the restore reserve.
export const SURPLUS_ABSORB_RESERVE_KW = RESTORE_ADMISSION_RESERVE_KW;
// A flip condition must persist this long before eligibility toggles (settle).
export const SURPLUS_ABSORB_SETTLE_MS = 90 * 1000;
// Minimum time an eligibility state holds after a flip (limit-cycle / chatter guard).
export const SURPLUS_ABSORB_MIN_DWELL_MS = 5 * 60 * 1000;
// Whole-home import above this marks the surplus as unambiguously gone (hard-off):
// an engaged release may then skip the min dwell (the settle confirmation still
// applies). Deliberately NOT derived from the reserve. Rationale: it must clear
// the ~100–200 W standing import a zero-export controller holds, with margin;
// and together with the engage bar (expectedDraw + the reserve of export) it
// keeps ≥ 0.6 kW of whole-home swing between re-engage and hard-off — but only
// ASSUMING a stable expectedDraw. A device whose engaged draw exceeds its
// off-state estimate (measured-feedback inflation) can swing net past both
// bounds regardless of this value and open a churn band; the hard_off release
// keeping its dwell floor (see the release-aftermath invariant above) is what
// bounds that cycle, not this threshold. Dogfood-tunable.
export const SURPLUS_ABSORB_HARD_OFF_IMPORT_KW = 0.35;

export type SurplusEligibilityInfo = {
  eligible: boolean;
};

// A never-set state carries no dwell floor, so the first engage waits only on settle.
const dwellSatisfied = (entry: SurplusEligibilityState | undefined, nowTs: number): boolean => (
  !entry || !isFiniteNumber(entry.sinceMs) || nowTs - entry.sinceMs >= SURPLUS_ABSORB_MIN_DWELL_MS
);

const flipConditionMet = (
  currentEligible: boolean,
  availableSurplusKw: number,
  expectedDrawKw: number,
): boolean => (
  currentEligible
    ? availableSurplusKw < expectedDrawKw
    : availableSurplusKw >= expectedDrawKw + SURPLUS_ABSORB_RESERVE_KW
);

// What drove a release flip (drives the structured release log AND the entry
// retention). 'hard_off' = the sustained hard-off condition was active at
// release time — it takes precedence over an elapsed dwell when both hold, so
// a long-running lift that hard-offs itself (measured-feedback import) is
// still retained with the owed off-state dwell. 'dwell_elapsed' = an ordinary
// dip release with NO sustained hard-off clock — entry dropped, fast
// re-engage. `null` when this call did not release (no flip, or an engage).
type ReleaseCause = 'dwell_elapsed' | 'hard_off' | null;

// Advance the settle window, toggling `working.eligible` once the flip condition
// has persisted past the settle window AND either the current state has held the
// min dwell or — release direction only — the hard-off condition has been
// sustained for a full settle window. Mutates `working` in place.
const advanceFlip = (params: {
  working: SurplusEligibilityState;
  entry: SurplusEligibilityState | undefined;
  flipCondition: boolean;
  currentEligible: boolean;
  nowTs: number;
}): ReleaseCause => {
  const { working, entry, flipCondition, currentEligible, nowTs } = params;
  if (!flipCondition) {
    delete working.pendingSinceMs;
    return null;
  }
  if (working.pendingSinceMs === undefined) {
    working.pendingSinceMs = nowTs;
  }
  const settled = nowTs - (working.pendingSinceMs ?? nowTs) >= SURPLUS_ABSORB_SETTLE_MS;
  const dwellOk = dwellSatisfied(entry, nowTs);
  // Release direction only: a hard-off sustained for a full settle window
  // bypasses the min dwell (the dwell exists for the passing-cloud dip, not for
  // an unambiguously gone surplus). Engage keeps the plain dwell gate.
  const hardOffBypass = currentEligible
    && isFiniteNumber(working.hardOffSinceMs)
    && nowTs - working.hardOffSinceMs >= SURPLUS_ABSORB_SETTLE_MS;
  if (settled && (dwellOk || hardOffBypass)) {
    working.eligible = !currentEligible;
    working.sinceMs = nowTs;
    delete working.pendingSinceMs;
    delete working.hardOffSinceMs;
    delete working.hardOffReleased;
    if (!currentEligible) return null; // engage flip — no release to report
    if (hardOffBypass) {
      // Sustained hard-off at release time takes precedence over an elapsed
      // dwell: mark the entry so it is retained until the dwell floor expires
      // and the next engage owes the full off-state dwell. Without the
      // precedence, a lift engaged longer than the dwell that then hard-offs
      // itself (its own draw manufacturing the import) would classify as
      // dwell_elapsed, drop the entry, and re-engage after one settle window —
      // the exact limit cycle the retention rule exists to bound.
      working.hardOffReleased = true;
      return 'hard_off';
    }
    return 'dwell_elapsed';
  }
  return null;
};

// A settled-off entry with nothing pending is idle and droppable — UNLESS it
// came from a hard_off release and its dwell floor is still running: dropping
// it would erase the owed off-state dwell (`dwellSatisfied(undefined)` is
// true), letting the device re-engage after a bare settle window.
const isDroppableIdleEntry = (working: SurplusEligibilityState, nowTs: number): boolean => (
  working.eligible !== true
  && working.pendingSinceMs === undefined
  && !(working.hardOffReleased === true && !dwellSatisfied(working, nowTs))
);

// Hard-off clock: stamp while an engaged device sees the unambiguous-release
// condition; reset the moment it clears (or when not engaged; a flip deletes it
// too, in `advanceFlip`). Only a hard-off held at every observation across a
// settle window can bypass the dwell — a brief import blip between plan builds
// cannot.
const trackHardOffClock = (params: {
  working: SurplusEligibilityState;
  currentEligible: boolean;
  hardOff: boolean;
  nowTs: number;
}): void => {
  const { working } = params;
  if (params.currentEligible && params.hardOff) {
    working.hardOffSinceMs ??= params.nowTs;
  } else {
    delete working.hardOffSinceMs;
  }
};

// Structured release record. 'hard_off' = the sustained hard-off condition
// drove the release (entry retained, dwell owed — whether or not the dwell had
// also elapsed); 'dwell_elapsed' = the normal dip-release path with no
// sustained hard-off. No-op when this cycle did not release.
const emitReleaseLog = (params: {
  deviceId: string;
  releaseCause: ReleaseCause;
  engagedSinceMs: number | undefined;
  nowTs: number;
}): void => {
  const { deviceId, releaseCause, engagedSinceMs, nowTs } = params;
  if (releaseCause === null) return;
  logger.debug({
    event: 'surplus_absorb_released',
    deviceId,
    releaseCause,
    heldMs: isFiniteNumber(engagedSinceMs) ? nowTs - engagedSinceMs : null,
  });
};

/**
 * Resolve and advance a device's surplus-absorb eligibility for this cycle
 * against the surplus the allocator has reserved for it. Pure over
 * `(state, inputs)` apart from the in-place `PlanEngineState` update.
 */
export function syncSurplusEligibilityState(params: {
  state: PlanEngineState;
  deviceId: string;
  willing: boolean;
  // Surplus the allocator has reserved for this device, in kW; null when power
  // is unknown/stale (treated as no surplus).
  availableSurplusKw: number | null;
  expectedDrawKw: number;
  // True when the release condition is unambiguous (power signal lost, or
  // sustained whole-home import beyond SURPLUS_ABSORB_HARD_OFF_IMPORT_KW):
  // sustained for a settle window it lets a release skip the min dwell. Must
  // stay false for the ordinary passing-cloud dip, which keeps the dwell.
  hardOff: boolean;
  nowTs?: number;
}): SurplusEligibilityInfo {
  const { deviceId, willing } = params;
  const map = params.state.surplusEligibilityByDevice;
  const nowTs = params.nowTs ?? Date.now();
  const expectedDrawKw = isFiniteNumber(params.expectedDrawKw) && params.expectedDrawKw > 0
    ? params.expectedDrawKw
    : 0;

  // Not a candidate → force off and drop any state, so toggling `willing` off
  // (or losing the expected-draw estimate) releases the raise immediately.
  if (!willing || expectedDrawKw <= 0) {
    delete map[deviceId];
    return { eligible: false };
  }

  const entry = map[deviceId];
  const currentEligible = entry?.eligible === true;
  const surplus = isFiniteNumber(params.availableSurplusKw)
    ? params.availableSurplusKw
    : Number.NEGATIVE_INFINITY;

  const working: SurplusEligibilityState = entry ?? {};
  trackHardOffClock({ working, currentEligible, hardOff: params.hardOff, nowTs });
  const engagedSinceMs = entry?.sinceMs;
  const releaseCause = advanceFlip({
    working,
    entry,
    flipCondition: flipConditionMet(currentEligible, surplus, expectedDrawKw),
    currentEligible,
    nowTs,
  });
  emitReleaseLog({ deviceId, releaseCause, engagedSinceMs, nowTs });

  if (isDroppableIdleEntry(working, nowTs)) {
    // Idle (settled-off, nothing pending, no live hard-off dwell floor): drop
    // the entry so idle devices hold no state.
    delete map[deviceId];
    return { eligible: false };
  }
  map[deviceId] = working;
  return { eligible: working.eligible === true };
}

/**
 * Prune a device's surplus-absorb state. Called from the lockstep per-device
 * cleanup when a device leaves the plan snapshot, alongside the sibling maps,
 * and from the delta-application path when a device is no longer willing.
 */
export function clearSurplusEligibility(state: PlanEngineState, deviceId: string): void {
  const map = state.surplusEligibilityByDevice;
  delete map[deviceId];
}
