import type CapacityGuard from '../../power/capacityGuard';
import { getSheddingClearThresholdKw } from '../../power/capacityGuard';
import type { PlanCapacityStateSummary } from '../../power/capacityStateSummary';
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
    capacityStateSummary?: PlanCapacityStateSummary;
  },
): Promise<void> {
  const { capacityGuard, remaining, deficitKw, capacityStateSummary } = params;
  return deficitKw > 0
    ? (capacityGuard?.checkShortfall(
      remaining > 0,
      deficitKw,
      capacityStateSummary,
    ) ?? Promise.resolve())
    : (capacityGuard?.checkShortfall(true, 0) ?? Promise.resolve());
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

function maybeBuildShortfallCapacityStateSummary(params: {
  deficitKw: number;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  total: number | null;
  limitSource: PlanContext['softLimitSource'];
  capacitySoftLimit: number;
}): PlanCapacityStateSummary | undefined {
  const { deficitKw, devices, shedSet, total, limitSource, capacitySoftLimit } = params;
  if (deficitKw <= 0) return undefined;
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
  /**
   * The measured whole-home draw (`resolveMeasuredTotalKw`), or `null` when this
   * cycle had none. The deficit is a real quantity in kW, so unlike most planner
   * power questions it cannot be answered with a headroom.
   */
  measuredTotalKw: number | null;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  softLimitSource: PlanContext['softLimitSource'];
  capacityGuard: CapacityGuard | undefined;
}): Promise<{ sheddingActive: boolean }> {
  const {
    headroom,
    overshootActionable,
    capacitySoftLimit,
    measuredTotalKw,
    devices,
    shedSet,
    softLimitSource,
    capacityGuard,
  } = params;
  const remainingCandidates = countRemainingCandidates({
    devices,
    shedSet,
    headroom,
    limitSource: softLimitSource,
    total: measuredTotalKw,
    capacitySoftLimit,
  });
  const shortfallThreshold = capacityGuard?.getShortfallThreshold() ?? capacitySoftLimit;
  const deficitKw = computeShortfallDeficitKw(measuredTotalKw, shortfallThreshold);

  if (overshootActionable && shouldActivateShedding(headroom, shedSet)) {
    await capacityGuard?.setSheddingActive(true);
    await handleShortfallCheck({
      capacityGuard,
      remaining: remainingCandidates,
      deficitKw,
      capacityStateSummary: maybeBuildShortfallCapacityStateSummary({
        deficitKw,
        devices,
        shedSet,
        total: measuredTotalKw,
        limitSource: softLimitSource,
        capacitySoftLimit,
      }),
    });
    return { sheddingActive: true };
  }

  const restoreMargin = capacityGuard?.getRestoreMargin() ?? 0.2;
  const canDisable = headroom >= getSheddingClearThresholdKw(restoreMargin);
  const current = capacityGuard?.isSheddingActive() ?? false;
  if (canDisable) {
    await capacityGuard?.setSheddingActive(false, headroom);
  }
  await handleShortfallCheck({
    capacityGuard,
    remaining: remainingCandidates,
    deficitKw,
    capacityStateSummary: maybeBuildShortfallCapacityStateSummary({
      deficitKw,
      devices,
      shedSet,
      total: measuredTotalKw,
      limitSource: softLimitSource,
      capacitySoftLimit,
    }),
  });
  const next = capacityGuard?.isSheddingActive() ?? current;
  return { sheddingActive: next };
}
