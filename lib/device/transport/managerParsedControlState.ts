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
  currentOn?: boolean;
  canSetControl: boolean | undefined;
  observedCurrentOn?: boolean;
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
  const candidateCurrentOn = observedCurrentOn
    ?? resolveUnobservedControlFallback({ invalidControlPayload, previousSnapshot, controlCapabilityId });
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
    currentOn: candidateCurrentOn,
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
    currentOn: parsedControlState.currentOn,
    canSetControl: parsedControlState.canSetControl,
    observedCurrentOn,
  };
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
 * - invalid-payload (wrong-typed value, a different anomaly) → latch previous;
 * - binary device with a missing value → `false`;
 * - no control capability but binary last snapshot (transient capability drop on
 *   a partial update) → latch previous (no phantom on-transition);
 * - genuinely non-binary (no off-switch, setpoint-controlled) → `true` — it may
 *   always draw, so it must stay sheddable (a `false` reads as 0-draw).
 *
 * @returns the synthesized `currentOn`, or `undefined` when the previous-snapshot
 *   latch itself has nothing to carry (the caller then coalesces to `false`).
 */
function resolveUnobservedControlFallback(params: {
  invalidControlPayload: boolean;
  previousSnapshot?: TargetDeviceSnapshot;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean | undefined {
  const { invalidControlPayload, previousSnapshot, controlCapabilityId } = params;
  // A wrong-typed value is a different anomaly — latch the previous observation
  // (coupled to device-drop handling).
  if (invalidControlPayload) return resolvePreviousCurrentOn({ previousSnapshot, controlCapabilityId });
  // Binary device (control capability present) with a missing value → the
  // should-never-happen anomaly → non-optimistic `false` (logged at error). We
  // never fabricate an optimistic `true`: that let an unobserved load look
  // already-restored.
  if (controlCapabilityId !== undefined) return false;
  // No control capability NOW. If the device was binary on the previous
  // snapshot, this is a transient capability drop (a partial update) — preserve
  // the prior state rather than synthesising an on-transition.
  if (previousSnapshot?.controlCapabilityId !== undefined) return previousSnapshot.currentOn;
  // Genuinely non-binary (no off-switch, setpoint-controlled) → `true`: it may
  // always draw, so it must stay sheddable (a `false` reads as 0-draw).
  return true;
}

function resolvePreviousCurrentOn(params: {
  previousSnapshot?: TargetDeviceSnapshot;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean | undefined {
  const { previousSnapshot, controlCapabilityId } = params;
  if (!previousSnapshot) return undefined;
  if (previousSnapshot.controlCapabilityId !== controlCapabilityId) return undefined;
  return previousSnapshot.currentOn;
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
