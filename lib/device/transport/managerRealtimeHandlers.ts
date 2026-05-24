import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import { resolveEvChargingStateBinaryEvidence } from '../managerControl';
import type { RecentLocalCapabilityWrites } from './managerRealtimeSupport';
import {
  reconcileRealtimeDeviceUpdate,
  type RealtimeDeviceReconcileChange,
} from '../managerRuntime';
import { isStateOfChargeCapabilityId } from '../stateOfCharge';

export type PlanRealtimeUpdateEvent = {
  deviceId: string;
  observationSeq?: number;
  observedAtMs?: number;
  name?: string;
  capabilityId?: string;
  changes?: RealtimeDeviceReconcileChange[];
};

export type ObservedDeviceStateEvent = {
  source: 'realtime_capability' | 'device_update';
  deviceId: string;
  observationSeq?: number;
  observedAtMs?: number;
  capabilityId?: string;
  observedCapabilityIds?: string[];
  measurePowerBecameSignificantlyPositive?: boolean;
};

export type DeviceObservationCursor = Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'>;

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

type BinarySettleEvidence = {
  value?: boolean;
  suppressRawBinaryChange?: boolean;
};

type PendingBinarySettleObservationRecorder = (
  deviceId: string,
  capabilityId: string,
  value: boolean,
  source: 'realtime_capability' | 'device_update',
  ensureEventFields?: () => DeviceObservationCursor,
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
  createObservationCursor?: (deviceId: string) => DeviceObservationCursor;
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
    createObservationCursor,
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

  // Extract explicit settlement evidence before reconcile so the settle window
  // receives the observed value rather than a preserved snapshot value.
  const priorSnapshot = latestSnapshot.find((s) => s.id === deviceId);
  const controlCapabilityId = priorSnapshot?.controlObservationCapabilityId ?? priorSnapshot?.controlCapabilityId;
  const rawBinaryValue = extractRawBinaryValue(device, controlCapabilityId);
  const binaryEvidence = extractBinarySettleEvidence(device, priorSnapshot);

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
    binaryEvidence,
    notePendingBinarySettleObservation,
    hasPendingBinarySettleWindow,
    createObservationCursor,
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
  emitDeviceObservationEvents({
    hadChanges,
    shouldReconcilePlan,
    deviceId,
    label,
    changes: filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
    cursor: settleResult.cursor,
    measurePowerBecameSignificantlyPositive,
    createObservationCursor,
    emitObservedState,
    emitPlanReconcile,
  });
  if (!shouldReconcilePlan) {
    return {
      hadChanges,
      shouldReconcilePlan: false,
      changes: filteredChanges,
      observedCapabilityIds: result.observedCapabilityIds,
      currentSnapshot: result.currentSnapshot,
    };
  }
  return {
    hadChanges,
    shouldReconcilePlan: true,
    changes: filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
    currentSnapshot: result.currentSnapshot,
  };
}

