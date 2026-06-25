import type { PlanEngineState, SurplusEligibilityState } from '../planState';
import { RESTORE_ADMISSION_RESERVE_KW } from '../planConstants';

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
 */

// Engage when the allocated surplus covers expected draw plus this reserve;
// release at the bare expected draw. The reserve band is the hysteresis. Reuses
// the restore reserve.
export const SURPLUS_ABSORB_RESERVE_KW = RESTORE_ADMISSION_RESERVE_KW;
// A flip condition must persist this long before eligibility toggles (settle).
export const SURPLUS_ABSORB_SETTLE_MS = 90 * 1000;
// Minimum time an eligibility state holds after a flip (limit-cycle / chatter guard).
export const SURPLUS_ABSORB_MIN_DWELL_MS = 5 * 60 * 1000;

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

// Advance the settle window, toggling `working.eligible` once the flip condition
// has persisted past the settle window AND the current state has held the min
// dwell. Mutates `working` in place.
const advanceFlip = (params: {
  working: SurplusEligibilityState;
  entry: SurplusEligibilityState | undefined;
  flipCondition: boolean;
  currentEligible: boolean;
  nowTs: number;
}): void => {
  const { working, entry, flipCondition, currentEligible, nowTs } = params;
  if (!flipCondition) {
    delete working.pendingSinceMs;
    return;
  }
  if (working.pendingSinceMs === undefined) {
    working.pendingSinceMs = nowTs;
  }
  const settled = nowTs - (working.pendingSinceMs ?? nowTs) >= SURPLUS_ABSORB_SETTLE_MS;
  if (settled && dwellSatisfied(entry, nowTs)) {
    working.eligible = !currentEligible;
    working.sinceMs = nowTs;
    delete working.pendingSinceMs;
  }
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
  advanceFlip({
    working,
    entry,
    flipCondition: flipConditionMet(currentEligible, surplus, expectedDrawKw),
    currentEligible,
    nowTs,
  });

  if (working.eligible !== true && working.pendingSinceMs === undefined) {
    // Settled-off with nothing pending: drop the entry so idle devices hold no state.
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
