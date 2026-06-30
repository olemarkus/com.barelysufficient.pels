/**
 * Observer-owned power resolution. Producing layer responsibility per the
 * "resolution belongs in producer" rule: plan and executor consume two flat
 * plan-state-blind values — current draw (for shed accounting) and restore
 * draw (for restore admission) — instead of branching on which raw source
 * carried the value.
 */
import type {
  BinaryControlCapabilityId,
  DeviceControlModel,
  RestorePowerSource,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import { isFiniteNumber } from '../utils/appTypeGuards';

// Re-export the canonical type so existing observer importers keep working.
export type { RestorePowerSource } from '../../packages/contracts/src/types';

type KnownPowerSource = Exclude<RestorePowerSource, 'fallback' | 'stepped'>;

export type ObservedPowerInput = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
  controlCapabilityId?: BinaryControlCapabilityId;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
};

export type ObservedStateInput = {
  // The producer-resolved on/off truth (binary axis AND stepped-off fold). Plan
  // callers pass plan devices' `currentOn`; the residual producer resolves it
  // from the snapshot. The raw `binaryControl` is no longer read here.
  currentOn?: boolean;
};

export type ActivelyDrawingInput = {
  available?: boolean;
  currentOn?: boolean;
  measuredPowerKw?: number;
};

export const EV_MIN_START_FALLBACK_KW = 1.38;
export const DEFAULT_FALLBACK_KW = 1;
export const MIN_ACTIVE_MEASURED_POWER_KW = 0.05;

/**
 * Highest known non-zero of measured / expected / planning / configured, or
 * null when no source carries a positive value. Lower-level building block —
 * `getRestoreDrawKw` is the higher-level "restore reservation" entry point;
 * plan-side helpers that need raw observational max evidence use this directly.
 */
export function getHighestKnownPowerKw(
  device: ObservedPowerInput,
): { kw: number; source: KnownPowerSource } | null {
  const candidates: Array<{ source: KnownPowerSource; value?: number }> = [
    { source: 'measured', value: device.measuredPowerKw },
    { source: 'expected', value: device.expectedPowerKw },
    { source: 'planning', value: device.planningPowerKw },
    { source: 'configured', value: device.powerKw },
  ];
  let best: { kw: number; source: KnownPowerSource } | null = null;
  for (const candidate of candidates) {
    const value = resolveFinitePositiveKw(candidate.value);
    if (value === null) continue;
    if (best === null || value > best.kw) best = { kw: value, source: candidate.source };
  }
  return best;
}

/**
 * Pure measurement — the value of `measure_power` if it is a finite
 * non-negative number, else null. Lower-level building block; most callers
 * want `getCurrentDrawKw` for "best estimate right now" or `getRestoreDrawKw`
 * for "what this device will draw when active".
 */
export function getMeasuredDrawKw(device: ObservedPowerInput): number | null {
  if (isFiniteNumber(device.measuredPowerKw) && device.measuredPowerKw >= 0) {
    return device.measuredPowerKw;
  }
  return null;
}

/**
 * Best estimate of what the device is drawing right now. Plan-state-blind:
 * Observer looks at measurement and observed binary state only.
 *
 *  - measured value if present (including 0).
 *  - 0 when the producer-resolved on/off truth is confirmed-off
 *    (`currentOn === false`) — shedding gives no immediate relief from an
 *    off device. The producer-resolved `currentOn` is trusted directly: it is
 *    the latched on/off value (Homey reports capabilities on change, so a stale
 *    `currentOn: false` is a trusted-off), and the plan/executor has no right to
 *    distrust the observer's resolution. There is no staleness gate here.
 *  - otherwise the device's preferred configured demand (expected, then
 *    planning, then configured), respecting an explicit zero as authoritative,
 *    with EV / default fallback when nothing is configured.
 *
 * Used for shed/swap candidate `effectivePower`. Callers reject the device
 * when this returns 0.
 */
export function getCurrentDrawKw(
  device: ObservedPowerInput & ObservedStateInput,
): number {
  const measured = getMeasuredDrawKw(device);
  if (measured !== null) return measured;
  if (device.currentOn === false) return 0;
  return resolveConfiguredOrFallbackKw(device);
}

/**
 * What the device is assumed to draw when restored / active — the reservation
 * target for restore admission, pending-restore accounting, and the device's
 * `expectedPowerKw` projection on plan snapshots. Plan-state-blind *and*
 * cycle-blind by design: independent of plannedState, currentOn, and current
 * measurement state, so headroom math, overshoot detection, and overview copy
 * see a stable value across thermostat duty cycles. Drawing a stable
 * configured demand is what avoids over-granting restores when a binary-on
 * thermostat is mid-cycle and momentarily reports `measure_power = 0`.
 *
 * Picks the highest known non-zero of measured / expected / planning /
 * configured. Falls back to the EV typical-start (1.38 kW) or generic
 * (1.0 kW) value when no source carries a positive number. Closes TODO §43.
 */
export function getRestoreDrawKw(
  device: ObservedPowerInput,
): { kw: number; source: RestorePowerSource } {
  const highest = getHighestKnownPowerKw(device);
  if (highest !== null) return { kw: highest.kw, source: highest.source };
  if (device.controlCapabilityId === 'evcharger_charging') {
    return { kw: EV_MIN_START_FALLBACK_KW, source: 'fallback' };
  }
  return { kw: DEFAULT_FALLBACK_KW, source: 'fallback' };
}

/**
 * True when the device is observably on or drawing power right now. Used by
 * activation backoff and other lifecycle gates that must not penalize
 * planner-driven sheds or unobserved devices.
 */
export function isActivelyDrawing(observation: ActivelyDrawingInput): boolean {
  if (observation.available === false) return false;
  if (observation.currentOn === true) return true;
  return isFiniteNumber(observation.measuredPowerKw)
    && observation.measuredPowerKw > MIN_ACTIVE_MEASURED_POWER_KW;
}

function resolveConfiguredOrFallbackKw(device: ObservedPowerInput): number {
  const candidates: Array<number | undefined> = [
    device.expectedPowerKw,
    device.planningPowerKw,
    device.powerKw,
  ];
  for (const value of candidates) {
    if (isFiniteNumber(value) && value >= 0) {
      return value;
    }
  }
  if (device.controlCapabilityId === 'evcharger_charging') {
    return EV_MIN_START_FALLBACK_KW;
  }
  return DEFAULT_FALLBACK_KW;
}

function resolveFinitePositiveKw(value: number | undefined): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value <= 0) return null;
  return value;
}
