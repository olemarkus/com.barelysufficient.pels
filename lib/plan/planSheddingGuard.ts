import type CapacityGuard from '../core/capacityGuard';
import type { PlanInputDevice, ShedAction } from './planTypes';
import type { PlanContext } from './planContext';
import { resolveCandidatePower } from './planCandidatePower';
import { getSteppedLoadShedTargetStep, isSteppedLoadDevice } from './planSteppedLoad';

function handleShortfallCheck(
  capacityGuard: CapacityGuard | undefined, remaining: number, deficitKw: number,
): Promise<void> {
  return deficitKw > 0
    ? (capacityGuard?.checkShortfall(remaining > 0, deficitKw) ?? Promise.resolve())
    : (capacityGuard?.checkShortfall(true, 0) ?? Promise.resolve());
}

function computeShortfallDeficitKw(total: number | null, shortfallThreshold: number): number {
  if (total === null) return 0;
  return Math.max(0, total - shortfallThreshold);
}

export function shouldActivateShedding(headroom: number | null, shedSet: Set<string>): boolean {
  if (shedSet.size > 0) return true;
  return headroom !== null && headroom < 0;
}

export function countRemainingCandidates(params: {
  devices: PlanInputDevice[];
  shedSet: Set<string>;
  headroom: number | null;
  limitSource: PlanContext['softLimitSource'];
  total: number | null;
  capacitySoftLimit: number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): number {
  const { devices, shedSet, headroom, limitSource, total, capacitySoftLimit, getShedBehavior } = params;
  if (headroom === null || headroom >= 0) return 0;
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
  return devices
    .filter((d) => d.controllable !== false && d.currentOn !== false && !shedSet.has(d.id))
    .filter((d) => limitSource !== 'daily' || capacityBreached || d.budgetExempt !== true)
    .filter((d) => {
      if (isSteppedLoadDevice(d)) {
        const shedBehavior = getShedBehavior(d.id);
        if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
          const power = resolveCandidatePower(d);
          return power !== null && power > 0;
        }
        const targetStep = getSteppedLoadShedTargetStep({
          device: d,
          shedAction: shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off',
          currentDesiredStepId: d.selectedStepId,
        });
        return Boolean(targetStep && targetStep.id !== d.selectedStepId);
      }
      const power = resolveCandidatePower(d);
      return power !== null && power > 0;
    })
    .length;
}

export function isCapacityBreached(total: number | null, capacitySoftLimit: number): boolean {
  return typeof total === 'number' && Number.isFinite(total) && total > capacitySoftLimit;
}

export async function updateGuardState(params: {
  headroom: number | null;
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
    capacitySoftLimit,
    total,
    devices,
    shedSet,
    softLimitSource,
    getShedBehavior,
    capacityGuard,
  } = params;
  if (shouldActivateShedding(headroom, shedSet)) {
    const remainingCandidates = countRemainingCandidates({
      devices,
      shedSet,
      headroom,
      limitSource: softLimitSource,
      total,
      capacitySoftLimit,
      getShedBehavior,
    });
    const shortfallThreshold = capacityGuard?.getShortfallThreshold() ?? capacitySoftLimit;
    const deficitKw = computeShortfallDeficitKw(total, shortfallThreshold);
    await capacityGuard?.setSheddingActive(true);
    await handleShortfallCheck(capacityGuard, remainingCandidates, deficitKw);
    return { sheddingActive: true };
  }

  const restoreMargin = capacityGuard?.getRestoreMargin() ?? 0.2;
  const canDisable = headroom !== null && headroom >= restoreMargin;
  const current = capacityGuard?.isSheddingActive() ?? false;
  if (canDisable) {
    await capacityGuard?.setSheddingActive(false);
  }
  await capacityGuard?.checkShortfall(true, 0);
  const next = capacityGuard?.isSheddingActive() ?? current;
  return { sheddingActive: next };
}
