import type { AppContext } from '../../lib/app/appContext';
import {
  isExternalOffHeldForObservedDevice,
  resolveExternalOffHoldActive as resolveExternalOffHoldPolicy,
} from '../../lib/observer/externalOffHold';
import {
  resolveExternalOffHoldActive as resolveProjectionHoldActive,
  projectPlanInputDevice,
  createDefaultToPlanDeviceOptions,
  type PlanInputProjectionSource,
  type ToPlanDeviceInput,
  type ToPlanDeviceOptions,
  type UnrankedPlanInputDevice,
} from '../../lib/planInput/projectPlanInputDevice';
import type {
  DecoratedDeviceSnapshot,
  EvObservedProbe,
  MeasuredPowerObservedProbe,
} from '../../packages/contracts/src/types';
import type { ReleaseHoldOutcome } from '../../lib/observer/externalOffHold';

/**
 * Bind the planner-input producer to its domain reads. This is wiring only:
 * each source remains owned by its domain, and the producer receives this
 * required, named read surface instead of the app-wide context.
 */
export function createPlanInputProjectionSource(ctx: AppContext): PlanInputProjectionSource {
  return {
    getNow: () => ctx.getNow(),
    getPowerCalibrationSnapshot: () => ctx.getPowerCalibrationSnapshot(),
    getTargetPowerConfig: (deviceId) => ctx.deviceTargetPowerConfigs[deviceId],
    getPriceOptimizationSettings: (deviceId) => ctx.priceOptimizationSettings[deviceId],
    isSurplusPoolReachable: () => ctx.isSurplusPoolReachable(),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getTemperatureBoostConfig: (deviceId) => ctx.getTemperatureBoostConfig(deviceId),
    getEvBoostConfig: (deviceId) => ctx.getEvBoostConfig(deviceId),
    getDeviceStartPolicies: () => ctx.deviceStartPolicies,
    isCapacityControlEnabled: (deviceId) => ctx.isCapacityControlEnabled(deviceId),
    resolveManagedState: (deviceId) => ctx.resolveManagedState(deviceId),
    isBudgetExempt: (deviceId) => ctx.isBudgetExempt(deviceId),
    isExternalOffHoldActive: (deviceId, device) => resolveExternalOffHoldPolicy(
      ctx.externalOffHold?.isHeld(deviceId) === true,
      device,
    ),
  };
}

/** Compatibility seam for wiring call sites that need one projection. */
export function toPlanDevice(
  ctx: AppContext,
  device: ToPlanDeviceInput,
  options: ToPlanDeviceOptions = createDefaultToPlanDeviceOptions(),
): UnrankedPlanInputDevice {
  return projectPlanInputDevice(createPlanInputProjectionSource(ctx), device, options);
}

export const holdExternalOffOnRelease = (
  ctx: AppContext,
  deviceId: string,
): ReleaseHoldOutcome => ctx.externalOffHold?.holdOnRelease(deviceId) ?? 'unavailable';

export const isExternalOffHeldForDevice = (
  ctx: AppContext,
  deviceId: string,
): boolean => isExternalOffHeldForObservedDevice(
  ctx.externalOffHold?.isHeld(deviceId) === true,
  ctx.getObservedRecord(deviceId),
);

export const resolveExternalOffHoldActive = (
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe,
): boolean => resolveProjectionHoldActive(createPlanInputProjectionSource(ctx), device);
