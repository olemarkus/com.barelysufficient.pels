/**
 * Banked-energy admission for minimum-run-time devices (PR 1b).
 *
 * The legacy restore-admission gate (`buildRestoreAdmissionMetrics`) requires a
 * device's full instantaneous draw to fit under the dynamic burst-rate soft
 * limit, which implicitly reserves that draw for the whole rest of the hour —
 * far too conservative for a large interruptible load (e.g. a 2.5 kW heater on a
 * 5 kWh/h budget). For a device that declares a `minRunMinutes`, we ALSO admit
 * it when there is enough *banked* hourly budget to run it for `minRunMinutes`,
 * as long as turning it on now will not project a breach of the physical hard
 * cap (that physical-rail check lives at the admission site as the safety floor;
 * see `lib/plan/restore/index.ts`).
 *
 * This is a pure helper — it never reads the clock or any global state. All
 * inputs are producer-resolved flat values supplied by the caller.
 */
export function canAdmitForMinRun(params: {
  /** kWh already consumed this hour (from `getCurrentHourContext`). */
  usedThisHourKWh: number;
  /** The device's expected restore draw in kW (`estimateRestorePower`). */
  drawKw: number;
  /** Per-device minimum run time in minutes (producer-resolved flat field). */
  minRunMinutes: number;
  /**
   * The SOFT hourly budget in kWh = `resolveUsableCapacityKw(capacitySettings)`
   * = `limitKw - marginKw`.
   */
  budgetKWh: number;
}): boolean {
  const { usedThisHourKWh, drawKw, minRunMinutes, budgetKWh } = params;

  // Guard: a non-positive / non-finite minimum run time means the caller must
  // not use the banked path — `0`/`undefined` is the legacy sentinel and any
  // other invalid value cannot describe a banked energy reservation.
  if (!Number.isFinite(minRunMinutes) || minRunMinutes <= 0) return false;
  if (!Number.isFinite(drawKw) || !Number.isFinite(usedThisHourKWh) || !Number.isFinite(budgetKWh)) return false;

  const minRunEnergyKWh = drawKw * (minRunMinutes / 60);
  return usedThisHourKWh + minRunEnergyKWh <= budgetKWh;
}
