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
  isCapacityBreached,
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

function computeShortfallDeficitKw(drawKw: number, powerIsMeasured: boolean, shortfallThreshold: number): number {
  // A deficit is a claim about the LIVE draw: an unmeasured cycle claims none.
  if (!powerIsMeasured) return 0;
  return Math.max(0, drawKw - shortfallThreshold);
}

function sumRemainingReducibleControlledLoadKw(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  limitSource: PlanContext['softLimitSource'];
  drawKw: number;
  powerIsMeasured: boolean;
  capacitySoftLimit: number;
}): number {
  const { devices, shedSet, limitSource, drawKw, powerIsMeasured, capacitySoftLimit } = params;
  const capacityBreached = powerIsMeasured && isCapacityBreached(drawKw, capacitySoftLimit);
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
  powerIsMeasured: boolean;
  limitSource: PlanContext['softLimitSource'];
  capacitySoftLimit: number;
  isBinaryCommandPending: (deviceId: string) => boolean;
}): PlanCapacityStateSummary {
  const {
    devices, shedSet, drawKw, powerIsMeasured, limitSource, capacitySoftLimit, isBinaryCommandPending,
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
    drawKw,
    powerIsMeasured,
    capacitySoftLimit,
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
  powerIsMeasured: boolean;
  limitSource: PlanContext['softLimitSource'];
  capacitySoftLimit: number;
  isBinaryCommandPending: (deviceId: string) => boolean;
}): PlanCapacityStateSummary {
  const {
    deficitKw, devices, shedSet, drawKw, powerIsMeasured, limitSource, capacitySoftLimit, isBinaryCommandPending,
  } = params;
  // Only an entering incident reads it, and that needs a positive deficit, so
  // the null summary spares every ordinary rebuild the device walk.
  if (deficitKw <= 0) return buildNullCapacityStateSummary();
  return buildShortfallCapacityStateSummary({
    devices,
    shedSet,
    drawKw,
    powerIsMeasured,
    limitSource,
    capacitySoftLimit,
    isBinaryCommandPending,
  });
}

function roundPowerW(powerKw: number | null | undefined): number | null {
  if (typeof powerKw !== 'number' || !Number.isFinite(powerKw)) return null;
  return Math.round(Math.max(0, powerKw * 1000));
}

export function shouldActivateShedding(headroom: number, shedSet: Set<string>): boolean {
  if (shedSet.size > 0) return true;
  return headroom < 0;
}

export function countRemainingCandidates(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  headroom: number;
  limitSource: PlanContext['softLimitSource'];
  drawKw: number;
  powerIsMeasured: boolean;
  capacitySoftLimit: number;
}): number {
  const { devices, shedSet, headroom, limitSource, drawKw, powerIsMeasured, capacitySoftLimit } = params;
  if (headroom >= 0) return 0;
  const capacityBreached = powerIsMeasured && isCapacityBreached(drawKw, capacitySoftLimit);
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
  capacitySoftLimit: number;
  /**
   * The whole-home draw (`PlanContext.drawKw` — always a number, the carried
   * reading) plus whether it was MEASURED this cycle. The deficit is a real
   * quantity in kW, so unlike most planner power questions it cannot be
   * answered with a headroom — and it is claimed only from a measured draw.
   */
  drawKw: number;
  powerIsMeasured: boolean;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  softLimitSource: PlanContext['softLimitSource'];
  capacityGuard: CapacityGuard;
  /** Producer-resolved `computeShortfallThreshold` for this build. */
  shortfallThresholdKw: number;
  /** The shedding latch this build inherits, from `PlanEngineState`. */
  sheddingActive: boolean;
  /**
   * "Is a binary command in flight", answered by `PendingBinaryCommandStore`.
   * Only the shortfall summary needs it, and only for its log counters.
   */
  isBinaryCommandPending: (deviceId: string) => boolean;
}): Promise<{ sheddingActive: boolean }> {
  const {
    headroom,
    overshootActionable,
    capacitySoftLimit,
    drawKw,
    powerIsMeasured,
    devices,
    shedSet,
    softLimitSource,
    capacityGuard,
    shortfallThresholdKw,
    sheddingActive,
    isBinaryCommandPending,
  } = params;
  const remainingCandidates = countRemainingCandidates({
    devices,
    shedSet,
    headroom,
    limitSource: softLimitSource,
    drawKw,
    powerIsMeasured,
    capacitySoftLimit,
  });
  const deficitKw = computeShortfallDeficitKw(drawKw, powerIsMeasured, shortfallThresholdKw);

  if (overshootActionable && shouldActivateShedding(headroom, shedSet)) {
    await handleShortfallCheck({
      capacityGuard,
      remaining: remainingCandidates,
      deficitKw,
      // The guard's `null` is its no-op signal, and lib/power may know
      // absence: an unmeasured cycle (the fail-closed pass) must not feed a
      // shortfall incident a carried total as if it were live.
      totalKw: powerIsMeasured ? drawKw : null,
      shortfallThresholdKw,
      capacityStateSummary: resolveShortfallCapacityStateSummary({
        isBinaryCommandPending,
        deficitKw,
        devices,
        shedSet,
        drawKw,
        powerIsMeasured,
        limitSource: softLimitSource,
        capacitySoftLimit,
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
    totalKw: powerIsMeasured ? drawKw : null,
    shortfallThresholdKw,
    capacityStateSummary: resolveShortfallCapacityStateSummary({
      isBinaryCommandPending,
      deficitKw,
      devices,
      shedSet,
      drawKw,
      powerIsMeasured,
      limitSource: softLimitSource,
      capacitySoftLimit,
    }),
  });
  return { sheddingActive: canDisable ? false : sheddingActive };
}
