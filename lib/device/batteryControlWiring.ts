import type { HomeBatteryControlSurface, HomeBatterySetpointRange } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import { asUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { DeviceCapabilityMap } from './managerControl';
import type { HomeBatteryCapabilityBinding, TargetPowerDefaults } from './deviceAdapter';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import { HOMEY_TARGET_POWER_DEFAULTS } from './homeBatteryBinding';

/**
 * How PELS could drive a home battery: a writable signed `target_power`, taken
 * over through a claim capability, as the device's integration binds it
 * (`DeviceAdapter.homeBatteryBinding`, `notes/battery-vendor-bindings.md`).
 * PELS's sign is positive charges, negative discharges, whatever the app's.
 * Pure classification of the device's declared capabilities against that
 * binding, and the mapping of a signed setpoint onto the range and into the
 * app's own value; nothing here writes (`deviceWrites.ts` does, for the
 * actuator's storage intents).
 *
 * A battery is NOT a stepped load. Its `target_power` is signed, so the 0..max
 * ladder `nativeSteppedLoadWiring.ts` builds for a heater or charger would
 * silently drop discharge, and the stepped overlays are gated off for the
 * battery and solar classes (`resolveFlowCapabilityOverlay`).
 */

// Homey's standard signed setpoint. Spelled here rather than borrowed from the
// stepped wiring: a battery's `target_power` is not a stepped one.
export const HOME_BATTERY_SETPOINT_CAPABILITY_ID = 'target_power';

type CapabilityEntry = Readonly<Record<string, unknown>>;

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
 * A `target_power` range edge: the binding's default when the driver leaves it
 * out. Homey fills an edge a driver does not declare with its own capability
 * default (±25 kW, step 1) before PELS reads `capabilitiesObj`, so that value
 * reads as left out too. Without that, a binding's own defaults (Sessy's
 * charge-mode presets) would never apply on a real Homey. For a binding whose
 * defaults are Homey's, nothing changes.
 */
const readRangeEdge = (entry: CapabilityEntry, key: string, homeyDefault: number, fallback: number): number | null => {
  const value = readNumericOption(entry, key, fallback);
  return value === homeyDefault ? fallback : value;
};

/** The app's range in PELS's sign: a flipped binding swaps and negates each pair of edges. */
const toPelsSign = (range: HomeBatterySetpointRange, sign: 1 | -1): HomeBatterySetpointRange => (
  sign === 1 ? range : {
    minW: -range.maxW,
    maxW: -range.minW,
    stepW: range.stepW,
    excludeMinW: range.excludeMaxW === 0 ? 0 : -range.excludeMaxW,
    excludeMaxW: range.excludeMinW === 0 ? 0 : -range.excludeMinW,
  }
);

/**
 * The signed range in PELS's sign, or `null` when the options do not describe
 * one: a range that does not straddle 0, a step that is not positive, or an
 * exclude band that does not contain 0 (Homey's own validator rejects that
 * last one). Malformed numbers are treated the same: no range PELS could
 * write against. The options are read in the app's sign, the binding's
 * defaults filling the edges it leaves out; every check holds in both signs.
 */
const resolveSignedRange = (
  entry: CapabilityEntry,
  binding: HomeBatteryCapabilityBinding,
): HomeBatterySetpointRange | null => {
  const defaults: TargetPowerDefaults = binding.rangeDefaults;
  const minW = readRangeEdge(entry, 'min', HOMEY_TARGET_POWER_DEFAULTS.minW, defaults.minW);
  const maxW = readRangeEdge(entry, 'max', HOMEY_TARGET_POWER_DEFAULTS.maxW, defaults.maxW);
  const stepW = readRangeEdge(entry, 'step', HOMEY_TARGET_POWER_DEFAULTS.stepW, defaults.stepW);
  // Homey reads a missing exclude edge as 0 (homey-lib `lib/App/index.js`), so
  // a device with no band resolves to the empty band (0, 0).
  const excludeMinW = readNumericOption(entry, 'excludeMin', 0);
  const excludeMaxW = readNumericOption(entry, 'excludeMax', 0);
  if (minW === null || maxW === null || stepW === null || excludeMinW === null || excludeMaxW === null) return null;
  if (!(minW < 0 && maxW > 0 && stepW > 0)) return null;
  if (excludeMinW > 0 || excludeMaxW < 0) return null;
  return toPelsSign({ minW, maxW, stepW, excludeMinW, excludeMaxW }, binding.setpointSign);
};

/** The ids an enum capability declares (`values: [{ id }]`); junk entries are skipped. */
const readEnumValueIds = (entry: CapabilityEntry): string[] => {
  const values = entry.values;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value: unknown) => {
    const id = asUnknownRecord(value)?.id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
};

/**
 * Classify a home battery's control surface from its declared capabilities,
 * against the claim capabilities its binding offers, in the binding's order.
 * `capabilityObj` is the raw Homey `capabilitiesObj`: target_power options
 * (`setable`, `min`, `max`, `step`, `excludeMin`, `excludeMax`) are read the
 * way `buildSyntheticTargetPowerCapabilityMap` reads them, and an enum claim
 * capability's `values` are read as `[{ id }]`. A claim capability must be
 * setable and declare its claim value.
 *
 * A battery whose binding is the app's own actions has no capability to
 * classify: its surface is `app_actions`, and whether those actions can run
 * now (the cards installed, the owner's API key) is the transport's read at
 * the moment it is asked (`homeBatteryAppActions.ts`), not a parse fact.
 */
export function resolveBatteryControlSurface(
  device: HomeyDeviceLike,
  capabilities: readonly string[],
  capabilityObj: DeviceCapabilityMap,
): HomeBatteryControlSurface {
  const binding = getDeviceAdapter(device).homeBatteryBinding(device);
  if (binding.kind === 'app_actions') return { kind: 'app_actions' };
  const targetPower = capabilities.includes(HOME_BATTERY_SETPOINT_CAPABILITY_ID)
    ? asUnknownRecord(capabilityObj[HOME_BATTERY_SETPOINT_CAPABILITY_ID])
    : null;
  if (targetPower === null) return { kind: 'observe_only', reason: 'no_target_power' };
  if (targetPower.setable !== true) return { kind: 'observe_only', reason: 'target_power_not_setable' };
  const range = resolveSignedRange(targetPower, binding);
  if (range === null) return { kind: 'observe_only', reason: 'not_signed_range' };

  const declared = binding.claims.filter((candidate) => capabilities.includes(candidate.capabilityId));
  const candidates = declared.flatMap((candidate) => {
    const entry = asUnknownRecord(capabilityObj[candidate.capabilityId]);
    return entry !== null && entry.setable === true ? [{ ...candidate, values: readEnumValueIds(entry) }] : [];
  });
  if (candidates.length === 0) return { kind: 'observe_only', reason: 'no_claim_capability' };
  const claim = candidates.find((candidate) => candidate.values.includes(candidate.homeyValue));
  if (claim === undefined) return { kind: 'observe_only', reason: 'claim_value_missing' };
  return { kind: 'setpoint', claim, range };
}

export { toTargetPowerCapabilityValue } from '../utils/storageSetpoint';

/**
 * The app's `target_power` value for a setpoint already mapped onto the range,
 * in PELS's sign: the binding's 0 W value for 0, then the app's sign.
 */
export function toBatterySetpointCapabilityValue(binding: HomeBatteryCapabilityBinding, setpointW: number): number {
  const valueW = setpointW === 0 ? binding.zeroSetpointW : setpointW;
  return valueW === 0 ? 0 : binding.setpointSign * valueW;
}
