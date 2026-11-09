import type { HomeBatteryCapabilityBinding, HomeBatteryClaimBinding, TargetPowerDefaults } from './deviceAdapter';
import type { HomeyDeviceLike } from '../utils/types';

/**
 * Homey's standard home-battery binding, the one every battery integration
 * starts from (`notes/battery-vendor-bindings.md`): a writable signed
 * `target_power` (positive charges), taken over through `target_power_mode`
 * set to `homey`. Integrations that drive their battery differently state it
 * in their own `DeviceAdapter.homeBatteryBinding`; this module names no app.
 */

/** Homey's standard claim: `target_power_mode` set to `homey`. A rejected write is an unanswered one. */
export const STANDARD_HOME_BATTERY_CLAIM: HomeBatteryClaimBinding = {
  capabilityId: 'target_power_mode',
  homeyValue: 'homey',
  rejection: 'unanswered',
};

/**
 * Homey's own `target_power` options, applied when a driver declares none.
 * Source: homey-lib `assets/capability/capabilities/target_power.json`
 * (`min: -25000`, `max: 25000`, `step: 1`; checked against homey-lib 2.52.2,
 * the version the Homey CLI ships). homey-lib is not a dependency of this
 * repo, so the values are copied rather than read.
 */
export const HOMEY_TARGET_POWER_DEFAULTS: TargetPowerDefaults = { minW: -25000, maxW: 25000, stepW: 1 };

export const STANDARD_HOME_BATTERY_BINDING: HomeBatteryCapabilityBinding = {
  kind: 'capability',
  claims: [STANDARD_HOME_BATTERY_CLAIM],
  setpointSign: 1,
  rangeDefaults: HOMEY_TARGET_POWER_DEFAULTS,
  zeroSetpointW: 0,
};

const normalizeText = (value: unknown): string => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

/**
 * Whether `device` belongs to the Homey app `appId` (such as `nl.sessy`), by
 * any of the identity fields Homey reports: the owner URI, the driver URI, or
 * a driver id under the app. An integration passes its own app id; common
 * code never calls this with one.
 */
export const isDeviceOfApp = (device: HomeyDeviceLike, appId: string): boolean => {
  const ownerUri = `homey:app:${appId}`;
  if (normalizeText(device.ownerUri) === ownerUri) return true;
  const driverId = normalizeText(device.driverId);
  return driverId.startsWith(`${ownerUri}:`) || driverId.startsWith(`${appId}:`);
};

/**
 * Whether `device` is one of app `appId`'s `driverId` driver (such as
 * `com.sigenergy` and `plant`), by its driver id with or without the
 * `homey:app:` prefix, or by the local driver id Homey reports beside the
 * owning app. An integration passes its own ids; common code never calls this
 * with one.
 */
export const isDeviceOfAppDriver = (device: HomeyDeviceLike, appId: string, driverId: string): boolean => {
  const id = normalizeText(device.driverId);
  const ownerUri = `homey:app:${appId}`;
  if (id === `${ownerUri}:${driverId}` || id === `${appId}:${driverId}`) return true;
  return id === driverId && normalizeText(device.ownerUri) === ownerUri;
};
