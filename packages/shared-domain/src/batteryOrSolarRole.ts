// The normalized class-keys that `resolveDeviceClassKey` assigns to the two energy
// ROLES (battery → 'battery', solar → 'solarpanel'). Neither is a load PELS limits
// the way it limits a heater or a charger: it has no on/off, temperature or step
// axis, is never flow-backed, and its measured power is never a managed load's
// draw. A home battery is commanded only through the actuator's storage intents
// (`lib/battery/`); a solar device is never commanded. Consumers that only have a
// `deviceClassKey` string in hand (the capability branch, the managed filter, the
// flow-card guards, the overview read model) match on these so battery and solar
// share that structural treatment from one definition.
//
// What differs between the two is the owner's model. A home battery is an
// ordinary managed device: the owner's Managed toggle decides whether PELS
// reads and uses it (`lib/battery/batteryControlSettings.ts`). A solar device is
// always read and never shown as a device.
//
// Pure, browser-safe domain knowledge (no Homey/device-layer dependency), so it lives
// in shared-domain and is importable by the runtime device layer, lib/plan, flowCards,
// and the settings UI alike. `lib/device/transport/managerHelpers` re-exports it for the
// device-layer call sites.
export const HOME_BATTERY_CLASS_KEY = 'battery';
export const SOLAR_PANEL_CLASS_KEY = 'solarpanel';

const BATTERY_OR_SOLAR_CLASS_KEYS: ReadonlySet<string> = new Set([HOME_BATTERY_CLASS_KEY, SOLAR_PANEL_CLASS_KEY]);

export const isBatteryOrSolarClassKey = (deviceClassKey: string | undefined): boolean => (
  deviceClassKey !== undefined && BATTERY_OR_SOLAR_CLASS_KEYS.has(deviceClassKey)
);

export const isHomeBatteryClassKey = (deviceClassKey: string | undefined): boolean => (
  deviceClassKey === HOME_BATTERY_CLASS_KEY
);
