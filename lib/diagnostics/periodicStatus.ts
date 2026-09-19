import type CapacityGuard from '../power/capacityGuard';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import { computeShortfallThreshold } from '../plan/planBudget';
import type { PowerTrackerState } from '../power/tracker';
import { getCurrentHourContext } from '../plan/planHourContext';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

type CapacityGuardView = Pick<
  CapacityGuard,
  'isInShortfall'
>;

type CapacityStatusMetrics = {
  total: number | null;
  capacityPace: number;
  capacityPaceHeadroom: number | null;
  shortfallBudgetThreshold: number;
  shortfallBudgetHeadroom: number | null;
  hardCapHeadroom: number | null;
};

export type PeriodicStatusLogFields = {
  event: 'periodic_status';
  homeId: HomeId;
  powerKw: number | null;
  capacityPaceKw: number;
  /**
   * Headroom against `capacityPaceKw`, raw. Deliberately NOT
   * `capacityHeadroomKw`: `MeasuredPower` already owns that name for the
   * restore-admission axis, and one name for both would be the `softLimit`
   * overload this record just renamed its way out of.
   */
  capacityPaceHeadroomKw: number | null;
  shortfallBudgetThresholdKw: number;
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
  capacitySettings: CapacitySettings;
  operatingMode: string;
  capacityDryRun: boolean;
  starvedDeviceCount?: number;
  /**
   * The dynamic hourly threshold, resolved by the caller and logged under its
   * canonical name (`notes/safe-pace-two-constraints.md` § "Canonical names").
   */
  capacityPaceKw: number;
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

  const inShortfall = capacityGuard.isInShortfall();
  // These published field names are an existing hourly diagnostics contract,
  // independent of the period selected for capacity control.
  const usage = getCurrentHourContext(powerTracker, nowMs);
  const hourRemainingKWh = Math.max(0, hourCapKWh - usage.usedKWh);
  return {
    event: 'periodic_status',
    homeId: MAIN_HOME_ID,
    powerKw: metrics.total,
    capacityPaceKw: metrics.capacityPace,
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
  capacitySettings: CapacitySettings,
  powerTracker: PowerTrackerState,
  capacityPaceKw: number,
  nowMs: number,
): CapacityStatusMetrics {
  const total = resolveLastTotalPowerKw(powerTracker);
  const capacityPaceHeadroom = total !== null ? capacityPaceKw - total : null;
  const shortfallBudgetThreshold = computeShortfallThreshold(capacitySettings, powerTracker, nowMs);
  const shortfallBudgetHeadroom = total !== null ? shortfallBudgetThreshold - total : null;
  const hardCapHeadroom = total !== null ? capacitySettings.limitKw - total : null;
  return {
    total,
    capacityPace: capacityPaceKw,
    capacityPaceHeadroom,
    shortfallBudgetThreshold,
    shortfallBudgetHeadroom,
    hardCapHeadroom,
  };
}
