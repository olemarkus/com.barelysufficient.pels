/**
 * The readiness apply-edge + no-tree warn + freshness-heartbeat timers for one
 * sub-home capacity bundle (multi-home R7b). Extracted from
 * `createHomeCapacityBundle` to keep that wiring function within the setup-layer
 * size ceilings; all mutable bundle state is reached through the passed closures
 * (teardown fence, sample revision, membership readiness).
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanService } from '../../lib/plan/planService';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { StableSampleRevision } from '../powerSamplePipeline';
import { installPowerSampleFreshnessEscalation } from '../powerSampleFreshnessEscalation';
import type { MeterSilenceMonitor } from '../../lib/power/meterSilence';

// Base freshness-heartbeat cadence (mirrors `POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS`
// in `setup/powerSamplePipeline.ts`). The test value is coarser than the poll
// cadence so a 10-minute stale-escalation test doesn't fire thousands of ticks.

// Grace after which a bundle still gated on a committed zone tree WARNS (a
// durable, operator-visible signal that the zones API is degraded). See the
// no-tree warn timer below.
const MEMBERSHIP_TREE_COMMIT_WARN_MS = process.env.NODE_ENV === 'test' ? 500 : 5 * 60 * 1000;
const MEMBERSHIP_READY_APPLY_RETRY_MS = 1_000;

/**
 * Per-home deterministic heartbeat interval: the base cadence plus a stable
 * per-`homeId` jitter (a fraction of the base) so N bundles' heartbeats do not
 * fire on the SAME tick — the phase-aligned synchronized rebuild storm P1#4
 * guards against. Hashed off the homeId so it is stable across restarts and
 * distinct per home; deterministic (not random) so timing tests stay reliable.
 */

export type InstallBundleReadinessParams = {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: (suffix: string) => string;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  planService: PlanService;
  getTrackerState: () => PowerTrackerState;
  /** This bundle's silence policy — shared with its composed plan-build gate. */
  meterSilence: MeterSilenceMonitor;
  /** Teardown fence: true once `teardown()` ran (all continuations must bail). */
  isTornDown: () => boolean;
  getStableSampleRevision: () => StableSampleRevision;
  beginPreparedOwnershipReconcile: (sampleRevision: number) => () => void;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
};

type MembershipReadyApplyResult = 'complete' | 'retry' | 'stopped';

const isCurrentSampleRevision = (
  reader: () => StableSampleRevision,
  revision: number,
): boolean => {
  const current = reader();
  return current.state === 'stable' && current.revision === revision;
};

/**
 * Keep the sample fence active for the whole rebuild, which now both plans and
 * actuates. A newer sample can arrive after planning starts but before the first
 * SDK write, so the guard has to span the apply.
 *
 * TWO mechanisms do that, and they are not interchangeable:
 * - `shouldAbort` is evaluated ONCE, inside the queued body before the build
 *   (`PlanService.rebuildPlanFromCache`). It catches a sample that landed while
 *   this request sat in the queue. It does NOT span the apply.
 * - `beginPreparedOwnershipReconcile` arms `preparedSampleFence`, and
 *   `isActuationFenced` (`createHomeCapacityBundle`) consults
 *   `preparedSampleFence.isSuperseded()` on EVERY actuator write. That is what
 *   fences the remaining writes when a newer revision lands mid-apply.
 *
 * So do not "simplify away" the prepared fence on the grounds that `shouldAbort`
 * already checks the revision — it checks it once, at a different moment.
 */
