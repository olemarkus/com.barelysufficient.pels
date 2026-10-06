/**
 * A home battery's Power-limit control, read from `controllable_devices`, the
 * same per-device map a load's Power-limit control lives in. Shared by its two
 * readers: the runtime's battery-specific gate (the planner input's storage
 * cluster, `lib/planInput/storageProjection.ts`) and the settings UI's switch
 * on the battery's device page and its row in the device list.
 *
 * A battery reads the map through this gate, never as a load's command
 * authority: the generic gate (`isCapacityControlEnabled`) vetoes every battery
 * or solar device whatever the map says.
 *
 * Absent entry: on. A battery was always limited before the switch existed
 * (owner ruling, 2026-10-06: last in the priority order by default, it covers
 * the house before any device is limited), so a battery the owner never
 * touched keeps that. `false`: the owner turned it off, and PELS never limits
 * the battery: no charge cap and no discharge for the limit.
 */
export const isBatteryPowerLimitEnabled = (
  controllable: Readonly<Record<string, boolean>>,
  deviceId: string,
): boolean => controllable[deviceId] !== false;
