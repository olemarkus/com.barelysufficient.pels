/**
 * The readiness apply-edge + no-tree warn + freshness-heartbeat timers for one
 * sub-home capacity bundle (multi-home R7b). Extracted from
 * `createHomeCapacityBundle` to keep that wiring function within the setup-layer
 * size ceilings; all mutable bundle state is reached through the passed closures
 * (teardown fence, sample revision, membership readiness).
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import { POWER_SOURCE } from '../../lib/utils/settingsKeys';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanService } from '../../lib/plan/planService';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/plan/planPowerFreshness';
import { normalizeError } from '../../lib/utils/errorUtils';

// Base freshness-heartbeat cadence (mirrors `POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS`
// in `setup/powerSamplePipeline.ts`). The test value is coarser than the poll
// cadence so a 10-minute stale-escalation test doesn't fire thousands of ticks.
const FRESHNESS_HEARTBEAT_BASE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 5000 : 30 * 1000;

// Grace after which a bundle still gated on a committed zone tree WARNS (a
// durable, operator-visible signal that the zones API is degraded). See the
// no-tree warn timer below.
const MEMBERSHIP_TREE_COMMIT_WARN_MS = process.env.NODE_ENV === 'test' ? 500 : 5 * 60 * 1000;

/**
 * Per-home deterministic heartbeat interval: the base cadence plus a stable
 * per-`homeId` jitter (a fraction of the base) so N bundles' heartbeats do not
 * fire on the SAME tick — the phase-aligned synchronized rebuild storm P1#4
 * guards against. Hashed off the homeId so it is stable across restarts and
 * distinct per home; deterministic (not random) so timing tests stay reliable.
 */
