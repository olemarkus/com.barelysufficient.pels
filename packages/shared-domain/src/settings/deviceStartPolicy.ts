/**
 * The `device_start_policies` setting: one key, one reader.
 *
 * Who is allowed to start a managed device — anyone (the owner's hand, the
 * device's own schedule, another automation), or only PELS.
 *
 * ## Why the key exists
 *
 * A device can be managed by PELS while power-limit control is OFF. PELS then
 * watches it and never commands it, which is what the owner asked for — but it
 * also means a start nobody planned is simply absorbed as background usage, and
 * the house can sit over its hard cap with PELS holding no lever at all. On the
 * production home that shape ran for two clock hours at ~7.4 kWh against a 5 kWh
 * cap, with every managed device already at zero.
 *
 * `'pels_only'` says: this device runs when PELS starts it, and not otherwise.
 * The plan then carries a standing OFF intent for it, and PELS's ordinary
 * convergence turns an unplanned start back off — nothing new actuates, the
 * device simply has a desired state it did not have before.
 *
 * ## Why an enum and not a boolean
 *
 * A third position is already designed but not built: hand the device to PELS on
 * a manual start (honour the start, but limit it under the cap) rather than
 * refusing it. Storing a boolean today would make that a migration; storing the
 * union makes it one more value. The settings UI renders the two-value case as a
 * single switch regardless.
 *
 * Transport stays with the callers, and so does the meaning of ABSENCE — the
 * runtime can cross-check `getKeys()`, the settings UI cannot. Here the two
 * coincide: absence reads as `'unrestricted'`, which is what every device did
 * before this key existed, so a never-written key is exactly backwards
 * compatible.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { DeviceStartPolicy } from '../../../contracts/src/types.js';

/**
 * `'unrestricted'` — anyone may start it. The default, and what every device did
 * before this key existed.
 *
 * `'pels_only'` — PELS decides when it runs. A start from anywhere else is
 * turned back off.
 */
export type { DeviceStartPolicy };

export const DEFAULT_DEVICE_START_POLICY: DeviceStartPolicy = 'unrestricted';

const isDeviceStartPolicy = (value: unknown): value is DeviceStartPolicy => (
  value === 'unrestricted' || value === 'pels_only'
);

/**
 * Read AND write policy: ALL OR NOTHING, matching every other per-device map
 * this app persists (`isBooleanMap` guards `controllable_devices`,
 * `managed_devices`, `budget_exempt_devices` the same way).
 *
 * One predicate serves both directions here, and that is not the asymmetry
 * `notes/settings-key-ownership.md` describes being ignored — it is that
 * asymmetry having nothing to bite on. The reader tolerates what the writer
 * refuses only where a value can be PARTIALLY repaired; a flat two-value union
 * has no partial state, so "sanitize and keep" and "refuse" are the same test.
 *
 * A rejected read is not an empty map. The caller keeps its current value
 * (`readDeviceFlagSettings`), because a transient SDK miss is a no-op and must
 * never look like an owner who just cleared every policy.
 */
export const isDeviceStartPolicyMap = (
  value: unknown,
): value is Record<string, DeviceStartPolicy> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => isDeviceStartPolicy(entry));
};

/**
 * The device's policy, always. Never `undefined` — a device with no entry has
 * the default policy, which is an answer rather than a gap, so no consumer ever
 * branches on presence.
 */
export const resolveDeviceStartPolicy = (
  policies: Readonly<Record<string, DeviceStartPolicy>>,
  deviceId: string,
): DeviceStartPolicy => {
  const stored = policies[deviceId];
  return isDeviceStartPolicy(stored) ? stored : DEFAULT_DEVICE_START_POLICY;
};
