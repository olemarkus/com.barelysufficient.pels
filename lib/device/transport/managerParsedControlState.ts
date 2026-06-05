import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { Logger } from '../../utils/types';
import {
  getCurrentOn,
  type DeviceCapabilityMap,
} from '../managerControl';
import { resolveParsedControlState } from './managerParseSnapshot';
import type { FlowReportedCapabilityId } from './flowReportedCapabilities';

const moduleLogger = getLogger('device/parsed-control-state');

export type ParsedControlStateResult = {
  resolvedOn?: boolean;
  binaryControl?: { on: boolean };
  canSetControl: boolean | undefined;
  observedCurrentOn?: boolean;
  hasTrustedControlState: boolean;
};

type ResolvedControlFallback = {
  currentOn?: boolean;
  trusted: boolean;
};

export function resolveDeviceParsedControlState(params: {
  logger: Logger;
  debugStructured?: StructuredDebugEmitter;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  deviceClassKey: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlWriteCapabilityId?: string;
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  previousSnapshot?: TargetDeviceSnapshot;
  suppressDropLog?: boolean;
}): ParsedControlStateResult {
  const {
    logger,
    debugStructured,
    deviceId,
    deviceName,
    deviceLabel,
    deviceClassKey,
    controlCapabilityId,
    controlWriteCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    flowBackedCapabilityIds,
    previousSnapshot,
    suppressDropLog = false,
  } = params;
  const observedCurrentOn = getCurrentOn({ deviceClassKey, capabilityObj, controlCapabilityId });
  const invalidControlPayload = hasInvalidControlPayload({ capabilityObj, controlCapabilityId });
  // `currentOn` ("whether the device may draw power") is strictly `boolean`, so
  // an unobserved control needs a fallback — see `resolveUnobservedControlFallback`.
  const resolvedCurrentOn: ResolvedControlFallback = observedCurrentOn === undefined
    ? resolveUnobservedControlFallback({ invalidControlPayload, previousSnapshot, controlCapabilityId })
    : { currentOn: observedCurrentOn, trusted: true };
  const parsedControlState = resolveParsedControlState({
    debugStructured,
    deviceId,
    deviceName,
    deviceLabel,
    controlCapabilityId,
    controlWriteCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    flowBackedCapabilityIds,
    currentOn: resolvedCurrentOn.currentOn,
  });
  if (!suppressDropLog && controlCapabilityId && (observedCurrentOn === undefined || invalidControlPayload)) {
    logDroppedControlState({
      logger,
      deviceId,
      deviceName,
      deviceLabel,
      controlCapabilityId,
      capabilityObj,
    });
  }
  return {
    resolvedOn: parsedControlState.resolvedOn,
    binaryControl: resolveBinaryControl({
      currentOn: parsedControlState.resolvedOn,
      controlCapabilityId,
      previousSnapshot,
    }),
    canSetControl: parsedControlState.canSetControl,
    observedCurrentOn,
    hasTrustedControlState: resolvedCurrentOn.trusted,
  };
}

/**
 * Resolves the nested `binaryControl` for the parsed snapshot. Present IFF the
 * device has binary control now, OR (transient capability-drop case) it was
 * binary on the previous snapshot — in which case the prior `.on` is latched.
 * Genuinely-non-binary devices get `undefined` (the old fabricated `currentOn:
 * true` is dropped; consumers treat absence as "may always draw").
 */
function resolveBinaryControl(params: {
  currentOn?: boolean;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  previousSnapshot?: TargetDeviceSnapshot;
}): { on: boolean } | undefined {
  const { currentOn, controlCapabilityId, previousSnapshot } = params;
  const isBinary = controlCapabilityId !== undefined || previousSnapshot?.controlCapabilityId !== undefined;
  if (!isBinary) return undefined;
  // Latch the prior `.on` in the transient capability-drop case: `currentOn`
  // already carries the latched value via `resolvedOn`, but if that resolves
  // `undefined` (e.g. an inconsistent previous snapshot) fall back to the
  // previous `binaryControl.on` directly so a trusted on-state is never lost on
  // a missing read (only a genuine cold start coalesces to `false`).
  return { on: currentOn ?? previousSnapshot?.binaryControl?.on ?? false };
}

/**
 * Synthesizes a `currentOn` value for the rare case where {@link getCurrentOn}
 * could not read a trusted boolean.
 *
 * ## Why this exists at all
 * `currentOn` is contractually a non-optional `boolean`, but the Homey SDK types
 * do not guarantee a capability value is present — `capabilitiesObj[id].value` is
 * typed `unknown` and the entry itself is optional. So the parser can be handed a
 * control capability with no readable boolean **purely as a type-level
 * possibility**. At runtime a real binary device's `onoff` always carries a
 * value+timestamp; this branch is a should-never-happen, *types-driven* boundary
 * case, not a real "device went unobserved" state. That is the only reason we
 * synthesize.
 *
 * ## Why we synthesize here, at the source
 * Resolving the missing value to a concrete boolean at the parse boundary means
 * every downstream consumer (planner, executor, shedding, UI) reads a real
 * `boolean` and never re-handles "missing". The alternative — **throwing** on a
 * missing value — is equally defensible, but it does not remove the decision: a
 * caller catching it would still have to synthesize *some* value to keep planning
 * and executing, just further from the boundary and duplicated per call site. We
 * centralize that one decision here and log the anomaly at error
 * (`device_snapshot_control_state_dropped`) so the should-never-happen case is
 * still visible.
 *
 * ## What we synthesize (never an optimistic `true`)
 * Claiming a device is on without evidence is what let an unobserved load look
 * already-restored, so the synthesized value is deliberately non-optimistic:
 * - invalid-payload (wrong-typed value, a different anomaly) → latch previous
 *   when possible, but do not make that fallback commandable unless it came
 *   from trusted binary evidence;
 * - binary device with a missing value → latch previous trusted evidence, else
 *   synthesize untrusted `false`;
 * - no control capability but binary last snapshot (transient capability drop on
 *   a partial update) → latch previous (no phantom on-transition);
 * - genuinely non-binary (no off-switch, setpoint-controlled) → `true` — it may
 *   always draw, so it must stay sheddable (a `false` reads as 0-draw).
 *
 * @returns the synthesized `currentOn` plus whether that value came from trusted
 *   evidence. Untrusted values are contract fillers only.
 */
