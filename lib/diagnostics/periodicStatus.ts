import type CapacityGuard from '../power/capacityGuard';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import { resolveShortfallThresholdKw } from '../plan/planBudget';
import type { PowerTrackerState } from '../power/tracker';
import { getCurrentHourContext } from '../plan/planHourContext';
import { resolveGridImportTargetKw } from '../plan/powerLimitMath';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

type CapacityGuardView = Pick<
  CapacityGuard,
  'isInShortfall'
>;

type CapacityStatusMetrics = {
  total: number | null;
  capacityPace: number | null;
  capacityPaceHeadroom: number | null;
  shortfallBudgetThreshold: number | null;
  shortfallBudgetHeadroom: number | null;
  hardCapHeadroom: number | null;
};

export type PeriodicStatusLogFields = {
  event: 'periodic_status';
  homeId: HomeId;
  powerKw: number | null;
  capacityPaceKw: number | null;
  gridImportLimitKw: number | null;
  gridImportHeadroomKw: number | null;
  /**
   * Headroom against `capacityPaceKw`, raw. Deliberately NOT
   * `capacityHeadroomKw`: `MeasuredPower` already owns that name for the
   * restore-admission axis, and one name for both would be the `softLimit`
   * overload this record just renamed its way out of.
   */
  capacityPaceHeadroomKw: number | null;
  shortfallBudgetThresholdKw: number | null;
  shortfallBudgetHeadroomKw: number | null;
  hardCapHeadroomKw: number | null;
  usedKWh: number;
  hourRemainingKWh: number;
  sheddingActive: boolean;
  capacityShortfall: boolean;
  starvedDeviceCount: number;
  mode: string;
  dryRun: boolean;
};

/**
 * Builds the whole-app periodic status record. The producer is the Main-home
 * app loop; sub-home bundles publish their own scoped plan/capacity records
 * instead. Keeping `MAIN_HOME_ID` here makes that ownership explicit.
 */
export function buildPeriodicStatusLogFields(params: {
  capacityGuard: CapacityGuardView;
  powerTracker: PowerTrackerState;
  capacitySettings: PowerLimitSettings;
  operatingMode: string;
  capacityDryRun: boolean;
  starvedDeviceCount?: number;
  /**
   * The dynamic hourly threshold, resolved by the caller and logged under its
   * canonical name (`notes/safe-pace-two-constraints.md` § "Canonical names").
   */
  capacityPaceKw: number | null;
  /** The shedding latch, read off `PlanEngineState` by the caller. */
  sheddingActive: boolean;
}): PeriodicStatusLogFields {
  const {
    capacityGuard,
    powerTracker,
    capacitySettings,
    operatingMode,
    capacityDryRun,
    starvedDeviceCount = 0,
    capacityPaceKw,
    sheddingActive,
  } = params;
  const nowMs = Date.now();
  const metrics = resolveCapacityStatusMetrics(capacitySettings, powerTracker, capacityPaceKw, nowMs);
  const hourCapKWh = resolveUsableCapacityKw(capacitySettings);

  // An incident counts only while the threshold it is judged against exists
  // (`resolveShortfallThresholdKw`: none with Capacity limit off). The guard
  // still holds a latched incident between a settings write that turns
  // Capacity limit off and the build that clears it, and this log runs outside
  // any build.
  const inShortfall = metrics.shortfallBudgetThreshold !== null && capacityGuard.isInShortfall();
  // These published field names are an existing hourly diagnostics contract,
  // independent of the period selected for capacity control.
  const usage = getCurrentHourContext(powerTracker, nowMs);
  const hourRemainingKWh = Math.max(0, hourCapKWh - usage.usedKWh);
  const gridTargetKw = resolveGridImportTargetKw(capacitySettings.gridImportLimitKw);
  return {
    event: 'periodic_status',
    homeId: MAIN_HOME_ID,
    powerKw: metrics.total,
    capacityPaceKw: metrics.capacityPace,
    gridImportLimitKw: capacitySettings.gridImportLimitKw,
    gridImportHeadroomKw: gridTargetKw !== null && metrics.total !== null ? gridTargetKw - metrics.total : null,
    capacityPaceHeadroomKw: metrics.capacityPaceHeadroom,
    shortfallBudgetThresholdKw: metrics.shortfallBudgetThreshold,
    shortfallBudgetHeadroomKw: metrics.shortfallBudgetHeadroom,
    hardCapHeadroomKw: metrics.hardCapHeadroom,
    usedKWh: usage.usedKWh,
    hourRemainingKWh,
    sheddingActive,
    capacityShortfall: inShortfall,
    starvedDeviceCount,
    mode: operatingMode,
    dryRun: capacityDryRun,
  };
}

function resolveCapacityStatusMetrics(
  capacitySettings: PowerLimitSettings,
  powerTracker: PowerTrackerState,
  capacityPaceKw: number | null,
  nowMs: number,
): CapacityStatusMetrics {
  const total = resolveLastTotalPowerKw(powerTracker);
  const capacityPaceHeadroom = total !== null && capacityPaceKw !== null ? capacityPaceKw - total : null;
  const shortfallBudgetThreshold = resolveShortfallThresholdKw(capacitySettings, powerTracker, nowMs);
  const shortfallBudgetHeadroom = total !== null && shortfallBudgetThreshold !== null
    ? shortfallBudgetThreshold - total : null;
  const hardCapHeadroom = total !== null && capacitySettings.capacityEnabled ? capacitySettings.limitKw - total : null;
  return {
    total,
    capacityPace: capacityPaceKw,
    capacityPaceHeadroom,
    shortfallBudgetThreshold,
    shortfallBudgetHeadroom,
    hardCapHeadroom,
  };
}
