/**
 * The community OCPP Server app's charger (`com.dnetlabs.ocpp`, `charger`
 * driver), which lets an OCPP 1.6 charger connect to Homey. See
 * `notes/native-wiring/ocpp-server.md`.
 *
 * Its setable `target_power` sets the charger's current limit and never starts
 * a session; its range is 0 W to `max_current` on the device's `phases`, in
 * 1 A steps, with no charging minimum. The adapter adds the 6 A floor on those
 * phases, so the native ladder starts at 1380 W on one phase and 4140 W on
 * three. Without a readable `phases` setting the floor is unknown, and the read
 * is parsed without its watt control rather than guessing.
 *
 * The app leaves `evcharger_charging` empty (null) until its first session
 * starts, and sets it true on a start and false on a stop: an empty switch is
 * read as off, dated by the charger's session state, so a plugged-in car is
 * started when there is room.
 *
 * Starting and stopping uses the app's `evcharger_charging`: a positive limit
 * is prepared and read back before a start, as the app opens a session only
 * from the switch. A 0 W target stops nothing on the app's default
 * `stop_behavior`, so the switch is the off step on every setting.
 */
import type { DeviceAdapter, DeviceEvOverlay } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TargetPowerConfigWithReachability } from '../targetPowerReachability';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { resolveTargetPowerPresetPhaseCount } from '../../../packages/shared-domain/src/targetPowerStepping';

const DRIVER_IDS = new Set(['homey:app:com.dnetlabs.ocpp:charger', 'com.dnetlabs.ocpp:charger']);
const MIN_CURRENT_A = 6;
const PHASE_VOLTAGE = 230;
/** Parsed without these when the charger's phases are unknown: no ladder can be built. */
const WATT_CONTROL: readonly string[] = ['target_power', 'target_power_mode'];

function isOcppServerCharger(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

/** The `phases` device setting, which the app keeps as `"1"` or `"3"`. */
function readPhases(device: HomeyDeviceLike): 1 | 3 | undefined {
  const phases = device.settings.phases;
  if (phases === '1' || phases === 1) return 1;
  if (phases === '3' || phases === 3) return 3;
  return undefined;
}

/** The watts the app converts one amp to: 230 V on each of the charger's phases. */
function wattsPerAmp(device: HomeyDeviceLike): number | undefined {
  const phases = readPhases(device);
  return phases === undefined ? undefined : phases * PHASE_VOLTAGE;
}

/**
 * An empty switch, read as the stopped session it stands for: off, dated by
 * its own reading or else by the session state that reads with it. An empty
 * switch with neither date stays as it is, and is rejected as unread.
 */
function withSessionSwitch(device: HomeyDeviceLike): HomeyDeviceLike {
  const charging = device.capabilitiesObj.evcharger_charging;
  if (!isOcppServerCharger(device) || charging === undefined || charging.value !== null) return device;
  const lastUpdated = charging.lastUpdated ?? device.capabilitiesObj.evcharger_charging_state?.lastUpdated;
  if (lastUpdated === undefined || lastUpdated === null) return device;
  return {
    ...device,
    capabilitiesObj: { ...device.capabilitiesObj, evcharger_charging: { ...charging, value: false, lastUpdated } },
  };
}

function chargerOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  const target = values.target_power;
  const step = wattsPerAmp(device);
  if (!isOcppServerCharger(device) || target?.setable !== true || step === undefined) {
    return { kind: 'standard', capabilities, capabilityObj: values };
  }
  const declaredMax = typeof target.max === 'number' && Number.isFinite(target.max) && target.max > 0
    ? Math.floor(target.max / step) * step : target.max;
  return {
    kind: 'adapted', capabilities,
    capabilityObj: {
      ...values,
      target_power: { ...target, min: 0, max: declaredMax, step, excludeMin: 0, excludeMax: MIN_CURRENT_A * step },
    },
    // A positive target changes only the limit. Prepare and observe that limit
    // before the switch opens a session, so an old limit cannot start it.
    controlAdapter: { kind: 'capability_adapter', activationRequired: false,
      activationAvailable: false, activationEnabled: true, activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'canonical' },
  };
}

/** A saved continuous range, resolved in the charger's whole amps from 6 A. An EV preset passes through. */
function configureTargetPower(
  device: HomeyDeviceLike, config: TargetPowerConfigWithReachability,
): TargetPowerConfigWithReachability {
  const gridW = wattsPerAmp(device);
  if (config.enabled === false || gridW === undefined || resolveTargetPowerPresetPhaseCount(config.preset)) {
    return config;
  }
  const declared = device.capabilitiesObj.target_power?.max;
  const declaredMax = typeof declared === 'number' && Number.isFinite(declared) && declared > 0
    ? Math.floor(declared / gridW) * gridW : undefined;
  const max = declaredMax === undefined ? config.max : Math.min(config.max ?? declaredMax, declaredMax);
  const minimumA = Math.max(MIN_CURRENT_A, Math.ceil((config.excludeMax ?? 0) / gridW));
  return { ...config, min: 0, max, step: gridW, excludeMin: 0, excludeMax: minimumA * gridW };
}

export const ocppServerAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isOcppServerCharger,
  projectRead: (device) => [withSessionSwitch(device)],
  normalize: (_snapshot, capabilityId, value) => [{
    capabilityId, value: capabilityId === 'evcharger_charging' && value === null ? false : value,
  }],
  overlay: chargerOverlay,
  configureTargetPower,
  // An EV preset plans in the car's phase watts; the app converts on the charger's own phases.
  targetPowerReading: (device, config, value) => {
    const phases = resolveTargetPowerPresetPhaseCount(config.preset);
    const gridW = wattsPerAmp(device);
    return phases && gridW !== undefined ? Math.round((value / gridW) * PHASE_VOLTAGE * phases) : value;
  },
  stepCommand: (device, step, command) => {
    const gridW = wattsPerAmp(device);
    return command.capabilityId === 'target_power' && step.planningCurrentA !== undefined && gridW !== undefined
      ? { ...command, value: Math.round(step.planningCurrentA * gridW) } : command;
  },
  createSession: (home) => ({
    ...standardDeviceAdapter.createSession(home),
    withheldCapabilities: (device) => (
      isOcppServerCharger(device) && device.capabilities.includes('target_power') && readPhases(device) === undefined
        ? WATT_CONTROL : []
    ),
  }),
};
