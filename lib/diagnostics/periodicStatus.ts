import type CapacityGuard from '../power/capacityGuard';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import { computeShortfallThreshold } from '../plan/planBudget';
import type { PowerTrackerState } from '../power/tracker';
import { getHourBucketKey } from '../utils/dateUtils';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

type CapacityGuardView = Pick<
  CapacityGuard,
  'isInShortfall'
>;

type CapacityStatusMetrics = {
  total: number | null;
  softLimit: number;
  headroom: number | null;
  shortfallBudgetThreshold: number;
  shortfallBudgetHeadroom: number | null;
  hardCapHeadroom: number | null;
};

export type PeriodicStatusLogFields = {
  event: 'periodic_status';
  homeId: HomeId;
  powerKw: number | null;
  softLimitKw: number;
  softHeadroomKw: number | null;
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
  capacitySettings: { limitKw: number; marginKw: number };
  operatingMode: string;
  capacityDryRun: boolean;
  starvedDeviceCount?: number;
  /**
   * `capacityPaceKw` — the dynamic hourly threshold, resolved by the caller.
   * Logged as `softLimitKw` (`notes/safe-pace-two-constraints.md`).
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
  const metrics = resolveCapacityStatusMetrics({ capacitySettings, powerTracker, capacityPaceKw });
  const hourCapKWh = resolveUsableCapacityKw(capacitySettings);

  const inShortfall = capacityGuard.isInShortfall();
  const usage = getCurrentHourUsage(powerTracker);
  const hourRemainingKWh = Math.max(0, hourCapKWh - usage.usedKWh);
  return {
    event: 'periodic_status',
    homeId: MAIN_HOME_ID,
    powerKw: metrics.total,
    softLimitKw: metrics.softLimit,
    softHeadroomKw: metrics.headroom,
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

function resolveCapacityStatusMetrics(params: {
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
  capacityPaceKw: number;
}): CapacityStatusMetrics {
  const { capacitySettings, powerTracker, capacityPaceKw } = params;
  const total = resolveLastTotalPowerKw(powerTracker);
  const softLimit = capacityPaceKw;
  // Derive headroom from the already-fetched softLimit to avoid a second provider call.
  // CapacityGuard.getHeadroom() is just getSoftLimit() - mainPowerKw, so this is equivalent.
  const headroom = total !== null ? softLimit - total : null;
  const shortfallBudgetThreshold = computeShortfallThreshold({ capacitySettings, powerTracker });
  const shortfallBudgetHeadroom = total !== null ? shortfallBudgetThreshold - total : null;
  const hardCapHeadroom = total !== null ? capacitySettings.limitKw - total : null;
  return {
    total,
    softLimit,
    headroom,
    shortfallBudgetThreshold,
    shortfallBudgetHeadroom,
    hardCapHeadroom,
  };
}

function getCurrentHourUsage(powerTracker: PowerTrackerState): { usedKWh: number } {
  const bucketKey = getHourBucketKey();
  // Floor at 0: a persisted solar-export hour can hold a negative kWh; billed usage can't be negative.
  const usedKWh = Math.max(0, powerTracker.buckets?.[bucketKey] || 0);
  return { usedKWh };
}
