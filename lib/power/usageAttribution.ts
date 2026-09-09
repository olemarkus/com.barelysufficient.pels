/**
 * Power-owned attribution of resolved device draw. Callers pass their existing
 * device snapshots with `currentDrawKw` resolved at the producer boundary;
 * attribution reads no plan state, observer state, or raw meter input.
 * Measured exemption is `measuredExemptKw` in `notes/safe-pace-two-constraints.md`.
 */
export type UsageDevice = {
  /**
   * Does this device's draw belong to the MANAGED side of the split?
   *
   * REQUIRED. Was `controllable?: boolean` tested `=== false`, so a device that
   * never carried the flag had its whole draw booked as managed — an
   * overstatement of what shedding can free, in the sum every capacity decision
   * rests on. Production always populated it, so the defect was latent.
   *
   * Named for the question rather than for the plan's `commandAuthority`,
   * because the three seams that answer it do not compute the same predicate: a
   * plan device answers with its resolved authority (`toUsageDevice`), while the
   * two raw-snapshot seams answer `controllable !== false` off the parse stamp,
   * which carries neither the temperature-axis term nor a smart task's grant.
   * That fork predates the posture split — both sides spelled it `controllable`
   * — and calling this member `commandAuthority` would assert an agreement that
   * does not exist.
   *
   * Flat rather than the posture object, so `sampleIngest` need not fabricate a
   * `managed`/`commandAuthority` it genuinely does not hold.
   */
  countsAsManagedUsage: boolean;
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
 * No longer `number | null`. The null meant "a commandable device has no usable
 * reading, so the managed total cannot be attributed" — a state that no longer
 * exists, because the producer always has an answer for every planned device.
 */
export const sumControlledUsageKw = (devices: readonly UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (!dev.countsAsManagedUsage) continue;
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
    if (dev.budgetExempt !== true || !dev.countsAsManagedUsage) continue;
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
