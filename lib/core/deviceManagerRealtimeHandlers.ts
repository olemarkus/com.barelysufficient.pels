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
  currentSnapshot: TargetDeviceSnapshot | null;
};

type BinarySettleOutcome = 'settled' | 'drift' | 'none';

type PendingBinarySettleObservationRecorder = (
  deviceId: string,
  capabilityId: string,
  value: boolean,
  source: 'realtime_capability' | 'device_update',
) => BinarySettleOutcome;

export function handleRealtimeDeviceUpdate(params: {
  device: HomeyDeviceLike;
  latestSnapshot: TargetDeviceSnapshot[];
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TargetDeviceSnapshot | null;
  recordObservedCapabilities?: (deviceId: string, capabilityIds: string[]) => void;
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
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
    hasPendingBinarySettleWindow,
    logDebug,
    emitPlanReconcile,
    emitObservedState,
  } = params;
  const deviceId = device.id;
  if (!shouldTrackRealtimeDevice(deviceId)) {
    return {
      hadChanges: false,
      shouldReconcilePlan: false,
      changes: [],
      observedCapabilityIds: [],
      currentSnapshot: null,
    };
  }
  const label = device.name;

  // Extract the raw binary value from the device payload before reconcile so the
  // settle window receives the actual observed value rather than a preserved or
  // synthesized snapshot value.
  const priorSnapshot = latestSnapshot.find((s) => s.id === deviceId);
  const rawBinaryValue = extractRawBinaryValue(device, priorSnapshot?.controlCapabilityId);

  const result = reconcileRealtimeDeviceUpdate({
    latestSnapshot,
    device,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
  });
  const settleResult = applyPendingBinarySettleToDeviceUpdate({
    currentSnapshot: result.currentSnapshot,
    changes: result.changes,
    rawBinaryValue,
    notePendingBinarySettleObservation,
  });
  const filteredChanges = settleResult.changes;
  const shouldReconcilePlan = filteredChanges.length > 0;
  if (result.observedCapabilityIds.length > 0) {
    recordObservedCapabilities?.(deviceId, result.observedCapabilityIds);
  }
  const suffix = buildReconcileSuffix(settleResult.binarySettleOutcome, shouldReconcilePlan);
  logDebug(`Realtime device.update received for ${label} (${deviceId})${suffix}`);
  // Use the pre-filter change count for hadChanges so that a drift-settled binary
  // observation (which is filtered from filteredChanges to avoid a double reconcile)
  // is still recorded as a meaningful update.
  const hadChanges = result.changes.length > 0;
  if (hadChanges) {
    emitObservedState({
      source: 'device_update',
      deviceId,
    });
  }
  if (!shouldReconcilePlan) {
    return {
      hadChanges,
      shouldReconcilePlan: false,
      changes: filteredChanges,
      observedCapabilityIds: result.observedCapabilityIds,
      currentSnapshot: result.currentSnapshot,
    };
  }
  emitPlanReconcile({
    deviceId,
    name: label,
    changes: filteredChanges,
  });
  return {
    hadChanges,
    shouldReconcilePlan: true,
    changes: filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
    currentSnapshot: result.currentSnapshot,
  };
}

function applyPendingBinarySettleToDeviceUpdate(params: {
  currentSnapshot: TargetDeviceSnapshot | null;
  changes: RealtimeDeviceReconcileChange[];
  rawBinaryValue: boolean | undefined;
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
}): {
  changes: RealtimeDeviceReconcileChange[];
  binarySettleOutcome: BinarySettleOutcome;
} {
  const {
    currentSnapshot,
    changes,
    rawBinaryValue,
    notePendingBinarySettleObservation,
  } = params;
  const deviceId = currentSnapshot?.id;
  const binaryCapabilityId = currentSnapshot?.controlCapabilityId;

  // rawBinaryValue is undefined when the device.update payload contained no explicit
  // boolean for the control capability — treat it as no observation (do not resolve).
  if (
    rawBinaryValue === undefined
    || !currentSnapshot
    || !deviceId
    || typeof binaryCapabilityId !== 'string'
    || !notePendingBinarySettleObservation
  ) {
    return { changes, binarySettleOutcome: 'none' };
  }

  const outcome = notePendingBinarySettleObservation(
    deviceId,
    binaryCapabilityId,
    rawBinaryValue,
    'device_update',
  );

  if (outcome === 'settled' || outcome === 'drift') {
    // Binary change handled by settle window (reconcile already emitted on drift).
    // Filter it out to prevent a duplicate reconcile from this path.
    const filteredChanges = changes.filter((change) => change.capabilityId !== binaryCapabilityId);
    return { changes: filteredChanges, binarySettleOutcome: outcome };
  }

  return { changes, binarySettleOutcome: 'none' };
}

function buildReconcileSuffix(outcome: BinarySettleOutcome, shouldReconcilePlan: boolean): string {
  if (outcome === 'settled') return ' [binary settled]';
  if (outcome === 'drift') return ' [binary drift]';
  if (shouldReconcilePlan) return ' [drift detected]';
  return '';
}

/** Returns the explicit boolean value for `capabilityId` from the device payload, or
 *  undefined if the capability is absent or its value is not a boolean. */
function extractRawBinaryValue(device: HomeyDeviceLike, capabilityId: string | undefined): boolean | undefined {
  if (capabilityId === undefined) return undefined;
  const capValue = device.capabilitiesObj?.[capabilityId]?.value;
  return typeof capValue === 'boolean' ? capValue : undefined;
}
