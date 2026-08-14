import { roundLogValue, shouldEmitOnChange } from '../logging/logDedupe';
import { resolveBinaryOn } from '../utils/binaryControl';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import {
  formatBinaryState,
  formatTargetValue,
  getRecentLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './transport/managerRealtimeSupport';
import { EV_SOC_CAPABILITY_ID } from './transport/stateOfCharge';
import { getLogger } from '../logging/logger';
import {
  applyExplicitBinaryObservation,
  preserveRejectedExplicitBinaryObservation,
  preserveStaleBundledEvState,
  resolveExplicitBinaryEvidence,
  type ExplicitControlObservation,
} from './transport/managerExplicitBinaryObservation';
import { preserveNewerReportedStepObservation } from './transport/reportedStepObservation';
import { nextLearnedPeak, type LearnedPeaksByDeviceId } from './devicePowerPeak';
import { preserveTemperatureAcrossPartialDeviceUpdate } from './transport/temperatureObservation';

const moduleLogger = getLogger('device/manager-runtime');

const REALTIME_CONTROL_CAPABILITY_IDS = ['onoff', 'evcharger_charging'] as const;
type RealtimeControlCapabilityId = NonNullable<TransportDeviceSnapshot['binaryCapabilityId']>;

export type RealtimeDeviceReconcileChange = {
  capabilityId: string;
  observedCapabilityId?: string;
  previousValue: string;
  nextValue: string;
};

type RealtimeReconcileResult = {
  observedControlStateChanged: boolean;
  changes: RealtimeDeviceReconcileChange[];
  observedCapabilityIds: string[];
  currentSnapshot: TransportDeviceSnapshot | null;
};

/**
 * Record a measured reading against the device's learned peak.
 *
 * The max/expiry policy lives in `devicePowerPeak.ts`; this owns the mutation,
 * the change log, and telling the wiring the record moved. `nowMs` is
 * when PELS took the reading — see that module for why the window must not be
 * anchored on the capability's `lastUpdated`.
 */
export function updateLastKnownPower(params: {
  state: {
    lastKnownPowerKw: LearnedPeaksByDeviceId;
    lastPeakPowerLogByDevice?: Map<string, { signature: string; emittedAt: number }>;
  };
  logger: Logger;
  deviceId: string;
  measuredKw: number;
  deviceLabel: string;
  nowMs: number;
  /**
   * Fired when the record actually moved — a new entry, a higher one, or a
   * re-anchored window. Persistence hangs off this rather than the
   * snapshot-mutation seam, because that seam fires on a CHANGED calibration
   * input and a reading equal to the standing peak changes none while still
   * re-anchoring `observedAtMs`: the window a steady device is keeping alive
   * would otherwise expire in settings while memory said it was fresh.
   */
  onPeakChanged?: () => void;
}): void {
  const {
    state,
    logger,
    deviceId,
    measuredKw,
    deviceLabel,
    nowMs,
    onPeakChanged,
  } = params;
  const previous = state.lastKnownPowerKw[deviceId];
  const next = nextLearnedPeak(previous, measuredKw, nowMs);
  if (!next) return;

  state.lastKnownPowerKw[deviceId] = next;
  // Announced before the log dedupe below, which returns early for a peak that
  // reads the same as last time — exactly the re-anchored window this exists for.
  onPeakChanged?.();
  const previousPeakKw = roundLogValue(previous?.kw ?? 0, 2);
  const peakKw = roundLogValue(next.kw, 2);
  const signature = JSON.stringify({ peakKw });
  if (!state.lastPeakPowerLogByDevice) return;
  if (!shouldEmitOnChange({
    state: state.lastPeakPowerLogByDevice,
    key: deviceId,
    signature,
    now: nowMs,
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
  latestSnapshot: TransportDeviceSnapshot[];
  device: HomeyDeviceLike;
  parseDevice: (device: HomeyDeviceLike, nowTs: number) => TransportDeviceSnapshot | null;
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
    observedControlStateChanged: false,
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
        observedControlStateChanged: false,
        changes: [],
        observedCapabilityIds: [],
        currentSnapshot: null,
      };
    }
    return {
      observedControlStateChanged: false,
      changes: [],
      observedCapabilityIds: [],
      currentSnapshot: null,
    };
  }

  const explicitBinaryValueAccepted = applyExplicitControlObservationFromUpdate({
    device,
    parsed,
    previous,
  });
  const preservedBinaryControlObservation = explicitBinaryValueAccepted === null
    ? getPreservedBinaryControlObservation(previous, parsed)
    : undefined;
  if (preservedBinaryControlObservation) {
    applyBinaryControlObservation({
      parsed,
      previous,
      observation: preservedBinaryControlObservation,
    });
  }

  preserveRecentLocalBinaryState({
    previous,
    parsed,
    deviceId,
    recentLocalCapabilityWrites,
    binaryValueExplicitlyObserved: explicitBinaryValueAccepted === true,
  });
  if (previous) preserveNewerReportedStepObservation(previous, parsed);
  const resolvedParsed = previous
    ? preserveTemperatureAcrossPartialDeviceUpdate({ device, previous, parsed })
    : parsed;

  if (snapshotIndex >= 0) {
    latestSnapshot[snapshotIndex] = resolvedParsed;
  } else {
    latestSnapshot.push(resolvedParsed);
  }

  const changes = getPlanReconcileRealtimeChanges(previous, resolvedParsed, {
    binaryValueExplicitlyObserved: explicitBinaryValueAccepted === true,
  });
  const observedCapabilityIds = getObservedCapabilityIds(previous, resolvedParsed, {
    binaryValueExplicitlyObserved: explicitBinaryValueAccepted === true,
  });
  return {
    observedControlStateChanged: changes.length > 0,
    changes,
    observedCapabilityIds,
    currentSnapshot: resolvedParsed,
  };
}

function applyExplicitControlObservationFromUpdate(params: {
  device: HomeyDeviceLike;
  parsed: TransportDeviceSnapshot;
  previous: TransportDeviceSnapshot | null;
}): boolean | null {
  const { device, parsed, previous } = params;
  const observation = resolveExplicitControlObservation({ device, parsed, previous });
  if (!observation) return null;
  preserveStaleBundledEvState({
    device,
    parsed,
    previous,
    observation,
  });
  const evidence = resolveExplicitBinaryEvidence({
    device,
    previous,
    observation,
    receivedAtMs: Date.now(),
  });
  if (evidence.accepted) {
    applyExplicitBinaryObservation({
      parsed,
      observation,
      observedAtMs: evidence.observedAtMs,
    });
    return true;
  }
  if (previous) {
    preserveRejectedExplicitBinaryObservation({
      parsed,
      previous,
      observation,
    });
  }
  return false;
}

function resolveExplicitControlObservation(params: {
  device: HomeyDeviceLike;
  parsed: TransportDeviceSnapshot;
  previous: TransportDeviceSnapshot | null;
}): {
  binaryCapabilityId: RealtimeControlCapabilityId;
  value: boolean;
  observedCapabilityId: string;
} | null {
  const { device, parsed, previous } = params;
  const binaryCapabilityId = parsed.binaryCapabilityId ?? previous?.binaryCapabilityId;
  if (typeof binaryCapabilityId !== 'string') return null;
  if (!isRealtimeControlCapability(binaryCapabilityId)) return null;
  const observation = getExplicitObservedBinaryObservation({
    device,
    binaryCapabilityId,
    binaryObservationCapabilityId: (
      parsed.binaryObservationCapabilityId
      ?? previous?.binaryObservationCapabilityId
      ?? binaryCapabilityId
    ),
    previousEvChargingState: previous?.evChargingState,
    previousEvCharging: previous?.evCharging,
  });
  if (!observation) return null;
  return { binaryCapabilityId, ...observation };
}

function getPreservedBinaryControlObservation(
  previous: TransportDeviceSnapshot | null,
  parsed: TransportDeviceSnapshot,
): TransportDeviceSnapshot['binaryControlObservation'] {
  if (!previous?.binaryControlObservation) return undefined;
  if (
    parsed.binaryCapabilityId !== undefined
    && previous.binaryControlObservation.capabilityId !== parsed.binaryCapabilityId
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
  parsed: TransportDeviceSnapshot;
  previous: TransportDeviceSnapshot | null;
  observation: NonNullable<TransportDeviceSnapshot['binaryControlObservation']>;
}): void {
  const { parsed, previous, observation } = params;
  if (observation.capabilityId === 'evcharger_charging') {
    const rawPermissionObserved = observation.observedCapabilityIds.includes('evcharger_charging');
    if (rawPermissionObserved) {
      parsed.evCharging = observation.observedValue;
      parsed.evChargingObservedAtMs = observation.observedAtMs;
      parsed.binaryControl = { on: observation.observedValue };
    } else if (previous) {
      if (parsed.evCharging === undefined) {
        parsed.evCharging = previous.evCharging;
        parsed.evChargingObservedAtMs = previous.evChargingObservedAtMs;
      }
      if (parsed.evChargingState === undefined) {
        parsed.evChargingState = previous.evChargingState;
        parsed.evChargingStateObservedAtMs = previous.evChargingStateObservedAtMs;
      }
      if (previous.binaryControl) parsed.binaryControl = { ...previous.binaryControl };
    }
  } else {
    parsed.binaryControl = { on: observation.observedValue };
  }
  parsed.binaryControlObservation = {
    ...observation,
    observedCapabilityIds: [...observation.observedCapabilityIds],
  };
}

type ExplicitBinaryObservation = Pick<ExplicitControlObservation, 'value' | 'observedCapabilityId'>;

function getChangedEvBinaryObservation(params: {
  device: HomeyDeviceLike;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  previousEvCharging?: boolean;
}): ExplicitBinaryObservation | undefined {
  const {
    device, binaryCapabilityId, previousEvCharging,
  } = params;
  if (binaryCapabilityId !== 'evcharger_charging') return undefined;
  const rawControlValue = device.capabilitiesObj?.evcharger_charging?.value;
  if (typeof rawControlValue === 'boolean' && rawControlValue !== previousEvCharging) {
    return { value: rawControlValue, observedCapabilityId: 'evcharger_charging' };
  }
  return undefined;
}

function getExplicitObservedBinaryObservation(params: {
  device: HomeyDeviceLike;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  binaryObservationCapabilityId?: TransportDeviceSnapshot['binaryObservationCapabilityId'];
  previousEvChargingState?: string;
  previousEvCharging?: boolean;
}): { value: boolean; observedCapabilityId: string } | undefined {
  const {
    device,
    binaryCapabilityId,
    binaryObservationCapabilityId,
    previousEvCharging,
  } = params;
  if (typeof binaryObservationCapabilityId !== 'string') return undefined;
  const changedEvObservation = getChangedEvBinaryObservation({
    device, binaryCapabilityId, previousEvCharging,
  });
  if (changedEvObservation) return changedEvObservation;
  const value = device.capabilitiesObj?.[binaryObservationCapabilityId]?.value;
  if (typeof value === 'boolean') {
    return { value, observedCapabilityId: binaryObservationCapabilityId };
  }
  // An EV commonly observes effective session state through
  // `evcharger_charging_state`, but its raw boolean control axis is still a
  // distinct explicit user/Flow action. When state itself did not change, retain
  // that raw observation so external-off provenance can see ON/OFF transitions.
  const rawControlValue = binaryCapabilityId === 'evcharger_charging'
    ? device.capabilitiesObj?.[binaryCapabilityId]?.value
    : undefined;
  return typeof rawControlValue === 'boolean'
    ? { value: rawControlValue, observedCapabilityId: 'evcharger_charging' }
    : undefined;
}

function preserveRecentLocalBinaryState(params: {
  previous: TransportDeviceSnapshot | null;
  parsed: TransportDeviceSnapshot;
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
  const capabilityId = parsed.binaryCapabilityId ?? previous.binaryCapabilityId;
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
  const parsedBinary = parsed.binaryControl;
  if (parsedBinary === undefined) return;
  if (parsedBinary.on === localWrite.value) return;
  const previousOn = resolveBinaryOn(previous);
  if (previousOn !== localWrite.value) return;
  parsed.binaryControl = { on: previousOn };
  if (capabilityId === 'evcharger_charging') {
    parsed.evCharging = previous.evCharging;
    parsed.evChargingObservedAtMs = previous.evChargingObservedAtMs;
  }
}

function resolveBinaryReconcileChange(
  previous: TransportDeviceSnapshot,
  next: TransportDeviceSnapshot,
): RealtimeDeviceReconcileChange {
  const rawEvAxisObserved = next.binaryCapabilityId === 'evcharger_charging'
    && next.binaryControlObservation?.observedCapabilityIds.includes('evcharger_charging') === true;
  const previousOn = rawEvAxisObserved
    ? (previous.evCharging ?? resolveBinaryOn(previous))
    : resolveBinaryOn(previous);
  const nextOn = rawEvAxisObserved
    ? (next.evCharging ?? resolveBinaryOn(next))
    : resolveBinaryOn(next);
  const observedCapabilityId = next.binaryControlObservation?.observedCapabilityIds[0];
  return {
    capabilityId: next.binaryCapabilityId ?? previous.binaryCapabilityId ?? 'onoff',
    ...(next.binaryCapabilityId === 'evcharger_charging' && observedCapabilityId
      ? { observedCapabilityId }
      : {}),
    previousValue: formatBinaryState(previousOn),
    nextValue: formatBinaryState(nextOn),
  };
}

function getPlanReconcileRealtimeChanges(
  previous: TransportDeviceSnapshot | null,
  next: TransportDeviceSnapshot,
  options: { binaryValueExplicitlyObserved: boolean },
): RealtimeDeviceReconcileChange[] {
  if (!previous) return [];

  const changes: RealtimeDeviceReconcileChange[] = [];
  if (options.binaryValueExplicitlyObserved) {
    const binaryChange = resolveBinaryReconcileChange(previous, next);
    if (binaryChange.previousValue !== binaryChange.nextValue) changes.push(binaryChange);
  }

  const temperaturePresenceChanged = (previous.temperature === undefined) !== (next.temperature === undefined);
  if (temperaturePresenceChanged) {
    changes.push({
      capabilityId: 'target_temperature',
      previousValue: previous.temperature
        ? formatTargetValue(previous.temperature.target.value, previous.temperature.target.unit)
        : 'absent',
      nextValue: next.temperature
        ? formatTargetValue(next.temperature.target.value, next.temperature.target.unit)
        : 'absent',
    });
  }

  const previousTargetsById = new Map(previous.targets.map((target) => [target.id, target]));
  for (const nextTarget of next.targets) {
    if (temperaturePresenceChanged && nextTarget.id === 'target_temperature') continue;
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
  previous: TransportDeviceSnapshot | null,
  next: TransportDeviceSnapshot,
  options: { binaryValueExplicitlyObserved: boolean },
): string[] {
  if (!previous) return [];

  const capabilityIds = new Set<string>();
  if (options.binaryValueExplicitlyObserved) {
    capabilityIds.add(next.binaryCapabilityId ?? previous.binaryCapabilityId ?? 'onoff');
  }
  if (previous.measuredPowerKw !== next.measuredPowerKw) {
    capabilityIds.add('measure_power');
  }
  if (previous.evChargingState !== next.evChargingState) {
    capabilityIds.add('evcharger_charging_state');
  }
  if ((previous.temperature === undefined) !== (next.temperature === undefined)) {
    capabilityIds.add('measure_temperature');
    capabilityIds.add('target_temperature');
  }
  if (hasTemperatureMeasurementChanged(previous, next)) {
    capabilityIds.add('measure_temperature');
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

function hasTemperatureMeasurementChanged(
  previous: TransportDeviceSnapshot,
  next: TransportDeviceSnapshot,
): boolean {
  if (!previous.temperature || !next.temperature) return false;
  return previous.temperature.currentTemperature !== next.temperature.currentTemperature;
}

function hasStateOfChargeObservationChanged(
  previous: TransportDeviceSnapshot,
  next: TransportDeviceSnapshot,
): next is TransportDeviceSnapshot & { stateOfCharge: NonNullable<TransportDeviceSnapshot['stateOfCharge']> } {
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
