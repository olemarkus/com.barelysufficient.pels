import type { HomeyDeviceLike, TargetDeviceSnapshot } from '../utils/types';
import type { RecentLocalCapabilityWrites } from './deviceManagerRealtimeSupport';
import {
  reconcileRealtimeDeviceUpdate,
  type RealtimeDeviceReconcileChange,
} from './deviceManagerRuntime';

export type PlanRealtimeUpdateEvent = {
  deviceId: string;
  name?: string;
  capabilityId?: string;
  changes?: RealtimeDeviceReconcileChange[];
};

export type ObservedDeviceStateEvent = {
  source: 'realtime_capability' | 'device_update';
  deviceId: string;
  capabilityId?: string;
  measurePowerBecameSignificantlyPositive?: boolean;
};

export type DeviceUpdateProcessedDebugEvent = {
  event: 'device_update_processed';
  source: 'device_update';
  deviceId: string;
  deviceName: string | null;
  reasonCode: 'binary_settled' | 'binary_drift' | 'drift_detected' | 'changed_without_reconcile' | 'no_snapshot_change';
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
  rawChangeCount: number;
  filteredChangeCount: number;
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  controlCapabilityId: string | null;
  rawBinaryObserved: boolean;
  rawBinaryValue: boolean | null;
  binarySettleOutcome: BinarySettleOutcome;
  previousCurrentOn: boolean | null;
  nextCurrentOn: boolean | null;
  previousMeasuredPowerKw: number | null;
  nextMeasuredPowerKw: number | null;
  measurePowerBecameSignificantlyPositive: boolean;
};

