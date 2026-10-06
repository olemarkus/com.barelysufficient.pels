/**
 * The parse of `battery_control_devices`, the owner's Managed choice per home
 * battery, shared by its two readers: the runtime owner
 * (`lib/battery/batteryControlSettings.ts`, which also owns absence through
 * `getKeys()`) and the settings UI's Managed toggle.
 *
 * Absent entry, or absent key: Managed is on. `false`: the owner turned it off.
 * `true` means the same as absence, so the UI may write either.
 */

/** Per-battery Managed choice, keyed by device id. Absent = on; `false` = off. */
export type BatteryControlDevices = Readonly<Record<string, boolean>>;

/**
 * Read policy: all or nothing, like every other per-device boolean map PELS
 * persists. A flat boolean has no partial state to repair, so a map with any
 * non-boolean entry is refused whole rather than sanitized: dropping one entry
 * would silently turn an opted-out battery back on. `null` is a rejected read,
 * never an empty map.
 */
export const parseBatteryControlDevices = (value: unknown): BatteryControlDevices | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([deviceId, enabled]) => deviceId.length > 0 && typeof enabled === 'boolean')) return null;
  return Object.fromEntries(entries);
};

/** Whether the owner has this battery managed: on unless turned off. */
export const isBatteryControlEnabled = (devices: BatteryControlDevices, deviceId: string): boolean => (
  devices[deviceId] !== false
);
