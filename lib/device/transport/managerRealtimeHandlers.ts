import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { ObservationCursor, TransportObservationState } from './transportObservationState';
import {
  reconcileRealtimeDeviceUpdate,
} from '../managerRuntime';
import { isStateOfChargeCapabilityId } from './stateOfCharge';
import type {
  ObservedCapabilityChange,
  ObservedControlStateChangedEvent,
  ObservedStateChangedEvent,
} from '../../ports/observedStateEvents';

export type DeviceUpdateProcessedDebugEvent = {
  event: 'device_update_processed';
  source: 'device_update';
  deviceId: string;
  deviceName: string | null;
  reasonCode: 'control_state_changed' | 'no_snapshot_change';
  observedControlStateChanged: boolean;
  changeCount: number;
  changes: ObservedCapabilityChange[];
  observedCapabilityIds: string[];
  binaryCapabilityId: string | null;
  rawBinaryObserved: boolean;
  rawBinaryValue: boolean | null;
  previousCurrentOn: boolean | null;
  nextCurrentOn: boolean | null;
  previousMeasuredPowerKw: number | null;
  nextMeasuredPowerKw: number | null;
  measurePowerBecameSignificantlyPositive: boolean;
};

export type HandleRealtimeDeviceUpdateResult = {
  /**
   * At least one control-relevant capability moved in this event.
   *
   * Read the name as scoped to this result rather than as a universal claim
   * about the observation: the producer reports which capabilities moved, so a
   * `measure_temperature` move does not qualify.
   *
   * What it is NOT is a plan verb. The producer knows which capabilities are
   * control-relevant and whether it already dispatched; it does not know what
   * the plan wants, whether the device disagrees with it, or what should happen
   * next. Deciding that is the executor's
   * (`lib/executor/executorConvergence.ts`) and the planner's, in that order.
   *
   * Formerly `shouldReconcilePlan` — a producer naming a plan operation, which
   * is inversion #1 of the drift/reconcile layering problem. Do not reintroduce
   * an imperative name here. The flag still carries two things — the
   * observation fact and the dispatch-suppression bit — and they want
   * splitting into separate fields.
   */
  observedControlStateChanged: boolean;
  changes: ObservedCapabilityChange[];
  observedCapabilityIds: string[];
  currentSnapshot: TransportDeviceSnapshot | null | undefined;
};

export function handleRealtimeDeviceUpdate(params: {
  device: HomeyDeviceLike;
  latestSnapshot: TransportDeviceSnapshot[];
  observationState: TransportObservationState;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TransportDeviceSnapshot | null;
  minSignificantPowerW?: number;
  recordObservedCapabilities?: (deviceId: string, capabilityIds: string[]) => void;
  emitDeviceUpdateProcessed?: (event: DeviceUpdateProcessedDebugEvent) => void;
  createObservationCursor: (deviceId: string) => ObservationCursor;
  emitObservedControlStateChanged: (event: ObservedControlStateChangedEvent) => void;
  emitObservedState: (event: ObservedStateChangedEvent) => void;
}): HandleRealtimeDeviceUpdateResult {
  const {
    device,
    latestSnapshot,
    observationState,
    shouldTrackRealtimeDevice,
    parseDevice,
    minSignificantPowerW = 0,
    recordObservedCapabilities,
    emitDeviceUpdateProcessed,
    createObservationCursor,
    emitObservedControlStateChanged,
    emitObservedState,
  } = params;
  const deviceId = device.id;
  if (!shouldTrackRealtimeDevice(deviceId)) {
    return {
      observedControlStateChanged: false,
      changes: [],
      observedCapabilityIds: [],
      currentSnapshot: undefined,
    };
  }
  const label = device.name;

  const priorSnapshot = latestSnapshot.find((s) => s.id === deviceId);
  const binaryCapabilityId = priorSnapshot?.binaryObservationCapabilityId ?? priorSnapshot?.binaryCapabilityId;
  const rawBinaryValue = extractRawBinaryValue(device, binaryCapabilityId);

  const result = reconcileRealtimeDeviceUpdate({
    latestSnapshot,
    device,
    observationState,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
  });
  const observedControlStateChanged = result.changes.length > 0;
  // The receipt-time recorder skips what the reconcile already recorded at
  // Homey's own timestamps (`sourceDatedCapabilityIds`).
  const receiptTimedCapabilityIds = result.observedCapabilityIds.filter(
    (capabilityId) => !result.sourceDatedCapabilityIds.includes(capabilityId),
  );
  if (receiptTimedCapabilityIds.length > 0) {
    recordObservedCapabilities?.(deviceId, receiptTimedCapabilityIds);
  }
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
    binaryCapabilityId,
    rawBinaryValue,
    observedControlStateChanged,
    changes: result.changes,
    observedCapabilityIds: result.observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  }));
  emitDeviceObservationEvents({
    observedControlStateChanged,
    deviceId,
    label,
    changes: result.changes,
    observedCapabilityIds: result.observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
    createObservationCursor,
    emitObservedState,
    emitObservedControlStateChanged,
  });
  return {
    observedControlStateChanged,
    changes: result.changes,
    observedCapabilityIds: result.observedCapabilityIds,
    currentSnapshot: result.currentSnapshot,
  };
}

