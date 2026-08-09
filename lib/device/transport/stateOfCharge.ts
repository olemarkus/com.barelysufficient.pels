import { isEvChargingState, type DeviceCapabilityMap } from '../managerControl';
import { isEvPlugStateConnected } from '../../../packages/shared-domain/src/evPlugState';
import type {
  FlowReportedCapabilitiesForDevice,
  FlowReportedCapabilityEntry,
} from './flowReportedCapabilities';
import type {
  DeviceStateOfChargeSnapshot,
  EvChargingState,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { hasCarStateOfChargeChanged } from './carStateOfChargeWrite';
import { stateOfChargeLevelsDiffer } from './stateOfChargeLevel';

export const EV_SOC_CAPABILITY_ID = 'measure_battery' as const;
export const EV_SOC_NATIVE_CAPABILITY_IDS = [
  EV_SOC_CAPABILITY_ID,
  'measure_soc_usable',
  'measure_soc_level',
] as const;

type StateOfChargeCandidate = {
  percent: number;
  observedAtMs?: number;
  capabilityId: string;
  /** Absent = the charger reported it; `'car'` = read off the associated car. */
  source?: 'car';
  sourceDeviceId?: string;
};

// The session anchoring / invalidation pair the caller already knows about.
// Threaded through the parse so a full refresh reasons from the retained
// session instead of re-deriving one from whatever timestamp the charging-state
// capability happens to carry right now (see `resolveEvSessionBoundary`).
export type RetainedStateOfChargeSession = Pick<
  DeviceStateOfChargeSnapshot, 'sessionStartedAtMs' | 'invalidatedAtMs'
>;

export function resolveStateOfChargeSnapshot(params: {
  deviceClassKey: string;
  nowMs: number;
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  retainedSession?: RetainedStateOfChargeSession;
  /**
   * Whether the user ticked any car for this charger. When they have, the car
   * is the ONLY source of its battery level: the charger's own native reading
   * and the `report_evcharger_battery_level` flow card are both ignored, so the
   * level cannot flip between two sources mid-session and the user gets what
   * they asked for. The value itself arrives on the realtime seam
   * (`updateStateOfChargeFromCarObservation`); parse's job is to carry it, not
   * to re-derive it.
   */
  eligibleCarIds?: readonly string[];
  /** The level parse last held, so an adopting charger can retain a car reading. */
  retainedStateOfCharge?: DeviceStateOfChargeSnapshot;
}): DeviceStateOfChargeSnapshot | undefined {
  const {
    deviceClassKey,
    nowMs,
    capabilityObj,
    reportedCapabilities,
    retainedSession,
    eligibleCarIds,
    retainedStateOfCharge,
  } = params;
  if (deviceClassKey !== 'evcharger') return undefined;

  const candidate = eligibleCarIds && eligibleCarIds.length > 0
    ? retainedCarCandidate(retainedStateOfCharge, eligibleCarIds)
    : resolveStateOfChargeCandidate({ capabilityObj });
  if (!candidate) return undefined;

  const resolved = buildStateOfChargeSnapshot({
    percent: candidate.percent,
    observedAtMs: candidate.observedAtMs,
    capabilityId: candidate.capabilityId,
    capabilityObj,
    reportedCapabilities,
    nowMs,
    retainedSession,
  });
  return candidate.source === 'car'
    ? { ...resolved, source: 'car', ...(candidate.sourceDeviceId ? { sourceDeviceId: candidate.sourceDeviceId } : {}) }
    : resolved;
}

/**
 * The car-sourced level parse is carrying forward, or nothing.
 *
 * An adopting charger has no candidate of its own to fall back to — that is the
 * point of the opt-in — so before the first car reading lands (a fresh install,
 * or a restart mid-session) it reports no level at all rather than briefly
 * showing the flow card's. A reading the charger itself produced is never
 * retained here: the toggle may have been switched on with one still present.
 */
function retainedCarCandidate(
  retained: DeviceStateOfChargeSnapshot | undefined,
  eligibleCarIds: readonly string[],
): StateOfChargeCandidate | null {
  if (retained?.source !== 'car') return null;
  // Re-checked against the CURRENT eligibility set, not just "some car supplied
  // it". Switching a charger from car A to car B otherwise leaves A's percentage
  // in place for the rest of the session, because the flag stays true and the
  // retained value still looks car-sourced.
  if (retained.sourceDeviceId !== undefined && !eligibleCarIds.includes(retained.sourceDeviceId)) {
    return null;
  }
  return {
    percent: retained.percent,
    observedAtMs: retained.observedAtMs,
    capabilityId: retained.capabilityId ?? EV_SOC_CAPABILITY_ID,
    source: 'car',
    sourceDeviceId: retained.sourceDeviceId,
  };
}

/**
 * Writes the associated car's battery level onto the charger, on the realtime
 * seam the probe reports it on. Mirrors
 * `updateStateOfChargeFromRealtimeCapability` — same session anchoring, same
 * invalidation carry-forward, same status rule — because a car-sourced level is
 * the charger's level as far as everything downstream is concerned; only its
 * provenance differs.
 */
export function updateStateOfChargeFromCarObservation(params: {
  snapshot: TransportDeviceSnapshot;
  percent: number;
  observedAtMs: number;
  carId: string;
  nowMs: number;
}): boolean {
  const { snapshot, percent, observedAtMs, carId, nowMs } = params;
  if (snapshot.deviceClass !== 'evcharger') return false;
  const normalized = normalizeStateOfChargePercent(percent);
  if (normalized === undefined) return false;

  const previous = snapshot.stateOfCharge;
  const next = buildStateOfChargeSnapshot({
    percent: normalized,
    observedAtMs,
    capabilityId: EV_SOC_CAPABILITY_ID,
    capabilityObj: {
      evcharger_charging_state: {
        value: snapshot.evChargingState,
        lastUpdated: previous?.sessionStartedAtMs ?? observedAtMs,
      },
    },
    reportedCapabilities: {},
    nowMs,
    retainedSession: previous,
  });
  const invalidatedAtMs = maxPositive([
    previous?.invalidatedAtMs,
    next.invalidatedAtMs,
  ].filter(isFinitePositiveNumber));
  const sessionStartedAtMs = resolveRealtimeSessionStartedAtMs(previous, next);
  snapshot.stateOfCharge = {
    ...next,
    source: 'car',
    sourceDeviceId: carId,
    ...(sessionStartedAtMs ? { sessionStartedAtMs } : {}),
    ...(invalidatedAtMs ? { invalidatedAtMs } : {}),
    ...resolveLevelFields({
      percent: normalized,
      observedAtMs,
      sessionStartedAtMs,
      invalidatedAtMs,
    }),
  };
  return hasCarStateOfChargeChanged(previous, snapshot.stateOfCharge, carId);
}

/**
 * Would a report at `reportedAt` give this charger a level it does not have?
 *
 * The producer answers its own question. The app-wiring seam used to clone the
 * snapshot, run the mutator on the copy and read the result back — simulating
 * the producer in order to predict it — which is a consumer holding a private
 * model of resolution that the producer is free to change underneath it.
 */
export function wouldReportRestoreStateOfChargeLevel(
  stateOfCharge: DeviceStateOfChargeSnapshot | undefined,
  reportedAt: number,
): boolean {
  if (!stateOfCharge || stateOfCharge.level.kind === 'known') return false;
  return resolveStateOfChargeLevel({
    percent: stateOfCharge.percent,
    observedAtMs: Math.max(stateOfCharge.observedAtMs ?? 0, reportedAt),
    sessionStartedAtMs: stateOfCharge.sessionStartedAtMs,
    invalidatedAtMs: stateOfCharge.invalidatedAtMs,
  }).kind === 'known';
}

export function updateStateOfChargeObservationFreshness(params: {
  snapshot: TransportDeviceSnapshot;
  reportedAt: number;
}): boolean {
  const { snapshot, reportedAt } = params;
  if (!snapshot.stateOfCharge) return false;
  const observedAtMs = Math.max(snapshot.stateOfCharge.observedAtMs ?? 0, reportedAt);
  const previous = snapshot.stateOfCharge;
  snapshot.stateOfCharge = {
    ...previous,
    observedAtMs,
    ...resolveLevelFields({
      percent: previous.percent,
      observedAtMs,
      sessionStartedAtMs: previous.sessionStartedAtMs,
      invalidatedAtMs: previous.invalidatedAtMs,
    }),
  };
  return true;
}

export function updateStateOfChargeFromRealtimeCapability(params: {
  snapshot: TransportDeviceSnapshot;
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
  // A charger-sourced realtime reading never displaces an adopted car value.
  // Parse suppresses the charger's own sources for an opted-in charger, but this
  // seam and the retained-observation replay run between refreshes — without
  // this the charger's value would win for a while, strip `source: 'car'`, and
  // then be dropped entirely by the next parse for not being a car reading.
  if (snapshot.stateOfCharge?.source === 'car') return false;
  const percent = normalizeStateOfChargePercent(value);
  if (percent === undefined) return false;

  const next = buildStateOfChargeSnapshot({
    percent,
    observedAtMs,
    capabilityId,
    capabilityObj: {
      evcharger_charging_state: {
        value: snapshot.evChargingState,
        lastUpdated: snapshot.stateOfCharge?.sessionStartedAtMs ?? observedAtMs,
      },
    },
    reportedCapabilities: {},
    nowMs: observedAtMs,
    retainedSession: snapshot.stateOfCharge,
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
    ...resolveLevelFields({
      percent,
      observedAtMs,
      sessionStartedAtMs,
      invalidatedAtMs,
    }),
  };
  return !previous
    || previous.percent !== next.percent
    || previous.observedAtMs !== next.observedAtMs
    || stateOfChargeLevelsDiffer(previous.level, next.level);
}

export function updateStateOfChargeSessionBoundary(params: {
  snapshot: TransportDeviceSnapshot;
  evChargingState: EvChargingState;
  observedAtMs: number;
}): boolean {
  const {
    snapshot,
    evChargingState,
    observedAtMs,
  } = params;
  const previous = snapshot.stateOfCharge;
  if (!previous) return false;
  const sessionStartedAtMs = shouldStartNewSession(previous, evChargingState)
    ? observedAtMs
    : previous.sessionStartedAtMs;
  const invalidatedAtMs = isDisconnectedEvState(evChargingState)
    ? Math.max(previous.invalidatedAtMs ?? 0, observedAtMs)
    : previous.invalidatedAtMs;
  const levelFields = resolveLevelFields({
    percent: previous.percent,
    observedAtMs: previous.observedAtMs,
    sessionStartedAtMs: sessionStartedAtMs || undefined,
    invalidatedAtMs: invalidatedAtMs || undefined,
  });
  snapshot.stateOfCharge = {
    ...previous,
    ...levelFields,
    ...(sessionStartedAtMs ? { sessionStartedAtMs } : {}),
    ...(invalidatedAtMs ? { invalidatedAtMs } : {}),
  };
  return stateOfChargeLevelsDiffer(previous.level, levelFields.level)
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

// Whether a connected observation would mark a RECONNECT rather than a
// re-sighting of the session already running: there is a recorded disconnect
// that the current session anchor does not already account for.
//
// This is the single rule both session paths use — the stateful realtime
// boundary (`shouldStartNewSession`) and the stateless parse
// (`resolveEvSessionBoundary`) — so a full refresh can never re-anchor a
// session the realtime path deliberately left alone. Without a recorded
// disconnect there is no evidence the car changed, so there is no new session
// to anchor.
function hasPendingReconnect(session: RetainedStateOfChargeSession): boolean {
  const { sessionStartedAtMs, invalidatedAtMs } = session;
  if (invalidatedAtMs === undefined) return false;
  return sessionStartedAtMs === undefined || invalidatedAtMs >= sessionStartedAtMs;
}

function shouldStartNewSession(
  previous: DeviceStateOfChargeSnapshot,
  evChargingState: EvChargingState,
): boolean {
  return isEvPlugStateConnected(evChargingState) && hasPendingReconnect(previous);
}

function resolveStateOfChargeCandidate(params: {
  capabilityObj: DeviceCapabilityMap;
}): StateOfChargeCandidate | null {
  const { capabilityObj } = params;
  for (const capabilityId of EV_SOC_NATIVE_CAPABILITY_IDS) {
    const capability = capabilityObj[capabilityId];
    const percent = normalizeStateOfChargePercent(capability?.value);
    if (percent === undefined) continue;
    return {
      percent,
      observedAtMs: getCapabilityLastUpdatedMs(capabilityObj, capabilityId),
      capabilityId,
    };
  }
  return null;
}

function buildStateOfChargeSnapshot(params: {
  percent: number;
  observedAtMs?: number;
  capabilityId: string;
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  nowMs: number;
  retainedSession?: RetainedStateOfChargeSession;
}): DeviceStateOfChargeSnapshot {
  const {
    percent,
    observedAtMs,
    capabilityId,
    capabilityObj,
    reportedCapabilities,
    nowMs,
    retainedSession,
  } = params;
  const session = resolveEvSessionBoundary({
    capabilityObj,
    reportedCapabilities,
    nowMs,
    retainedSession,
  });
  const levelFields = resolveLevelFields({
    percent,
    observedAtMs,
    invalidatedAtMs: session.invalidatedAtMs,
    sessionStartedAtMs: session.sessionStartedAtMs,
  });
  return {
    percent,
    ...(observedAtMs ? { observedAtMs } : {}),
    ...levelFields,
    capabilityId,
    ...(session.sessionStartedAtMs ? { sessionStartedAtMs: session.sessionStartedAtMs } : {}),
    ...(session.invalidatedAtMs ? { invalidatedAtMs: session.invalidatedAtMs } : {}),
  };
}

/**
 * Whether PELS has a battery level for this charger, and nothing about how much
 * to trust one.
 *
 * **There is no ageing here, deliberately.** A level is reported on CHANGE and
 * can only change while a car is attached, so what decides whether PELS has one
 * is the SESSION, not the clock: a reading belongs to the session it was taken
 * in, and it stays true until that session ends. The clock-based gate this
 * replaced (`EV_SOC_STALE_MS`, 40 minutes of charge-in-motion) was wrong in both
 * directions — it marked a reading stale the instant a >40-minute pause ended,
 * because the age was total wall-clock; and once a reading HAD aged out during a
 * genuine charging interval, the next idle observation resurrected it to fresh.
 * Accepted cost: a charger that stops reporting mid-session leaves PELS holding
 * the level it last published. That is a device fault, and the old gate did not
 * detect it either — it produced a qualifier every consumer then had to
 * interpret, which is what this file no longer emits.
 */
function resolveStateOfChargeLevel(params: {
  percent: number;
  observedAtMs?: number;
  invalidatedAtMs?: number;
  sessionStartedAtMs?: number;
}): DeviceStateOfChargeSnapshot['level'] {
  const {
    percent, observedAtMs, invalidatedAtMs, sessionStartedAtMs,
  } = params;
  // Nothing has been reported at all.
  if (!observedAtMs) return { kind: 'unavailable', reasonCode: 'not_reported' };
  // A disconnect is recorded and no reconnect has been observed since, so there
  // is no session for a level to belong to.
  if (hasPendingReconnect({ sessionStartedAtMs, invalidatedAtMs })) {
    return { kind: 'unavailable', reasonCode: 'not_connected' };
  }
  // A car IS attached, but the reading predates it: it was taken before the
  // unplug, or before this session was anchored. Possibly a different car.
  if (
    (invalidatedAtMs !== undefined && invalidatedAtMs >= observedAtMs)
    || (sessionStartedAtMs !== undefined && sessionStartedAtMs > observedAtMs)
  ) {
    return { kind: 'unavailable', reasonCode: 'not_reported' };
  }
  return { kind: 'known', percent };
}

function resolveLevelFields(params: {
  percent: number;
  observedAtMs?: number;
  invalidatedAtMs?: number;
  sessionStartedAtMs?: number;
}): Pick<DeviceStateOfChargeSnapshot, 'level'> {
  return { level: resolveStateOfChargeLevel(params) };
}

function resolveEvSessionBoundary(params: {
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  nowMs: number;
  retainedSession?: RetainedStateOfChargeSession;
}): {
  sessionStartedAtMs?: number;
  invalidatedAtMs?: number;
} {
  const {
    capabilityObj, reportedCapabilities, nowMs, retainedSession,
  } = params;
  const chargingState = getStringCapabilityValue(capabilityObj.evcharger_charging_state?.value);
  const chargingStateObservedAt = getCapabilityLastUpdatedMs(capabilityObj, 'evcharger_charging_state');
  const flowConnected = getBooleanFlowEntry(reportedCapabilities['alarm_generic.car_connected']);

  const invalidatedAtCandidates = [
    isDisconnectedEvState(chargingState) ? chargingStateObservedAt ?? nowMs : undefined,
    flowConnected?.value === false ? flowConnected.reportedAt : undefined,
    retainedSession?.invalidatedAtMs,
  ].filter(isFinitePositiveNumber);
  const invalidatedAtMs = maxPositive(invalidatedAtCandidates);

  // A connected observation anchors a session only when it marks a reconnect.
  // `evcharger_charging_state` re-stamps its `lastUpdated` on every connected
  // sub-state change — an Easee drops `plugged_in_charging` → `plugged_in` the
  // moment PELS pauses it — and anchoring the session on that pushed the start
  // past the last SoC report, marking a two-minute-old reading stale for good
  // (prod 2026-07-26). Absent a disconnect, the retained anchor stands.
  const reconnectPending = hasPendingReconnect({
    sessionStartedAtMs: retainedSession?.sessionStartedAtMs,
    invalidatedAtMs,
  });
  const reconnectAtMs = reconnectPending && invalidatedAtMs !== undefined
    ? resolveReconnectAtMs({
      chargingState, chargingStateObservedAt, flowConnected, invalidatedAtMs,
    })
    : undefined;

  return {
    sessionStartedAtMs: reconnectAtMs ?? retainedSession?.sessionStartedAtMs,
    invalidatedAtMs,
  };
}

/**
 * When the car reconnected, given a disconnect is already pending.
 *
 * Deliberately requires REAL evidence: a connected observation with no
 * `lastUpdated` anchors nothing. Substituting the refresh time was tried and
 * reverted — a full refresh can carry a cached connected state that predates a
 * newer realtime plug-out (`snapshotRefresh.ts` parses the pull before merging
 * retained fresher observations), and a fabricated `sessionStartedAtMs` in the
 * future cannot be undone by reapplying that plug-out, so the next genuine
 * reconnect goes unrecognised and a same-value SoC report stays trusted for a
 * different car. The cost of requiring evidence — a timestamp-less reconnect
 * leaving the reading stale — is tracked as a P1 in TODO.md.
 */
function resolveReconnectAtMs(params: {
  chargingState?: string;
  chargingStateObservedAt?: number;
  flowConnected?: { value: boolean; reportedAt: number };
  invalidatedAtMs: number;
}): number | undefined {
  const {
    chargingState, chargingStateObservedAt, flowConnected, invalidatedAtMs,
  } = params;
  const candidates = [
    isConnectedCapabilityValue(chargingState) ? chargingStateObservedAt : undefined,
    flowConnected?.value === true ? flowConnected.reportedAt : undefined,
  ].filter(isFinitePositiveNumber).filter((ms) => ms > invalidatedAtMs);
  return maxPositive(candidates);
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

// Narrows a RAW capability value before asking the total predicate. Parse reads
// `evcharger_charging_state.value` straight off the payload, so this is the
// boundary where an unparsed string becomes a plug state; a value outside the
// union is not a connected car.
function isConnectedCapabilityValue(value: string | undefined): boolean {
  return isEvChargingState(value) && isEvPlugStateConnected(value);
}

// Stays local: it accepts vendor values outside the `EvChargingState` union,
// which a device may still report.
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
