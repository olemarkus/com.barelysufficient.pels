import { roundLogValue, shouldEmitOnChange } from '../logging/logDedupe';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import {
  formatBinaryState,
  formatTargetValue,
  getRecentLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './managerRealtimeSupport';
import {
  resolveEvChargingStateBinaryEvidence,
  resolveEvCurrentOn,
} from './managerControl';
import { EV_SOC_CAPABILITY_ID } from './stateOfCharge';

const REALTIME_CONTROL_CAPABILITY_IDS = ['onoff', 'evcharger_charging'] as const;
type RealtimeControlCapabilityId = NonNullable<TargetDeviceSnapshot['controlCapabilityId']>;

export type RealtimeDeviceReconcileChange = {
  capabilityId: string;
  previousValue: string;
  nextValue: string;
};

type RealtimeReconcileResult = {
  shouldReconcilePlan: boolean;
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  currentSnapshot: TargetDeviceSnapshot | null;
};

export function updateLastKnownPower(params: {
  state: {
    lastKnownPowerKw: Record<string, number>;
    lastPeakPowerLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
  };
  logger: Logger;
  deviceId: string;
  measuredKw: number;
  deviceLabel: string;
}): void {
  const {
    state,
    logger,
    deviceId,
    measuredKw,
    deviceLabel,
  } = params;
  const previousPeak = state.lastKnownPowerKw[deviceId] || 0;
  if (measuredKw <= previousPeak) return;

  state.lastKnownPowerKw[deviceId] = measuredKw;
  const previousPeakKw = roundLogValue(previousPeak, 2);
  const peakKw = roundLogValue(measuredKw, 2);
  const signature = JSON.stringify({ peakKw });
  if (!state.lastPeakPowerLogByDevice) return;
  if (!shouldEmitOnChange({
    state: state.lastPeakPowerLogByDevice,
    key: deviceId,
    signature,
    now: Date.now(),
  })) {
    return;
  }
  logger.structuredLog?.debug({
    event: 'power_estimate_peak_updated',
    deviceId,
    deviceName: deviceLabel,
    previousPeakKw,
    peakKw,
  });
}

export function reconcileRealtimeDeviceUpdate(params: {
  latestSnapshot: TargetDeviceSnapshot[];
  device: HomeyDeviceLike;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TargetDeviceSnapshot | null;
  recentLocalCapabilityWrites?: RecentLocalCapabilityWrites;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
}): RealtimeReconcileResult {
  const {
    latestSnapshot,
    device,
    parseDevice,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
  } = params;
  const deviceId = device.id;
  if (!deviceId) return {
    shouldReconcilePlan: false,
    changes: [],
    observedCapabilityIds: [],
    currentSnapshot: null,
  };

  const parsed = parseDevice(device, Date.now());
  const snapshotIndex = latestSnapshot.findIndex((entry) => entry.id === deviceId);
  const previous = snapshotIndex >= 0 ? latestSnapshot[snapshotIndex] : null;
  if (!parsed) {
    if (snapshotIndex >= 0) {
      latestSnapshot.splice(snapshotIndex, 1);
      return {
        shouldReconcilePlan: false,
        changes: [],
        observedCapabilityIds: [],
        currentSnapshot: null,
      };
    }
    return {
      shouldReconcilePlan: false,
      changes: [],
      observedCapabilityIds: [],
      currentSnapshot: null,
    };
  }

  applyExplicitControlObservation({
    device,
    parsed,
    previous,
  });
  const preservedBinaryControlObservation = getPreservedBinaryControlObservation(previous, parsed);
  if (preservedBinaryControlObservation) parsed.binaryControlObservation = preservedBinaryControlObservation;

  preserveRecentLocalBinaryState({
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
    binaryValueExplicitlyObserved: hasExplicitControlObservation({ device, parsed, previous }),
  });

  if (snapshotIndex >= 0) {
    latestSnapshot[snapshotIndex] = parsed;
  } else {
    latestSnapshot.push(parsed);
  }

  const changes = getPlanReconcileRealtimeChanges(previous, parsed);
  const observedCapabilityIds = getObservedCapabilityIds(previous, parsed);
  return {
    shouldReconcilePlan: changes.length > 0,
    changes,
    observedCapabilityIds,
    currentSnapshot: parsed,
  };
}

function applyExplicitControlObservation(params: {
  device: HomeyDeviceLike;
  parsed: TargetDeviceSnapshot;
  previous: TargetDeviceSnapshot | null;
}): void {
  const explicitObservation = resolveExplicitControlObservation(params);
  if (!explicitObservation) return;
  applyExplicitBinaryObservation({
    parsed: params.parsed,
    controlCapabilityId: explicitObservation.controlCapabilityId,
    value: explicitObservation.value,
  });
}

function hasExplicitControlObservation(params: {
  device: HomeyDeviceLike;
  parsed: TargetDeviceSnapshot;
  previous: TargetDeviceSnapshot | null;
}): boolean {
  return resolveExplicitControlObservation(params) !== null;
}

function resolveExplicitControlObservation(params: {
  device: HomeyDeviceLike;
  parsed: TargetDeviceSnapshot;
  previous: TargetDeviceSnapshot | null;
}): {
  controlCapabilityId: RealtimeControlCapabilityId;
  value: boolean;
} | null {
  const { device, parsed, previous } = params;
  const controlCapabilityId = parsed.controlCapabilityId ?? previous?.controlCapabilityId;
  if (typeof controlCapabilityId !== 'string') return null;
  if (!isRealtimeControlCapability(controlCapabilityId)) return null;
  const value = getExplicitObservedBinaryValue({
    device,
    controlCapabilityId,
    controlObservationCapabilityId: (
      parsed.controlObservationCapabilityId
      ?? previous?.controlObservationCapabilityId
      ?? controlCapabilityId
    ),
    previousEvChargingState: previous?.evChargingState,
  });
  if (value === undefined) return null;
  return { controlCapabilityId, value };
}

function getPreservedBinaryControlObservation(
  previous: TargetDeviceSnapshot | null,
  parsed: TargetDeviceSnapshot,
): TargetDeviceSnapshot['binaryControlObservation'] {
  if (!previous?.binaryControlObservation) return undefined;
  const nextObservation = parsed.binaryControlObservation;
  if (
    !nextObservation
    || nextObservation.observedAtMs < previous.binaryControlObservation.observedAtMs
  ) {
    return { ...previous.binaryControlObservation };
  }
  return undefined;
}

function applyExplicitBinaryObservation(params: {
  parsed: TargetDeviceSnapshot;
  controlCapabilityId: TargetDeviceSnapshot['controlCapabilityId'];
  value: boolean;
}): void {
  const { parsed, controlCapabilityId, value } = params;
  if (controlCapabilityId === 'evcharger_charging') {
    parsed.evCharging = value;
    parsed.currentOn = resolveEvCurrentOn({
      evChargingState: parsed.evChargingState,
      evchargerCharging: parsed.evCharging,
    });
    return;
  }
  parsed.currentOn = value;
}

function getExplicitObservedBinaryValue(params: {
  device: HomeyDeviceLike;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlObservationCapabilityId?: TargetDeviceSnapshot['controlObservationCapabilityId'];
  previousEvChargingState?: string;
}): boolean | undefined {
  const {
    device,
    controlCapabilityId,
    controlObservationCapabilityId,
    previousEvChargingState,
  } = params;
  if (typeof controlObservationCapabilityId !== 'string') return undefined;
  if (controlCapabilityId === 'evcharger_charging') {
    const rawStateValue = device.capabilitiesObj?.evcharger_charging_state?.value;
    if (rawStateValue !== undefined) {
      if (!Object.is(rawStateValue, previousEvChargingState)) {
        return resolveEvChargingStateBinaryEvidence(rawStateValue);
      }
    }
  }
  const value = device.capabilitiesObj?.[controlObservationCapabilityId]?.value;
  return typeof value === 'boolean' ? value : undefined;
}

function preserveRecentLocalBinaryState(params: {
  previous: TargetDeviceSnapshot | null;
  parsed: TargetDeviceSnapshot;
  deviceId: string;
  recentLocalCapabilityWrites?: RecentLocalCapabilityWrites;
  hasPendingBinarySettleWindow?: (deviceId: string, capabilityId: string) => boolean;
  binaryValueExplicitlyObserved?: boolean;
}): void {
  const {
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    hasPendingBinarySettleWindow,
    binaryValueExplicitlyObserved,
  } = params;
  if (!previous || !recentLocalCapabilityWrites) return;
  const capabilityId = parsed.controlCapabilityId ?? previous.controlCapabilityId;
  if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return;
  // Skip preservation only when a settle window is active AND the payload contained
  // an explicit boolean value. Without an explicit observation, parseDevice may
  // synthesize a default (getCurrentOn returns true when the value is absent), which
  // must not be passed to the settle window as a real observation.
  if (hasPendingBinarySettleWindow?.(deviceId, capabilityId) && binaryValueExplicitlyObserved) return;
  const localWrite = getRecentLocalCapabilityWrite({
    recentLocalCapabilityWrites,
    deviceId,
    capabilityId,
  });
  if (!localWrite || typeof localWrite.value !== 'boolean') return;
  if (typeof parsed.currentOn !== 'boolean') return;
  if (parsed.currentOn === localWrite.value) return;
  if (previous.currentOn !== localWrite.value) return;
  parsed.currentOn = previous.currentOn;
  if (capabilityId === 'evcharger_charging') {
    parsed.evCharging = previous.evCharging;
  }
}

function getPlanReconcileRealtimeChanges(
  previous: TargetDeviceSnapshot | null,
  next: TargetDeviceSnapshot,
): RealtimeDeviceReconcileChange[] {
  if (!previous) return [];

  const changes: RealtimeDeviceReconcileChange[] = [];
  if (previous.currentOn !== next.currentOn) {
    changes.push({
      capabilityId: next.controlCapabilityId ?? previous.controlCapabilityId ?? 'onoff',
      previousValue: formatBinaryState(previous.currentOn),
      nextValue: formatBinaryState(next.currentOn),
    });
  }

  const previousTargetsById = new Map(previous.targets.map((target) => [target.id, target]));
  for (const nextTarget of next.targets) {
    const previousTarget = previousTargetsById.get(nextTarget.id);
    if (!previousTarget || previousTarget.value === nextTarget.value) continue;
    changes.push({
      capabilityId: nextTarget.id,
      previousValue: formatTargetValue(previousTarget.value, nextTarget.unit),
      nextValue: formatTargetValue(nextTarget.value, nextTarget.unit),
    });
  }

  return changes;
}

function getObservedCapabilityIds(
  previous: TargetDeviceSnapshot | null,
  next: TargetDeviceSnapshot,
): string[] {
  if (!previous) return [];

  const capabilityIds = new Set<string>();
  if (previous.currentOn !== next.currentOn) {
    capabilityIds.add(next.controlCapabilityId ?? previous.controlCapabilityId ?? 'onoff');
  }
  if (previous.measuredPowerKw !== next.measuredPowerKw) {
    capabilityIds.add('measure_power');
  }
  if (previous.evChargingState !== next.evChargingState) {
    capabilityIds.add('evcharger_charging_state');
  }
  if (hasStateOfChargeObservationChanged(previous, next)) {
    capabilityIds.add(next.stateOfCharge.capabilityId ?? EV_SOC_CAPABILITY_ID);
  }

  const previousTargetsById = new Map(previous.targets.map((target) => [target.id, target]));
  for (const nextTarget of next.targets) {
    const previousTarget = previousTargetsById.get(nextTarget.id);
    if (!previousTarget || previousTarget.value === nextTarget.value) continue;
    capabilityIds.add(nextTarget.id);
  }

  return [...capabilityIds];
}

function hasStateOfChargeObservationChanged(
  previous: TargetDeviceSnapshot,
  next: TargetDeviceSnapshot,
): next is TargetDeviceSnapshot & { stateOfCharge: NonNullable<TargetDeviceSnapshot['stateOfCharge']> } {
  const previousSoc = previous.stateOfCharge;
  const nextSoc = next.stateOfCharge;
  if (!nextSoc) return false;
  return previousSoc?.capabilityId !== nextSoc.capabilityId
    || previousSoc?.percent !== nextSoc.percent
    || previousSoc?.observedAtMs !== nextSoc.observedAtMs;
}

export function isRealtimeControlCapability(
  capabilityId: string,
): capabilityId is (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number] {
  return REALTIME_CONTROL_CAPABILITY_IDS.includes(
    capabilityId as (typeof REALTIME_CONTROL_CAPABILITY_IDS)[number],
  );
}
