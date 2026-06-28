// The normalized class-keys that `resolveDeviceClassKey` assigns to the two
// observe-only ROLES (battery → 'battery', solar → 'solarpanel'). PELS tracks but
// never controls a device with one of these class-keys: it is kept as a power-capable,
// non-controllable, non-temperature snapshot entry and excluded from flow-backed
// control. Consumers that only have a `deviceClassKey` string in hand (the capability
// branch, the managed-filter ui_picker drop, the flow-card guard, the overview read
// model) match on this set so battery + solar share the same observe-only treatment
// from one definition.
//
// Pure, browser-safe domain knowledge (no Homey/device-layer dependency), so it lives
// in shared-domain and is importable by the runtime device layer, lib/plan, flowCards,
// and the settings UI alike. `lib/device/transport/managerHelpers` re-exports it for the
// device-layer call sites.
const OBSERVE_ONLY_ROLE_CLASS_KEYS: ReadonlySet<string> = new Set(['battery', 'solarpanel']);

export const isObserveOnlyRoleClassKey = (deviceClassKey: string | undefined): boolean => (
  deviceClassKey !== undefined && OBSERVE_ONLY_ROLE_CLASS_KEYS.has(deviceClassKey)
);
