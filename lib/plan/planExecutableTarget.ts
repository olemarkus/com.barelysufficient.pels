import type { ExecutableTargetCommand, ExecutableTargetUpdate } from '../executor/executablePlan';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { DevicePlan, ShedAction } from './planTypes';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableTargetUpdate(
  dev: PlanDevice,
  snapshot: TargetDeviceSnapshot | undefined,
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null },
  getCurrentSnapshot?: (deviceId: string) => TargetDeviceSnapshot | undefined,
): ExecutableTargetUpdate | null {
  if (typeof dev.plannedTarget !== 'number' || dev.plannedTarget === dev.currentTarget) return null;
  const targetCap = (snapshot ?? getCurrentSnapshot?.(dev.id))?.targets?.[0]?.id;
  if (!targetCap) return null;

  return {
    deviceId: dev.id,
    name: dev.name,
    targetCap,
    desired: dev.plannedTarget,
    observedValue: dev.currentTarget,
    isRestoring: isTargetRestore({
      dev,
      plannedTarget: dev.plannedTarget,
      getShedBehavior,
    }),
  };
}

export function buildExecutableShedTemperatureCommand(
  dev: PlanDevice,
  targetCap: string,
  plannedTarget: number,
): ExecutableTargetCommand {
  return {
    deviceId: dev.id,
    name: dev.name,
    targetCap,
    desired: plannedTarget,
    observedValue: dev.currentTarget,
    isSwapShed: dev.reason?.code === PLAN_REASON_CODES.swappedOut,
  };
}

const isTargetRestore = (params: {
  dev: PlanDevice;
  plannedTarget: number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
}): boolean => {
  const { dev, plannedTarget, getShedBehavior } = params;
  if (typeof dev.currentTarget !== 'number') return false;
  const shedBehavior = getShedBehavior(dev.id);
  return shedBehavior.action === 'set_temperature'
    && shedBehavior.temperature !== null
    && dev.currentTarget === shedBehavior.temperature
    && plannedTarget > dev.currentTarget;
};
