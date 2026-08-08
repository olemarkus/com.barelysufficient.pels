import type { AppContext } from '../../lib/app/appContext';
import type { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import { normalizeError } from '../../lib/utils/errorUtils';
import { createHomeMembershipService, type HomeMembershipWiring } from '../homeMembership';
import type { StableSampleRevision } from '../powerSamplePipeline';

const MAIN_OWNERSHIP_RECOVERY_TIMER = 'mainOwnershipRecovery';
const MAIN_OWNERSHIP_RECOVERY_BASE_DELAY_MS = 1000;
const MAIN_OWNERSHIP_RECOVERY_MAX_DELAY_MS = 60 * 1000;

type MainOwnershipRecovery = {
  applyNow: () => void;
  schedule: () => void;
  stop: () => void;
};

export type OwnershipGenerationRuntime = {
  /** Producer-resolved Main sample revision: stable, or pending incorporation. */
  getMainStableSampleRevision: () => StableSampleRevision;
  /** Install a final-actuator sample fence for the prepared Main reconcile. */
  beginMainPreparedReconcile: (sampleRevision: number) => () => void;
  /** Reconcile meter runtimes and commit fresh sub-home plans while fenced. */
  prepare: () => Promise<boolean>;
  /** No sub-home sample may have superseded a prepared plan. */
  isPreparedCurrent: () => boolean;
  /** Apply the prepared sub-home plans after the current generation opens. */
  reconcile: () => Promise<boolean>;
  /** Deliver a Main shortfall enter/clear deferred by the ownership fence. */
  flushMainShortfallSideEffect: () => Promise<boolean>;
};

export type WireHomeMembershipOptions = {
  onOwnershipReadyBeforePlanWork?: (
    membership: HomeMembershipWiring['service'],
    allowPendingOwnershipGeneration: boolean,
  ) => void;
  onZoneTreeCommitReady?: () => void;
  onRuntimeActiveChanged?: (runtimeActive: boolean) => void;
  onSubHomeMembershipChanged?: () => boolean;
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
};

const retryFencedAuthority = (
  membership: HomeMembershipWiring['service'],
  revisionBeforeFence: number,
  revisionAfterFence: number,
): boolean => (
  !membership.isOwnershipReady() || revisionAfterFence !== revisionBeforeFence
);

type PreparedRecoveryAuthority = {
  ownershipGeneration: number;
  generationPending: boolean;
};

const arePreparedSubHomesCurrent = (
  prepared: PreparedRecoveryAuthority,
  runtime: OwnershipGenerationRuntime | undefined,
): boolean => (
  !prepared.generationPending || !runtime || runtime.isPreparedCurrent()
);

const isStableSampleRevision = (
  sample: StableSampleRevision,
  revision: number,
): boolean => sample.state === 'stable' && sample.revision === revision;

const prepareRecoveryAuthority = async (params: {
  membership: HomeMembershipWiring['service'];
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
  retryDeferredOvershootSeed?: WireHomeMembershipOptions['onOwnershipReadyBeforePlanWork'];
  retryRevisionBeforeFence: number;
  getRetryRevision: () => number;
  schedule: () => void;
}): Promise<PreparedRecoveryAuthority | null> => {
  const {
    membership,
    ownershipGenerationRuntime,
    retryDeferredOvershootSeed,
    retryRevisionBeforeFence,
    getRetryRevision,
    schedule,
  } = params;
  const ownershipGeneration = membership.getObservedOwnershipGeneration();
  const generationPending = membership.hasPendingOwnershipGeneration();
  if (!generationPending) {
    if (!membership.isMainHomeActuationFenced()) {
      retryDeferredOvershootSeed?.(membership, false);
      return { ownershipGeneration, generationPending };
    }
    if (retryFencedAuthority(
      membership,
      retryRevisionBeforeFence,
      getRetryRevision(),
    )) schedule();
    return null;
  }
  const preparation = membership.classifyOwnershipGenerationForPreparation(
    ownershipGeneration,
  );
  if (preparation === 'retry') schedule();
  if (preparation !== 'ready') return null;
  // The current observed map and settings have been classified ready, while
  // final actuation remains fenced by the pending generation. Seed now so both
  // Main and bundle preparation below build with the usable temperature action.
  retryDeferredOvershootSeed?.(membership, true);
  if (ownershipGenerationRuntime && !(await ownershipGenerationRuntime.prepare())) {
    schedule();
    return null;
  }
  const stillReady = membership.getObservedOwnershipGeneration() === ownershipGeneration
    && membership.classifyOwnershipGenerationForPreparation(ownershipGeneration) === 'ready';
  if (!stillReady) schedule();
  return stillReady ? { ownershipGeneration, generationPending } : null;
};

const reconcilePreparedPlans = async (params: {
  planService: NonNullable<AppContext['planService']>;
  mainSampleRevision: number;
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
  generationPending: boolean;
  getMainStableSampleRevision: () => StableSampleRevision;
  schedule: () => void;
}): Promise<boolean> => {
  const {
    planService,
    mainSampleRevision,
    ownershipGenerationRuntime,
    generationPending,
    getMainStableSampleRevision,
    schedule,
  } = params;
  let mainReconcileAborted = false;
  // The settlement convergence is a full rebuild now, not the decision-free
  // reconcile it replaced, so it can FAIL where the old call could only no-op.
  // `rebuildPlanFromCache` contains planner errors and resolves `{failed:true}`
  // rather than throwing, so an unchecked result would finalize the generation
  // and flush side effects as though convergence had happened. On the flow power
  // source no later sample is guaranteed, which would strand the prepared
  // actions indefinitely.
  const [mainOutcome, subHomesReconciled] = await Promise.all([
    planService.rebuildPlanFromCache(
      'home_membership_settled',
      () => !isStableSampleRevision(getMainStableSampleRevision(), mainSampleRevision),
      () => {
        mainReconcileAborted = true;
        schedule();
      },
    ),
    generationPending && ownershipGenerationRuntime
      ? ownershipGenerationRuntime.reconcile()
      : Promise.resolve(true),
  ]);
  if (mainOutcome.failed) schedule();
  if (
    mainReconcileAborted
    || mainOutcome.failed
    || !subHomesReconciled
    || !isStableSampleRevision(getMainStableSampleRevision(), mainSampleRevision)
  ) {
    schedule();
    return false;
  }
  return true;
};

type AuthorityPlanApplyResult =
  | { state: 'stopped' }
  | { state: 'retry' }
  | { state: 'reconciled'; generationApplicationStarted: boolean };

const abortOwnershipGenerationApplication = (
  membership: HomeMembershipWiring['service'],
  prepared: PreparedRecoveryAuthority,
  started: boolean,
): void => {
  if (started) {
    membership.abortPreparedOwnershipGenerationApplication(prepared.ownershipGeneration);
  }
};

const applyAuthorityPlansUnderFence = async (params: {
  ctx: AppContext;
  planService: NonNullable<AppContext['planService']>;
  membership: HomeMembershipWiring['service'];
  prepared: PreparedRecoveryAuthority;
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
  mainSampleRevision: number;
  getMainStableSampleRevision: () => StableSampleRevision;
  isStopped: () => boolean;
  schedule: () => void;
}): Promise<AuthorityPlanApplyResult> => {
  const {
    ctx, planService, membership, prepared, ownershipGenerationRuntime,
    mainSampleRevision, getMainStableSampleRevision, isStopped, schedule,
  } = params;
  let generationApplicationStarted = false;
  try {
    const outcome = await planService.rebuildPlanFromCache('home_ownership_ready');
    if (isStopped()) return { state: 'stopped' };
    if (outcome.failed) {
      ctx.getStructuredLogger('homes')?.warn({
        event: 'home_ownership_ready_rebuild_failed',
      });
      schedule();
      return { state: 'retry' };
    }
    const preparedPlansCurrent = isStableSampleRevision(
      getMainStableSampleRevision(),
      mainSampleRevision,
    ) && arePreparedSubHomesCurrent(prepared, ownershipGenerationRuntime);
    if (!preparedPlansCurrent) {
      schedule();
      return { state: 'retry' };
    }
    const generationCommitted = prepared.generationPending
      ? membership.beginPreparedOwnershipGenerationApplication(prepared.ownershipGeneration)
      : !membership.isMainHomeActuationFenced();
    if (!generationCommitted) {
      schedule();
      return { state: 'retry' };
    }
    generationApplicationStarted = prepared.generationPending;
    const reconciled = await reconcilePreparedPlans({
      planService,
      mainSampleRevision,
      ownershipGenerationRuntime,
      generationPending: prepared.generationPending,
      getMainStableSampleRevision,
      schedule,
    });
    if (!reconciled) {
      abortOwnershipGenerationApplication(membership, prepared, generationApplicationStarted);
      return { state: 'retry' };
    }
    return { state: 'reconciled', generationApplicationStarted };
  } catch (error) {
    abortOwnershipGenerationApplication(membership, prepared, generationApplicationStarted);
    throw error;
  }
};

const finalizeAuthorityApplication = async (params: {
  membership: HomeMembershipWiring['service'];
  prepared: PreparedRecoveryAuthority;
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
  mainSampleRevision: number;
  getMainStableSampleRevision: () => StableSampleRevision;
  generationApplicationStarted: boolean;
  schedule: () => void;
}): Promise<boolean> => {
  const {
    membership, prepared, ownershipGenerationRuntime, mainSampleRevision,
    getMainStableSampleRevision, generationApplicationStarted, schedule,
  } = params;
  try {
    const mainShortfallFlushed = await (
      ownershipGenerationRuntime?.flushMainShortfallSideEffect() ?? Promise.resolve(true)
    );
    if (
      !mainShortfallFlushed
      || !isStableSampleRevision(getMainStableSampleRevision(), mainSampleRevision)
    ) {
      abortOwnershipGenerationApplication(
        membership,
        prepared,
        generationApplicationStarted,
      );
      schedule();
      return false;
    }
    if (!prepared.generationPending) return true;
    const completed = membership.completePreparedOwnershipGenerationApplication(
      prepared.ownershipGeneration,
    );
    if (!completed) {
      membership.abortPreparedOwnershipGenerationApplication(prepared.ownershipGeneration);
      schedule();
    }
    return completed;
  } catch (error) {
    abortOwnershipGenerationApplication(
      membership,
      prepared,
      generationApplicationStarted,
    );
    throw error;
  }
};

const rebuildAndReconcileAuthority = async (params: {
  ctx: AppContext;
  membership: HomeMembershipWiring['service'];
  prepared: PreparedRecoveryAuthority;
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
  isStopped: () => boolean;
  schedule: () => void;
}): Promise<boolean> => {
  const {
    ctx,
    membership,
    prepared,
    ownershipGenerationRuntime,
    isStopped,
    schedule,
  } = params;
  const planService = ctx.planService;
  const getMainStableSampleRevision = ownershipGenerationRuntime?.getMainStableSampleRevision
    ?? (() => ({ state: 'stable', revision: 0 }));
  // Initial boot can establish trustworthy ownership before the plan service
  // is wired; normal bootstrap builds that first plan.
  if (!planService) return true;
  const mainSample = getMainStableSampleRevision();
  if (mainSample.state === 'pending') {
    schedule();
    return false;
  }
  const mainSampleRevision = mainSample.revision;
  const endMainPreparedReconcile = ownershipGenerationRuntime
    ?.beginMainPreparedReconcile(mainSampleRevision) ?? (() => undefined);
  let result: AuthorityPlanApplyResult;
  try {
    result = await applyAuthorityPlansUnderFence({
      ctx,
      planService,
      membership,
      prepared,
      ownershipGenerationRuntime,
      mainSampleRevision,
      getMainStableSampleRevision,
      isStopped,
      schedule,
    });
  } finally {
    endMainPreparedReconcile();
  }
  if (result.state === 'stopped') return true;
  if (result.state === 'retry') return false;
  return finalizeAuthorityApplication({
    membership,
    prepared,
    ownershipGenerationRuntime,
    mainSampleRevision,
    getMainStableSampleRevision,
    generationApplicationStarted: result.generationApplicationStarted,
    schedule,
  });
};

/**
 * Self-healing Main authority edge. A live settings read can fence at any
 * point, including flow mode with no later sample/event. Re-probe with bounded
 * exponential backoff; once authority is proven, build a FRESH plan and only
 * then reconcile it. Failed rebuilds and a fence that recloses mid-build both
 * retry rather than applying a stale pre-fence plan.
 */
const createMainOwnershipRecovery = (
  ctx: AppContext,
  getMembership: () => HomeMembershipWiring['service'] | undefined,
  ownershipGenerationRuntime?: OwnershipGenerationRuntime,
  retryDeferredOvershootSeed?: WireHomeMembershipOptions['onOwnershipReadyBeforePlanWork'],
): MainOwnershipRecovery => {
  let stopped = false;
  let inFlight = false;
  let inFlightOwnershipGeneration: number | null = null;
  let retryAttempt = 0;
  // Monotonic request generation. A final actuator can discover a fresh fence
  // while reconcile is in flight and call `schedule()`. The completing apply
  // must not clear that newer retry merely because reconcile itself resolved.
  let retryRequestRevision = 0;

  const schedule = (): void => {
    if (stopped) return;
    retryRequestRevision += 1;
    if (ctx.timers.has(MAIN_OWNERSHIP_RECOVERY_TIMER)) return;
    const delayMs = Math.min(
      MAIN_OWNERSHIP_RECOVERY_BASE_DELAY_MS * (2 ** retryAttempt),
      MAIN_OWNERSHIP_RECOVERY_MAX_DELAY_MS,
    );
    retryAttempt = Math.min(retryAttempt + 1, 6);
    ctx.timers.registerTimeout(MAIN_OWNERSHIP_RECOVERY_TIMER, setTimeout(() => {
      ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
      // Never consume a retry while another rebuild/reconcile is still active.
      // Re-arm it at the bounded backoff cadence instead.
      if (inFlight) {
        schedule();
        return;
      }
      void apply();
    }, delayMs));
  };

  const apply = async (): Promise<void> => {
    if (stopped || inFlight) return;
    const membership = getMembership();
    if (!membership) return;
    inFlight = true;
    inFlightOwnershipGeneration = membership.getObservedOwnershipGeneration();
    try {
      // Refresh the semantic store baselines/tree on every retry. Without this,
      // a first suspect homes/assignments read can remain fenced forever in
      // flow mode when no later settings or snapshot event arrives.
      membership.recompute();
      const retryRevisionAtStart = retryRequestRevision;
      const prepared = await prepareRecoveryAuthority({
        membership,
        ownershipGenerationRuntime,
        retryDeferredOvershootSeed,
        retryRevisionBeforeFence: retryRequestRevision,
        getRetryRevision: () => retryRequestRevision,
        schedule,
      });
      if (!prepared) return;
      const completed = await rebuildAndReconcileAuthority({
        ctx,
        membership,
        prepared,
        ownershipGenerationRuntime,
        isStopped: () => stopped,
        schedule,
      });
      if (stopped || !completed) return;
      // A final point-of-use actuator may have closed on a newer authority
      // fence DURING reconcile and scheduled recovery. Preserve that request;
      // only an apply with no newer retry work may reset/clear the backoff.
      if (retryRequestRevision === retryRevisionAtStart) {
        retryAttempt = 0;
        ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
      }
    } catch (error: unknown) {
      ctx.getStructuredLogger('homes')?.error({
        event: 'home_ownership_ready_apply_failed',
        err: normalizeError(error),
      });
      schedule();
    } finally {
      inFlight = false;
      inFlightOwnershipGeneration = null;
    }
  };

  return {
    applyNow: () => {
      if (inFlight) {
        // Two serialized handlers can recompute the same already-observed
        // homes/pins generation. The active apply read both latest stores, so
        // that second immediate request is duplicate work. A genuinely newer
        // event advances the generation and retains the bounded retry.
        if (
          getMembership()?.getObservedOwnershipGeneration()
          !== inFlightOwnershipGeneration
        ) schedule();
        return;
      }
      ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
      void apply();
    },
    schedule,
    stop: () => {
      stopped = true;
      ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
    },
  };
};

/**
 * Boot-wire the multi-home membership cache over the ctx seams: real stores,
 * the transport's zone tree + zone-tree-commit callback, and the latest
 * target snapshot. Runs after `initDeviceManager` so the recompute triggers
 * ride the transport-owned notification seams; the reads are lazy closures,
 * so a not-yet-populated transport resolves fail-safe. Read-only over the
 * stores; the control path consumes it through `filterDevicesForHome` — main's
 * plan input (`setup/homeRuntime/homeScope.ts`) and the sample-pipeline
 * snapshot view (`setup/homeRuntime/createHomePowerPipeline.ts`).
 *
 * The caller (`AppServiceWiring.initHomeMembership`) assigns the returned
 * `service` to `ctx.homeMembership` and invokes `teardown` in `runUninit`.
 */
export const wireHomeMembership = (
  ctx: AppContext,
  emitter: ObservedStateEmitter,
  options: WireHomeMembershipOptions = {},
): HomeMembershipWiring => {
  const {
    onOwnershipReadyBeforePlanWork,
    onZoneTreeCommitReady,
    onRuntimeActiveChanged,
    onSubHomeMembershipChanged,
    ownershipGenerationRuntime,
  } = options;
  let service: HomeMembershipWiring['service'] | undefined = undefined;
  const recovery = createMainOwnershipRecovery(
    ctx,
    () => service,
    ownershipGenerationRuntime,
    onOwnershipReadyBeforePlanWork,
  );
  const wiring = createHomeMembershipService({
    homey: ctx.homey,
    emitter,
    onZoneTreeCommitReady,
    onRuntimeActiveChanged,
    onMainOwnershipReady: recovery.applyNow,
    onMainAuthorityUnresolved: recovery.schedule,
    // A repaired sampled-meter fence still leaves a committed plan derived
    // under the old provenance. Advance the ownership generation synchronously
    // before the authority latch opens; that generation is the takeover fence
    // while the normal bounded recovery rebuilds and reconciles a fresh plan.
    // `observeOwnershipConfigurationChanged` schedules through the existing
    // unresolved-authority callback, so recovery remains deferred off the
    // sample-dispatch stack.
    onMainAuthorityReopened: () => service?.observeOwnershipConfigurationChanged(),
    onOwnershipReadyBeforePlanWork,
    setOnZoneTreeCommitted: (callback) => ctx.deviceManager?.setOnZoneTreeCommitted(callback),
    setOnDeviceZoneChanged: (callback) => ctx.deviceManager?.setOnDeviceZoneChanged(callback),
    getZoneTree: () => ctx.deviceManager?.getZoneTree() ?? null,
    // The RAW transport snapshot on purpose, NOT `ctx.latestTargetSnapshot`:
    // the decorated path (`decorateTargetSnapshotList`) prunes/expires/confirms
    // stepped-load command state, while a membership recompute must be a pure
    // read. The join needs only `id` + `zoneId`, both
    // stamped on the raw snapshot at parse (R3).
    getDevices: () => (ctx.deviceManager?.getSnapshot() ?? []).map((device) => ({
      deviceId: device.id,
      zoneId: device.zoneId ?? null,
    })),
    getLogger: () => ctx.getStructuredLogger('homes'),
    // Restart fence anchor: the stamp of the sample Main's tracker currently
    // serves. `loadPowerTracker` reloads the durable `lastPowerW`/
    // `lastTimestamp`, so after a restart inside the freshness window the
    // planner treats pre-restart watts as live while the sampled-identity owner
    // starts empty — the authority reads this to fence Main until its own first
    // ingest re-proves provenance. Lazy: the tracker may load after this wiring,
    // and an unloaded `{}` honestly reports no restored sample.
    getRestoredSampleAtMs: () => ctx.powerTracker?.lastTimestamp,
    // Change-gated plan invalidation, mirroring the settings-change rebuild
    // path (`rebuildPlanFromSettings` → `planService.rebuildPlanFromCache`): a
    // changed membership map means the committed plan governs the wrong device
    // set — worst in flow mode, where no sample-driven rebuild is guaranteed.
    onMembershipChanged: () => {
      // A settings-generation recovery owns the full fresh Main/sub-home build
      // and reconcile. Do not enqueue duplicate stale-plan work from the
      // intermediate semantic recompute.
      if (service?.hasPendingOwnershipGeneration()) return;
      if (onSubHomeMembershipChanged?.() === false) return;
      const planService = ctx.planService;
      if (!planService) {
        // Honest skip, never silent: the change-gate cannot fire on the first
        // resolution, so an absent plan service here is a wiring-order
        // regression (membership changed before the plan wiring exists) — the
        // committed plan, if any, keeps governing until the next rebuild
        // trigger. Warn so the regression is diagnosable from logs.
        ctx.getStructuredLogger('homes')?.warn({
          event: 'home_membership_rebuild_skipped_unwired',
        });
        return;
      }
      void planService.rebuildPlanFromCache('home_membership_changed')
        .catch((error: unknown) => ctx.getStructuredLogger('homes')?.error({
          event: 'home_membership_plan_rebuild_failed',
          err: normalizeError(error),
        }));
    },
  });
  service = wiring.service;
  if (!service.isOwnershipReady()) recovery.schedule();
  return {
    service: wiring.service,
    requestMainAuthorityRecovery: (timing = 'scheduled') => {
      if (timing === 'immediate') recovery.applyNow();
      else recovery.schedule();
    },
    teardown: () => {
      recovery.stop();
      wiring.teardown();
    },
  };
};
