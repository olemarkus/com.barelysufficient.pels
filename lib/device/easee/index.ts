import type { DeviceAdapter, NativeCurrentControl, DeviceReadRules } from '../deviceAdapter';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { isEaseeDevice, resolveEaseePhaseReport } from './phases';
import { isEaseeChargerDevice, isEaseeChargerCurrentCandidate, EASEE_CHARGER_CURRENT_CAPABILITY_ID,
  EASEE_CHARGER_CURRENT_FLOW_CARD_ID, EASEE_MIN_CHARGING_CURRENT_A, resolveCurrentStep } from './current';
import { isEaseeUnderBuiltInControl, resolveEaseeRealtimeUpdates, withEaseeObservedCharging,
  resolveEaseeSwitchWrite, recoverEaseeSwitchWrite } from './switch';

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

export const easeeAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isEaseeDevice(device) || isEaseeChargerDevice(device),
  matchesCapabilities: (capabilities) => capabilities.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID),
  normalize: (snapshot, capabilityId, value) => isEaseeUnderBuiltInControl(snapshot)
    ? resolveEaseeRealtimeUpdates(snapshot, capabilityId, value) : [{ capabilityId, value }],
  finalizeObservation: (control, capabilities, values) => control.activationAvailable !== undefined
    && control.activationEnabled && capabilities.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID)
    ? withEaseeObservedCharging(values) : values,
  readRules: (device): DeviceReadRules => isEaseeChargerDevice(device)
    ? { [EASEE_CHARGER_CURRENT_CAPABILITY_ID]: 'number' } : {},
  phaseReport: (device) => isEaseeDevice(device) ? resolveEaseePhaseReport(device.settings) : { kind: 'not_reported' },
  nativeCurrentControls: [currentControl],
  switchWrite: (snapshot, request) => {
    const plain = standardDeviceAdapter.switchWrite(snapshot, request);
    if (typeof request.value !== 'boolean') return plain;
    const resolved = resolveEaseeSwitchWrite(snapshot, request.value);
    return { write: resolved.kind === 'current' ? resolved.write : plain.write,
      readBackAsWritten: !isEaseeUnderBuiltInControl(snapshot) };
  },
  recoverSwitchWrite: (snapshot, raw, request) => {
    const plain = easeeAdapter.switchWrite(snapshot, request);
    if (typeof request.value !== 'boolean') return plain;
    const resolved = recoverEaseeSwitchWrite(snapshot, raw, request.value);
    return { ...plain, write: resolved.kind === 'current' ? resolved.write : plain.write };
  },
};
