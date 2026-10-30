import { requireDeviceManager } from './contextGuards';
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
    isWaitingForCarAssociation: (deviceId) => requireDeviceManager(ctx).isWaitingForCarAssociation(deviceId),
    getPowerCalibrationSnapshot: () => ctx.getPowerCalibrationSnapshot(),
    deviceControl: ctx.deviceControlSettings,
    getPriceOptimizationSettings: (deviceId) => ctx.priceOptimizationSettings[deviceId],
    isSurplusPoolReachable: () => ctx.isSurplusPoolReachable(),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    isCapacityControlEnabled: (deviceId) => ctx.isCapacityControlEnabled(deviceId),
    readContinuousBatteryPlan: (deviceId) => ctx.readContinuousBatteryPlan(deviceId),
    resolveManagedState: (deviceId) => ctx.resolveManagedState(deviceId),
    isExternalOffHoldActive: (deviceId, device) => (
      resolveExternalOffHoldActive(ctx.externalOffHold?.isHeld(deviceId) === true, device)
    ),
  };
}
