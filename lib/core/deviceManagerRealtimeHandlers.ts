import type { HomeyDeviceLike, TargetDeviceSnapshot } from '../utils/types';
import type { RecentLocalCapabilityWrites } from './deviceManagerRealtimeSupport';
import {
  reconcileRealtimeDeviceUpdate,
  type RealtimeDeviceReconcileChange,
} from './deviceManagerRuntime';
import type { ParsedDeviceResult } from './deviceManagerParseDevice';

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
  canSettleBinary?: boolean;
  measurePowerBecameSignificantlyPositive?: boolean;
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
  parseDeviceWithControlObservation?: (device: HomeyDeviceLike, nowTs: number) => ParsedDeviceResult;
  minSignificantPowerW?: number;
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
    parseDeviceWithControlObservation,
    minSignificantPowerW = 0,
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
      currentSnapshot: undefined,
    };
  }
  const label = device.name;

  const priorSnapshot = latestSnapshot.find((s) => s.id === deviceId);
  let parsedResultForSettle: ParsedDeviceResult | undefined;

  const result = reconcileRealtimeDeviceUpdate({
    latestSnapshot,
    device,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
    parseDeviceWithControlObservation: parseDeviceWithControlObservation
      ? (nextDevice, nowTs) => {
        parsedResultForSettle = parseDeviceWithControlObservation(nextDevice, nowTs);
        return parsedResultForSettle;
      }
      : undefined,
  });
  const settleResult = applyPendingBinarySettleToDeviceUpdate({
    currentSnapshot: result.currentSnapshot,
    changes: result.changes,
    controlObservation: parsedResultForSettle?.controlObservation,
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
      canSettleBinary: parsedResultForSettle?.controlObservation.canSettleBinary,
      measurePowerBecameSignificantlyPositive: didMeasurePowerBecomeSignificantlyPositive(
        priorSnapshot?.measuredPowerKw,
        result.currentSnapshot?.measuredPowerKw,
        minSignificantPowerW,
      ),
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
  controlObservation: ParsedDeviceResult['controlObservation'] | undefined;
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
}): {
  changes: RealtimeDeviceReconcileChange[];
  binarySettleOutcome: BinarySettleOutcome;
} {
  const {
    currentSnapshot,
    changes,
    controlObservation,
    notePendingBinarySettleObservation,
  } = params;
  const deviceId = currentSnapshot?.id;
  const binaryCapabilityId = currentSnapshot?.controlCapabilityId;
  const observedValue = getSettleObservedBinaryValue(currentSnapshot, controlObservation);

  if (
    observedValue === undefined
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
    observedValue,
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

function getSettleObservedBinaryValue(
  snapshot: TargetDeviceSnapshot | null,
  controlObservation: ParsedDeviceResult['controlObservation'] | undefined,
): boolean | undefined {
  if (!snapshot || !controlObservation?.canSettleBinary) return undefined;
  if (snapshot.controlCapabilityId === 'evcharger_charging') {
    if (typeof snapshot.evCharging === 'boolean') return snapshot.evCharging;
    if (typeof snapshot.evChargingState === 'string') {
      return snapshot.evChargingState === 'plugged_in_charging'
        || snapshot.evChargingState === 'plugged_in_paused';
    }
    return undefined;
  }
  return snapshot.currentOn;
}
