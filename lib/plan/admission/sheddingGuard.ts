import type CapacityGuard from '../../power/capacityGuard';
import { SHEDDING_CLEAR_THRESHOLD_KW } from '../../power/capacityGuard';
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
    capacityGuard: CapacityGuard | undefined;
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
    ? (capacityGuard?.checkShortfall({
      hasCandidates: remaining > 0,
      deficitKw,
      totalKw,
      shortfallThresholdKw,
      capacityStateSummary,
    }) ?? Promise.resolve())
    : (capacityGuard?.checkShortfall({
      hasCandidates: true,
      deficitKw: 0,
      totalKw,
      shortfallThresholdKw,
      capacityStateSummary,
    }) ?? Promise.resolve());
}

function computeShortfallDeficitKw(total: number | null, shortfallThreshold: number): number {
  if (total === null) return 0;
  return Math.max(0, total - shortfallThreshold);
}

function sumRemainingReducibleControlledLoadKw(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  limitSource: PlanContext['softLimitSource'];
  total: number | null;
  capacitySoftLimit: number;
}): number {
  const { devices, shedSet, limitSource, total, capacitySoftLimit } = params;
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
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
  total: number | null;
  limitSource: PlanContext['softLimitSource'];
  capacitySoftLimit: number;
}): PlanCapacityStateSummary {
  const { devices, shedSet, total, limitSource, capacitySoftLimit } = params;
  const summary = buildPlanInputCapacityStateSummary(devices, shedSet, {
    summarySource: 'plan_input',
    summarySourceAtMs: Date.now(),
  });
  const controlledKw = sumControlledUsageKw(devices);
  const controlledPowerW = roundPowerW(controlledKw);
  const totalPowerW = roundPowerW(total);
  const remainingReducibleControlledLoadW = roundPowerW(sumRemainingReducibleControlledLoadKw({
    devices,
    shedSet,
    limitSource,
    total,
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
  total: number | null;
  limitSource: PlanContext['softLimitSource'];
  capacitySoftLimit: number;
}): PlanCapacityStateSummary {
  const { deficitKw, devices, shedSet, total, limitSource, capacitySoftLimit } = params;
  // Only an entering incident reads it, and that needs a positive deficit, so
  // the null summary spares every ordinary rebuild the device walk.
  if (deficitKw <= 0) return buildNullCapacityStateSummary();
  return buildShortfallCapacityStateSummary({
    devices,
    shedSet,
    total,
    limitSource,
    capacitySoftLimit,
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
  total: number | null;
  capacitySoftLimit: number;
}): number {
  const { devices, shedSet, headroom, limitSource, total, capacitySoftLimit } = params;
  if (headroom >= 0) return 0;
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
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
  /** `context.planningTotalKw` — already resolved; `null` means no trustworthy total. */
  planningTotalKw: number | null;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  softLimitSource: PlanContext['softLimitSource'];
  capacityGuard: CapacityGuard | undefined;
  /** Producer-resolved `computeShortfallThreshold` for this build. */
  shortfallThresholdKw: number;
}): Promise<{ sheddingActive: boolean }> {
  const {
    headroom,
    overshootActionable,
    capacitySoftLimit,
    planningTotalKw,
    devices,
    shedSet,
    softLimitSource,
    capacityGuard,
    shortfallThresholdKw,
  } = params;
  const remainingCandidates = countRemainingCandidates({
    devices,
    shedSet,
    headroom,
    limitSource: softLimitSource,
    total: planningTotalKw,
    capacitySoftLimit,
  });
  const deficitKw = computeShortfallDeficitKw(planningTotalKw, shortfallThresholdKw);

  if (overshootActionable && shouldActivateShedding(headroom, shedSet)) {
    capacityGuard?.activateShedding();
    await handleShortfallCheck({
      capacityGuard,
      remaining: remainingCandidates,
      deficitKw,
      totalKw: planningTotalKw,
      shortfallThresholdKw,
      capacityStateSummary: resolveShortfallCapacityStateSummary({
        deficitKw,
        devices,
        shedSet,
        total: planningTotalKw,
        limitSource: softLimitSource,
        capacitySoftLimit,
      }),
    });
    return { sheddingActive: true };
  }

  const canDisable = headroom >= SHEDDING_CLEAR_THRESHOLD_KW;
  const current = capacityGuard?.isSheddingActive() ?? false;
  if (canDisable) {
    capacityGuard?.releaseShedding(headroom);
  }
  await handleShortfallCheck({
    capacityGuard,
    remaining: remainingCandidates,
    deficitKw,
    totalKw: planningTotalKw,
    shortfallThresholdKw,
    capacityStateSummary: resolveShortfallCapacityStateSummary({
      deficitKw,
      devices,
      shedSet,
      total: planningTotalKw,
      limitSource: softLimitSource,
      capacitySoftLimit,
    }),
  });
  const next = capacityGuard?.isSheddingActive() ?? current;
  return { sheddingActive: next };
}
