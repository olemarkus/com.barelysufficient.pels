import type { HomeyDeviceLike, TargetDeviceSnapshot } from '../utils/types';
import {
  consumeMatchingLocalCapabilityWrite,
  formatRealtimeCapabilityValue,
  type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import {
  isRealtimePowerCapability,
  reconcileRealtimeCapabilityValue,
  reconcileRealtimeDeviceUpdate,
  type RealtimeDeviceReconcileChange,
} from './deviceManagerRuntime';

export type PlanRealtimeUpdateEvent = {
  deviceId: string;
  name: string;
  capabilityId?: string;
  changes?: RealtimeDeviceReconcileChange[];
};

export function handleRealtimeDeviceUpdate(params: {
  device: HomeyDeviceLike;
  latestSnapshot: TargetDeviceSnapshot[];
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TargetDeviceSnapshot | null;
  logDebug: (message: string) => void;
  emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => void;
}): void {
  const {
    device,
    latestSnapshot,
    shouldTrackRealtimeDevice,
    parseDevice,
    logDebug,
    emitPlanReconcile,
  } = params;
  const deviceId = device.id || device.data?.id;
  if (!deviceId || !shouldTrackRealtimeDevice(deviceId)) return;
  const label = device.name || deviceId;
  const result = reconcileRealtimeDeviceUpdate({
    latestSnapshot,
    device,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
  });
  const reconcileSuffix = result.shouldReconcilePlan ? ' [drift detected]' : '';
  logDebug(`Realtime device.update received for ${label} (${deviceId})${reconcileSuffix}`);
  if (!result.shouldReconcilePlan) return;
  emitPlanReconcile({
    deviceId,
    name: label,
    changes: result.changes,
  });
}

export function handleRealtimeCapabilityUpdate(params: {
  deviceId: string;
  label: string;
  capabilityId: string;
  value: unknown;
  latestSnapshot: TargetDeviceSnapshot[];
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  handlePowerUpdate: (deviceId: string, label: string, value: number | null) => void;
  logDebug: (message: string) => void;
  emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => void;
}): void {
  const {
    deviceId,
    label,
    capabilityId,
    value,
    latestSnapshot,
    recentLocalCapabilityWrites,
    shouldTrackRealtimeDevice,
    handlePowerUpdate,
    logDebug,
    emitPlanReconcile,
  } = params;
  if (!shouldTrackRealtimeDevice(deviceId)) return;
  const formattedValue = formatRealtimeCapabilityValue(value);
  if (isRealtimePowerCapability(capabilityId)) {
    logDebug(`Realtime capability update for ${label} (${deviceId}) via ${capabilityId}: ${formattedValue}`);
    handlePowerUpdate(deviceId, label, typeof value === 'number' ? value : null);
    return;
  }

  const result = reconcileRealtimeCapabilityValue({
    latestSnapshot,
    deviceId,
    capabilityId,
    value,
  });
  const isLocalEcho = consumeMatchingLocalCapabilityWrite({
    recentLocalCapabilityWrites,
    deviceId,
    capabilityId,
    value,
  });
  let reconcileSuffix = '';
  if (isLocalEcho) {
    reconcileSuffix = ' [local echo]';
  } else if (result.shouldReconcilePlan) {
    reconcileSuffix = ' [drift detected]';
  }
  logDebug(
    `Realtime capability update for ${label} (${deviceId}) `
    + `via ${capabilityId}: ${formattedValue}${reconcileSuffix}`,
  );
  if (!result.shouldReconcilePlan || isLocalEcho) return;
  emitPlanReconcile({
    deviceId,
    name: label,
    capabilityId,
    changes: result.changes,
  });
}
