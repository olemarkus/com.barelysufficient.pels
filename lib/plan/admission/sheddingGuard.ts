import type CapacityGuard from '../../power/capacityGuard';
import { SHEDDING_CLEAR_THRESHOLD_KW } from '../planConstants';
import {
  buildNullCapacityStateSummary,
  type PlanCapacityStateSummary,
} from '../../power/capacityStateSummary';
import type { PlanInputDevice } from '../planTypes';
import type { PlanContext } from '../planContext';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { buildPlanInputCapacityStateSummary } from '../planLogging';
import {
  resolveRemainingSheddableLoadKw,
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
} from '../planRemainingSheddableLoad';
import { sumControlledUsageKw } from '../planUsage';

function handleShortfallCheck(
  params: {
    capacityGuard: CapacityGuard;
    remaining: number;
    deficitKw: number;
    totalKw: number | null;
    shortfallThresholdKw: number;
    capacityStateSummary: PlanCapacityStateSummary;
  },
): Promise<void> {
  const {
    capacityGuard, remaining, deficitKw, totalKw, shortfallThresholdKw, capacityStateSummary,
  } = params;
  return deficitKw > 0
    ? (capacityGuard.checkShortfall({
      hasCandidates: remaining > 0,
      deficitKw,
      totalKw,
      shortfallThresholdKw,
      capacityStateSummary,
    }) ?? Promise.resolve())
    : (capacityGuard.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw,
      shortfallThresholdKw,
      capacityStateSummary,
    }) ?? Promise.resolve());
}

function computeShortfallDeficitKw(drawKw: number, shortfallThreshold: number): number {
  return Math.max(0, drawKw - shortfallThreshold);
}

function sumRemainingReducibleControlledLoadKw(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  limitSource: PlanContext['softLimitSource'];
  capacityBreached: boolean;
}): number {
  const { devices, shedSet, limitSource, capacityBreached } = params;
  return sumRemainingSheddableLoadKw({
    devices: devices.map(toInputRemainingSheddableDevice),
    isAlreadyShed: (device) => shedSet.has(device.id),
    limitSource,
    capacityBreached,
  });
}

function buildShortfallCapacityStateSummary(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  drawKw: number;
  capacityBreached: boolean;
  limitSource: PlanContext['softLimitSource'];
  isBinaryCommandPending: (deviceId: string) => boolean;
}): PlanCapacityStateSummary {
  const {
    devices, shedSet, drawKw, capacityBreached, limitSource, isBinaryCommandPending,
  } = params;
  const summary = buildPlanInputCapacityStateSummary(devices, shedSet, isBinaryCommandPending, {
    summarySource: 'plan_input',
    summarySourceAtMs: Date.now(),
  });
  const controlledKw = sumControlledUsageKw(devices);
  const controlledPowerW = roundPowerW(controlledKw);
  const totalPowerW = roundPowerW(drawKw);
  const remainingReducibleControlledLoadW = roundPowerW(sumRemainingReducibleControlledLoadKw({
    devices,
    shedSet,
    limitSource,
    capacityBreached,
  }));

  return {
    ...summary,
    controlledPowerW,
    uncontrolledPowerW:
      totalPowerW !== null && controlledPowerW !== null
        ? Math.max(0, totalPowerW - controlledPowerW)
        : null,
    remainingReducibleControlledLoadW,
    remainingReducibleControlledLoad: (remainingReducibleControlledLoadW ?? 0) > 0,
    remainingActionableControlledLoadW: remainingReducibleControlledLoadW,
    remainingActionableControlledLoad: (remainingReducibleControlledLoadW ?? 0) > 0,
  };
}

function resolveShortfallCapacityStateSummary(params: {
  deficitKw: number;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  drawKw: number;
  capacityBreached: boolean;
  limitSource: PlanContext['softLimitSource'];
  isBinaryCommandPending: (deviceId: string) => boolean;
}): PlanCapacityStateSummary {
  const {
    deficitKw, devices, shedSet, drawKw, capacityBreached, limitSource, isBinaryCommandPending,
  } = params;
  // Only an entering incident reads it, and that needs a positive deficit, so
  // the null summary spares every ordinary rebuild the device walk.
  if (deficitKw <= 0) return buildNullCapacityStateSummary();
  return buildShortfallCapacityStateSummary({
    devices,
    shedSet,
    drawKw,
    capacityBreached,
    limitSource,
    isBinaryCommandPending,
  });
}

function roundPowerW(powerKw: number | null | undefined): number | null {
  if (typeof powerKw !== 'number' || !Number.isFinite(powerKw)) return null;
  return Math.round(Math.max(0, powerKw * 1000));
}