export const freshnessHeartbeatIntervalMs = (homeId: HomeId): number => {
  const hash = [...homeId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const jitterMs = hash % Math.max(1, Math.floor(FRESHNESS_HEARTBEAT_BASE_INTERVAL_MS / 4));
  return FRESHNESS_HEARTBEAT_BASE_INTERVAL_MS + jitterMs;
};

export type InstallBundleReadinessParams = {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: (suffix: string) => string;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  planService: PlanService;
  getTrackerState: () => PowerTrackerState;
  /** Teardown fence: true once `teardown()` ran (all continuations must bail). */
  isTornDown: () => boolean;
  /** Monotonic meter-sample counter; a change between capture and commit aborts a ready-edge. */
  getSampleRevision: () => number;
  isMembershipReady: () => boolean;
};

// Installs the bundle's readiness apply-edge + the no-tree warn and freshness
// heartbeat timers, returning the (latched, idempotent) `applyMembershipReadyEdge`.
export function installBundleReadinessAndFreshness(
  params: InstallBundleReadinessParams,
): { applyMembershipReadyEdge: () => void } {
  const {
    ctx, homeId, timerKey, logger, planService, getTrackerState,
    isTornDown, getSampleRevision, isMembershipReady,
  } = params;
  // Latch for the readiness apply-edge (rebuild → reconcile). The rebuild
  // recomputes against the guard's freshest total power (each ingested sample
  // updates it synchronously), so an over-cap reading sheds; reconcile then
  // applies that fresh plan's intent even when its action signature is unchanged
  // (plans actuate on CHANGE; a stable committed shed would otherwise never apply
  // once the gate opens). A BARE reconcile would re-apply the last COMMITTED plan
  // — which, if built from an earlier under-cap dry-run sample, could RESTORE load
  // while the home is over cap (R7b P0-1). NOT once-only: a FAILED rebuild or a
  // sample landing mid-rebuild re-arms the latch so a later attempt retries
  // (driven by the registry edge and by each sample's post-ingest re-trigger).
  let membershipReadySeen = isMembershipReady();
  const applyMembershipReadyEdge = (): void => {
    if (isTornDown() || membershipReadySeen || !isMembershipReady()) return;
    membershipReadySeen = true;
    const revisionAtStart = getSampleRevision();
    void planService.rebuildPlanFromCache('home_membership_ready')
      .then((outcome) => {
        if (isTornDown()) return undefined;
        // `PlanService` catches rebuild exceptions internally and RESOLVES
        // `{ failed: true }` — so a rejected `.catch` never fires. Inspect the
        // outcome: a failed FRESH rebuild left the STALE pre-gate dry-run plan in
        // place; reconciling it could restore over cap. Skip the reconcile and
        // re-arm so a later attempt retries.
        if (outcome.failed) {
          membershipReadySeen = false;
          logger()?.warn({ event: 'home_membership_ready_rebuild_failed', homeId });
          return undefined;
        }
        // Sample-revision race: a newer meter sample landed while this rebuild was
        // in flight, so the plan just built may be stale (e.g. an over-cap sample
        // arrived during a rebuild of an under-cap plan). Abort the reconcile — the
        // newer sample's own rebuild drives actuation — and re-arm so the next
        // (settled) attempt applies the fresh decision rather than a stale restore.
        if (getSampleRevision() !== revisionAtStart) {
          membershipReadySeen = false;
          return undefined;
        }
        // The pre-check above only closes the race up to the enqueue boundary:
        // `reconcileLatestPlanState` merely ENQUEUES, so a sample can still land
        // AFTER this check but BEFORE the queued reconcile reads the committed
        // plan (TOCTOU). Pass the revision predicate so the reconcile re-checks at
        // the point of use and aborts if it moved, rather than resuming load after
        // a newer over-cap sample (R7b P1). A queue-side abort resolves a bare
        // `false` — indistinguishable from a no-op — so it re-arms the latch and
        // reschedules via `onAbort`. Re-arming alone is NOT enough: the sample that
        // moved the revision already ran its own post-ingest edge retry, which
        // no-opped against the still-latched flag; in flow mode the meter may then
        // fall silent, so without an explicit reschedule the pre-gate stable shed
        // could stay unapplied indefinitely.
        return planService.reconcileLatestPlanState(
          () => getSampleRevision() !== revisionAtStart,
          () => {
            membershipReadySeen = false;
            applyMembershipReadyEdge();
          },
        );
      })
      .catch((error: unknown) => {
        membershipReadySeen = false;
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

  // Freshness heartbeat: re-run the planner when a silent meter dropout ages the
  // last sample past the fail-closed timeout, so the bundle sheds instead of
  // freezing the last "under cap" decision forever. Bounded by design (P1#4): an
  // in-flight latch (no overlapping rebuild), and — because `stale_fail_closed`
  // is TERMINAL until a fresh sample returns — exactly ONE rebuild per stale
  // period (tracked by the sample timestamp), never a per-tick storm. During live
  // sampling and the stale_hold window (age below the timeout) the state does not
  // change, so this stays idle; a never-sampled bundle has no aging timestamp
  // (stays `stale_hold`), so it is skipped too.
  let heartbeatInFlight = false;
  let failClosedRebuiltForTs: number | null = null;
  const maybeFreshnessHeartbeatRebuild = (): void => {
    if (isTornDown() || heartbeatInFlight) return;
    // Flow-mode gate (P2#4): sub-home meters are fanned out ONLY by the Homey
    // Energy poll (`routeMeterReadings` drops readings under flow). If the user
    // switches power_source to flow while a prior sample is still cached, no
    // fresh sub-home sample will ever arrive — so the heartbeat must NOT keep
    // aging that now-orphaned timestamp into a fail-closed shed on a dead
    // reading. Suspend escalation entirely under flow; switching back to
    // homey_energy resumes normal sampling (and normal staleness escalation).
    if (normalizePowerSource(ctx.homey.settings.get(POWER_SOURCE)) !== 'homey_energy') return;
    const lastTs = getTrackerState().lastTimestamp;
    if (typeof lastTs !== 'number' || !Number.isFinite(lastTs)) return;
    if (Date.now() - lastTs < POWER_SAMPLE_STALE_SHED_TIMEOUT_MS) return;
    // Already escalated this stale period (state is terminal until a fresh sample
    // moves `lastTimestamp`); do not keep re-rebuilding the same fail-closed plan.
    if (failClosedRebuiltForTs === lastTs) return;
    heartbeatInFlight = true;
    void planService.rebuildPlanFromCache('freshness_heartbeat')
      .then((outcome) => {
        // Latch this stale period as escalated ONLY after a rebuild that both
        // SUCCEEDED and actually ACTUATED (ran outside dry-run). `rebuildPlanFromCache`
        // RESOLVES `{ failed: true }` on a build error (it never throws), and it also
        // runs forced-dry-run during the boot-window membership gate. In either case
        // the fail-closed shed did NOT take effect, so latching would wrongly suppress
        // the retry the next tick owes — (a) never re-attempting a failed shed during
        // a live meter dropout, and (b) burning the escalation one-shot before the
        // ready-edge opens the actuation gate. Log and let the next tick retry both.
        if (outcome.failed) {
          logger()?.warn({ event: 'home_freshness_heartbeat_rebuild_failed', homeId });
          return;
        }
        if (outcome.isDryRun) {
          logger()?.debug({ event: 'home_freshness_heartbeat_rebuild_dry_run_skipped', homeId });
          return;
        }
        // Still fail-closed on completion (a sample racing in would have moved
        // `lastTimestamp`): mark this stale period escalated so it does not re-rebuild.
        if (getTrackerState().lastTimestamp === lastTs) failClosedRebuiltForTs = lastTs;
      })
      .catch((error: unknown) => {
        logger()?.error({ event: 'home_freshness_heartbeat_rebuild_failed', homeId, err: normalizeError(error) });
      })
      .finally(() => { heartbeatInFlight = false; });
  };
  ctx.timers.registerInterval(
    timerKey('freshnessHeartbeat'),
    setInterval(maybeFreshnessHeartbeatRebuild, freshnessHeartbeatIntervalMs(homeId)),
  );

  return { applyMembershipReadyEdge };
}
