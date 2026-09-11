import type { HomeyDeviceLike } from '../../utils/types';
import { isHomeBatteryDevice, isSolarPanelDevice } from '../managerEnergy';

const SUPPORTED_DEVICE_CLASSES = new Set([
  'thermostat',
  'heater',
  'socket',
  'heatpump',
  'airconditioning',
  'airtreatment',
  // NB: home batteries and solar devices are NOT listed here — `resolveDeviceClassKey`
  // normalizes a role-detected battery (class OR `homeBattery` energy role) to the
  // 'battery' class-key and a role-detected solar device (class:'solarpanel' OR the
  // `meterPowerExportedCapability` producer designation) to the 'solarpanel' class-key
  // BEFORE this set check, so each survives regardless of its real class. Both ride the
  // snapshot as MANAGED OBSERVE-ONLY devices (resolved to `controllable: false` +
  // non-temperature, so every control gate excludes them).
  'evcharger',
]);

/**
 * Whether a device of this RAW Homey class can be driven by PELS — i.e. whether
 * it is in the controllable set above. Exported for the meter-picker rule,
 * which needs the complement: a device PELS can command must never be offered
 * as a meter, because a meter that also switches load does not work here (owner
 * ruling 2026-09-11) and because the two sets being disjoint is what lets the
 * actuator apply a plan without re-checking whether a device is a source.
 */
export const isControllableDeviceClass = (deviceClass: string | undefined): boolean => (
  deviceClass !== undefined && SUPPORTED_DEVICE_CLASSES.has(deviceClass)
);

/**
 * Whether a live-energy-report item may be offered as a whole-home / meter-area
 * meter, given the raw class of the device the report names.
 *
 * Two ways in, and the second is not a loophole:
 * - class `sensor` — the ordinary meter, a device that measures and cannot switch;
 * - a `cumulative` item whose device is NOT of a controllable class. A cumulative
 *   item is the home's total by definition, and real HAN/P1 readers report one
 *   while registering under class `other` (a Tibber Pulse is the worked example
 *   in `soleCumulativeMeter`'s own fixtures). Requiring `sensor` of them would
 *   drop exactly the meters most whole-home installs depend on.
 *
 * What both arms refuse is a device PELS can command. That is the invariant the
 * rule exists for; the class of a meter is only ever evidence about it.
 */
export const isPickableMeterItem = (
  params: { isCumulativeItem: boolean; deviceClass: string | undefined },
): boolean => (
  params.deviceClass === 'sensor'
  || (params.isCumulativeItem && !isControllableDeviceClass(params.deviceClass))
);

// The observe-only role class-key predicate is pure, browser-safe domain knowledge,
// so its canonical home is shared-domain (`observeOnlyRole.ts`); it is re-exported here
// for the device-layer call sites (the capability branch, the managed-filter ui_picker
// drop, the flow-card guard) that already import it from `./managerHelpers`.
export { isObserveOnlyRoleClassKey } from '../../../packages/shared-domain/src/observeOnlyRole';

export const getDeviceId = (device: HomeyDeviceLike): string => device.id;

export const resolveDeviceClassKey = (device: HomeyDeviceLike): string | null => {
  // Normalize EVERY role-detected home battery to the 'battery' class-key — by class
  // OR the canonical `homeBattery` energy role — at this single point. This makes
  // detection (`isHomeBatteryDevice`) and snapshot SURVIVAL use the SAME predicate:
  // an energy-role-only battery (whose real `class` may be 'sensor'/'other', not in
  // the supported set) still resolves to 'battery', so it survives identity and every
  // downstream `deviceClassKey === 'battery'` gate fires consistently. A battery is
  // then stamped managed observe-only structurally in `resolveParsedDeviceSettings`.
  if (isHomeBatteryDevice(device)) return 'battery';
  // Same machinery for a role-detected solar device — by class:'solarpanel' OR the
  // `meterPowerExportedCapability` producer designation — normalized to the
  // 'solarpanel' class-key so an energy-role-only PV (real class 'sensor'/'other')
  // also survives identity and every downstream `deviceClassKey === 'solarpanel'`
  // gate fires. Stamped managed observe-only structurally in `resolveParsedDeviceSettings`.
  if (isSolarPanelDevice(device)) return 'solarpanel';
  const deviceClass = typeof device.class === 'string' ? device.class.trim() : '';
  if (!deviceClass) return null;
  const deviceClassKey = deviceClass.toLowerCase();
  if (!SUPPORTED_DEVICE_CLASSES.has(deviceClassKey)) return null;
  return deviceClassKey;
};

export const getCapabilities = (device: HomeyDeviceLike): string[] => (
  Array.isArray(device.capabilities) ? device.capabilities : []
);

export const getIsAvailable = (device: HomeyDeviceLike): boolean => (
  typeof device.available === 'boolean' ? device.available : true
);

export const resolveDeviceLabel = (device: HomeyDeviceLike, deviceId: string): string => (
  `${device.name} (${deviceId})`
);

/**
 * Zone IDENTITY (uuid), distinct from the display label above. On the local
 * Web API REST payload `device.zone` is the zone-id STRING; homey-api-shaped
 * objects carry `{ id, name }`. Boundary validation: only a non-empty string
 * id crosses inward; anything else resolves to flat `undefined` (no consumer
 * reads this yet — multi-home membership will join it against the zone tree).
 */
export const resolveZoneId = (device: HomeyDeviceLike): string | undefined => {
  const zone = device.zone;
  if (typeof zone === 'string' && zone) {
    return zone;
  }
  if (zone && typeof zone === 'object') {
    const id = (zone as { id?: unknown }).id;
    if (typeof id === 'string' && id) {
      return id;
    }
  }
  return undefined;
};

export const resolveZoneLabel = (device: HomeyDeviceLike): string => {
  const zone = device.zone;
  if (zone && typeof zone === 'object' && 'name' in zone) {
    const name = (zone as { name?: unknown }).name;
    if (typeof name === 'string' && name) {
      return name;
    }
  }
  if (typeof zone === 'string' && zone) {
    return zone;
  }
  const zoneName = device.zoneName;
  if (typeof zoneName === 'string' && zoneName) {
    return zoneName;
  }
  return 'Unknown';
};
