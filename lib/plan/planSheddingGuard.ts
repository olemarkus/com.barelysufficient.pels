import type CapacityGuard from '../core/capacityGuard';
import { getSheddingClearThresholdKw } from '../core/capacityGuard';
import type { PlanCapacityStateSummary } from '../core/capacityStateSummary';
import type { PlanInputDevice, ShedAction } from './planTypes';
import type { PlanContext } from './planContext';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { buildPlanInputCapacityStateSummary } from './planLogging';
import {
  isCapacityBreached,
  normalizeRemainingShedBehavior,
  resolveRemainingSheddableLoadKw,
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
} from './planRemainingSheddableLoad';
import { sumControlledUsageKw } from './planUsage';

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
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): number {
  const { devices, shedSet, limitSource, total, capacitySoftLimit, getShedBehavior } = params;
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
  return sumRemainingSheddableLoadKw({
    devices: devices.map(toInputRemainingSheddableDevice),
    shedBehaviorForDevice: (device) => normalizeRemainingShedBehavior(getShedBehavior(device.id)),
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
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): PlanCapacityStateSummary {
  const { devices, shedSet, total, limitSource, capacitySoftLimit, getShedBehavior } = params;
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
    getShedBehavior,
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
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): PlanCapacityStateSummary | undefined {
  const { deficitKw, devices, shedSet, total, limitSource, capacitySoftLimit, getShedBehavior } = params;
  if (deficitKw <= 0) return undefined;
  return buildShortfallCapacityStateSummary({
    devices,
    shedSet,
    total,
    limitSource,
    capacitySoftLimit,
    getShedBehavior,
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
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): number {
  const { devices, shedSet, headroom, limitSource, total, capacitySoftLimit, getShedBehavior } = params;
  if (headroom >= 0) return 0;
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
  return devices
    .filter((d) => {
      const effectiveCurrentOn = resolveEffectiveCurrentOn(d);
      return d.controllable !== false && effectiveCurrentOn !== false && !shedSet.has(d.id);
    })
    .filter((d) => limitSource !== 'daily' || capacityBreached || d.budgetExempt !== true)
    .filter((d) => resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice(d),
      shedBehavior: normalizeRemainingShedBehavior(getShedBehavior(d.id)),
      alreadyShed: false,
      limitSource,
      capacityBreached,
    }) > 0)
    .length;
}

export function resolvePlanningTotalPower(total: number | null, powerKnown: boolean): number | null {
  return powerKnown ? total : null;
}

export async function updateGuardState(params: {
  headroom: number;
  powerKnown: boolean;
  overshootActionable: boolean;
  capacitySoftLimit: number;
  total: number | null;
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  softLimitSource: PlanContext['softLimitSource'];
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  capacityGuard: CapacityGuard | undefined;
}): Promise<{ sheddingActive: boolean }> {
  const {
    headroom,
    powerKnown,
    overshootActionable,
    capacitySoftLimit,
    total,
    devices,
    shedSet,
    softLimitSource,
    getShedBehavior,
    capacityGuard,
  } = params;
  const planningTotal = resolvePlanningTotalPower(total, powerKnown);
  const remainingCandidates = countRemainingCandidates({
    devices,
    shedSet,
    headroom,
    limitSource: softLimitSource,
    total: planningTotal,
    capacitySoftLimit,
    getShedBehavior,
  });
  const shortfallThreshold = capacityGuard?.getShortfallThreshold() ?? capacitySoftLimit;
  const deficitKw = computeShortfallDeficitKw(planningTotal, shortfallThreshold);

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
        total: planningTotal,
        limitSource: softLimitSource,
        capacitySoftLimit,
        getShedBehavior,
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
      total: planningTotal,
      limitSource: softLimitSource,
      capacitySoftLimit,
      getShedBehavior,
    }),
  });
  const next = capacityGuard?.isSheddingActive() ?? current;
  return { sheddingActive: next };
}
