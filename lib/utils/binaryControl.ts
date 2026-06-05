/**
 * Shared accessor for the nested optional `binaryControl` observation.
 *
 * A device carries `binaryControl` IFF it has binary control. A non-binary
 * device has no `binaryControl`; consumers treat its absence exactly like the
 * old fabricated `currentOn: true` ("may always draw, so stays sheddable").
 * This helper centralises that `?? true` fabrication so call sites read a plain
 * boolean without re-deriving the fallback (and without each branch counting
 * against the caller's cyclomatic complexity).
 */
export function resolveBinaryOn(device: { binaryControl?: { on: boolean } }): boolean {
  return device.binaryControl?.on ?? true;
}
