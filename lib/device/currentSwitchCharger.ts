/**
 * A charger PELS steps through one writable whole-amp current capability, and
 * whose charging switch is that current: below 6 A the car pauses. The shared
 * shape of integrations whose app turns its own charging switch on at a
 * current PELS did not choose (the last one, or the charger's maximum).
 * See `notes/native-wiring/alfen.md` and `notes/native-wiring/peblar.md`.
 *
 * Under built-in control:
 * - **on** writes the ladder's lowest charging current, never the app's switch;
 *   PELS sets its planned level from there with its ordinary step commands.
 * - **off** goes to the app's switch, which pauses the charger and holds it.
 * - The switch is read from the current, on at 6 A or more, dated by it. The
 *   app's own switch events are dropped: they say whether a car draws now,
 *   which a full car or one waiting to start never does.
 * Without built-in control the switch is the app's.
 *
 * The integration supplies only what is its own: which driver it is, the
 * capability and Flow card that set the current, and the watts per amp its
 * charger draws. It owns nothing else here, so no state is held.
 */
import type {
  CapabilityWrite, DeviceAdapter, NativeCurrentControl, SwitchWrite,
} from './deviceAdapter';
import type { DeviceCapabilityMap } from './managerControl';
import type { HomeyDeviceLike } from '../utils/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ChargerPhaseReport } from './chargerPhasePreset';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { standardDeviceAdapter } from './standardDeviceAdapter';
import { sortSteppedLoadSteps, isSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { TARGET_POWER_MAX_GENERATED_STEPS } from '../../packages/shared-domain/src/targetPowerLadder';

/** The smallest current a car charges at; below it the charger pauses. */
export const CURRENT_SWITCH_MIN_CHARGING_A = 6;
const PHASE_VOLTAGE = 230;

export type CurrentSwitchCharger = {
  /** The writable whole-amp charging current the app reads back. */
  currentCapabilityId: string;
  /** The app's Flow card that sets the same current: a user Flow using it conflicts. */
  currentFlowCardId: string;
  matches(device: HomeyDeviceLike): boolean;
  /** Whether a capability list is this driver's, including `[current, card]` alone. */
  matchesCapabilities(capabilities: readonly string[]): boolean;
  /** The phases the charger draws on, from its own reports and settings. */
  phases(device: HomeyDeviceLike, values: DeviceCapabilityMap | undefined): 1 | 3 | undefined;
};

export function readCurrentA(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function automaticProfile(
  charger: CurrentSwitchCharger, device: HomeyDeviceLike, values: DeviceCapabilityMap,
): SteppedLoadProfile | undefined {
  const phases = charger.phases(device, values);
  const current = values[charger.currentCapabilityId];
  const max = typeof current?.max === 'number' && Number.isFinite(current.max) ? Math.floor(current.max) : undefined;
  if (phases === undefined || max === undefined || current?.setable !== true) return undefined;
  const count = max - CURRENT_SWITCH_MIN_CHARGING_A + 1;
  if (count < 1 || count > TARGET_POWER_MAX_GENERATED_STEPS) return undefined;
  return { steps: [
    { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    ...Array.from({ length: count }, (_, index) => {
      const amps = CURRENT_SWITCH_MIN_CHARGING_A + index;
      return { id: `${amps}a`, planningPowerW: amps * phases * PHASE_VOLTAGE, planningCurrentA: amps };
    }),
  ] };
}

/** The rung nearest the current the charger holds; under 6 A is the off step. */
function resolveCurrentStep(
  capabilityId: string, profile: SteppedLoadProfile, values: DeviceCapabilityMap,
): string | undefined {
  const currentA = readCurrentA(values[capabilityId]?.value);
  if (currentA === undefined) return undefined;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  if (currentA < CURRENT_SWITCH_MIN_CHARGING_A) {
    return sortedSteps.find((step) => isSteppedLoadOffStep(profile, step.id))?.id;
  }
  // eslint-disable-next-line functional/immutable-data -- Sorts a newly allocated candidate array.
  return sortedSteps
    .flatMap((step) => (
      step.planningCurrentA === undefined || isSteppedLoadOffStep(profile, step.id)
        ? [] : [{ id: step.id, distanceA: Math.abs(step.planningCurrentA - currentA) }]
    ))
    .sort((left, right) => left.distanceA - right.distanceA)[0]?.id;
}

/** The lowest current the ladder charges at. */
function resumeCurrent(snapshot: TransportDeviceSnapshot): number {
  const currents = (snapshot.steppedLoadProfile?.steps ?? [])
    .flatMap((step) => (step.planningCurrentA !== undefined && step.planningCurrentA >= CURRENT_SWITCH_MIN_CHARGING_A
      ? [step.planningCurrentA] : []));
  return currents.length > 0 ? Math.min(...currents) : CURRENT_SWITCH_MIN_CHARGING_A;
}

const NO_SESSION_EVIDENCE = { hasCarStopEvidence: () => false };

/** The adapter for one such integration. */
export function createCurrentSwitchChargerAdapter(charger: CurrentSwitchCharger): DeviceAdapter {
  const { currentCapabilityId } = charger;
  const isUnderBuiltInControl = (
    snapshot: Pick<TransportDeviceSnapshot, 'controlAdapter' | 'capabilities'>,
  ): boolean => snapshot.controlAdapter?.kind === 'capability_adapter'
    && snapshot.controlAdapter.activationAvailable !== undefined
    && snapshot.controlAdapter.activationEnabled === true
    && snapshot.capabilities?.includes(currentCapabilityId) === true;

  const withCurrentSwitch = (values: DeviceCapabilityMap): DeviceCapabilityMap => {
    const charging = values.evcharger_charging;
    const current = values[currentCapabilityId];
    const currentA = readCurrentA(current?.value);
    if (charging === undefined || currentA === undefined) return values;
    return { ...values, evcharger_charging: { ...charging,
      value: currentA >= CURRENT_SWITCH_MIN_CHARGING_A, lastUpdated: current?.lastUpdated } };
  };

  const switchWrite = (snapshot: TransportDeviceSnapshot, request: CapabilityWrite): SwitchWrite => {
    const plain = standardDeviceAdapter.switchWrite(snapshot, request, NO_SESSION_EVIDENCE);
    if (typeof request.value !== 'boolean' || plain.kind === 'none' || !isUnderBuiltInControl(snapshot)) return plain;
    // Read from the current under built-in control, the switch is no observation of either write.
    if (!request.value) return { ...plain, readBackAsWritten: false };
    return { kind: 'write', write: { capabilityId: currentCapabilityId, value: resumeCurrent(snapshot) },
      readBackAsWritten: false };
  };

  const phaseReport = (device: HomeyDeviceLike): ChargerPhaseReport => {
    if (!charger.matches(device)) return { kind: 'not_reported' };
    const phases = charger.phases(device, device.capabilitiesObj as DeviceCapabilityMap | undefined);
    if (phases === undefined) return { kind: 'not_reported' };
    return { kind: 'reported', preset: phases === 1 ? 'ev_charger_1_phase' : 'ev_charger_3_phase' };
  };

  const currentControl: NativeCurrentControl = {
    capabilityId: currentCapabilityId,
    writeCapabilities: [currentCapabilityId, charger.currentFlowCardId],
    minimumChargingA: CURRENT_SWITCH_MIN_CHARGING_A,
    accepts: (device, values) => charger.matches(device) && values[currentCapabilityId]?.setable === true,
    automaticProfile: (device, values) => automaticProfile(charger, device, values),
    stepObservations: (profile, values) => {
      const step = resolveCurrentStep(currentCapabilityId, profile, values);
      return step === undefined ? [] : [step];
    },
  };

  return {
    ...standardDeviceAdapter,
    matches: charger.matches,
    matchesCapabilities: charger.matchesCapabilities,
    finalizeObservation: (control, capabilities, values) => control.activationAvailable !== undefined
      && control.activationEnabled && capabilities.includes(currentCapabilityId)
      ? withCurrentSwitch(values) : values,
    normalize: (snapshot, capabilityId, value) => {
      if (!isUnderBuiltInControl(snapshot)) return [{ capabilityId, value }];
      if (capabilityId === 'evcharger_charging') return [];
      const currentA = capabilityId === currentCapabilityId ? readCurrentA(value) : undefined;
      if (currentA === undefined) return [{ capabilityId, value }];
      return [{ capabilityId, value },
        { capabilityId: 'evcharger_charging', value: currentA >= CURRENT_SWITCH_MIN_CHARGING_A }];
    },
    readRules: (device) => charger.matches(device)
      ? { [currentCapabilityId]: (value) => readCurrentA(value) !== undefined } : {},
    phaseReport,
    nativeCurrentControls: [currentControl],
    switchWrite: (snapshot, request) => switchWrite(snapshot, request),
    recoverSwitchWrite: (snapshot, _raw, request) => switchWrite(snapshot, request),
  };
}
