import type CapacityGuard from './capacityGuard';
import { resolveCapacitySoftLimitKw, resolveUsableCapacityKw } from './capacityModel';
import type { PowerTrackerState } from './powerTracker';
import { getHourBucketKey } from '../utils/dateUtils';

type CapacityGuardView = Pick<
  CapacityGuard,
  'getLastTotalPower' | 'getSoftLimit' | 'getShortfallThreshold' | 'isSheddingActive' | 'isInShortfall'
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
  mode: string;
  dryRun: boolean;
};

export function buildPeriodicStatusLogFields(params: {
  capacityGuard?: CapacityGuardView;
  powerTracker: PowerTrackerState;
  capacitySettings: { limitKw: number; marginKw: number };
  operatingMode: string;
  capacityDryRun: boolean;
}): PeriodicStatusLogFields {
  const { capacityGuard, powerTracker, capacitySettings, operatingMode, capacityDryRun } = params;
  const metrics = resolveCapacityStatusMetrics({ capacityGuard, capacitySettings });
  const hourCapKWh = resolveUsableCapacityKw(capacitySettings);
  const sheddingActive = capacityGuard?.isSheddingActive() ?? false;
  const inShortfall = capacityGuard?.isInShortfall() ?? false;
  const usage = getCurrentHourUsage(powerTracker);
  const hourRemainingKWh = Math.max(0, hourCapKWh - usage.usedKWh);
  return {
    event: 'periodic_status',
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
    mode: operatingMode,
    dryRun: capacityDryRun,
  };
}

function resolveCapacityStatusMetrics(params: {
  capacityGuard?: CapacityGuardView;
  capacitySettings: { limitKw: number; marginKw: number };
}): CapacityStatusMetrics {
  const { capacityGuard, capacitySettings } = params;
  const total = capacityGuard?.getLastTotalPower() ?? null;
  const softLimit = capacityGuard?.getSoftLimit() ?? resolveCapacitySoftLimitKw(capacitySettings);
  // Derive headroom from the already-fetched softLimit to avoid a second provider call.
  // CapacityGuard.getHeadroom() is just getSoftLimit() - mainPowerKw, so this is equivalent.
  const headroom = total !== null ? softLimit - total : null;
  const shortfallBudgetThreshold = capacityGuard?.getShortfallThreshold() ?? capacitySettings.limitKw;
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
  const usedKWh = powerTracker.buckets?.[bucketKey] || 0;
  return { usedKWh };
}