function emitDeviceObservationEvents(params: {
  hadChanges: boolean;
  shouldReconcilePlan: boolean;
  deviceId: string;
  label?: string;
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  cursor?: DeviceObservationCursor;
  measurePowerBecameSignificantlyPositive: boolean;
  createObservationCursor?: (deviceId: string) => DeviceObservationCursor;
  emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => void;
  emitObservedState: (event: ObservedDeviceStateEvent) => void;
}): void {
  const {
    hadChanges,
    shouldReconcilePlan,
    deviceId,
    label,
    changes,
    observedCapabilityIds,
    cursor,
    measurePowerBecameSignificantlyPositive,
    createObservationCursor,
    emitObservedState,
    emitPlanReconcile,
  } = params;
  const observedStateOfCharge = observedCapabilityIds.some((capabilityId) => (
    isStateOfChargeCapabilityId(capabilityId)
  ));
  if (!hadChanges && !observedStateOfCharge) return;
  const eventCursor = cursor ?? createObservationCursor?.(deviceId) ?? {};
  emitObservedState({
    source: 'device_update',
    deviceId,
    ...eventCursor,
    observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  });
  if (!shouldReconcilePlan) return;
  emitPlanReconcile({
    deviceId,
    ...eventCursor,
    name: label,
    changes,
  });
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
  binaryEvidence: BinarySettleEvidence;
  notePendingBinarySettleObservation?: PendingBinarySettleObservationRecorder;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
  createObservationCursor?: (deviceId: string) => DeviceObservationCursor;
}): {
  changes: RealtimeDeviceReconcileChange[];
  binarySettleOutcome: BinarySettleOutcome;
  cursor?: DeviceObservationCursor;
} {
  const {
    currentSnapshot,
    changes,
    binaryEvidence,
    notePendingBinarySettleObservation,
    hasPendingBinarySettleWindow,
    createObservationCursor,
  } = params;
  const deviceId = currentSnapshot?.id;
  const binaryCapabilityId = currentSnapshot?.controlCapabilityId;

  if (shouldSuppressPendingBinaryChange({
    binaryEvidence,
    currentSnapshot,
    deviceId,
    binaryCapabilityId,
    hasPendingBinarySettleWindow,
  })) {
    return {
      changes: changes.filter((change) => change.capabilityId !== binaryCapabilityId),
      binarySettleOutcome: 'none',
    };
  }

  const applicableEvidence = resolveApplicableBinarySettleEvidence({
    binaryEvidence,
    currentSnapshot,
    deviceId,
    binaryCapabilityId,
  });
  if (!applicableEvidence || !notePendingBinarySettleObservation) {
    return { changes, binarySettleOutcome: 'none' };
  }

  let cursor: DeviceObservationCursor | undefined;
  const ensureCursor = (): DeviceObservationCursor => {
    cursor ??= createObservationCursor?.(applicableEvidence.deviceId) ?? {};
    return cursor;
  };
  const outcome = notePendingBinarySettleObservation(
    applicableEvidence.deviceId,
    applicableEvidence.binaryCapabilityId,
    applicableEvidence.value,
    'device_update',
    ensureCursor,
  );

  if (outcome === 'settled' || outcome === 'drift') {
    // Binary change handled by settle window (reconcile already emitted on drift).
    // Filter it out to prevent a duplicate reconcile from this path.
    const filteredChanges = changes.filter((change) => change.capabilityId !== applicableEvidence.binaryCapabilityId);
    return { changes: filteredChanges, binarySettleOutcome: outcome, cursor: ensureCursor() };
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

function shouldSuppressPendingBinaryChange(params: {
  binaryEvidence: BinarySettleEvidence;
  currentSnapshot: TargetDeviceSnapshot | null;
  deviceId?: string;
  binaryCapabilityId?: string;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
}): boolean {
  const {
    binaryEvidence,
    currentSnapshot,
    deviceId,
    binaryCapabilityId,
    hasPendingBinarySettleWindow,
  } = params;
  if (binaryEvidence.value !== undefined) return false;
  if (binaryEvidence.suppressRawBinaryChange !== true) return false;
  if (currentSnapshot === null) return false;
  if (typeof deviceId !== 'string') return false;
  if (typeof binaryCapabilityId !== 'string') return false;
  return hasPendingBinarySettleWindow?.(deviceId, binaryCapabilityId) === true;
}

function resolveApplicableBinarySettleEvidence(params: {
  binaryEvidence: BinarySettleEvidence;
  currentSnapshot: TargetDeviceSnapshot | null;
  deviceId?: string;
  binaryCapabilityId?: string;
}): {
  deviceId: string;
  binaryCapabilityId: string;
  value: boolean;
} | null {
  const {
    binaryEvidence,
    currentSnapshot,
    deviceId,
    binaryCapabilityId,
  } = params;
  if (
    binaryEvidence.value !== undefined
    && currentSnapshot !== null
    && typeof deviceId === 'string'
    && typeof binaryCapabilityId === 'string'
  ) {
    return {
      deviceId,
      binaryCapabilityId,
      value: binaryEvidence.value,
    };
  }
  return null;
}

function extractBinarySettleEvidence(
  device: HomeyDeviceLike,
  priorSnapshot: TargetDeviceSnapshot | undefined,
): BinarySettleEvidence {
  const capabilityId = priorSnapshot?.controlObservationCapabilityId ?? priorSnapshot?.controlCapabilityId;
  if (capabilityId === undefined) return {};

  if (priorSnapshot?.controlCapabilityId === 'evcharger_charging') {
    const rawStateValue = device.capabilitiesObj?.evcharger_charging_state?.value;
    if (rawStateValue !== undefined) {
      const stateEvidence = resolveEvChargingStateBinaryEvidence(rawStateValue);
      const rawBinaryValue = extractRawBinaryValue(device, capabilityId);
      if (
        Object.is(rawStateValue, priorSnapshot.evChargingState)
        && stateEvidence !== undefined
        && rawBinaryValue !== undefined
        && rawBinaryValue !== stateEvidence
      ) {
        return { suppressRawBinaryChange: true };
      }
      return {
        value: stateEvidence,
        suppressRawBinaryChange: true,
      };
    }
    if (priorSnapshot.evChargingState !== undefined) {
      return {
        suppressRawBinaryChange: extractRawBinaryValue(device, capabilityId) !== undefined,
      };
    }
  }

  return { value: extractRawBinaryValue(device, capabilityId) };
}

function extractRawBinaryValue(device: HomeyDeviceLike, capabilityId: string | undefined): boolean | undefined {
  if (capabilityId === undefined) return undefined;
  const capValue = device.capabilitiesObj?.[capabilityId]?.value;
  return typeof capValue === 'boolean' ? capValue : undefined;
}
