import type { DeviceCapabilityMap } from './deviceManagerControl';
import type {
  FlowReportedCapabilitiesForDevice,
  FlowReportedCapabilityEntry,
  FlowReportedCapabilityId,
} from './flowReportedCapabilities';
import type { DeviceStateOfChargeSnapshot, TargetDeviceSnapshot } from '../utils/types';

export const EV_SOC_CAPABILITY_ID = 'measure_battery' as const;
export const EV_SOC_NATIVE_CAPABILITY_IDS = [
  EV_SOC_CAPABILITY_ID,
  'measure_soc_usable',
  'measure_soc_level',
] as const;

const EV_SOC_STALE_MS = 40 * 60 * 1000;

type StateOfChargeSource = DeviceStateOfChargeSnapshot['source'];

type StateOfChargeCandidate = {
  percent: number;
  observedAtMs?: number;
  source: StateOfChargeSource;
  capabilityId: string;
};

export function resolveStateOfChargeSnapshot(params: {
  deviceClassKey: string;
  nowMs: number;
  capabilityObj: DeviceCapabilityMap;
  flowBackedCapabilityIds: readonly FlowReportedCapabilityId[];
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
}): DeviceStateOfChargeSnapshot | undefined {
  const {
    deviceClassKey,
    nowMs,
    capabilityObj,
    flowBackedCapabilityIds,
    reportedCapabilities,
  } = params;
  if (deviceClassKey !== 'evcharger') return undefined;

  const candidate = resolveStateOfChargeCandidate({
    capabilityObj,
    flowBackedCapabilityIds,
  });
  if (!candidate) return undefined;

  return buildStateOfChargeSnapshot({
    percent: candidate.percent,
    observedAtMs: candidate.observedAtMs,
    source: candidate.source,
    capabilityId: candidate.capabilityId,
    capabilityObj,
    reportedCapabilities,
    nowMs,
  });
}

export function updateStateOfChargeObservationFreshness(params: {
  snapshot: TargetDeviceSnapshot;
  reportedAt: number;
  nowMs: number;
}): boolean {
  const { snapshot, reportedAt, nowMs } = params;
  if (!snapshot.stateOfCharge) return false;
  const observedAtMs = Math.max(snapshot.stateOfCharge.observedAtMs ?? 0, reportedAt);
  const previous = snapshot.stateOfCharge;
  snapshot.stateOfCharge = {
    ...previous,
    observedAtMs,
    status: resolveStateOfChargeStatus({
      observedAtMs,
      nowMs,
      sessionStartedAtMs: previous.sessionStartedAtMs,
      invalidatedAtMs: previous.invalidatedAtMs,
    }),
  };
  return true;
}

export function updateStateOfChargeFromRealtimeCapability(params: {
  snapshot: TargetDeviceSnapshot;
  capabilityId: string;
  value: unknown;
  observedAtMs: number;
}): boolean {
  const {
    snapshot,
    capabilityId,
    value,
    observedAtMs,
  } = params;
  if (!isStateOfChargeCapabilityId(capabilityId)) return false;
  if (snapshot.deviceClass !== 'evcharger') return false;
  const percent = normalizeStateOfChargePercent(value);
  if (percent === undefined) return false;

  const next = buildStateOfChargeSnapshot({
    percent,
    observedAtMs,
    source: 'capability',
    capabilityId,
    capabilityObj: {
      evcharger_charging_state: {
        value: snapshot.evChargingState,
        lastUpdated: snapshot.stateOfCharge?.sessionStartedAtMs ?? observedAtMs,
      },
    },
    reportedCapabilities: {},
    nowMs: observedAtMs,
  });
  const previous = snapshot.stateOfCharge;
  const invalidatedAtMs = maxPositive([
    previous?.invalidatedAtMs,
    next.invalidatedAtMs,
  ].filter(isFinitePositiveNumber));
  const sessionStartedAtMs = resolveRealtimeSessionStartedAtMs(previous, next);
  snapshot.stateOfCharge = {
    ...next,
    ...(sessionStartedAtMs ? { sessionStartedAtMs } : {}),
    ...(invalidatedAtMs ? { invalidatedAtMs } : {}),
    status: resolveStateOfChargeStatus({
      observedAtMs,
      nowMs: observedAtMs,
      sessionStartedAtMs,
      invalidatedAtMs,
    }),
  };
  return !previous
    || previous.percent !== next.percent
    || previous.observedAtMs !== next.observedAtMs
    || previous.status !== next.status;
}

