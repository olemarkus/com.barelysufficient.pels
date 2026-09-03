import type { ObservedDeviceState } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { ObservedDeviceStateRefreshPayload } from '../../../packages/contracts/src/observedDeviceState';
import type { HomeyDeviceLike } from '../../utils/types';
import type { RecentLocalCapabilityWrites } from './managerRealtimeSupport';
import {
  reconcileRealtimeDeviceUpdate,
  type RealtimeDeviceReconcileChange,
} from '../managerRuntime';
import { isStateOfChargeCapabilityId } from './stateOfCharge';

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
  // The decided observed value transport's fresher-wins merge produced for this
  // device, attached once at the dispatch funnel (`dispatchObservedStateChanged`)
  // so the observer projection records the merged value rather than re-merging.
  // Stage 4a of the snapshot decomposition.
  observed?: ObservedDeviceState;
};

export type DeviceObservationCursor = Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'>;

/**
 * Batch full-refresh event. One entry per device in the committed snapshot,
 * carrying a fresh per-device cursor (so it supersedes in-flight deltas) and
 * the decided observed value. Aliases the shared contracts payload so the
 * device-side type and the observer-side `ObservedStateRefreshEvent` can't
 * drift — neither layer imports the other; both reference contracts.
 */
export type ObservedDeviceStateRefreshEvent = ObservedDeviceStateRefreshPayload;

/**
 * Non-optional per-device observation cursor. `nextObservationCursor` always
 * resolves both fields; this type makes that an enforced invariant rather than
 * an `as number` assertion at the refresh-dispatch site.
 */
export type ObservationCursor = { observationSeq: number; observedAtMs: number };

export type DeviceUpdateProcessedDebugEvent = {
  event: 'device_update_processed';
  source: 'device_update';
  deviceId: string;
  deviceName: string | null;
  reasonCode: 'control_state_changed' | 'no_snapshot_change';
  observedControlStateChanged: boolean;
  changeCount: number;
  changes: RealtimeDeviceReconcileChange[];
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
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  currentSnapshot: TransportDeviceSnapshot | null | undefined;
};

export function handleRealtimeDeviceUpdate(params: {
  device: HomeyDeviceLike;
  latestSnapshot: TransportDeviceSnapshot[];
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TransportDeviceSnapshot | null;
  minSignificantPowerW?: number;
  recordObservedCapabilities?: (deviceId: string, capabilityIds: string[]) => void;
  emitDeviceUpdateProcessed?: (event: DeviceUpdateProcessedDebugEvent) => void;
  createObservationCursor?: (deviceId: string) => DeviceObservationCursor;
  emitObservedControlStateChanged: (event: PlanRealtimeUpdateEvent) => void;
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
    recentLocalCapabilityWrites,
    parseDevice: (nextDevice, nowTs) => parseDevice(nextDevice, nowTs),
  });
  const observedControlStateChanged = result.changes.length > 0;
  if (result.observedCapabilityIds.length > 0) {
    recordObservedCapabilities?.(deviceId, result.observedCapabilityIds);
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
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  measurePowerBecameSignificantlyPositive: boolean;
  createObservationCursor?: (deviceId: string) => DeviceObservationCursor;
  emitObservedControlStateChanged: (event: PlanRealtimeUpdateEvent) => void;
  emitObservedState: (event: ObservedDeviceStateEvent) => void;
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
  const eventCursor = createObservationCursor?.(deviceId) ?? {};
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
  changes: RealtimeDeviceReconcileChange[];
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