/**
 * The exhausted hour keeps the latch engaged on its own: with the hour's kWh
 * spent nothing may restore, even when the measured house is idle and there is
 * nothing left to shed. This used to ride on the context forcing the headroom
 * to -1; it is the flag now (owner ruling 2026-09-02).
 */
export function shouldActivateShedding(
  headroom: number,
  shedSet: Set<string>,
  hourlyBudgetExhausted: boolean,
): boolean {
  if (shedSet.size > 0 || hourlyBudgetExhausted) return true;
  return headroom < 0;
}

export function countRemainingCandidates(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  headroom: number;
  limitSource: PlanContext['softLimitSource'];
  drawKw: number;
  capacityBreached: boolean;
}): number {
  const { devices, shedSet, headroom, limitSource, capacityBreached } = params;
  if (headroom >= 0) return 0;
  return devices
    .filter((d) => d.controllable && !shedSet.has(d.id))
    // On/off is a binary-only question: a binary device is still a remaining
    // candidate only while on; non-binary (setpoint/step) devices stay eligible
    // regardless. `currentOn` is read only after narrowing to the binary kind.
    .filter((d) => !isBinaryPlanDevice(d) || d.currentOn)
    .filter((d) => limitSource !== 'daily' || capacityBreached || d.budgetExempt !== true)
    .filter((d) => resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice(d),
      alreadyShed: false,
      limitSource,
      capacityBreached,
    }) > 0)
    .length;
}

export async function updateGuardState(params: {
  headroom: number;
  overshootActionable: boolean;
  /**
   * The whole-home draw (`MeasuredPower.drawKw`). The deficit is a real
   * quantity in kW, so unlike most planner power questions it cannot be
   * answered with a headroom.
   */
  drawKw: number;
  /** The one "is capacity breached" answer (`MeasuredPower.capacityBreached`). */
  capacityBreached: boolean;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  softLimitSource: PlanContext['softLimitSource'];
  capacityGuard: CapacityGuard;
  /** Producer-resolved `computeShortfallThreshold` for this build. */
  shortfallThresholdKw: number;
  /** The shedding latch this build inherits, from `PlanEngineState`. */
  sheddingActive: boolean;
  /** The hour's kWh is spent: the latch stays engaged whatever the headroom says. */
  hourlyBudgetExhausted: boolean;
  /**
   * "Is a binary command in flight", answered by `PendingBinaryCommandStore`.
   * Only the shortfall summary needs it, and only for its log counters.
   */
  isBinaryCommandPending: (deviceId: string) => boolean;
}): Promise<{ sheddingActive: boolean }> {
  const {
    headroom,
    overshootActionable,
    drawKw,
    capacityBreached,
    devices,
    shedSet,
    softLimitSource,
    capacityGuard,
    shortfallThresholdKw,
    sheddingActive,
    hourlyBudgetExhausted,
    isBinaryCommandPending,
  } = params;
  const remainingCandidates = countRemainingCandidates({
    devices,
    shedSet,
    headroom,
    limitSource: softLimitSource,
    drawKw,
    capacityBreached,
  });
  const deficitKw = computeShortfallDeficitKw(drawKw, shortfallThresholdKw);

  if (overshootActionable && shouldActivateShedding(headroom, shedSet, hourlyBudgetExhausted)) {
    await handleShortfallCheck({
      capacityGuard,
      remaining: remainingCandidates,
      deficitKw,
      totalKw: drawKw,
      shortfallThresholdKw,
      capacityStateSummary: resolveShortfallCapacityStateSummary({
        isBinaryCommandPending,
        deficitKw,
        devices,
        shedSet,
        drawKw,
        capacityBreached,
        limitSource: softLimitSource,
      }),
    });
    return { sheddingActive: true };
  }

  // The release decision is made once, here. It used to be evaluated twice on
  // the same input — this predicate, then the identical one inside the guard's
  // `releaseShedding` — which is why the caller had to re-read the guard to
  // learn whether its own request had been refused.
  const canDisable = headroom >= SHEDDING_CLEAR_THRESHOLD_KW;
  await handleShortfallCheck({
    capacityGuard,
    remaining: remainingCandidates,
    deficitKw,
    totalKw: drawKw,
    shortfallThresholdKw,
    capacityStateSummary: resolveShortfallCapacityStateSummary({
      isBinaryCommandPending,
      deficitKw,
      devices,
      shedSet,
      drawKw,
      capacityBreached,
      limitSource: softLimitSource,
    }),
  });
  return { sheddingActive: canDisable ? false : sheddingActive };
}
