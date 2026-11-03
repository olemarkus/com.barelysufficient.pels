import type {
  CapabilityWrite, DeviceAdapter, NativeCurrentControl, DeviceReadRules, SwitchWrite,
} from '../deviceAdapter';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { isEaseeDevice, resolveEaseePhaseReport } from './phases';
import { isEaseeChargerDevice, isEaseeChargerCurrentCandidate, EASEE_CHARGER_CURRENT_CAPABILITY_ID,
  EASEE_CHARGER_CURRENT_FLOW_CARD_ID, EASEE_MIN_CHARGING_CURRENT_A, resolveCurrentStep } from './current';
import { isEaseeUnderBuiltInControl, resolveEaseeRealtimeUpdates, withEaseeObservedCharging,
  resolveEaseeSwitchWrite, recoverEaseeSwitchWrite, type EaseeSwitchWrite } from './switch';
import { EASEE_CHARGER_STATUS, withEaseeChargingState } from './chargingState';
import { EaseeChargingSession } from './session';

const currentControl: NativeCurrentControl = {
  capabilityId: EASEE_CHARGER_CURRENT_CAPABILITY_ID,
  writeCapabilities: [EASEE_CHARGER_CURRENT_CAPABILITY_ID, EASEE_CHARGER_CURRENT_FLOW_CARD_ID],
  minimumChargingA: EASEE_MIN_CHARGING_CURRENT_A,
  stepObservations: (profile, values) => {
    const step = resolveCurrentStep(profile, values);
    return step === undefined ? [] : [step];
  },
  accepts: isEaseeChargerCurrentCandidate,
};

// Under built-in control the switch is read from the plug state and the current,
// so PELS's own write to it is no observation of it (`withEaseeObservedCharging`).
const toSwitchWrite = (
  snapshot: TransportDeviceSnapshot, resolved: EaseeSwitchWrite, plain: CapabilityWrite,
): SwitchWrite => {
  if (resolved.kind === 'none') return resolved;
  return { kind: 'write', write: resolved.kind === 'current' ? resolved.write : plain,
    readBackAsWritten: !isEaseeUnderBuiltInControl(snapshot) };
};

export const easeeAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  readsAsReported: false,
  matches: (device) => isEaseeDevice(device) || isEaseeChargerDevice(device),
  matchesCapabilities: (capabilities) => capabilities.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID),
  overlay: (_device, capabilities, values) => ({
    kind: 'standard', capabilities, capabilityObj: withEaseeChargingState(capabilities, values),
  }),
  observation: (device) => withEaseeChargingState(device.capabilities ?? [], standardDeviceAdapter.observation(device)),
  normalize: (snapshot, capabilityId, value) => isEaseeUnderBuiltInControl(snapshot)
    ? resolveEaseeRealtimeUpdates(snapshot, capabilityId, value) : [{ capabilityId, value }],
  finalizeObservation: (control, capabilities, values) => control.activationAvailable !== undefined
    && control.activationEnabled && capabilities.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID)
    ? withEaseeObservedCharging(values) : values,
  readRules: (device): DeviceReadRules => isEaseeChargerDevice(device)
    ? {
      [EASEE_CHARGER_CURRENT_CAPABILITY_ID]: 'number',
      ...(device.capabilities?.includes(EASEE_CHARGER_STATUS)
        // Any mode name: a full read with one this adapter does not know carries the app's own plug state.
        ? { [EASEE_CHARGER_STATUS]: 'string' } : {}),
    } : {},
  createSession: () => new EaseeChargingSession(),
  phaseReport: (device) => isEaseeDevice(device) ? resolveEaseePhaseReport(device.settings) : { kind: 'not_reported' },
  nativeCurrentControls: [currentControl],
  switchWrite: (snapshot, request, sessions) => {
    const plain = standardDeviceAdapter.switchWrite(snapshot, request, sessions);
    if (typeof request.value !== 'boolean' || plain.kind === 'none') return plain;
    return toSwitchWrite(snapshot, resolveEaseeSwitchWrite(snapshot, request.value, sessions), plain.write);
  },
  recoverSwitchWrite: (snapshot, raw, request, sessions) => {
    const plain = standardDeviceAdapter.switchWrite(snapshot, request, sessions);
    if (typeof request.value !== 'boolean' || plain.kind === 'none') return plain;
    return toSwitchWrite(snapshot, recoverEaseeSwitchWrite(snapshot, raw, request.value, sessions), plain.write);
  },
};
