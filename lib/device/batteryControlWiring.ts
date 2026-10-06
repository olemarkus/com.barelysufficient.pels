import type {
  HomeBatteryClaimCapabilityId,
  HomeBatteryClaimRejection,
  HomeBatteryControlSurface,
  HomeBatterySetpointRange,
} from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap } from './managerControl';

/**
 * How PELS could drive a home battery: Homey's standard writable signed
 * `target_power` (W; positive charges, negative discharges), taken over through
 * a claim capability. Pure classification of the device's declared
 * capabilities, and the mapping of a signed setpoint onto the range it
 * declares; nothing here writes (`deviceWrites.ts` does, for the actuator's
 * storage intents).
 *
 * A battery is NOT a stepped load. Its `target_power` is signed, so the 0..max
 * ladder `nativeSteppedLoadWiring.ts` builds for a heater or charger would
 * silently drop discharge, and the stepped overlays are gated off for the
 * battery and solar classes (`resolveFlowCapabilityOverlay`).
 */

// Homey's standard signed setpoint. Spelled here rather than borrowed from the
// stepped wiring: a battery's `target_power` is not a stepped one.
export const HOME_BATTERY_SETPOINT_CAPABILITY_ID = 'target_power';
const TARGET_POWER_MODE_CAPABILITY_ID = 'target_power_mode';
const TARGET_POWER_MODE_HOMEY_VALUE = 'homey';

/*
 * The Sessy binding, verified against the Sessy app's source (nl.sessy,
 * `drivers/sessy/device.js` and `driver.compose.json`):
 *
 * - `control_strategy` is a setable enum whose values include
 *   `POWER_STRATEGY_API`, the strategy that hands the battery to Homey.
 * - The `target_power` listener acts only under `POWER_STRATEGY_API`
 *   (`setPowerSetpoint` throws otherwise, unless the owner set
 *   `force_control_strategy`), so the claim is written before every setpoint.
 *   It writes `power_setpoint = -target_power`, and a positive
 *   `power_setpoint` discharges: Homey's sign, positive charges.
 * - `setControlStrategy` throws unless the device uses its local login
 *   (`useLocalLogin`). A Sessy connected through its cloud login rejects every
 *   claim, so a rejected claim write means its app refuses control
 *   (`app_refuses_control`), not a battery that did not answer.
 * - The driver declares no `target_power` min, max or step.
 */
const SESSY_CONTROL_STRATEGY_CAPABILITY_ID = 'control_strategy';
const SESSY_CONTROL_STRATEGY_HOMEY_VALUE = 'POWER_STRATEGY_API';
const SESSY_OWNER_URI = 'homey:app:nl.sessy';
const SESSY_DRIVER_ID_PREFIXES = ['homey:app:nl.sessy:', 'nl.sessy:'] as const;

/** The `target_power` edges a driver leaves out are read as these, W. */
type TargetPowerDefaults = { minW: number; maxW: number; stepW: number };

/**
 * Homey's own `target_power` options, applied when a driver declares none.
 * Source: homey-lib `assets/capability/capabilities/target_power.json`
 * (`min: -25000`, `max: 25000`, `step: 1`; checked against homey-lib 2.52.2,
 * the version the Homey CLI ships). homey-lib is not a dependency of this
 * repo, so the values are copied rather than read.
 */
const HOMEY_TARGET_POWER_DEFAULTS: TargetPowerDefaults = { minW: -25000, maxW: 25000, stepW: 1 };

/**
 * A Sessy's `target_power` edges when it declares none, in PELS's sign
 * (positive charges): the Sessy app's own charge-mode presets, `setChargeMode`
 * in nl.sessy `drivers/sessy/device.js` (`CHARGE` sets `power_setpoint` -2200,
 * `DISCHARGE` +1800, and `target_power` is `-power_setpoint`). Homey's ±25 kW
 * would let PELS credit a whole deficit to a 2.2 kW battery until it learned a
 * plateau. An edge the driver declares always wins.
 */
const SESSY_TARGET_POWER_DEFAULTS: TargetPowerDefaults = {
  minW: -1800,
  maxW: 2200,
  stepW: HOMEY_TARGET_POWER_DEFAULTS.stepW,
};

type CapabilityEntry = Readonly<Record<string, unknown>>;

const asCapabilityEntry = (value: unknown): CapabilityEntry | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as CapabilityEntry : undefined
);

/**
 * A declared numeric option: the default when the driver leaves it out, the
 * number when it is finite, and `null` for anything else, which is junk.
 */
