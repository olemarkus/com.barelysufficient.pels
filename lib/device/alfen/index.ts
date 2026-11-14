/**
 * The official Alfen app (`com.alfen`, `chargepoint` driver) at the SDK seam.
 * See `notes/native-wiring/alfen.md`.
 *
 * Its `target_power` is the charger's external charging limit, and the only
 * control PELS uses: a positive limit lets the car charge at it, 0 W stops it.
 * The app's own `evcharger_charging` is never written or read. Writing it
 * replaces that same limit, with the station maximum (32 A) for `true`, and the
 * app publishes it as "is charging now", which a full car or one waiting to
 * start never is. So the charging switch is the limit: on while it lets a car
 * charge (6 A per phase or more), off otherwise.
 */
import type {
  CapabilityWrite, DeviceAdapter, DeviceEvOverlay, SwitchWrite,
} from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TargetPowerConfigWithReachability } from '../targetPowerReachability';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { resolveTargetPowerPresetPhaseCount } from '../../../packages/shared-domain/src/targetPowerStepping';
import { getSteppedLoadLowestActiveStep } from '../../../packages/shared-domain/src/deviceControlProfiles';

const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 32;
const PHASE_VOLTAGE = 230;
/** The app reads a station as three-phase when L2 or L3 carries more than this. */
const LIVE_PHASE_VOLTAGE = 50;
const DRIVER_IDS = new Set(['homey:app:com.alfen:chargepoint', 'com.alfen:chargepoint']);
/** Declared by every `chargepoint` device and by no other driver PELS knows. */
const SIGNATURE_CAPABILITY = 'measure_current.stationlimit';