export function updateStateOfChargeSessionBoundary(params: {
  snapshot: TargetDeviceSnapshot;
  evChargingState: string;
  observedAtMs: number;
  nowMs: number;
}): boolean {
  const {
    snapshot,
    evChargingState,
    observedAtMs,
    nowMs,
  } = params;
  const previous = snapshot.stateOfCharge;
  if (!previous) return false;
  const sessionStartedAtMs = shouldStartNewSession(previous, evChargingState)
    ? observedAtMs
    : previous.sessionStartedAtMs;
  const invalidatedAtMs = isDisconnectedEvState(evChargingState)
    ? Math.max(previous.invalidatedAtMs ?? 0, observedAtMs)
    : previous.invalidatedAtMs;
  const status = resolveStateOfChargeStatus({
    observedAtMs: previous.observedAtMs,
    nowMs,
    sessionStartedAtMs: sessionStartedAtMs || undefined,
    invalidatedAtMs: invalidatedAtMs || undefined,
  });
  snapshot.stateOfCharge = {
    ...previous,
    status,
    ...(sessionStartedAtMs ? { sessionStartedAtMs } : {}),
    ...(invalidatedAtMs ? { invalidatedAtMs } : {}),
  };
  return previous.status !== status
    || previous.sessionStartedAtMs !== snapshot.stateOfCharge.sessionStartedAtMs
    || previous.invalidatedAtMs !== snapshot.stateOfCharge.invalidatedAtMs;
}

export function isStateOfChargeCapabilityId(
  capabilityId: string,
): capabilityId is (typeof EV_SOC_NATIVE_CAPABILITY_IDS)[number] {
  return (EV_SOC_NATIVE_CAPABILITY_IDS as readonly string[]).includes(capabilityId);
}

export function normalizeStateOfChargePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return Math.round(value * 10) / 10;
}

function resolveRealtimeSessionStartedAtMs(
  previous: DeviceStateOfChargeSnapshot | undefined,
  next: DeviceStateOfChargeSnapshot,
): number | undefined {
  if (!next.sessionStartedAtMs) return previous?.sessionStartedAtMs;
  if (!previous?.sessionStartedAtMs) return next.sessionStartedAtMs;
  if (
    previous.invalidatedAtMs !== undefined
    && previous.invalidatedAtMs >= previous.sessionStartedAtMs
  ) {
    return next.sessionStartedAtMs;
  }
  return previous.sessionStartedAtMs;
}

function shouldStartNewSession(
  previous: DeviceStateOfChargeSnapshot,
  evChargingState: string,
): boolean {
  if (!isConnectedEvState(evChargingState)) return false;
  if (previous.sessionStartedAtMs === undefined) return true;
  return previous.invalidatedAtMs !== undefined
    && previous.invalidatedAtMs >= previous.sessionStartedAtMs;
}

function resolveStateOfChargeCandidate(params: {
  capabilityObj: DeviceCapabilityMap;
  flowBackedCapabilityIds: readonly FlowReportedCapabilityId[];
}): StateOfChargeCandidate | null {
  const { capabilityObj, flowBackedCapabilityIds } = params;
  for (const capabilityId of EV_SOC_NATIVE_CAPABILITY_IDS) {
    const capability = capabilityObj[capabilityId];
    const percent = normalizeStateOfChargePercent(capability?.value);
    if (percent === undefined) continue;
    return {
      percent,
      observedAtMs: getCapabilityLastUpdatedMs(capabilityObj, capabilityId),
      source: flowBackedCapabilityIds.includes(capabilityId as FlowReportedCapabilityId)
        ? 'flow'
        : 'capability',
      capabilityId,
    };
  }
  return null;
}

