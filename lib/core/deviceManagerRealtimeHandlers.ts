import type { HomeyDeviceLike, TargetDeviceSnapshot } from '../utils/types';
import type { RecentLocalCapabilityWrites } from './deviceManagerRealtimeSupport';
import {
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
  observedCapabilityIds: string[];
};

type PendingBinarySettleObservationRecorder = (
  deviceId: string,
  capabilityId: string,
  value: boolean,
) => boolean;

export function handleRealtimeDeviceUpdate(params: {
  device: HomeyDeviceLike;
  latestSnapshot: TargetDeviceSnapshot[];
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TargetDeviceSnapshot | null;
  recordObservedCapabilities?: (deviceId: string, capabilityIds: string[]) => void;
  notePendingBinarySettleObservation?: (
    deviceId: string,
    capabilityId: string,
    value: boolean,
  ) => boolean;
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
    recordObservedCapabilities,
    notePendingBinarySettleObservation,
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
      observedCapabilityIds: [],
    };
  }
  const label = device.name || deviceId;
  const result = reconcileRealtimeDeviceUpdate({
    latestSnapshot,
    device,
    recentLocalCapabilityWrites,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
  });
  const settleResult = applyPendingBinarySettleToDeviceUpdate({
    latestSnapshot,
    deviceId,
    changes: result.changes,
    notePendingBinarySettleObservation,
  });
  const filteredChanges = settleResult.changes;
  const shouldReconcilePlan = filteredChanges.length > 0;
  if (result.observedCapabilityIds.length > 0) {
    recordObservedCapabilities?.(deviceId, result.observedCapabilityIds);
  }
  let reconcileSuffix = '';
  if (settleResult.binaryChangeDeferred) {
    reconcileSuffix = ' [binary settling]';
  } else if (shouldReconcilePlan) {
    reconcileSuffix = ' [drift detected]';
  }
  logDebug(`Realtime device.update received for ${label} (${deviceId})${reconcileSuffix}`);
  if (result.changes.length > 0) {
    emitObservedState({
      source: 'device_update',
      deviceId,
    });
  }
  if (!shouldReconcilePlan) {
    return {
      hadChanges: filteredChanges.length > 0,
      shouldReconcilePlan: false,
      changes: filteredChanges,
      observedCapabilityIds: result.observedCapabilityIds,
    };
  }
  emitPlanReconcile({
    deviceId,
    name: label,
    changes: filteredChanges,
  });
  return {
    hadChanges: filteredChanges.length > 0,
    shouldReconcilePlan: true,
    changes: filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
  };
}

function applyPendingBinarySettleToDeviceUpdate(params: {
  latestSnapshot: TargetDeviceSnapshot[];
  deviceId: string;
  changes: RealtimeDeviceReconcileChange[];
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
}): {
  changes: RealtimeDeviceReconcileChange[];
  binaryChangeDeferred: boolean;
} {
  const {
    latestSnapshot,
    deviceId,
    changes,
    notePendingBinarySettleObservation,
  } = params;
  const currentSnapshot = latestSnapshot.find((entry) => entry.id === deviceId);
  const binaryCapabilityId = currentSnapshot?.controlCapabilityId;
  const shouldDefer = (
    typeof currentSnapshot?.currentOn === 'boolean'
    && typeof binaryCapabilityId === 'string'
    && notePendingBinarySettleObservation?.(
      deviceId,
      binaryCapabilityId,
      currentSnapshot.currentOn,
    ) === true
  );
  if (!shouldDefer) {
    return {
      changes,
      binaryChangeDeferred: false,
    };
  }

  const filteredChanges = changes.filter((change) => change.capabilityId !== binaryCapabilityId);
  return {
    changes: filteredChanges,
    binaryChangeDeferred: filteredChanges.length !== changes.length,
  };
}