function emitDeviceObservationEvents(params: {
  observedControlStateChanged: boolean;
  deviceId: string;
  label?: string;
  changes: ObservedCapabilityChange[];
  observedCapabilityIds: string[];
  measurePowerBecameSignificantlyPositive: boolean;
  createObservationCursor: (deviceId: string) => ObservationCursor;
  emitObservedControlStateChanged: (event: ObservedControlStateChangedEvent) => void;
  emitObservedState: (event: ObservedStateChangedEvent) => void;
}): void {
  const {
    observedControlStateChanged,
    deviceId,
    label,
    changes,
    observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
    createObservationCursor,
    emitObservedState,
    emitObservedControlStateChanged,
  } = params;
  const observedNonControlFacet = observedCapabilityIds.some((capabilityId) => (
    capabilityId === 'measure_temperature' || isStateOfChargeCapabilityId(capabilityId)
  ));
  if (!observedControlStateChanged && !observedNonControlFacet) return;
  const eventCursor = createObservationCursor(deviceId);
  emitObservedState({
    source: 'device_update',
    deviceId,
    ...eventCursor,
    observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  });
  if (!observedControlStateChanged) return;
  emitObservedControlStateChanged({
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

function buildDeviceUpdateProcessedDebugEvent(params: {
  deviceId: string;
  deviceName?: string;
  priorSnapshot: TransportDeviceSnapshot | undefined;
  currentSnapshot: TransportDeviceSnapshot | null;
  binaryCapabilityId: string | undefined;
  rawBinaryValue: boolean | undefined;
  observedControlStateChanged: boolean;
  changes: ObservedCapabilityChange[];
  observedCapabilityIds: string[];
  measurePowerBecameSignificantlyPositive: boolean;
}): DeviceUpdateProcessedDebugEvent {
  const {
    deviceId,
    deviceName,
    priorSnapshot,
    currentSnapshot,
    binaryCapabilityId,
    rawBinaryValue,
    observedControlStateChanged,
    changes,
    observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  } = params;
  return {
    event: 'device_update_processed',
    source: 'device_update',
    deviceId,
    deviceName: deviceName ?? null,
    reasonCode: observedControlStateChanged ? 'control_state_changed' : 'no_snapshot_change',
    observedControlStateChanged,
    changeCount: changes.length,
    changes,
    observedCapabilityIds,
    binaryCapabilityId: binaryCapabilityId ?? null,
    rawBinaryObserved: hasRawBinaryObservation(rawBinaryValue),
    rawBinaryValue: rawBinaryValue ?? null,
    previousCurrentOn: priorSnapshot ? (priorSnapshot.binaryControl?.on ?? true) : null,
    nextCurrentOn: currentSnapshot ? (currentSnapshot.binaryControl?.on ?? true) : null,
    previousMeasuredPowerKw: priorSnapshot?.measuredPowerKw ?? null,
    nextMeasuredPowerKw: currentSnapshot?.measuredPowerKw ?? null,
    measurePowerBecameSignificantlyPositive,
  };
}

function hasRawBinaryObservation(rawBinaryValue: boolean | undefined): rawBinaryValue is boolean {
  return rawBinaryValue !== undefined;
}

function extractRawBinaryValue(device: HomeyDeviceLike, capabilityId: string | undefined): boolean | undefined {
  if (capabilityId === undefined) return undefined;
  const capValue = device.capabilitiesObj?.[capabilityId]?.value;
  return typeof capValue === 'boolean' ? capValue : undefined;
}
