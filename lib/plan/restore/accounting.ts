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

export function buildInsufficientHeadroomUpdate(
  neededKw: number,
  availableKw: number,
  marginKw: number,
  penaltyExtraKw: number | null,
  swapReserveKw: number | null,
  effectiveAvailableKw: number | null,
): Partial<DevicePlanDevice> {
  return {
    plannedState: 'shed',
    reason: buildRestoreHeadroomReason(
      neededKw, availableKw, marginKw, penaltyExtraKw, swapReserveKw, effectiveAvailableKw,
    ),
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

/**
 * The kW admission must find before PELS raises a device's draw by
 * `increaseKw`: the increase, its restore buffer, and the recent-shed inflation
 * (a device shed within `RECENT_SHED_RESTORE_BACKOFF_MS` must clear a
 * deliberately higher bar, so the same marginal power does not flap it straight
 * off again). A binary device's increase is its whole restore power, a stepped
 * device's the step it climbs.
 *
 * The one rule, and shared on purpose. The binary gate (`getRestoreNeed`,
 * `restore/support.ts`), the stepped lane (`steppedRestoreTarget.ts`) and the
 * card's gap (`resolveCeilingShortfall`, `planReasonShortfall.ts`) all price a
 * restore here — measuring them against different needs is how the card came to
 * claim a device would be admitted while the gate had just rejected it on a
 * larger number, and how a stepped device faced the same bar a minute after a
 * shed as an hour later.
 */
export function computeRestoreRequirementKw(
  increaseKw: number,
  lastDeviceShedMs: number | undefined,
  nowMs: number,
): number {
  return applyRecentShedInflation(increaseKw + computeRestoreBufferKw(increaseKw), lastDeviceShedMs, nowMs);
}

function applyRecentShedInflation(
  baseNeededKw: number,
  lastDeviceShedMs: number | undefined,
  nowMs: number,
): number {
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
