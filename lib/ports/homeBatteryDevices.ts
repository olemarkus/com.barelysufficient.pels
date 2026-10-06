/**
 * Which devices the device layer knows as home batteries, as one explicit
 * read. `unavailable` until the device layer exists and has completed a full
 * device refresh: before then a battery is not yet told apart from any other
 * device, and an answer of "no battery" would be invented, not observed.
 * Produced by `BatteryStateProducer.readBatteryDevices`
 * (`lib/device/batteryStateProducer.ts`); `lib/device/deviceRoleReads.ts`
 * reads it through the transport.
 */
export type HomeBatteryDevicesRead =
  | { status: 'resolved'; deviceIds: ReadonlySet<string> }
  | { status: 'unavailable' };
