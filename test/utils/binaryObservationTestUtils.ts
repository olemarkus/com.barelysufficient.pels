import type { BinaryControlObservation } from '../../packages/contracts/src/types';

/**
 * Build a `BinaryControlObservation` for tests. Drift detection treats a
 * snapshot without `binaryControlObservation` as never-observed (binary state
 * unknown), so reconcile/drift tests must supply trusted observation evidence
 * to model an observed binary value.
 */
export const buildBinaryObservation = (
  capabilityId: 'onoff' | 'evcharger_charging',
  observedValue: boolean,
  options: {
    observedAtMs?: number;
    observedCapabilityIds?: string[];
    source?: BinaryControlObservation['source'];
  } = {},
): BinaryControlObservation => ({
  valid: true,
  capabilityId,
  observedValue,
  observedCapabilityIds: options.observedCapabilityIds ?? [capabilityId],
  observedAtMs: options.observedAtMs ?? 1_000,
  source: options.source ?? 'snapshot_refresh',
});