function isAlfenChargepoint(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

function readVolts(values: DeviceCapabilityMap | undefined, capabilityId: string): number {
  const volts = values?.[capabilityId]?.value;
  return typeof volts === 'number' && Number.isFinite(volts) ? volts : 0;
}

/**
 * Watts per amp the app converts the limit with: three phases when L2 or L3 is
 * live, otherwise one, as the app counts phases, since that is what turns
 * PELS's watts into the charger's amps.
 */
function wattsPerAmp(values: DeviceCapabilityMap | undefined): number {
  const threePhase = readVolts(values, 'measure_voltage.l2') > LIVE_PHASE_VOLTAGE
    || readVolts(values, 'measure_voltage.l3') > LIVE_PHASE_VOLTAGE;
  return (threePhase ? 3 : 1) * PHASE_VOLTAGE;
}

const deviceWattsPerAmp = (device: HomeyDeviceLike): number => (
  wattsPerAmp(device.capabilitiesObj as DeviceCapabilityMap | undefined)
);

const currentToNativeWatts = (currentA: number, stationWattsPerAmp: number): number => (
  Math.round(currentA * stationWattsPerAmp)
);

/**
 * The complete native ladder starts at 6 A even in Manual. Its watts retain
 * the station phase conversion from the last full read, independently of the
 * owner's planning model. A phase change is picked up at the next full read.
 */
function stationWattsPerAmp(
  snapshot: Pick<TransportDeviceSnapshot, 'automaticPowerControl'>,
): number | undefined {
  const physical = snapshot.automaticPowerControl?.profile;
  const floor = physical && getSteppedLoadLowestActiveStep(physical);
  return floor ? floor.planningPowerW / MIN_CURRENT_A : undefined;
}

/** Whether a limit, in the app's watts, lets a car charge: 6 A per phase or more. */
function allowsCharging(limitW: number, gridWattsPerAmp: number): boolean {
  return limitW / gridWattsPerAmp >= MIN_CURRENT_A - 0.05;
}

function chargerOverlay(
  _device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap,
): DeviceEvOverlay {
  const target = values.target_power;
  if (target?.setable !== true) return { kind: 'standard', capabilities, capabilityObj: values };
  // The app declares 230 W steps and a 1380 W charging floor on every station.
  // On three phases those are a third of an amp and 2 A per phase, which no
  // car charges at, so the ladder is rebuilt in the station's own whole amps.
  const step = wattsPerAmp(values);
  const declaredMax = typeof target.max === 'number' && Number.isFinite(target.max) && target.max > 0
    ? Math.floor(target.max / step) * step : MAX_CURRENT_A * step;
  return {
    kind: 'adapted', capabilities,
    capabilityObj: {
      ...withLimitSwitch(values),
      target_power: { ...target, min: 0, max: Math.min(declaredMax, MAX_CURRENT_A * step), step,
        excludeMin: 0, excludeMax: MIN_CURRENT_A * step },
    },
    controlAdapter: { kind: 'capability_adapter', activationRequired: false,
      activationAvailable: false, activationEnabled: true },
    binaryTarget: { kind: 'canonical' },
  };
}

/** The charging switch read from the limit, dated by it; the app's own switch otherwise stays. */
function withLimitSwitch(values: DeviceCapabilityMap): DeviceCapabilityMap {
  const limit = values.target_power;
  const charging = values.evcharger_charging;
  if (limit?.setable !== true || charging === undefined) return values;
  if (typeof limit.value !== 'number' || !Number.isFinite(limit.value)) {
    // A native write descriptor proves no switch reading. The app's own
    // "charging now" value cannot replace the missing accepted limit.
    const { evcharger_charging: _charging, ...withoutSwitch } = values;
    return withoutSwitch;
  }
  return {
    ...values,
    evcharger_charging: { ...charging, value: allowsCharging(limit.value, wattsPerAmp(values)),
      lastUpdated: limit.lastUpdated },
  };
}

/** The lowest planned charging rung, translated to the station's own watts. */
function resumeWatts(snapshot: TransportDeviceSnapshot): number | undefined {
  const gridWattsPerAmp = stationWattsPerAmp(snapshot);
  const step = snapshot.steppedLoadProfile && getSteppedLoadLowestActiveStep(snapshot.steppedLoadProfile);
  if (!step || gridWattsPerAmp === undefined) return undefined;
  return step.planningCurrentA === undefined ? step.planningPowerW
    : currentToNativeWatts(step.planningCurrentA, gridWattsPerAmp);
}

function switchWrite(snapshot: TransportDeviceSnapshot, request: CapabilityWrite): SwitchWrite {
  if (typeof request.value !== 'boolean' || request.capabilityId !== 'evcharger_charging') {
    return standardDeviceAdapter.switchWrite(snapshot, request);
  }
  const watts = request.value ? resumeWatts(snapshot) : 0;
  // Without a ladder there is no safe current to start at, and the app's switch would start at 32 A.
  if (watts === undefined) return { kind: 'none' };
  return { kind: 'write', write: { capabilityId: 'target_power', value: watts }, readBackAsWritten: false };
}

function configureTargetPower(
  device: HomeyDeviceLike, config: TargetPowerConfigWithReachability,
): TargetPowerConfigWithReachability {
  if (config.enabled === false || resolveTargetPowerPresetPhaseCount(config.preset)) return config;
  const gridW = deviceWattsPerAmp(device);
  const max = Math.min(config.max ?? MAX_CURRENT_A * gridW, MAX_CURRENT_A * gridW);
  const minimumA = Math.max(MIN_CURRENT_A, Math.ceil((config.excludeMax ?? 0) / gridW));
  return { ...config, min: 0, max, step: gridW, excludeMin: 0, excludeMax: minimumA * gridW };
}

export const alfenAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isAlfenChargepoint,
  matchesCapabilities: (capabilities) => capabilities.includes(SIGNATURE_CAPABILITY),
  overlay: chargerOverlay,
  // Derive the switch while target_power is still in the station's raw units.
  // Later preset projection rewrites that value into the car's planning watts.
  observation: (device) => withLimitSwitch(standardDeviceAdapter.observation(device)),
  configureTargetPower,
  targetPowerReading: (device, config, value) => {
    const phases = resolveTargetPowerPresetPhaseCount(config.preset);
    return phases ? Math.round((value / deviceWattsPerAmp(device)) * PHASE_VOLTAGE * phases) : value;
  },
  stepCommand: (device, step, command) => command.capabilityId === 'target_power' && step.planningCurrentA !== undefined
    ? { ...command, value: currentToNativeWatts(step.planningCurrentA, deviceWattsPerAmp(device)) } : command,
  normalize: whileBuiltInControlEnabled((snapshot, capabilityId, value) => {
    // The app's switch says "charging now", not whether PELS lets it charge.
    if (capabilityId === 'evcharger_charging') return [];
    if (capabilityId !== 'target_power' || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return [{ capabilityId, value }];
    }
    const gridWattsPerAmp = stationWattsPerAmp(snapshot);
    if (gridWattsPerAmp === undefined) return [{ capabilityId, value }];
    return [{ capabilityId, value },
      { capabilityId: 'evcharger_charging', value: allowsCharging(value, gridWattsPerAmp) }];
  }),
  switchWrite: (snapshot, request) => switchWrite(snapshot, request),
  recoverSwitchWrite: (snapshot, _raw, request) => switchWrite(snapshot, request),
};
