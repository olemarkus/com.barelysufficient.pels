import type CapacityGuard from '../core/capacityGuard';
import { getSheddingClearThresholdKw } from '../core/capacityGuard';
import type { PlanCapacityStateSummary } from '../core/capacityStateSummary';
import type { PlanInputDevice, ShedAction } from './planTypes';
import type { PlanContext } from './planContext';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { resolveCandidatePower } from './planCandidatePower';
import { getSteppedLoadShedTargetStep, isSteppedLoadDevice } from './planSteppedLoad';
import { buildPlanInputCapacityStateSummary } from './planLogging';
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

function resolveReduciblePowerKw(device: PlanInputDevice): number | null {
  const power = resolveCandidatePower(device);
  return power !== null && power > 0 ? power : null;
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
  let totalKw = 0;
  for (const device of devices) {
    const reduciblePowerKw = resolveReducibleControlledLoadCandidatePowerKw({
      device,
      shedSet,
      limitSource,
      capacityBreached,
      getShedBehavior,
    });
    if (reduciblePowerKw === null) continue;
    totalKw += reduciblePowerKw;
  }
  return totalKw;
}

function resolveReducibleControlledLoadCandidatePowerKw(params: {
  device: PlanInputDevice;
  shedSet: Set<string>;
  limitSource: PlanContext['softLimitSource'];
  capacityBreached: boolean;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): number | null {
  const { device, shedSet, limitSource, capacityBreached, getShedBehavior } = params;
  const effectiveCurrentOn = resolveEffectiveCurrentOn(device);
  if (device.controllable === false || effectiveCurrentOn === false || shedSet.has(device.id)) return null;
  if (limitSource === 'daily' && !capacityBreached && device.budgetExempt === true) return null;
  const reduciblePowerKw = resolveReduciblePowerKw(device);
  if (reduciblePowerKw === null) return null;
  return canStillReduceSteppedLoad(device, getShedBehavior) ? reduciblePowerKw : null;
}

function canStillReduceSteppedLoad(
  device: PlanInputDevice,
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null },
): boolean {
  if (!isSteppedLoadDevice(device)) return true;
  const shedBehavior = getShedBehavior(device.id);
  if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    return true;
  }
  const targetStep = getSteppedLoadShedTargetStep({
    device,
    shedAction: shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off',
    currentDesiredStepId: device.selectedStepId,
  });
  return Boolean(targetStep && targetStep.id !== device.selectedStepId);
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
  }) * 1000);

  return {
    ...summary,
    controlledPowerW,
    uncontrolledPowerW:
      totalPowerW !== null && controlledPowerW !== null
        ? Math.max(0, totalPowerW - controlledPowerW)
        : null,
    remainingReducibleControlledLoadW,
    remainingReducibleControlledLoad: (remainingReducibleControlledLoadW ?? 0) > 0,
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
    .filter((d) => {
      if (resolveReduciblePowerKw(d) === null) return false;
      if (isSteppedLoadDevice(d)) {
        const shedBehavior = getShedBehavior(d.id);
        if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) return true;
        const targetStep = getSteppedLoadShedTargetStep({
          device: d,
          shedAction: shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off',
          currentDesiredStepId: d.selectedStepId,
        });
        return Boolean(targetStep && targetStep.id !== d.selectedStepId);
      }
      return true;
    })
    .length;
}

export function isCapacityBreached(total: number | null, capacitySoftLimit: number): boolean {
  return typeof total === 'number' && Number.isFinite(total) && total > capacitySoftLimit;
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
