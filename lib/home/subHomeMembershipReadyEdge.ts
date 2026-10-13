import { normalizeError } from '../utils/errorUtils';
import { isCurrentSampleRevision, type SubHomeRecoveryDeps } from './subHomeRecovery';

// Grace after which a bundle still gated on a committed zone tree WARNS (a
// durable, operator-visible signal that the zones API is degraded). See the
// no-tree warn timer below.
const MEMBERSHIP_TREE_COMMIT_WARN_MS = process.env.NODE_ENV === 'test' ? 500 : 5 * 60 * 1000;
const MEMBERSHIP_READY_APPLY_RETRY_MS = 1_000;

type MembershipReadyApplyResult = 'complete' | 'retry' | 'stopped';

/**
 * The membership-ready apply-edge: one rebuild, which both plans and actuates,
 * once membership is trustworthy. Driven by the registry from the membership
 * tree-commit transition (decoupled from sample arrival, so it works in flow
 * mode) and retried after each ingested sample.
 *
 * The rebuild recomputes against the guard's freshest total power (each
 * ingested sample updates it synchronously), so an over-cap reading sheds, and
 * it applies that fresh plan even when the action signature is unchanged — a
 * stable committed shed would otherwise never apply once the gate opens.
 *
 * This was a rebuild followed by a reconcile, for exactly that
 * unchanged-signature reason; the reconcile is gone because re-applying the last
 * COMMITTED plan is the hazard, not the remedy. Built from an earlier under-cap
 * dry-run sample, it could RESTORE load while the home is over cap (R7b P0-1),
 * and the same shape breached the hard cap in production (inc_26449fb9).
 *
 * NOT once-only: a FAILED rebuild or a sample landing mid-rebuild re-arms the
 * latch so a later attempt retries.
 */
export class SubHomeMembershipReadyEdge {
  private membershipReadySeen: boolean;

  private readonly applyRetryTimerKey: string;

  constructor(private readonly deps: SubHomeRecoveryDeps) {
    this.membershipReadySeen = deps.runtime.isMembershipReady();
    this.applyRetryTimerKey = deps.timerKey('membershipReadyApplyRetry');
    // No-tree warn timer (only armed while not yet ready): if no committed zone
    // tree lands within the grace, WARN — a durable, operator-visible signal that
    // the zones API is degraded and any PINNED sub-home members stay gated
    // (controlled by nobody until the tree lands). Warn-only: it does NOT open the
    // actuation gate (that boot-window guard is a documented safety invariant).
    if (!this.membershipReadySeen) this.armNoTreeWarn();
  }

  /** Apply the edge now; idempotent and latched, a no-op until membership is ready. */
  readonly apply = (): void => {
    const { runtime, timers, pipeline } = this.deps;
    if (runtime.isTornDown() || this.membershipReadySeen || !runtime.isMembershipReady()) return;
    const sample = pipeline.getStableSampleRevision();
    if (sample.state === 'pending') {
      this.scheduleRetry();
      return;
    }
    timers.clear(this.applyRetryTimerKey);
    this.membershipReadySeen = true;
    void this.applyPlan(sample.revision)
      .then((result) => {
        if (result === 'retry') this.rearm();
      })
      .catch((error: unknown) => {
        this.rearm();
        this.deps.getLogger()?.error({
          event: 'home_membership_ready_apply_failed', homeId: runtime.homeId, err: normalizeError(error),
        });
      });
  };

  /** A prepared ownership generation reconciled this area, which is the edge's work done. */
  readonly markPreparedOwnershipGenerationReconciled = (): void => {
    const { runtime } = this.deps;
    if (!runtime.isTornDown() && runtime.isMembershipReady()) this.membershipReadySeen = true;
  };

  private armNoTreeWarn(): void {
    const { runtime, timers, timerKey } = this.deps;
    const key = timerKey('noTreeWarn');
    timers.registerTimeout(key, setTimeout(() => {
      timers.clear(key);
      if (runtime.isTornDown() || runtime.isMembershipReady()) return;
      this.deps.getLogger()?.warn({
        event: 'home_bundle_gated_no_zone_tree_commit',
        homeId: runtime.homeId,
        detail: 'no committed zone tree after boot grace; bundle stays dry-run gated — '
          + 'pinned members are uncontrolled until the zones API recovers',
      });
    }, MEMBERSHIP_TREE_COMMIT_WARN_MS));
  }

