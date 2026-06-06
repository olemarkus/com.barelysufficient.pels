import { roundLogValue, shouldEmitOnChange } from '../logging/logDedupe';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import {
  formatBinaryState,
  formatTargetValue,
  getRecentLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './transport/managerRealtimeSupport';
import {
  resolveEvChargingStateBinaryEvidence,
  resolveEvCurrentOn,
} from './managerControl';
import { EV_SOC_CAPABILITY_ID } from './transport/stateOfCharge';
import { getLogger } from '../logging/logger';

const moduleLogger = getLogger('device/manager-runtime');

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
  (logger.structuredLog ?? moduleLogger).debug({
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
}): RealtimeReconcileResult {
  const {
    latestSnapshot,
    device,
    parseDevice,
    recentLocalCapabilityWrites,
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

  const explicitControlObservation = resolveExplicitControlObservation({ device, parsed, previous });
  if (explicitControlObservation) {
    applyExplicitBinaryObservation({
      parsed,
      controlCapabilityId: explicitControlObservation.controlCapabilityId,
      value: explicitControlObservation.value,
      observedCapabilityId: explicitControlObservation.observedCapabilityId,
      observedAtMs: Date.now(),
    });
  }
  const preservedBinaryControlObservation = explicitControlObservation === null
    ? getPreservedBinaryControlObservation(previous, parsed)
    : undefined;
  if (preservedBinaryControlObservation) {
    applyBinaryControlObservation({
      parsed,
      observation: preservedBinaryControlObservation,
    });
  }

  preserveRecentLocalBinaryState({
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    binaryValueExplicitlyObserved: explicitControlObservation !== null,
  });

  if (snapshotIndex >= 0) {
    latestSnapshot[snapshotIndex] = parsed;
  } else {
    latestSnapshot.push(parsed);
  }

  const changes = getPlanReconcileRealtimeChanges(previous, parsed, {
    binaryValueExplicitlyObserved: explicitControlObservation !== null,
  });
  const observedCapabilityIds = getObservedCapabilityIds(previous, parsed, {
    binaryValueExplicitlyObserved: explicitControlObservation !== null,
  });
  return {
    shouldReconcilePlan: changes.length > 0,
    changes,
    observedCapabilityIds,
    currentSnapshot: parsed,
  };
}

function resolveExplicitControlObservation(params: {
  device: HomeyDeviceLike;
  parsed: TargetDeviceSnapshot;
  previous: TargetDeviceSnapshot | null;
}): {
  controlCapabilityId: RealtimeControlCapabilityId;
  value: boolean;
  observedCapabilityId: string;
} | null {
  const { device, parsed, previous } = params;
  const controlCapabilityId = parsed.controlCapabilityId ?? previous?.controlCapabilityId;
  if (typeof controlCapabilityId !== 'string') return null;
  if (!isRealtimeControlCapability(controlCapabilityId)) return null;
  const observation = getExplicitObservedBinaryObservation({
    device,
    controlCapabilityId,
    controlObservationCapabilityId: (
      parsed.controlObservationCapabilityId
      ?? previous?.controlObservationCapabilityId
      ?? controlCapabilityId
    ),
    previousEvChargingState: previous?.evChargingState,
  });
  if (!observation) return null;
  return { controlCapabilityId, ...observation };
}

function getPreservedBinaryControlObservation(
  previous: TargetDeviceSnapshot | null,
  parsed: TargetDeviceSnapshot,
): TargetDeviceSnapshot['binaryControlObservation'] {
  if (!previous?.binaryControlObservation) return undefined;
  if (
    parsed.controlCapabilityId !== undefined
    && previous.binaryControlObservation.capabilityId !== parsed.controlCapabilityId
  ) return undefined;
  const nextObservation = parsed.binaryControlObservation;
  if (
    !nextObservation
    || nextObservation.observedAtMs < previous.binaryControlObservation.observedAtMs
  ) {
    return { ...previous.binaryControlObservation };
  }
  return undefined;
}

function applyBinaryControlObservation(params: {
  parsed: TargetDeviceSnapshot;
  observation: NonNullable<TargetDeviceSnapshot['binaryControlObservation']>;
}): void {
  const { parsed, observation } = params;
  if (observation.capabilityId === 'evcharger_charging') {
    parsed.evCharging = observation.observedValue;
    parsed.currentOn = resolveEvCurrentOn({
      evChargingState: parsed.evChargingState,
      evchargerCharging: parsed.evCharging,
    });
  } else {
    parsed.currentOn = observation.observedValue;
  }
  parsed.binaryControlObservation = {
    ...observation,
    observedCapabilityIds: [...observation.observedCapabilityIds],
  };
}

function applyExplicitBinaryObservation(params: {
  parsed: TargetDeviceSnapshot;
  controlCapabilityId: TargetDeviceSnapshot['controlCapabilityId'];
  value: boolean;
  observedCapabilityId: string;
  observedAtMs: number;
}): void {
  const {
    parsed,
    controlCapabilityId,
    value,
    observedCapabilityId,
    observedAtMs,
  } = params;
  if (controlCapabilityId === 'evcharger_charging') {
    parsed.evCharging = value;
    parsed.currentOn = resolveEvCurrentOn({
      evChargingState: parsed.evChargingState,
      evchargerCharging: parsed.evCharging,
    });
  } else {
    parsed.currentOn = value;
  }
  if (controlCapabilityId !== undefined) {
    parsed.binaryControlObservation = {
      valid: true,
      capabilityId: controlCapabilityId,
      observedValue: value,
      observedCapabilityIds: [observedCapabilityId],
      observedAtMs,
      source: 'device_update',
    };
  }
}

function getExplicitObservedBinaryObservation(params: {
  device: HomeyDeviceLike;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlObservationCapabilityId?: TargetDeviceSnapshot['controlObservationCapabilityId'];
  previousEvChargingState?: string;
}): { value: boolean; observedCapabilityId: string } | undefined {
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
        const value = resolveEvChargingStateBinaryEvidence(rawStateValue);
        if (value !== undefined) {
          return { value, observedCapabilityId: 'evcharger_charging_state' };
        }
      }
    }
  }
  const value = device.capabilitiesObj?.[controlObservationCapabilityId]?.value;
  return typeof value === 'boolean'
    ? { value, observedCapabilityId: controlObservationCapabilityId }
    : undefined;
}

function preserveRecentLocalBinaryState(params: {
  previous: TargetDeviceSnapshot | null;
  parsed: TargetDeviceSnapshot;
  deviceId: string;
  recentLocalCapabilityWrites?: RecentLocalCapabilityWrites;
  binaryValueExplicitlyObserved?: boolean;
}): void {
  const {
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    binaryValueExplicitlyObserved,
  } = params;
  if (!previous || !recentLocalCapabilityWrites) return;
  const capabilityId = parsed.controlCapabilityId ?? previous.controlCapabilityId;
  if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return;
  // Without an explicit observation, parseDevice may synthesize a default that
  // must not be treated as stronger than a recent local write. Once the payload
  // carries an explicit binary value, that observed value wins.
  if (binaryValueExplicitlyObserved) return;
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
  options: { binaryValueExplicitlyObserved: boolean },
): RealtimeDeviceReconcileChange[] {
  if (!previous) return [];

  const changes: RealtimeDeviceReconcileChange[] = [];
  if (options.binaryValueExplicitlyObserved && previous.currentOn !== next.currentOn) {
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
  options: { binaryValueExplicitlyObserved: boolean },
): string[] {
  if (!previous) return [];

  const capabilityIds = new Set<string>();
  if (options.binaryValueExplicitlyObserved) {
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
