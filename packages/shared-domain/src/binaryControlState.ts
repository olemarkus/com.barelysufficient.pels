/**
 * Canonical readings of a device's observed binary on/off state, so the
 * planner and executor never re-decide what an absent `binaryControl` means.
 *
 * `binaryControl` is `{ on: boolean } | undefined`; absence means "no trusted
 * binary state" (a non-binary device, or a binary device before its first
 * observation). The domain rule — documented on `ObservedDeviceState` — is that
 * absence is treated as ON ("may draw, stays sheddable"). These two predicates
 * encode that rule once (they are exact complements when applied to the same
 * input) and return a `boolean`, so call sites can't mishandle the `undefined`.
 *
 * Browser-safe: a structural shape, no Homey SDK types.
 */
type BinaryControlObserved = { binaryControl?: { on: boolean } };

/**
 * True unless the device is CONFIRMED observed-off. Absent/unknown binary state
 * counts as on (the device "may draw"). The canonical reading of the historical
 * `binaryControl?.on ?? true`.
 */
export const isBinaryOnOrUnknown = (device: BinaryControlObserved | null | undefined): boolean => (
  device?.binaryControl?.on ?? true
);

/**
 * True only when the binary control is CONFIRMED observed-off
 * (`binaryControl.on === false`). Absent/unknown is NOT off — the canonical
 * reading of the historical `binaryControl?.on === false`.
 */
export const isBinaryObservedOff = (device: BinaryControlObserved | null | undefined): boolean => (
  device?.binaryControl?.on === false
);