  private scheduleRetry(): void {
    const { runtime, timers } = this.deps;
    if (
      runtime.isTornDown()
      || this.membershipReadySeen
      || !runtime.isMembershipReady()
      || timers.has(this.applyRetryTimerKey)
    ) return;
    timers.registerTimeout(this.applyRetryTimerKey, setTimeout(() => {
      timers.clear(this.applyRetryTimerKey);
      this.apply();
    }, MEMBERSHIP_READY_APPLY_RETRY_MS));
  }

  private rearm(): void {
    this.membershipReadySeen = false;
    this.scheduleRetry();
  }

  /**
   * Keep the sample fence active for the whole rebuild, which now both plans and
   * actuates. A newer sample can arrive after planning starts but before the first
   * SDK write, so the guard has to span the apply.
   *
   * TWO mechanisms do that, and they are not interchangeable:
   * - `shouldAbort` is evaluated ONCE, inside the queued body before the build
   *   (`PlanService.rebuildPlanFromCache`). It catches a sample that landed while
   *   this request sat in the queue. It does NOT span the apply.
   * - `beginPreparedReconcile` arms the prepared-reconcile fence, and the area's
   *   actuation fence (`SubHomeRuntime.isActuationFenced`) consults it on EVERY
   *   actuator write. That is what fences the remaining writes when a newer
   *   revision lands mid-apply.
   *
   * So do not "simplify away" the prepared fence on the grounds that `shouldAbort`
   * already checks the revision — it checks it once, at a different moment.
   */
  private async applyPlan(revision: number): Promise<MembershipReadyApplyResult> {
    const { runtime, planService, pipeline } = this.deps;
    const endPreparedReconcile = this.deps.beginPreparedReconcile(revision);
    let reconciledCurrent: boolean;
    try {
      // ONE rebuild, not a rebuild followed by a reconcile. The pair existed
      // because a rebuild whose action signature was unchanged would not actuate,
      // so the reconcile was needed to converge the devices; the rebuild now
      // applies whenever the executor has work outstanding, which covers it.
      //
      // The fence must therefore cover TEARDOWN as well as a newer sample. While
      // this was two calls, a teardown landing between them was caught by the
      // `isTornDown()` check after the rebuild — the rebuild itself only planned.
      // Now the rebuild also writes, so teardown has to trip the point-of-use
      // predicate. (The actuator seam gates on `isTornDown()` too — see
      // `SubHomeRuntime.isActuationFenced` — but a fence the caller owns should
      // not depend on a fence further in.)
      let rebuildAborted = false;
      const outcome = await planService.rebuildPlanFromCache('home_membership_ready', {
        shouldAbort: () => runtime.isTornDown() || !isCurrentSampleRevision(pipeline, revision),
        onAbort: () => { rebuildAborted = true; },
      });
      if (runtime.isTornDown()) return 'stopped';
      if (outcome.failed) {
        this.deps.getLogger()?.warn({
          event: 'home_membership_ready_rebuild_failed',
          homeId: runtime.homeId,
        });
        return 'retry';
      }
      // A GATED skip built no plan, so it reconciled nothing — treat it like the
      // point-of-use abort rather than like a successful no-op, or this one-shot
      // apply edge is consumed by a build that never happened. Reachable at boot
      // whenever a bundle's zone tree commits before its meter's first reading;
      // the sample's own rebuild then has no edge left to ride.
      reconciledCurrent = !rebuildAborted
        && !outcome.gated
        && isCurrentSampleRevision(pipeline, revision);
    } finally {
      endPreparedReconcile();
    }
    if (!reconciledCurrent) return 'retry';
    return await this.deps.flushDeferredShortfallSideEffect() ? 'complete' : 'retry';
  }
}
