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
   * plan device answers with its resolved authority (`control.commandAuthority`), while the
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
  currentDrawKw: number;
};

/**
 * A device's resolved draw and whether that draw is outside the daily budget
 * this cycle: the owner's per-device setting, or a smart task's claim for the
 * hour. The producer answers it completely (managed devices only, never a
 * battery or solar device); nothing below adds a gate of its own.
 */
export type BudgetExemptDraw = {
  budgetExempt: boolean;
  currentDrawKw: number;
};

const countsAsManagedUsage = (device: UsageDevice): boolean => device.countsAsManagedUsage;

type UsageSplit = { controlledKw: number; uncontrolledKw: number };

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
export const sumControlledUsageKw = (devices: readonly UsageDevice[]): number => (
  sumControlledUsageKwFor(devices, countsAsManagedUsage)
);

export const sumControlledUsageKwFor = <T extends { currentDrawKw: number }>(
  devices: readonly T[],
  countsAsManaged: (device: T) => boolean,
): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (!countsAsManaged(dev)) continue;
    totalKw += dev.currentDrawKw;
  }
  return totalKw;
};

/**
 * Measured exemption (`measuredExemptKw`): the resolved draw of every exempt
 * device. It is the restore-admission budget axis and, split below, the exempt
 * kWh the sample path integrates (`notes/safe-pace-two-constraints.md`
 * § "It needs to land twice"). An off exempt device contributes no reservation:
 * only its draw counts. The projected sibling is in `lib/plan/planUsage.ts`.
 *
 * Exemption is its own axis. Whether PELS commands the device, or counts its
 * draw as managed usage, does not decide whether its energy is outside the
 * budget: a smart task on a charger with Power-limit control off is background
 * usage AND exempt (prod 2026-11-02, where gating on the managed side left the
 * task's energy counted as spent budget and held the higher-priority
 * thermostats off).
 */
export const sumBudgetExemptMeasuredUsageKw = (devices: readonly BudgetExemptDraw[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.budgetExempt) totalKw += dev.currentDrawKw;
  }
  return totalKw;
};

/**
 * The measured exemption split by the managed / background attribution it is a
 * subset of, so each share is booked beside its side
 * (`exemptBuckets` within `controlledBuckets`, `uncontrolledExemptBuckets`
 * within `uncontrolledBuckets`). The daily budget's breakdown and learning move
 * only the managed share to the background side; the background share is
 * already there. Pacing reads both (`resolveBudgetExemptKWh`).
 */
export const splitBudgetExemptMeasuredUsageKw = (
  devices: readonly (UsageDevice & BudgetExemptDraw)[],
): UsageSplit => {
  let controlledKw = 0;
  let uncontrolledKw = 0;
  for (const dev of devices) {
    if (!dev.budgetExempt) continue;
    if (countsAsManagedUsage(dev)) controlledKw += dev.currentDrawKw;
    else uncontrolledKw += dev.currentDrawKw;
  }
  return { controlledKw, uncontrolledKw };
};

const splitUsageKw = (totalKw: number, controlledKw: number): UsageSplit => {
  const boundedControlledKw = Math.max(0, Math.min(totalKw, controlledKw));
  return {
    controlledKw: boundedControlledKw,
    uncontrolledKw: Math.max(0, totalKw - boundedControlledKw),
  };
};

export const splitControlledUsageKw = (params: {
  devices: readonly UsageDevice[];
  totalKw: number;
}): UsageSplit => splitUsageKw(params.totalKw, sumControlledUsageKw(params.devices));

export const splitControlledUsageKwFor = <T extends { currentDrawKw: number }>(
  params: { devices: readonly T[]; totalKw: number },
  countsAsManaged: (device: T) => boolean,
): UsageSplit => splitUsageKw(params.totalKw, sumControlledUsageKwFor(params.devices, countsAsManaged));