function buildStateOfChargeSnapshot(params: {
  percent: number;
  observedAtMs?: number;
  source: StateOfChargeSource;
  capabilityId: string;
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  nowMs: number;
}): DeviceStateOfChargeSnapshot {
  const {
    percent,
    observedAtMs,
    source,
    capabilityId,
    capabilityObj,
    reportedCapabilities,
    nowMs,
  } = params;
  const session = resolveEvSessionBoundary({ capabilityObj, reportedCapabilities, nowMs });
  const status = resolveStateOfChargeStatus({
    observedAtMs,
    nowMs,
    invalidatedAtMs: session.invalidatedAtMs,
    sessionStartedAtMs: session.sessionStartedAtMs,
  });
  return {
    percent,
    ...(observedAtMs ? { observedAtMs } : {}),
    status,
    source,
    capabilityId,
    ...(session.sessionStartedAtMs ? { sessionStartedAtMs: session.sessionStartedAtMs } : {}),
    ...(session.invalidatedAtMs ? { invalidatedAtMs: session.invalidatedAtMs } : {}),
  };
}

function resolveStateOfChargeStatus(params: {
  observedAtMs?: number;
  nowMs: number;
  invalidatedAtMs?: number;
  sessionStartedAtMs?: number;
}): DeviceStateOfChargeSnapshot['status'] {
  const {
    observedAtMs,
    nowMs,
    invalidatedAtMs,
    sessionStartedAtMs,
  } = params;
  if (!observedAtMs) return 'unknown';
  const sessionCurrentlyInvalid = invalidatedAtMs !== undefined
    && (sessionStartedAtMs === undefined || invalidatedAtMs >= sessionStartedAtMs);
  if (
    sessionCurrentlyInvalid
    || (invalidatedAtMs !== undefined && invalidatedAtMs >= observedAtMs)
    || (sessionStartedAtMs !== undefined && sessionStartedAtMs > observedAtMs)
  ) {
    return 'invalid_session';
  }
  return nowMs - observedAtMs >= EV_SOC_STALE_MS ? 'stale' : 'fresh';
}

function resolveEvSessionBoundary(params: {
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  nowMs: number;
}): {
  sessionStartedAtMs?: number;
  invalidatedAtMs?: number;
} {
  const { capabilityObj, reportedCapabilities, nowMs } = params;
  const chargingState = getStringCapabilityValue(capabilityObj.evcharger_charging_state?.value);
  const chargingStateObservedAt = getCapabilityLastUpdatedMs(capabilityObj, 'evcharger_charging_state');
  const flowConnected = getBooleanFlowEntry(reportedCapabilities['alarm_generic.car_connected']);

  const invalidatedAtCandidates = [
    isDisconnectedEvState(chargingState) ? chargingStateObservedAt ?? nowMs : undefined,
    flowConnected?.value === false ? flowConnected.reportedAt : undefined,
  ].filter(isFinitePositiveNumber);

  const sessionStartedCandidates = [
    isConnectedEvState(chargingState) ? chargingStateObservedAt : undefined,
    flowConnected?.value === true ? flowConnected.reportedAt : undefined,
  ].filter(isFinitePositiveNumber);

  return {
    sessionStartedAtMs: maxPositive(sessionStartedCandidates),
    invalidatedAtMs: maxPositive(invalidatedAtCandidates),
  };
}

function getBooleanFlowEntry(
  entry: FlowReportedCapabilityEntry | undefined,
): { value: boolean; reportedAt: number } | undefined {
  return typeof entry?.value === 'boolean' && isFinitePositiveNumber(entry.reportedAt)
    ? { value: entry.value, reportedAt: entry.reportedAt }
    : undefined;
}

function getStringCapabilityValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isConnectedEvState(value: string | undefined): boolean {
  return value === 'plugged_in'
    || value === 'plugged_in_charging'
    || value === 'plugged_in_paused';
}

function isDisconnectedEvState(value: string | undefined): boolean {
  return value === 'plugged_out'
    || value === 'disconnected'
    || value === 'unplugged';
}

function getCapabilityLastUpdatedMs(
  capabilityObj: DeviceCapabilityMap,
  capabilityId: string,
): number | undefined {
  const raw = capabilityObj[capabilityId]?.lastUpdated;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function maxPositive(values: readonly number[]): number | undefined {
  let max = 0;
  for (const value of values) {
    max = Math.max(max, value);
  }
  return max > 0 ? max : undefined;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
