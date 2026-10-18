import type { AppContext } from '../../lib/app/appContext';
import type { PlanInputProjectionSource } from '../../lib/planInput/projectPlanInputDevice';
import { resolveExternalOffHoldActive } from '../../lib/planInput/externalOffHoldProjection';

/**
 * Bind the planner-input producer to its domain reads. This is wiring only:
 * each source remains owned by its domain, and the producer receives this
 * required, named read surface instead of the app-wide context.
 */
export function createPlanInputProjectionSource(ctx: AppContext): PlanInputProjectionSource {
  return {
    getNow: () => ctx.getNow(),
    getPowerCalibrationSnapshot: () => ctx.getPowerCalibrationSnapshot(),
    getTargetPowerConfig: (deviceId) => ctx.deviceControlSettings.getDeviceTargetPowerConfig(deviceId),
    getPriceOptimizationSettings: (deviceId) => ctx.priceOptimizationSettings[deviceId],
    isSurplusPoolReachable: () => ctx.isSurplusPoolReachable(),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getTemperatureBoostConfig: (deviceId) => ctx.deviceControlSettings.getTemperatureBoostConfig(deviceId),
    getEvBoostConfig: (deviceId) => ctx.deviceControlSettings.getEvBoostConfig(deviceId),
    getEvChargeTargetConfig: (deviceId) => ctx.deviceControlSettings.getEvChargeTargetConfig(deviceId),
    getDeviceStartPolicies: () => ctx.deviceControlSettings.deviceStartPolicies,
    isCapacityControlEnabled: (deviceId) => ctx.isCapacityControlEnabled(deviceId),
    getControllableDevices: () => ctx.deviceControlSettings.controllableDevices,
    resolveManagedState: (deviceId) => ctx.resolveManagedState(deviceId),
    isBudgetExempt: (deviceId) => ctx.deviceControlSettings.isBudgetExempt(deviceId),
    isExternalOffHoldActive: (deviceId, device) => (
      resolveExternalOffHoldActive(ctx.externalOffHold?.isHeld(deviceId) === true, device)
    ),
  };
}