function resolveUnobservedControlFallback(params: {
  invalidControlPayload: boolean;
  previousSnapshot?: TargetDeviceSnapshot;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): ResolvedControlFallback {
  const { invalidControlPayload, previousSnapshot, controlCapabilityId } = params;
  // A wrong-typed value is a different anomaly — latch the previous observation
  // (coupled to device-drop handling).
  if (invalidControlPayload) {
    const previousTrusted = resolvePreviousTrustedCurrentOn({ previousSnapshot, controlCapabilityId });
    if (previousTrusted !== undefined) return { currentOn: previousTrusted, trusted: true };
    return {
      currentOn: resolvePreviousCurrentOn({ previousSnapshot, controlCapabilityId }),
      trusted: false,
    };
  }
  // Binary device (control capability present) with a missing value → no new
  // evidence. Preserve prior trusted evidence; otherwise synthesize
  // non-optimistic `false` as a contract filler only.
  if (controlCapabilityId !== undefined) {
    const previousTrusted = resolvePreviousTrustedCurrentOn({ previousSnapshot, controlCapabilityId });
    if (previousTrusted !== undefined) return { currentOn: previousTrusted, trusted: true };
    return { currentOn: false, trusted: false };
  }
  // No control capability NOW. If the device was binary on the previous
  // snapshot, this is a transient capability drop (a partial update) — preserve
  // the prior state rather than synthesising an on-transition.
  if (previousSnapshot?.controlCapabilityId !== undefined) {
    const previousTrusted = resolvePreviousTrustedCurrentOn({
      previousSnapshot,
      controlCapabilityId: previousSnapshot.controlCapabilityId,
    });
    return {
      currentOn: previousTrusted ?? previousSnapshot.binaryControl?.on,
      trusted: previousTrusted !== undefined,
    };
  }
  // Genuinely non-binary (no off-switch, setpoint-controlled) → `true`: it may
  // always draw, so it must stay sheddable (a `false` reads as 0-draw).
  return { currentOn: true, trusted: true };
}

function resolvePreviousTrustedCurrentOn(params: {
  previousSnapshot?: TargetDeviceSnapshot;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean | undefined {
  const { previousSnapshot, controlCapabilityId } = params;
  if (!previousSnapshot || !controlCapabilityId) return undefined;
  if (previousSnapshot.controlCapabilityId !== controlCapabilityId) return undefined;
  const previousObservation = previousSnapshot.binaryControlObservation;
  if (previousObservation?.capabilityId !== controlCapabilityId) return undefined;
  const previousOn = previousSnapshot.binaryControl?.on;
  if (previousOn !== previousObservation.observedValue) return undefined;
  return previousOn;
}

function resolvePreviousCurrentOn(params: {
  previousSnapshot?: TargetDeviceSnapshot;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean | undefined {
  const { previousSnapshot, controlCapabilityId } = params;
  if (!previousSnapshot) return undefined;
  if (previousSnapshot.controlCapabilityId !== controlCapabilityId) return undefined;
  return previousSnapshot.binaryControl?.on;
}

function hasInvalidControlPayload(params: {
  capabilityObj: DeviceCapabilityMap;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean {
  const { capabilityObj, controlCapabilityId } = params;
  if (!controlCapabilityId) return false;
  const capability = capabilityObj[controlCapabilityId];
  if (!capability || !('value' in capability)) return false;
  if (capability.value === undefined) return false;
  return typeof capability.value !== 'boolean';
}

function logDroppedControlState(params: {
  logger: Logger;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  controlCapabilityId: NonNullable<TargetDeviceSnapshot['controlCapabilityId']>;
  capabilityObj: DeviceCapabilityMap;
}): void {
  const {
    logger,
    deviceId,
    deviceName,
    deviceLabel,
    controlCapabilityId,
    capabilityObj,
  } = params;
  const rawValue = capabilityObj[controlCapabilityId]?.value;
  (logger.structuredLog ?? moduleLogger).error({
    event: 'device_snapshot_control_state_dropped',
    reasonCode: controlCapabilityId === 'evcharger_charging'
      ? 'missing_ev_charging_state'
      : 'missing_boolean_onoff',
    source: 'snapshot_parse',
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    deviceLabel,
    capabilityId: controlCapabilityId,
    controlCapabilityId,
    rawValue: rawValue ?? null,
    rawValueType: typeof rawValue,
  });
}
