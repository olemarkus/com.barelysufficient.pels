/**
 * Canonical readings of a device's observed binary on/off state, so the
 * planner and executor never re-decide what an absent `binaryControl` means.
 *
 * `binaryControl` is `{ on: boolean } | undefined`; absence means "no trusted
 * binary state" (a non-binary device, or a binary device before its first
 * observation). The domain rule — documented on `ObservedDeviceState` — is that
 * absence is treated as ON ("may draw, stays sheddable"). These readers encode
 * that rule once, so call sites can't mishandle the `undefined` — and so the
 * planner/executor never touch `binaryControl.on` directly (enforced by the
 * `check-binary-vocab` guard). The two predicates collapse absence to the
 * default; `getObservedBinaryOn` preserves it for callers that must tell
 * "non-binary" apart from on/off.
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

/**
 * The observed binary on-state, or `null` when the device has no binary control
 * (a non-binary device, or an absent `binaryControl`). Unlike the two predicates
 * this does NOT collapse absence to a default — use it where the caller must
 * distinguish "non-binary" from on/off (e.g. rendering current state, or an
 * exact-match check against a desired boolean where absent must not match).
 */
export const getObservedBinaryOn = (device: BinaryControlObserved | null | undefined): boolean | null => (
  device?.binaryControl?.on ?? null
);
