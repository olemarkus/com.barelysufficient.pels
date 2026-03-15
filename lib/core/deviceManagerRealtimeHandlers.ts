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
  notePendingBinarySettleObservation?: (
    deviceId: string,
    capabilityId: string,
    value: boolean,
  ) => boolean;
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
    notePendingBinarySettleObservation,
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
  const deferredBinarySettle = shouldDeferBinarySettleObservation({
    deviceId,
    capabilityId,
    value,
    notePendingBinarySettleObservation,
  });
  const reconcileSuffix = resolveCapabilityReconcileSuffix({
    isLocalEcho,
    deferredBinarySettle,
    shouldReconcilePlan: result.shouldReconcilePlan,
  });
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
  if (!result.shouldReconcilePlan || isLocalEcho || deferredBinarySettle) {
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

function shouldDeferBinarySettleObservation(params: {
  deviceId: string;
  capabilityId: string;
  value: unknown;
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
}): boolean {
  const {
    deviceId,
    capabilityId,
    value,
    notePendingBinarySettleObservation,
  } = params;
  return typeof value === 'boolean'
    && notePendingBinarySettleObservation?.(deviceId, capabilityId, value) === true;
}

function resolveCapabilityReconcileSuffix(params: {
  isLocalEcho: boolean;
  deferredBinarySettle: boolean;
  shouldReconcilePlan: boolean;
}): string {
  const {
    isLocalEcho,
    deferredBinarySettle,
    shouldReconcilePlan,
  } = params;
  if (isLocalEcho) return ' [local echo]';
  if (deferredBinarySettle) return ' [binary settling]';
  if (shouldReconcilePlan) return ' [drift detected]';
  return '';
}
