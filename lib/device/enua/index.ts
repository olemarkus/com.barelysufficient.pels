import type { DeviceAdapter, DeviceEvOverlay } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import type { TargetPowerConfigWithReachability } from '../targetPowerReachability';
import { resolveTargetPowerPresetPhaseCount } from '../../../packages/shared-domain/src/targetPowerStepping';

const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 32;
const PHASE_VOLTAGE = 230;
const SHIPPED_MAX_POWER_W = 22080;

function isEnuaCharger(device: HomeyDeviceLike): boolean {
  return device.driverId === 'homey:app:no.enua:enua-charger'
    || device.driverId === 'no.enua:enua-charger';
}

function wattsPerAmp(device: HomeyDeviceLike): number {
  switch (device.settings?.grid_type) {
    case '1phase': return PHASE_VOLTAGE;
    case 'it_3phase': return Math.sqrt(3) * PHASE_VOLTAGE;
    // Enua itself defaults missing/unknown grid types to three-phase TN.
    default: return 3 * PHASE_VOLTAGE;
  }
}

function configureTargetPower(
  device: HomeyDeviceLike, config: TargetPowerConfigWithReachability,
): TargetPowerConfigWithReachability {
  // An EV preset ladder already stops at 32 A in the car's phase watts, and
  // reachability learns a lower installation ceiling. Passing it through keeps
  // the device, reachability and planner reading the same saved preset.
  if (config.enabled === false || resolveTargetPowerPresetPhaseCount(config.preset)) return config;
  const gridW = wattsPerAmp(device);
  const raw = device.capabilitiesObj?.target_power;
  const declaredMaxA = typeof raw?.max === 'number' && Number.isFinite(raw.max) && raw.max > 0
    ? raw.max / gridW : MAX_CURRENT_A;
  const max = Math.min(config.max ?? MAX_CURRENT_A * gridW, Math.min(MAX_CURRENT_A, declaredMaxA) * gridW);
  const minimumA = Math.max(MIN_CURRENT_A, Math.ceil((config.excludeMax ?? 0) / gridW));
  return { ...config, min: 0, max, step: gridW, excludeMin: 0, excludeMax: minimumA * gridW };
}

function chargerOverlay(
  device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap,
): DeviceEvOverlay {
  const target = values.target_power;
  if (!target || target.setable !== true) return { kind: 'standard', capabilities, capabilityObj: values };
  // Enua 3.2.0 live / 3.2.1 test advertise the same 0..22080 W / 230 W
  // range on every grid, but convert watts to whole amps clamped to 6..32 A.
  // Repair only that shipped declaration; an upstream corrected range wins.
  const shippedRange = target.min === 0 && target.max === SHIPPED_MAX_POWER_W
    && target.step === PHASE_VOLTAGE && target.excludeMax === undefined;
  const step = wattsPerAmp(device);
  return {
    kind: 'adapted', capabilities,
    capabilityObj: shippedRange ? {
      ...values,
      target_power: { ...target, max: MAX_CURRENT_A * step, step,
        excludeMin: 0, excludeMax: MIN_CURRENT_A * step },
    } : values,
    // A positive target changes only the limit. Prepare and observe that
    // limit before enabling the session, so an old 32 A limit cannot start it.
    controlAdapter: { kind: 'capability_adapter', activationRequired: false,
      activationAvailable: false, activationEnabled: true, activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'canonical' },
  };
}

export const enuaAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  readsAsReported: false,
  matches: isEnuaCharger,
  overlay: chargerOverlay,
  configureTargetPower,
  targetPowerReading: (device, config, value) => {
    const phases = resolveTargetPowerPresetPhaseCount(config.preset);
    if (!phases) return value;
    const gridWatts = wattsPerAmp(device);
    const wholeAmps = Math.round(value / gridWatts);
    // Homey can retain the rounded watt command until the next vendor poll.
    // Decode that exact encoding before converting to the car's phase units.
    const amps = wholeAmps >= MIN_CURRENT_A && wholeAmps <= MAX_CURRENT_A
      && value === Math.round(wholeAmps * gridWatts) ? wholeAmps : value / gridWatts;
    return Math.round(amps * PHASE_VOLTAGE * phases);
  },
  stepCommand: (device, step, command) => command.capabilityId === 'target_power' && step.planningCurrentA !== undefined
    ? { ...command, value: Math.round(step.planningCurrentA * wattsPerAmp(device)) } : command,
};
