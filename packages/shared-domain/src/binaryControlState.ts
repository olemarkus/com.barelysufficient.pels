/**
 * Canonical readings of a device's observed binary on/off state, so the
 * planner and executor never re-decide what an absent `binaryControl` means.
 *
 * `binaryControl` is `{ on: boolean } | undefined`, and absence is STRUCTURAL:
 * the contract is "present IFF the device has binary control"
 * (`ObservedDeviceState`, `packages/contracts/src/types.ts`). It says the device
 * has no on/off axis. It is not an unreadable axis, not a not-yet-observed one,
 * and `on` is never `undefined` when `binaryControl` is there — so there is no
 * third state to model, and a consumer that widens this shape to admit one ends
 * up guarding a value the producer cannot emit.
 *
 * The domain rule for that structural absence is that it reads as ON ("may
 * draw, stays sheddable"). These readers encode it once, so call sites can't
 * mishandle the `undefined` — and so the planner/executor never touch
 * `binaryControl.on` directly (enforced by the `check-binary-vocab` guard).
 * `isBinaryOnOrUnknown` and `isBinaryObservedOff` collapse absence to the
 * default; callers that must tell "non-binary" apart from on/off narrow through
 * `isBinaryControlled` and then read a guaranteed `boolean` via `getBinaryOn` —
 * no sentinel (`null`/`undefined`) re-encodes the non-binary case as a value.
 *
 * Browser-safe: a structural shape, no Homey SDK types.
 */
export type BinaryControlObserved = { binaryControl?: { on: boolean } };

/** A device narrowed to one that HAS observed binary control. */
type BinaryControlled = { binaryControl: { on: boolean } };

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
 * True only when the binary control is CONFIRMED observed-on
 * (`binaryControl.on === true`). Absent binary state is NOT on — the third
 * reading, and the mirror of `isBinaryObservedOff`.
 *
 * Distinct from `isBinaryOnOrUnknown`, and the difference is directional: use
 * that one to decide whether a device MAY DRAW (absence must not fabricate an
 * off), and this one to decide whether the device WAS TURNED ON (absence must
 * not fabricate consent). The external-off hold needs both — it starts on an
 * observed on→off transition and releases only on affirmative on evidence.
 */
export const isBinaryObservedOn = (device: BinaryControlObserved | null | undefined): boolean => (
  device?.binaryControl?.on === true
);

/**
 * Type guard: the device HAS observed binary control. A non-binary device (or
 * one with no observed `binaryControl` yet) returns `false` — that case is the
 * guard's else-branch, NOT a nullable value the caller has to handle. On the
 * narrowed shape `binaryControl` is guaranteed present, so `getBinaryOn` reads
 * `.on` as a plain `boolean`. The shared-domain twin of `isEvObserved`: callers
 * narrow through this instead of re-deciding what an absent `binaryControl`
 * means.
 */
export const isBinaryControlled = <T extends BinaryControlObserved>(
  device: T | null | undefined,
): device is T & BinaryControlled => (
  device?.binaryControl !== undefined
);

/**
 * The observed binary on-state of a device already narrowed to one that has
 * binary control (via `isBinaryControlled`). Keeps the `.on` read in one place
 * so the planner / executor never touch it directly.
 */
export const getBinaryOn = (device: BinaryControlled): boolean => device.binaryControl.on;

/**
 * Planner command-equivalence state as one strict boolean. The producer has
 * already resolved the device-specific control capability into
 * `binaryControl`; physical activity such as EV charging remains a separate
 * fact and must not change whether an accepted binary command has settled.
 */
export function resolveBinaryCommandCurrentOn(
  snapshot: BinaryControlled & { evCharging?: boolean },
): boolean {
  return snapshot.binaryControl.on;
}
