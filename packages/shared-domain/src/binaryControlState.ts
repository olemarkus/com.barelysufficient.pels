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
 * default; callers that must tell "non-binary" apart from on/off narrow through
 * `isBinaryControlled` and then read a guaranteed `boolean` via `getBinaryOn` —
 * no sentinel (`null`/`undefined`) re-encodes the non-binary case as a value.
 *
 * Browser-safe: a structural shape, no Homey SDK types.
 */
import type { BinaryControlObservation } from '../../contracts/src/types';

type BinaryControlObserved = { binaryControl?: { on: boolean } };

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
 * The observed control-state shape the evidence reader below consumes.
 * Structural so
 * transport snapshots, plan-side decision snapshots, and executor snapshots
 * all fit. Browser-safe: contracts types only, no Homey SDK types.
 */
type ObservedBinaryControlFields = BinaryControlObserved & {
  binaryControlObservation?: Pick<
    BinaryControlObservation,
    'valid' | 'capabilityId' | 'observedValue' | 'observedCapabilityIds'
  >;
};

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

/**
 * Whether trusted evidence says the device's binary control is observed OFF —
 * "trusted" meaning a real observation record for the CURRENT control
 * capability (`binaryControlObservation`), never the parse-boundary latched
 * fallback (`binaryControl.on` alone), which can be a cold-start contract
 * filler. Used to tell a no-op re-assert ("write off over an observed-off
 * device") from a real load-changing shed; absence of evidence resolves
 * `false` — an unproven no-op is treated as a real shed.
 *
 * State-derived off evidence (a charger paused with its switch still armed)
 * answers this question correctly — no charging activity means the off-write
 * changes no load.
 */
export function isTrustedObservedBinaryOff(snapshot: ObservedBinaryControlFields | undefined): boolean {
  const observation = snapshot?.binaryControlObservation;
  if (observation?.valid !== true) return false;
  return observation.observedValue === false;
}