const applyMembershipReadyPlan = async (params: {
  homeId: HomeId;
  revision: number;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  planService: PlanService;
  isTornDown: () => boolean;
  getStableSampleRevision: () => StableSampleRevision;
  beginPreparedOwnershipReconcile: (sampleRevision: number) => () => void;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
}): Promise<MembershipReadyApplyResult> => {
  const endPreparedReconcile = params.beginPreparedOwnershipReconcile(params.revision);
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
    // `isActuationFenced` in `createHomeCapacityBundle` — but a fence the caller
    // owns should not depend on a fence further in.)
    let rebuildAborted = false;
    const outcome = await params.planService.rebuildPlanFromCache('home_membership_ready', {
      shouldAbort: () => params.isTornDown()
        || !isCurrentSampleRevision(params.getStableSampleRevision, params.revision),
      onAbort: () => { rebuildAborted = true; },
    });
    if (params.isTornDown()) return 'stopped';
    if (outcome.failed) {
      params.logger()?.warn({
        event: 'home_membership_ready_rebuild_failed',
        homeId: params.homeId,
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
      && isCurrentSampleRevision(params.getStableSampleRevision, params.revision);
  } finally {
    endPreparedReconcile();
  }
  if (!reconciledCurrent) return 'retry';
  return await params.flushDeferredShortfallSideEffect() ? 'complete' : 'retry';
};

// Installs the bundle's readiness apply-edge + the no-tree warn and freshness
// heartbeat timers, returning the (latched, idempotent) `applyMembershipReadyEdge`.
export function installBundleReadinessAndFreshness(
  params: InstallBundleReadinessParams,
): {
  applyMembershipReadyEdge: () => void;
  markPreparedOwnershipGenerationReconciled: () => void;
} {
  const {
    ctx, homeId, timerKey, logger, planService, getTrackerState, meterSilence,
    isTornDown, getStableSampleRevision, beginPreparedOwnershipReconcile,
    flushDeferredShortfallSideEffect,
    isMembershipReady, isMeterSourceAuthorized,
  } = params;
  // Latch for the readiness apply-edge (one rebuild, which both plans and
  // actuates). The rebuild recomputes against the guard's freshest total power
  // (each ingested sample updates it synchronously), so an over-cap reading sheds,
  // and it applies that fresh plan even when the action signature is unchanged —
  // a stable committed shed would otherwise never apply once the gate opens.
  //
  // This was a rebuild followed by a reconcile, for exactly that
  // unchanged-signature reason; the reconcile is gone because re-applying the last
  // COMMITTED plan is the hazard, not the remedy. Built from an earlier under-cap
  // dry-run sample, it could RESTORE load while the home is over cap (R7b P0-1),
  // and the same shape breached the hard cap in production (inc_26449fb9).
  //
  // NOT once-only: a FAILED rebuild or a sample landing mid-rebuild re-arms the
  // latch so a later attempt retries (driven by the registry edge and by each
  // sample's post-ingest re-trigger).
  let membershipReadySeen = isMembershipReady();
  const applyRetryTimerKey = timerKey('membershipReadyApplyRetry');
  const scheduleMembershipReadyApplyRetry = (): void => {
    if (
      isTornDown()
      || membershipReadySeen
      || !isMembershipReady()
      || ctx.timers.has(applyRetryTimerKey)
    ) return;
    ctx.timers.registerTimeout(applyRetryTimerKey, setTimeout(() => {
      ctx.timers.clear(applyRetryTimerKey);
      applyMembershipReadyEdge();
    }, MEMBERSHIP_READY_APPLY_RETRY_MS));
  };
  const rearmMembershipReadyApply = (): void => {
    membershipReadySeen = false;
    scheduleMembershipReadyApplyRetry();
  };
  const applyMembershipReadyEdge = (): void => {
    if (isTornDown() || membershipReadySeen || !isMembershipReady()) return;
    const sample = getStableSampleRevision();
    if (sample.state === 'pending') {
      scheduleMembershipReadyApplyRetry();
      return;
    }
    ctx.timers.clear(applyRetryTimerKey);
    membershipReadySeen = true;
    const revisionAtStart = sample.revision;
    void applyMembershipReadyPlan({
      homeId,
      revision: revisionAtStart,
      logger,
      planService,
      isTornDown,
      getStableSampleRevision,
      beginPreparedOwnershipReconcile,
      flushDeferredShortfallSideEffect,
    })
      .then((result) => {
        if (result === 'retry') rearmMembershipReadyApply();
      })
      .catch((error: unknown) => {
        rearmMembershipReadyApply();
        logger()?.error({ event: 'home_membership_ready_apply_failed', homeId, err: normalizeError(error) });
      });
  };

  // No-tree warn timer (only armed while not yet ready): if no committed zone
  // tree lands within the grace, WARN — a durable, operator-visible signal that
  // the zones API is degraded and any PINNED sub-home members stay gated
  // (controlled by nobody until the tree lands). Warn-only: it does NOT open the
  // actuation gate (that boot-window guard is a documented safety invariant).
  if (!membershipReadySeen) {
    ctx.timers.registerTimeout(timerKey('noTreeWarn'), setTimeout(() => {
      ctx.timers.clear(timerKey('noTreeWarn'));
      if (isTornDown() || isMembershipReady()) return;
      logger()?.warn({
        event: 'home_bundle_gated_no_zone_tree_commit',
        homeId,
        detail: 'no committed zone tree after boot grace; bundle stays dry-run gated — '
          + 'pinned members are uncontrolled until the zones API recovers',
      });
    }, MEMBERSHIP_TREE_COMMIT_WARN_MS));
  }

  // This home's one silent-meter clock. Shared with main
  // (`setup/powerSampleFreshnessEscalation.ts`) so both escalate on the same rule.
  installPowerSampleFreshnessEscalation({
    ctx,
    homeId,
    timerKey: timerKey('freshnessHeartbeat'),
    logger,
    rebuild: () => planService.rebuildPlanFromCache('freshness_heartbeat'),
    meterSilence,
    getLastSampleAtMs: () => getTrackerState().lastTimestamp,
    isTornDown,
    // Sub-home meters are fanned out ONLY by the Homey Energy poll
    // (`routeMeterReadings` drops readings under flow), so a bundle whose source
    // has been switched to flow has an orphaned timestamp that will never refresh.
    isMeterSampled: isMeterSourceAuthorized,
  });

  return {
    applyMembershipReadyEdge,
    markPreparedOwnershipGenerationReconciled: () => {
      if (!isTornDown() && isMembershipReady()) membershipReadySeen = true;
    },
  };
}
