/**
 * Single source of truth for the "a lifecycle disable records via the
 * diagnostic-only recorder" rule. A smart-task lifecycle-end disable is a
 * planning decision, not capacity pressure, so it must NOT stamp the capacity
 * cooldown markers — it routes through the diagnostic-only release recorder.
 *
 * Both the direct (non-flow-backed) executor path and the deferred
 * (flow-backed, confirmed-after-the-fact) path resolve through these helpers so
 * the two paths cannot drift.
 */
import type { ActuationRecorder, ExecutorCommandContext } from './executorCommandContext';

/**
 * Selects the recorder for a binary OFF actuation: the diagnostic-only release
 * recorder for a lifecycle disable, otherwise the capacity-shed recorder (which
 * additionally stamps the cooldown markers).
 */
export function selectShedActuationRecorder(
  lifecycleRelease: boolean | undefined,
  recorders: Pick<ExecutorCommandContext, 'recordShedActuation' | 'recordReleaseShedActuation'>,
): ActuationRecorder {
  return lifecycleRelease ? recorders.recordReleaseShedActuation : recorders.recordShedActuation;
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