export type HandleRealtimeDeviceUpdateResult = {
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  currentSnapshot: TargetDeviceSnapshot | null | undefined;
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
  minSignificantPowerW?: number;
  recordObservedCapabilities?: (deviceId: string, capabilityIds: string[]) => void;
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
  emitDeviceUpdateProcessed?: (event: DeviceUpdateProcessedDebugEvent) => void;
  emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => void;
  emitObservedState: (event: ObservedDeviceStateEvent) => void;
}): HandleRealtimeDeviceUpdateResult {
  const {
    device,
    latestSnapshot,
    recentLocalCapabilityWrites,
    shouldTrackRealtimeDevice,
    parseDevice,
    minSignificantPowerW = 0,
    recordObservedCapabilities,
    notePendingBinarySettleObservation,
    hasPendingBinarySettleWindow,
    emitDeviceUpdateProcessed,
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
      currentSnapshot: undefined,
    };
  }
  const label = device.name;

  // Extract the raw binary value from the device payload before reconcile so the
  // settle window receives the actual observed value rather than a preserved or
  // synthesized snapshot value.
  const priorSnapshot = latestSnapshot.find((s) => s.id === deviceId);
  const controlCapabilityId = priorSnapshot?.controlObservationCapabilityId ?? priorSnapshot?.controlCapabilityId;
  const rawBinaryValue = extractRawBinaryValue(
    device,
    controlCapabilityId,
  );

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
  // Use the pre-filter change count for hadChanges so that a drift-settled binary
  // observation (which is filtered from filteredChanges to avoid a double reconcile)
  // is still recorded as a meaningful update.
  const hadChanges = result.changes.length > 0;
  const measurePowerBecameSignificantlyPositive = didMeasurePowerBecomeSignificantlyPositive(
    priorSnapshot?.measuredPowerKw,
    result.currentSnapshot?.measuredPowerKw,
    minSignificantPowerW,
  );
  emitDeviceUpdateProcessed?.(buildDeviceUpdateProcessedDebugEvent({
    deviceId,
    deviceName: label,
    priorSnapshot,
    currentSnapshot: result.currentSnapshot,
    controlCapabilityId,
    rawBinaryValue,
    binarySettleOutcome: settleResult.binarySettleOutcome,
    hadChanges,
    shouldReconcilePlan,
    rawChanges: result.changes,
    filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  }));
  if (hadChanges) {
    emitObservedState({
      source: 'device_update',
      deviceId,
      measurePowerBecameSignificantlyPositive,
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

export function didMeasurePowerBecomeSignificantlyPositive(
  previousPowerKw: number | null | undefined,
  nextPowerKw: number | null | undefined,
  minSignificantPowerW: number,
): boolean {
  const thresholdKw = minSignificantPowerW / 1000;
  const previousKw = typeof previousPowerKw === 'number' ? previousPowerKw : 0;
  const nextKw = typeof nextPowerKw === 'number' ? nextPowerKw : 0;
  return previousKw <= thresholdKw && nextKw > thresholdKw;
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
    !hasRawBinaryObservation(rawBinaryValue)
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

function buildDeviceUpdateProcessedDebugEvent(params: {
  deviceId: string;
  deviceName?: string;
  priorSnapshot: TargetDeviceSnapshot | undefined;
  currentSnapshot: TargetDeviceSnapshot | null;
  controlCapabilityId: string | undefined;
  rawBinaryValue: boolean | undefined;
  binarySettleOutcome: BinarySettleOutcome;
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
  rawChanges: RealtimeDeviceReconcileChange[];
  filteredChanges: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  measurePowerBecameSignificantlyPositive: boolean;
}): DeviceUpdateProcessedDebugEvent {
  const {
    deviceId,
    deviceName,
    priorSnapshot,
    currentSnapshot,
    controlCapabilityId,
    rawBinaryValue,
    binarySettleOutcome,
    hadChanges,
    shouldReconcilePlan,
    rawChanges,
    filteredChanges,
    observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  } = params;
  return {
    event: 'device_update_processed',
    source: 'device_update',
    deviceId,
    deviceName: deviceName ?? null,
    reasonCode: resolveDeviceUpdateReasonCode({ binarySettleOutcome, hadChanges, shouldReconcilePlan }),
    hadChanges,
    shouldReconcilePlan,
    rawChangeCount: rawChanges.length,
    filteredChangeCount: filteredChanges.length,
    changes: filteredChanges,
    observedCapabilityIds,
    controlCapabilityId: controlCapabilityId ?? null,
    rawBinaryObserved: hasRawBinaryObservation(rawBinaryValue),
    rawBinaryValue: rawBinaryValue ?? null,
    binarySettleOutcome,
    previousCurrentOn: priorSnapshot?.currentOn ?? null,
    nextCurrentOn: currentSnapshot?.currentOn ?? null,
    previousMeasuredPowerKw: priorSnapshot?.measuredPowerKw ?? null,
    nextMeasuredPowerKw: currentSnapshot?.measuredPowerKw ?? null,
    measurePowerBecameSignificantlyPositive,
  };
}

function resolveDeviceUpdateReasonCode(params: {
  binarySettleOutcome: BinarySettleOutcome;
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
}): DeviceUpdateProcessedDebugEvent['reasonCode'] {
  const { binarySettleOutcome, hadChanges, shouldReconcilePlan } = params;
  if (binarySettleOutcome === 'settled') return 'binary_settled';
  if (binarySettleOutcome === 'drift') return 'binary_drift';
  if (shouldReconcilePlan) return 'drift_detected';
  if (hadChanges) return 'changed_without_reconcile';
  return 'no_snapshot_change';
}

function hasRawBinaryObservation(rawBinaryValue: boolean | undefined): rawBinaryValue is boolean {
  return rawBinaryValue !== undefined;
}

/** Returns the explicit boolean value for `capabilityId` from the device payload, or
 *  undefined if the capability is absent or its value is not a boolean. */
function extractRawBinaryValue(device: HomeyDeviceLike, capabilityId: string | undefined): boolean | undefined {
  if (capabilityId === undefined) return undefined;
  const capValue = device.capabilitiesObj?.[capabilityId]?.value;
  return typeof capValue === 'boolean' ? capValue : undefined;
}
