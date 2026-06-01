/**
 * Single source of truth for the "a lifecycle disable records via the
 * diagnostic-only recorder" rule. A smart-task lifecycle-end disable is a
 * planning decision, not capacity pressure, so it must NOT stamp the capacity
 * cooldown markers — it routes through the diagnostic-only release recorder and
 * carries the `lifecycle_release` reason-code label.
 *
 * Both the direct (non-flow-backed) executor path and the deferred
 * (flow-backed, confirmed-after-the-fact) path resolve through these helpers so
 * the two paths cannot drift.
 */

/** Recorder that closes a binary OFF actuation (diagnostics + control clocks). */
export type ShedActuationRecorder = (deviceId: string, name: string, now: number) => void;

/**
 * Reason-code label for a binary OFF (`desired === false`) command. A lifecycle
 * release is always `lifecycle_release`; a capacity shed is `shed_with_reason`
 * when a reason string is present, else `shedding`.
 */
export function resolveBinaryShedReasonCode(
  reason: string | undefined,
  lifecycleRelease: boolean | undefined,
): 'lifecycle_release' | 'shed_with_reason' | 'shedding' {
  if (lifecycleRelease) return 'lifecycle_release';
  return reason ? 'shed_with_reason' : 'shedding';
}

/**
 * Selects the recorder for a binary OFF actuation: the diagnostic-only release
 * recorder for a lifecycle disable, otherwise the capacity-shed recorder (which
 * additionally stamps the cooldown markers).
 */
export function selectShedActuationRecorder(params: {
  lifecycleRelease: boolean | undefined;
  recordShedActuation: ShedActuationRecorder;
  recordReleaseShedActuation: ShedActuationRecorder;
}): ShedActuationRecorder {
  return params.lifecycleRelease ? params.recordReleaseShedActuation : params.recordShedActuation;
}

/**
 * Whether a binary OFF should stamp the capacity shed marker (`lastDeviceShedMs`).
 * Only a capacity shed does; a lifecycle disable must not, so the no-actuation
 * (no control plan) guard reuses the same rule the recorder selection encodes.
 */
export function shedActuationStampsCapacityMarkers(
  lifecycleRelease: boolean | undefined,
): boolean {
  return !lifecycleRelease;
}
