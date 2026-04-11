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
  hardCapHeadroom: number | null;
};

export type PeriodicStatusLogFields = {
  event: 'periodic_status';
  powerKw: number | null;
  softLimitKw: number;
  softHeadroomKw: number | null;
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
    hardCapHeadroomKw: metrics.hardCapHeadroom,
    usedKWh: usage.usedKWh,
    hourRemainingKWh,
    sheddingActive,
    capacityShortfall: inShortfall,
    mode: operatingMode,
    dryRun: capacityDryRun,
  };
}

export function buildPeriodicStatusLog(params: {
  capacityGuard?: CapacityGuardView;
  powerTracker: PowerTrackerState;
  capacitySettings: { limitKw: number; marginKw: number };
  operatingMode: string;
  capacityDryRun: boolean;
}): string {
  const fields = buildPeriodicStatusLogFields(params);
  const parts = [
    formatPowerPart(fields.powerKw),
    `softLimit=${fields.softLimitKw.toFixed(2)}kW`,
    formatHeadroomPart(fields.softHeadroomKw),
    formatHardCapPart(fields.hardCapHeadroomKw),
    `used=${fields.usedKWh.toFixed(2)}kWh`,
    `hourRemaining=${fields.hourRemainingKWh.toFixed(1)}kWh`,
    fields.sheddingActive ? 'SHEDDING' : null,
    fields.capacityShortfall ? 'SHORTFALL' : null,
    `mode=${fields.mode}`,
    fields.dryRun ? 'dry-run' : null,
  ].filter((part): part is string => Boolean(part));

  return `Status: ${parts.join(', ')}`;
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
  const hardCapThreshold = capacityGuard?.getShortfallThreshold() ?? capacitySettings.limitKw;
  const hardCapHeadroom = total !== null ? hardCapThreshold - total : null;
  return { total, softLimit, headroom, hardCapHeadroom };
}

function formatPowerPart(total: number | null): string | null {
  if (total === null) return null;
  return `power=${total.toFixed(2)}kW`;
}

function formatHeadroomPart(headroom: number | null): string | null {
  if (headroom === null) return null;
  return `headroom=${headroom.toFixed(2)}kW`;
}

function formatHardCapPart(hardCapHeadroom: number | null): string | null {
  if (hardCapHeadroom === null) return null;
  if (hardCapHeadroom < 0) return `hardCapBreachedBy=${Math.abs(hardCapHeadroom).toFixed(2)}kW`;
  return `hardCapHeadroom=${hardCapHeadroom.toFixed(2)}kW`;
}

function getCurrentHourUsage(powerTracker: PowerTrackerState): { usedKWh: number } {
  const bucketKey = getHourBucketKey();
  const usedKWh = powerTracker.buckets?.[bucketKey] || 0;
  return { usedKWh };
}
