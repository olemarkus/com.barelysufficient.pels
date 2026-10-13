import type { StableSampleRevision } from './sampleIngestQueue';

/**
 * Reference-counted final-actuator fence for prepared plan work: a reconcile
 * prepared against one stable sample revision may write only while that
 * revision is still the one the home's sample loop serves. Main and every meter
 * area build one over their own sample pipeline.
 *
 * Handles are identity-keyed so ending one overlapping reconcile cannot remove
 * another reconcile's protection, even when both use the same sample revision.
 */
export class PreparedReconcileFence {
  private readonly activeRevisions = new Map<symbol, number>();

  constructor(private readonly readStableRevision: () => StableSampleRevision) {}

  /** Open a prepared reconcile against `sampleRevision`; the returned callback ends it. */
  begin(sampleRevision: number): () => void {
    const handle = Symbol('preparedReconcile');
    this.activeRevisions.set(handle, sampleRevision);
    return () => { this.activeRevisions.delete(handle); };
  }

  /** Whether any prepared reconcile is in progress. */
  isActive(): boolean {
    return this.activeRevisions.size > 0;
  }

  /**
   * Whether an in-progress prepared reconcile was overtaken: a sample is in
   * flight, or a newer one has landed since it was prepared.
   */
  isSuperseded(): boolean {
    if (this.activeRevisions.size === 0) return false;
    const current = this.readStableRevision();
    return current.state !== 'stable'
      || [...this.activeRevisions.values()].some((revision) => revision !== current.revision);
  }
}
