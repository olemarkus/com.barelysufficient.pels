/**
 * Power-owned attribution of resolved device draw. Callers pass their existing
 * device snapshots with `currentDrawKw` resolved at the producer boundary;
 * attribution reads no plan state, observer state, or raw meter input.
 * Measured exemption is `measuredExemptKw` in `notes/safe-pace-two-constraints.md`.
 */
export type UsageDevice = {
  controllable?: boolean;
  budgetExempt?: boolean;
  currentDrawKw: number;
};

/**
 * Managed usage: the sum of what the managed devices are drawing.
 *
 * The per-device rule is now just the producer's `currentDrawKw`. Three
 * plan-state-dependent ladders used to live here (shed / observed-off /
 * observed-on), each deciding for itself what an absent reading meant. The
 * observed-off arm answered with `getHighestKnownPowerKw`, i.e. RATED power, so
 * a device measuring a true 0 W was credited its nameplate — and this sum is
 * what `sampleIngest` persists into `controlledBuckets`. `0` is an answer, not a
 * gap: a device drawing nothing contributes nothing.
 *
 * No longer `number | null`. The null meant "a controllable device has no usable
 * reading, so the managed total cannot be attributed" — a state that no longer
 * exists, because the producer always has an answer for every planned device.
 */
export const sumControlledUsageKw = (devices: readonly UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.controllable === false) continue;
    totalKw += dev.currentDrawKw;
  }
  return totalKw;
};

// Measured exemption is the budget-axis input for restore admission
// (`notes/safe-pace-two-constraints.md` § "It needs to land twice"). An off
// exempt device contributes no reservation on this axis: only its resolved
// current draw counts. The projected sibling remains in `lib/plan/planUsage.ts`.
export const sumBudgetExemptMeasuredUsageKw = (devices: readonly UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.budgetExempt !== true || dev.controllable === false) continue;
    totalKw += dev.currentDrawKw;
  }
  return totalKw;
};

export function splitControlledUsageKw(params: {
  devices: readonly UsageDevice[];
  totalKw: number;
}): { controlledKw: number; uncontrolledKw: number } {
  const { devices, totalKw } = params;
  const controlledKw = sumControlledUsageKw(devices);
  const boundedControlledKw = Math.max(0, Math.min(totalKw, controlledKw));
  return {
    controlledKw: boundedControlledKw,
    uncontrolledKw: Math.max(0, totalKw - boundedControlledKw),
  };
}
