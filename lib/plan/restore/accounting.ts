import type { DevicePlanDevice } from '../planTypes';
import {
  RECENT_SHED_EXTRA_BUFFER_KW,
  RECENT_SHED_RESTORE_BACKOFF_MS,
  RECENT_SHED_RESTORE_MULTIPLIER,
} from '../planConstants';
import { buildRestoreHeadroomReason } from '../planReasonStrings';
import type { RestorePowerSource } from '../../../packages/contracts/src/types';

// Re-exported for plan-layer consumers (planReasons, restore/index, tests)
// that read `RestorePowerSource` from this module. The canonical declaration
// lives in `packages/contracts/src/types.ts`.
export type { RestorePowerSource };

export function buildInsufficientHeadroomUpdate(params: {
  neededKw: number;
  availableKw: number;
  postReserveMarginKw: number;
  minimumRequiredPostReserveMarginKw: number;
  penaltyExtraKw?: number;
  swapReserveKw?: number;
  effectiveAvailableKw?: number;
  swapTargetName?: string;
}): Partial<DevicePlanDevice> {
  return {
    plannedState: 'shed',
    reason: buildRestoreHeadroomReason(params),
  };
}

export function computeRestoreBufferKw(devPower: number): number {
  const boundedPower = Math.max(0, devPower);
  const scaled = boundedPower * 0.1 + 0.1;
  return Math.max(0.2, Math.min(0.6, scaled));
}

export function resolveRestorePowerSource(dev: DevicePlanDevice): RestorePowerSource {
  return resolveRestorePower(dev).source;
}

export function estimateRestorePower(dev: DevicePlanDevice): number {
  return resolveRestorePower(dev).kw;
}

function resolveRestorePower(
  dev: DevicePlanDevice,
): { kw: number; source: RestorePowerSource } {
  // The producer resolved the whole question once
  // (`buildResidualKwForPlanDevice` → `resolveResidualKwRestore`), so the
  // consumer reads the answer. There is no fallback: the
  // `isSteppedLoadDevice + getSteppedLoadRestoreStep` chain that used to live
  // here was reachable only from fixtures that stamped `shed` without
  // `restore` — a shape `toPlanDevice` cannot emit — and it went when the
  // shared fixture builders started resolving both halves through the producer
  // itself.
  return dev.residualKw.restore;
}

export function computeBaseRestoreNeed(
  dev: DevicePlanDevice,
): { power: number; buffer: number; needed: number } {
  const power = estimateRestorePower(dev);
  const buffer = computeRestoreBufferKw(power);
  return { power, buffer, needed: power + buffer };
}

/**
 * The recent-shed inflation the restore gate applies on top of the base need: a
 * device shed within `RECENT_SHED_RESTORE_BACKOFF_MS` must clear a deliberately
 * higher bar before PELS puts it back, so the same marginal power does not flap
 * it straight off again.
 *
 * Pure, and shared on purpose. `getRestoreNeed` (`restore/support.ts`) gates the
 * restore lane on this figure, and `resolveCeilingShortfall`
 * (`planReasonShortfall.ts`) states the card's gap against it — measuring the
 * two against different needs is how the card came to claim a device would be
 * admitted while the gate had just rejected it on a larger number.
 */
export function applyRecentShedInflation(params: {
  baseNeededKw: number;
  lastDeviceShedMs: number | undefined;
  nowMs: number;
}): number {
  const { baseNeededKw, lastDeviceShedMs, nowMs } = params;
  // The clock is injected (two callers, two stages of the same cycle), so the
  // window is bounded at BOTH ends: a `nowMs` before the shed stamp is not
  // "recently shed", it is a nonsense elapsed time, and inflating on it would
  // silently raise the restore bar.
  const elapsedMs = lastDeviceShedMs === undefined ? null : nowMs - lastDeviceShedMs;
  const recentlyShed = lastDeviceShedMs !== undefined
    && lastDeviceShedMs > 0
    && elapsedMs !== null
    && elapsedMs >= 0
    && elapsedMs < RECENT_SHED_RESTORE_BACKOFF_MS;
  if (!recentlyShed) return baseNeededKw;
  return Math.max(
    baseNeededKw * RECENT_SHED_RESTORE_MULTIPLIER,
    baseNeededKw + RECENT_SHED_EXTRA_BUFFER_KW,
  );
}
