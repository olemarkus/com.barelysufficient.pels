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

export type ObservedDeviceStateEvent = {
  source: 'realtime_capability' | 'device_update';
  deviceId: string;
  capabilityId?: string;
};

export type HandleRealtimeDeviceUpdateResult = {
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
  changes: RealtimeDeviceReconcileChange[];
};

export type HandleRealtimeCapabilityUpdateResult = {
  isPower: boolean;
  isLocalEcho: boolean;
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
  changes: RealtimeDeviceReconcileChange[];
};

export function handleRealtimeDeviceUpdate(params: {
  device: HomeyDeviceLike;
  latestSnapshot: TargetDeviceSnapshot[];
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TargetDeviceSnapshot | null;
  logDebug: (message: string) => void;
  emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => void;
  emitObservedState: (event: ObservedDeviceStateEvent) => void;
}): HandleRealtimeDeviceUpdateResult {
  const {
    device,
    latestSnapshot,
    recentLocalCapabilityWrites,
    shouldTrackRealtimeDevice,
    parseDevice,
    logDebug,
    emitPlanReconcile,
    emitObservedState,
  } = params;
  const deviceId = device.id || device.data?.id;
  if (!deviceId || !shouldTrackRealtimeDevice(deviceId)) {
    return {
      hadChanges: false,
      shouldReconcilePlan: false,
      changes: [],
    };
  }
  const label = device.name || deviceId;
  const result = reconcileRealtimeDeviceUpdate({
    latestSnapshot,
    device,
    recentLocalCapabilityWrites,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
  });
  const reconcileSuffix = result.shouldReconcilePlan ? ' [drift detected]' : '';
  logDebug(`Realtime device.update received for ${label} (${deviceId})${reconcileSuffix}`);
  if (result.changes.length > 0) {
    emitObservedState({
      source: 'device_update',
      deviceId,
    });
  }
  if (!result.shouldReconcilePlan) {
    return {
      hadChanges: result.changes.length > 0,
      shouldReconcilePlan: false,
      changes: result.changes,
    };
  }
  emitPlanReconcile({
    deviceId,
    name: label,
    changes: result.changes,
  });
  return {
    hadChanges: result.changes.length > 0,
    shouldReconcilePlan: true,
    changes: result.changes,
  };
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
  emitObservedState: (event: ObservedDeviceStateEvent) => void;
}): HandleRealtimeCapabilityUpdateResult {
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
    emitObservedState,
  } = params;
  if (!shouldTrackRealtimeDevice(deviceId)) {
    return {
      isPower: false,
      isLocalEcho: false,
      hadChanges: false,
      shouldReconcilePlan: false,
      changes: [],
    };
  }
  const formattedValue = formatRealtimeCapabilityValue(value);
  if (isRealtimePowerCapability(capabilityId)) {
    logDebug(`Realtime capability update for ${label} (${deviceId}) via ${capabilityId}: ${formattedValue}`);
    handlePowerUpdate(deviceId, label, typeof value === 'number' ? value : null);
    return {
      isPower: true,
      isLocalEcho: false,
      hadChanges: true,
      shouldReconcilePlan: false,
      changes: [],
    };
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
  if (isLocalEcho || result.changes.length > 0) {
    emitObservedState({
      source: 'realtime_capability',
      deviceId,
      capabilityId,
    });
  }
  if (!result.shouldReconcilePlan || isLocalEcho) {
    return {
      isPower: false,
      isLocalEcho,
      hadChanges: isLocalEcho || result.changes.length > 0,
      shouldReconcilePlan: false,
      changes: result.changes,
    };
  }
  emitPlanReconcile({
    deviceId,
    name: label,
    capabilityId,
    changes: result.changes,
  });
  return {
    isPower: false,
    isLocalEcho: false,
    hadChanges: result.changes.length > 0,
    shouldReconcilePlan: true,
    changes: result.changes,
  };
}
