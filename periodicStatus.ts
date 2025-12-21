import type CapacityGuard from './capacityGuard';
import type { PowerTrackerState } from './powerTracker';

export function buildPeriodicStatusLog(params: {
  capacityGuard?: CapacityGuard;
  powerTracker: PowerTrackerState;
  capacitySettings: { limitKw: number };
  operatingMode: string;
  capacityDryRun: boolean;
}): string {
  const { capacityGuard, powerTracker, capacitySettings, operatingMode, capacityDryRun } = params;
  const total = capacityGuard?.getLastTotalPower() ?? null;
  const softLimit = capacityGuard?.getSoftLimit() ?? capacitySettings.limitKw;
  const headroom = capacityGuard?.getHeadroom() ?? null;
  const sheddingActive = capacityGuard?.isSheddingActive() ?? false;
  const inShortfall = capacityGuard?.isInShortfall() ?? false;
  const usage = getCurrentHourUsage(powerTracker);
  const parts = [
    formatPowerPart(total),
    `limit=${softLimit.toFixed(2)}kW`,
    formatHeadroomPart(headroom),
    `used=${usage.usedKWh.toFixed(2)}/${capacitySettings.limitKw.toFixed(1)}kWh`,
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
  const now = Date.now();
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  const hourStart = date.getTime();
  const bucketKey = new Date(hourStart).toISOString();
  const usedKWh = powerTracker.buckets?.[bucketKey] || 0;
  return { usedKWh };
}
