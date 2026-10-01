import type { AppContext } from '../lib/app/appContext';
import { DeviceTargetPowerReachabilityOwner } from '../lib/device/deviceTargetPowerReachabilityOwner';
import { SteppedDeviceControl } from '../lib/executor/steppedDeviceControl';
import { TargetPowerCommandLifecycle } from '../lib/executor/targetPowerCommandLifecycle';
import { DeviceControlProjection } from '../lib/planInput/deviceControlProjection';
import { getDebugEmitter, getLogger } from '../lib/logging/logger';
import { requireDeviceManager, requirePlanService } from './appInit/contextGuards';

/** Bind owner reads, executor lifecycle and pure runtime projection. */
export const createDeviceControlHelpers = (
  ctx: AppContext,
  updateReachability: DeviceTargetPowerReachabilityOwner['update'],
  scheduleSettlement: (dueAtMs: number) => void,
) => {
  const loggers = { structuredLog: getLogger('devices'), debugStructured: getDebugEmitter('devices', 'devices') };
  const reachabilityOwner = new DeviceTargetPowerReachabilityOwner(
    (deviceId) => ctx.deviceTargetPowerConfigs[deviceId],
    (deviceId) => ctx.deviceConfiguration.get(deviceId), updateReachability,
  );
  const targetPower = new TargetPowerCommandLifecycle(ctx.steppedCommandStore, reachabilityOwner,
    scheduleSettlement, loggers);
  const control = new SteppedDeviceControl(ctx.steppedCommandStore, ctx.steppedReportedStore, {
    getDeviceConfiguration: (deviceId) => ctx.deviceConfiguration.get(deviceId),
    getDeviceConfigurations: () => ctx.deviceConfiguration.getAll(),
    getObservedState: (deviceId) => ctx.getObservedRecord(deviceId),
  }, targetPower,
  (deviceId, stepId, powerW) => requireDeviceManager(ctx).reportSteppedLoadActualStep(deviceId, stepId, powerW),
  (deviceId, profile) => requirePlanService(ctx).getLatestPlannedStepId(deviceId, profile), loggers);
  const projection = new DeviceControlProjection(ctx.steppedCommandStore, ctx.deviceConfiguration,
    (deviceId) => ctx.getObservedRecord(deviceId),
    (deviceId) => ctx.isTemperatureControlDisabled(deviceId),
    (deviceId) => ctx.observedTemperatureModeUpdates.allowsAutomaticAdjustments(deviceId));
  return {
    getSteppedLoadProfile: control.getSteppedLoadProfile.bind(control),
    getSteppedLoadCommandSession: control.getSteppedLoadCommandSession.bind(control),
    markSteppedLoadDesiredStepIssued: control.markSteppedLoadDesiredStepIssued.bind(control),
    hasPendingTargetPowerProbe: control.hasPendingTargetPowerProbe.bind(control),
    reconcileTargetPowerReachability: control.reconcileTargetPowerReachability.bind(control),
    reportSteppedLoadActualStep: control.reportSteppedLoadActualStep.bind(control),
    getRuntimeStateForTests: control.getRuntimeStateForTests.bind(control),
    decorateTargetSnapshotList: projection.decorateTargetSnapshotList.bind(projection),
    getLifecycleFallbackDevice: projection.getLifecycleFallbackDevice.bind(projection),
  };
};

export type DeviceControlHelpers = ReturnType<typeof createDeviceControlHelpers>;
