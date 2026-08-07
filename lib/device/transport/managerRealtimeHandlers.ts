import type { ObservedDeviceState } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { ObservedDeviceStateRefreshPayload } from '../../../packages/contracts/src/observedDeviceState';
import type { HomeyDeviceLike } from '../../utils/types';
import { resolveEvChargingStateBinaryEvidence } from '../managerControl';
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
  reasonCode:
    | 'binary_settled'
    | 'binary_drift'
    | 'control_state_changed'
    | 'changed_without_control_effect'
    | 'no_snapshot_change';
  hadChanges: boolean;
  observedControlStateChanged: boolean;
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
  /**
   * At least one control-relevant capability moved in this event AND was not
   * already consumed by the pending-binary settle window.
   *
   * Both halves are load-bearing, so read the name as scoped to this result
   * rather than as a universal claim about the observation:
   * - control-relevant: `hadChanges` counts RAW changes; this counts the
   *   filtered set, so a `measure_temperature` move does not qualify.
   * - not already settled: `applyPendingBinarySettleToDeviceUpdate` removes a
   *   binary change it classified as `settled`/`drift`, because that path has
   *   already dispatched for it. A pending-command confirmation therefore
   *   reports `false` here while `hadChanges`/`result.changes` still record the
   *   real transition — deliberately, to avoid dispatching twice for one event.
   *
   * What it is NOT is a plan verb. The producer knows which capabilities are
   * control-relevant and whether it already dispatched; it does not know what
   * the plan wants, whether the device disagrees with it, or what should happen
   * next. Deciding that is the executor's
   * (`lib/executor/executorConvergence.ts`) and the planner's, in that order.
   *
   * Formerly `shouldReconcilePlan` — a producer naming a plan operation, which
   * is inversion #1 of the drift/reconcile layering problem. Do not reintroduce
   * an imperative name here. Splitting the observation fact from the
   * dispatch-suppression bit is tracked in `TODO.md`.
   */
  observedControlStateChanged: boolean;
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  currentSnapshot: TransportDeviceSnapshot | null | undefined;
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
  latestSnapshot: TransportDeviceSnapshot[];
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TransportDeviceSnapshot | null;
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
      observedControlStateChanged: false,
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
  const observedControlStateChanged = filteredChanges.length > 0;
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
    observedControlStateChanged,
    rawChanges: result.changes,
    filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
    measurePowerBecameSignificantlyPositive,
  }));
  emitDeviceObservationEvents({
    hadChanges,
    observedControlStateChanged,
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
  if (!observedControlStateChanged) {
    return {
      hadChanges,
      observedControlStateChanged: false,
      changes: filteredChanges,
      observedCapabilityIds: result.observedCapabilityIds,
      currentSnapshot: result.currentSnapshot,
    };
  }
  return {
    hadChanges,
    observedControlStateChanged: true,
    changes: filteredChanges,
    observedCapabilityIds: result.observedCapabilityIds,
    currentSnapshot: result.currentSnapshot,
  };
}

function emitDeviceObservationEvents(params: {
  hadChanges: boolean;
  observedControlStateChanged: boolean;
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
    observedControlStateChanged,
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
  if (!observedControlStateChanged) return;
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
  currentSnapshot: TransportDeviceSnapshot | null;
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
  priorSnapshot: TransportDeviceSnapshot | undefined;
  currentSnapshot: TransportDeviceSnapshot | null;
  controlCapabilityId: string | undefined;
  rawBinaryValue: boolean | undefined;
  binarySettleOutcome: BinarySettleOutcome;
  hadChanges: boolean;
  observedControlStateChanged: boolean;
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
    observedControlStateChanged,
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
    reasonCode: resolveDeviceUpdateReasonCode({ binarySettleOutcome, hadChanges, observedControlStateChanged }),
    hadChanges,
    observedControlStateChanged,
    rawChangeCount: rawChanges.length,
    filteredChangeCount: filteredChanges.length,
    changes: filteredChanges,
    observedCapabilityIds,
    controlCapabilityId: controlCapabilityId ?? null,
    rawBinaryObserved: hasRawBinaryObservation(rawBinaryValue),
    rawBinaryValue: rawBinaryValue ?? null,
    binarySettleOutcome,
    previousCurrentOn: priorSnapshot ? (priorSnapshot.binaryControl?.on ?? true) : null,
    nextCurrentOn: currentSnapshot ? (currentSnapshot.binaryControl?.on ?? true) : null,
    previousMeasuredPowerKw: priorSnapshot?.measuredPowerKw ?? null,
    nextMeasuredPowerKw: currentSnapshot?.measuredPowerKw ?? null,
    measurePowerBecameSignificantlyPositive,
  };
}

function resolveDeviceUpdateReasonCode(params: {
  binarySettleOutcome: BinarySettleOutcome;
  hadChanges: boolean;
  observedControlStateChanged: boolean;
}): DeviceUpdateProcessedDebugEvent['reasonCode'] {
  const { binarySettleOutcome, hadChanges, observedControlStateChanged } = params;
  if (binarySettleOutcome === 'settled') return 'binary_settled';
  if (binarySettleOutcome === 'drift') return 'binary_drift';
  if (observedControlStateChanged) return 'control_state_changed';
  if (hadChanges) return 'changed_without_control_effect';
  return 'no_snapshot_change';
}

function hasRawBinaryObservation(rawBinaryValue: boolean | undefined): rawBinaryValue is boolean {
  return rawBinaryValue !== undefined;
}

function shouldSuppressPendingBinaryChange(params: {
  binaryEvidence: BinarySettleEvidence;
  currentSnapshot: TransportDeviceSnapshot | null;
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
  currentSnapshot: TransportDeviceSnapshot | null;
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
  priorSnapshot: TransportDeviceSnapshot | undefined,
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
