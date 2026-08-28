/**
 * The `mode_device_targets` setting: one key, one reader, one writer.
 *
 * The stored blob maps a mode name to that mode's device→setpoint map:
 *
 *     { "Home": { "heater-1": 21 }, "Away": { "heater-1": 16 } }
 *
 * Before this module, fifteen files read or wrote that key and the two sides
 * disagreed about what its bytes MEAN. The runtime coerced a malformed mode
 * value to `{}` and carried on; the settings UI rejected the entire catalog and
 * raised "Mode catalog unavailable". Same key, same bytes, opposite policies —
 * which is the failure mode a shared key invites whenever each caller brings its
 * own parser.
 *
 * So the meaning lives here and the transport does not. The runtime reads
 * through `homey.settings`, the settings UI through its async bridge; both hand
 * the raw value to `sanitizeModeDeviceTargets` and get the same answer. Absence
 * stays with the caller, because the two genuinely differ: the runtime can
 * cross-check `getKeys()` to tell "never written" from "read failed", and the UI
 * cannot.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/** Mode name → device id → setpoint (°C). */
export type ModeDeviceTargets = Record<string, Record<string, number>>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Read policy: SANITIZE AND KEEP.
 *
 * `null` when the blob itself is not an object — there is no catalog to speak
 * of, and the caller decides whether that means "never written" or "read
 * failed". Otherwise every mode key survives, with the entries that are finite
 * numbers.
 *
 * A malformed mode value (`"Away": null`, a number, a string, an array) becomes
 * `{}` rather than dropping the key or failing the read, and the reason is
 * asymmetric damage: the key is the only record that the owner configured that
 * mode, so dropping it silently deletes a mode on the next write, while the
 * value it carried held no usable targets to lose. Failing the whole read is
 * worse still — the caller that fills missing targets would stop filling, and a
 * device with no target is one PELS can shed with nothing to restore it to.
 *
 * The same reasoning covers a single junk entry inside a good mode: the device
 * reads as unset and gets filled, rather than poisoning its neighbours.
 */
export const sanitizeModeDeviceTargets = (value: unknown): ModeDeviceTargets | null => {
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).map(([mode, entries]) => {
    if (!isPlainObject(entries)) return [mode, {}] as const;
    return [mode, Object.fromEntries(
      Object.entries(entries).filter((entry): entry is [string, number] => (
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )),
    )] as const;
  }));
};

/**
 * Write policy: REFUSE ANYTHING THE READ POLICY WOULD HAVE TO REPAIR.
 *
 * The reader tolerates a malformed catalog because it has to — the store may
 * already hold one, written by an older build, by `homey api`, or by a partial
 * write. A writer has no such excuse: it is choosing the bytes, so it must not
 * be the source of the thing every reader then has to work around.
 *
 * Every write path goes through this — the runtime's fill pass and all four
 * settings-UI edits — so a malformed catalog can only ever enter from outside
 * PELS.
 */
export const isWritableModeDeviceTargets = (value: unknown): value is ModeDeviceTargets => {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entries) => (
    isPlainObject(entries)
    && Object.values(entries).every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ));
};