const readNumericOption = (entry: CapabilityEntry, key: string, fallback: number): number | null => {
  const value = entry[key];
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * The signed range, or `null` when the options do not describe one: a range
 * that does not straddle 0, a step that is not positive, or an exclude band
 * that does not contain 0 (Homey's own validator rejects that last one).
 * Malformed numbers are treated the same: no range PELS could write against.
 */
const resolveSignedRange = (entry: CapabilityEntry, defaults: TargetPowerDefaults): HomeBatterySetpointRange | null => {
  const minW = readNumericOption(entry, 'min', defaults.minW);
  const maxW = readNumericOption(entry, 'max', defaults.maxW);
  const stepW = readNumericOption(entry, 'step', defaults.stepW);
  // Homey reads a missing exclude edge as 0 (homey-lib `lib/App/index.js`), so
  // a device with no band resolves to the empty band (0, 0).
  const excludeMinW = readNumericOption(entry, 'excludeMin', 0);
  const excludeMaxW = readNumericOption(entry, 'excludeMax', 0);
  if (minW === null || maxW === null || stepW === null || excludeMinW === null || excludeMaxW === null) return null;
  if (!(minW < 0 && maxW > 0 && stepW > 0)) return null;
  if (excludeMinW > 0 || excludeMaxW < 0) return null;
  return { minW, maxW, stepW, excludeMinW, excludeMaxW };
};

/** The ids an enum capability declares (`values: [{ id }]`); junk entries are skipped. */
const readEnumValueIds = (entry: CapabilityEntry): string[] => {
  const values = entry.values;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value: unknown) => {
    const id = asCapabilityEntry(value)?.id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
};

const normalizeText = (value: unknown): string => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

/** A device of the Sessy app, matched the way `isHoiaxDevice` matches Høiax. */
const isSessyDevice = (device: HomeyDeviceLike): boolean => {
  if (normalizeText(device.ownerUri ?? device.driver?.owner_uri) === SESSY_OWNER_URI) return true;
  if (normalizeText(device.driverUri ?? device.driver?.uri) === SESSY_OWNER_URI) return true;
  const driverId = normalizeText(device.driverId ?? device.driver?.id);
  return SESSY_DRIVER_ID_PREFIXES.some((prefix) => driverId.startsWith(prefix));
};

type ClaimCandidate = {
  capabilityId: HomeBatteryClaimCapabilityId;
  homeyValue: string;
  rejection: HomeBatteryClaimRejection;
};

/**
 * The claim capabilities this battery declares, in preference order: the
 * standard `target_power_mode`, then Sessy's `control_strategy`. A custom
 * capability id means nothing outside the app that defined it, so
 * `control_strategy` is only a claim on a Sessy driver.
 */
const resolveClaimCandidates = (
  device: HomeyDeviceLike,
  capabilities: readonly string[],
): ClaimCandidate[] => [
  ...(capabilities.includes(TARGET_POWER_MODE_CAPABILITY_ID)
    ? [{
      capabilityId: TARGET_POWER_MODE_CAPABILITY_ID,
      homeyValue: TARGET_POWER_MODE_HOMEY_VALUE,
      rejection: 'unanswered',
    } as const]
    : []),
  ...(capabilities.includes(SESSY_CONTROL_STRATEGY_CAPABILITY_ID) && isSessyDevice(device)
    ? [{
      capabilityId: SESSY_CONTROL_STRATEGY_CAPABILITY_ID,
      homeyValue: SESSY_CONTROL_STRATEGY_HOMEY_VALUE,
      rejection: 'app_refuses_control',
    } as const]
    : []),
];

/**
 * Classify a home battery's control surface from its declared capabilities.
 * `capabilityObj` is the raw Homey `capabilitiesObj`: target_power options
 * (`setable`, `min`, `max`, `step`, `excludeMin`, `excludeMax`) are read the
 * way `buildSyntheticTargetPowerCapabilityMap` reads them, and an enum claim
 * capability's `values` are read as `[{ id }]`. A claim capability must be
 * setable and declare its claim value.
 */
export function resolveBatteryControlSurface(
  device: HomeyDeviceLike,
  capabilities: readonly string[],
  capabilityObj: DeviceCapabilityMap,
): HomeBatteryControlSurface {
  const targetPower = capabilities.includes(HOME_BATTERY_SETPOINT_CAPABILITY_ID)
    ? asCapabilityEntry(capabilityObj[HOME_BATTERY_SETPOINT_CAPABILITY_ID])
    : undefined;
  if (targetPower === undefined) return { kind: 'observe_only', reason: 'no_target_power' };
  if (targetPower.setable !== true) return { kind: 'observe_only', reason: 'target_power_not_setable' };
  const range = resolveSignedRange(
    targetPower,
    isSessyDevice(device) ? SESSY_TARGET_POWER_DEFAULTS : HOMEY_TARGET_POWER_DEFAULTS,
  );
  if (range === null) return { kind: 'observe_only', reason: 'not_signed_range' };

  const candidates = resolveClaimCandidates(device, capabilities).flatMap((candidate) => {
    const entry = asCapabilityEntry(capabilityObj[candidate.capabilityId]);
    return entry !== undefined && entry.setable === true ? [{ ...candidate, values: readEnumValueIds(entry) }] : [];
  });
  if (candidates.length === 0) return { kind: 'observe_only', reason: 'no_claim_capability' };
  const claim = candidates.find((candidate) => candidate.values.includes(candidate.homeyValue));
  if (claim === undefined) return { kind: 'observe_only', reason: 'claim_value_missing' };
  return { kind: 'setpoint', claim, range };
}

export { toTargetPowerCapabilityValue } from '../utils/storageSetpoint';
