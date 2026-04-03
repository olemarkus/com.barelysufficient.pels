import { resolveCapacitySoftLimitKw, resolveUsableCapacityKw } from './capacityModel';
import type { PowerTrackerState } from './powerTracker';
import { getHourBucketKey } from '../utils/dateUtils';

type CapacityGuardView = {
  getLastTotalPower(): number | null;
  getSoftLimit(): number;
  getHeadroom(): number | null;
  isSheddingActive(): boolean;
  isInShortfall(): boolean;
};

export function buildPeriodicStatusLog(params: {
  capacityGuard?: CapacityGuardView;
  powerTracker: PowerTrackerState;
  capacitySettings: { limitKw: number; marginKw: number };
  operatingMode: string;
  capacityDryRun: boolean;
}): string {
  const { capacityGuard, powerTracker, capacitySettings, operatingMode, capacityDryRun } = params;
  const total = capacityGuard?.getLastTotalPower() ?? null;
  const softLimit = capacityGuard?.getSoftLimit() ?? resolveCapacitySoftLimitKw(capacitySettings);
  const hourCapKWh = resolveUsableCapacityKw(capacitySettings);
  const headroom = capacityGuard?.getHeadroom() ?? null;
  const sheddingActive = capacityGuard?.isSheddingActive() ?? false;
  const inShortfall = capacityGuard?.isInShortfall() ?? false;
  const usage = getCurrentHourUsage(powerTracker);
  const hourRemainingKWh = Math.max(0, hourCapKWh - usage.usedKWh);
  const parts = [
    formatPowerPart(total),
    `softLimit=${softLimit.toFixed(2)}kW`,
    formatHeadroomPart(headroom),
    `used=${usage.usedKWh.toFixed(2)}kWh`,
    `hourRemaining=${hourRemainingKWh.toFixed(1)}kWh`,
    sheddingActive ? 'SHEDDING' : null,
    inShortfall ? 'SHORTFALL' : null,
    `mode=${operatingMode}`,
    capacityDryRun ? 'dry-run' : null,
  ].filter((part): part is string => Boolean(part));

  return `Status: ${parts.join(', ')}`;
}

function formatPowerPart(total: number | null): string | null {
  if (total === null) return null;
  return `power=${total.toFixed(2)}kW`;
}

function formatHeadroomPart(headroom: number | null): string | null {
  if (headroom === null) return null;
  return `headroom=${headroom.toFixed(2)}kW`;
}

function getCurrentHourUsage(powerTracker: PowerTrackerState): { usedKWh: number } {
  const bucketKey = getHourBucketKey();
  const usedKWh = powerTracker.buckets?.[bucketKey] || 0;
  return { usedKWh };
}
