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
    isExternalOffHoldActive: (deviceId, device) => (
      resolveExternalOffHoldActive(ctx.externalOffHold?.isHeld(deviceId) === true, device)
    ),
  };
}
