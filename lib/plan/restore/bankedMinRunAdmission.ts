import type { DevicePlanDevice } from '../planTypes';
import type { PlanContext } from '../planContext';
import { RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import { canAdmitForMinRun } from '../planMinRunAdmission';
import type { buildRestoreAdmissionMetrics } from '../admission';
import type { getRestoreNeed } from './support';

export type BinaryAdmissionPath = 'instantaneous' | 'banked_min_run';

/**
 * Producer-resolved inputs for the banked-energy min-run admission path (PR 1b).
 * All flat values lifted off `PlanContext` in `applyRestorePlan` so the deep
 * restore gating never re-reads the clock, power, or capacity settings.
 */
export type BankedAdmissionContext = {
  /**
   * Whether this cycle has a fresh, trusted whole-home sample. The banked path
   * may relax admission only when this is true — a stale (but non-null) total
   * understates `usedThisHourKWh` (no samples accrued into the bucket) and
   * freezes `currentTotalPowerKw` at an old reading, both of which make the
   * gates unsafely permissive. Mirrors the freshness gate the restore batch
   * already applies (`buildRestoreBatchState`).
   */
  powerKnown: boolean;
  /** kWh consumed so far this hour. */
  usedThisHourKWh: number;
  /** Soft hourly budget in kWh (`limitKw - marginKw`). */
  budgetKWh: number;
  /** Current total power draw in kW (`context.total`), or null when unknown. */
  currentTotalPowerKw: number | null;
  /** Physical hard-cap burst rate in kW (`(limitKw - used) / remainingHours`). */
  hardCapBurstRateKw: number;
};

export function buildBankedAdmissionContext(context: PlanContext): BankedAdmissionContext {
  return {
    powerKnown: context.powerKnown,
    usedThisHourKWh: context.usedKWh,
    budgetKWh: context.budgetKWh,
    currentTotalPowerKw: context.total,
    hardCapBurstRateKw: context.hardCapBurstRateKw,
  };
}

/**
 * Resolves which admission path (if any) admits this binary restore. The legacy
 * instantaneous soft-rail gate wins first; otherwise — for a min-run device —
 * the banked-energy path (PR 1b) admits against banked hourly budget, gated by
 * the physical hard cap. Returns null when neither path admits.
 */
export function resolveBinaryAdmissionPath(params: {
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>;
  dev: DevicePlanDevice;
  restoreNeed: ReturnType<typeof getRestoreNeed>;
  bankedAdmission: BankedAdmissionContext;
  /**
   * True when nothing has been restored yet this cycle. The banked path admits
   * ONLY as the first restore of the cycle, so it always evaluates against a
   * clean `usedThisHourKWh` / `currentTotalPowerKw` snapshot — which is NOT
   * decremented mid-cycle. This makes "at most one banked admit per cycle,
   * against an un-stale total" an explicit invariant rather than an emergent
   * property of the batch gate: the physical hard-cap projection can never be
   * computed against a total that already omits an in-cycle banked admission.
   * Multiple min-run devices therefore start staggered across cycles (which also
   * avoids a simultaneous surge). The legacy instantaneous path is unaffected.
   */
  firstRestoreOfCycle: boolean;
}): BinaryAdmissionPath | null {
  const { admission, dev, restoreNeed, bankedAdmission, firstRestoreOfCycle } = params;
  if (admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) return 'instantaneous';
  if (firstRestoreOfCycle && resolveBankedMinRunAdmission({ dev, restoreNeed, bankedAdmission })) {
    return 'banked_min_run';
  }
  return null;
}

/**
 * Banked-energy min-run admission (PR 1b). Returns true iff the device declares
 * a positive `minRunMinutes`, there is enough banked hourly budget to run it for
 * that long (`canAdmitForMinRun`), AND turning it on now stays under the
 * physical hard-cap burst rate (`instantaneousHardCapSafe`). The hard-cap gate
 * is the safety floor: it never lets the banked path overshoot the physical cap.
 * A null current-total power (whole-home reading unknown) is treated as NOT
 * safe — we never relax admission without a trusted instantaneous draw.
 */
function resolveBankedMinRunAdmission(params: {
  dev: DevicePlanDevice;
  restoreNeed: ReturnType<typeof getRestoreNeed>;
  bankedAdmission: BankedAdmissionContext;
}): boolean {
  const { dev, restoreNeed, bankedAdmission } = params;
  // Never relax admission on untrusted power. A stale (but non-null) total
  // freezes `currentTotalPowerKw` and understates `usedThisHourKWh`, making both
  // gates unsafely permissive — fail closed exactly as the legacy gate does.
  if (!bankedAdmission.powerKnown) return false;

  const minRunMinutes = dev.minRunMinutes ?? 0;
  if (minRunMinutes <= 0) return false;

  // The PHYSICAL gate (and the banked-energy reservation) uses the device's raw
  // expected draw (`devPower`), NOT the penalized `needed` that the cycle's
  // headroom/batch accounting decrements. The activation penalty / recent-shed
  // buffer is a planning safety margin, not real extra watts, so the actual
  // burst when the device turns on is ~`devPower`. Do not "fix" this to `needed`
  // — that would silently tighten the physical-cap projection.
  const drawKw = restoreNeed.devPower;
  const canAdmit = canAdmitForMinRun({
    usedThisHourKWh: bankedAdmission.usedThisHourKWh,
    drawKw,
    minRunMinutes,
    budgetKWh: bankedAdmission.budgetKWh,
  });
  if (!canAdmit) return false;

  const { currentTotalPowerKw, hardCapBurstRateKw } = bankedAdmission;
  if (currentTotalPowerKw === null || !Number.isFinite(currentTotalPowerKw)) return false;
  const instantaneousHardCapSafe = currentTotalPowerKw + drawKw <= hardCapBurstRateKw;
  return instantaneousHardCapSafe;
}
