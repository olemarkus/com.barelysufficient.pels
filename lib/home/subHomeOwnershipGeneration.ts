import { normalizeError } from '../utils/errorUtils';
import type { SubHomeMembershipReadyEdge } from './subHomeMembershipReadyEdge';
import {
  isCurrentSampleRevision,
  type SubHomeRecoveryDeps,
  type SubHomeSampleRevision,
} from './subHomeRecovery';

/**
 * A meter area's side of the ownership-generation protocol (multi-home R7b).
 * The membership owner fences actuation while a new ownership generation is
 * pending; each area then commits a fresh plan behind that fence (`prepare`),
 * answers whether the plan is still the one its current sample produced
 * (`isPreparedCurrent`), and applies it once the generation commits
 * (`reconcilePrepared`). Whether a reconcile is current, whether the held
 * shortfall side effects may flush, and whether the membership-ready latch is
 * consumed are runtime authority decisions, so they live here beside the
 * area's other prepared-rebuild lanes rather than in the bundle's wiring.
 */
export class SubHomeOwnershipGeneration {
  constructor(
    private readonly deps: SubHomeRecoveryDeps,
    private readonly membershipReadyEdge: SubHomeMembershipReadyEdge,
  ) {}

  /**
   * Rebuild this home's committed plan after a pin/zone/config ownership
   * change so the new complement is adopted promptly. Point-of-use ownership
   * fencing remains the immediate safety boundary for any older continuation.
   */
  readonly rebuildForMembershipChange = async (): Promise<boolean> => {
    const { runtime, planService } = this.deps;
    if (runtime.isTornDown()) return false;
    try {
      const outcome = await planService.rebuildPlanFromCache('home_membership_changed');
      return !outcome.failed && !runtime.isTornDown();
    } catch (error: unknown) {
      this.deps.getLogger()?.error({
        event: 'home_membership_bundle_rebuild_failed',
        homeId: runtime.homeId,
        err: normalizeError(error),
      });
      return false;
    }
  };

  /** Commit a fresh plan behind the ownership fence; the token is its sample revision. */
  readonly prepare = async (): Promise<SubHomeSampleRevision> => {
    const { pipeline } = this.deps;
    const sample = pipeline.getStableSampleRevision();
    if (sample.state === 'pending') return sample;
    const rebuilt = await this.rebuildForMembershipChange();
    return rebuilt && isCurrentSampleRevision(pipeline, sample.revision)
      ? sample
      : { state: 'pending' };
  };

  /** Whether the plan prepared at `sampleRevision` is still the area's current one. */
  readonly isPreparedCurrent = (sampleRevision: number): boolean => (
    !this.deps.runtime.isTornDown() && isCurrentSampleRevision(this.deps.pipeline, sampleRevision)
  );

  /**
   * Apply the plan prepared at `sampleRevision`, with the same point-of-use
   * sample-revision abort as the ready edge, then latch that edge so the next
   * sample does not duplicate the same rebuild.
   */
  readonly reconcilePrepared = async (sampleRevision: number): Promise<boolean> => {
    const { runtime, planService, pipeline } = this.deps;
    let aborted = false;
    // A full rebuild can FAIL where the decision-free reconcile it replaced
    // could only no-op, and `rebuildPlanFromCache` contains planner errors and
    // resolves `{failed:true}` instead of throwing. Treat that as
    // not-converged, or the generation finalizes and side effects flush as
    // though the prepared actions had been applied.
    let failed: boolean;
    const endPreparedReconcile = this.deps.beginPreparedReconcile(sampleRevision);
    try {
      const outcome = await planService.rebuildPlanFromCache('home_ownership_generation_prepared', {
        shouldAbort: () => runtime.isTornDown() || !isCurrentSampleRevision(pipeline, sampleRevision),
        onAbort: () => { aborted = true; },
      });
      failed = outcome.failed;
    } finally {
      endPreparedReconcile();
    }
    const current = !aborted
      && !failed
      && !runtime.isTornDown()
      && isCurrentSampleRevision(pipeline, sampleRevision);
    const sideEffectFlushed = current && await this.deps.flushDeferredShortfallSideEffect();
    if (sideEffectFlushed) this.membershipReadyEdge.markPreparedOwnershipGenerationReconciled();
    return sideEffectFlushed;
  };
}
