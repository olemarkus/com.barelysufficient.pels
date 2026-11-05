import type { HomeMembershipService } from './homeMembershipService';
import type { StableSampleRevision } from '../ports/sampleRevision';
import type { TimerRegistry } from '../utils/timerRegistry';
import type { Logger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';

/** Only the two fresh-plan operations required to settle home ownership. */
type MainAuthorityPlan = {
  rebuildPlanFromCache(
    trigger: 'home_membership_settled' | 'home_ownership_ready',
    options?: { shouldAbort: () => boolean; onAbort: () => void },
  ): Promise<{ failed?: boolean }>;
};

/** The existing application runtime, narrowed to ownership-recovery reads and scheduling. */
export type MainAuthorityRecoveryRuntime = {
  readonly planService?: MainAuthorityPlan;
  readonly timers: TimerRegistry;
  getStructuredLogger(component: 'homes'): Logger;
};

type OwnershipPreparationHook = (allowPendingOwnershipGeneration: boolean) => void;

const MAIN_OWNERSHIP_RECOVERY_TIMER = 'mainOwnershipRecovery';
const MAIN_OWNERSHIP_RECOVERY_BASE_DELAY_MS = 1000;
const MAIN_OWNERSHIP_RECOVERY_MAX_DELAY_MS = 60 * 1000;

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

const retryFencedAuthority = (
  membership: HomeMembershipService,
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

type AuthorityPlanApplyResult =
  | { state: 'stopped' }
  | { state: 'retry' }
  | { state: 'reconciled'; generationApplicationStarted: boolean };

const abortOwnershipGenerationApplication = (
  membership: HomeMembershipService,
  prepared: PreparedRecoveryAuthority,
  started: boolean,
): void => {
  if (started) {
    membership.abortPreparedOwnershipGenerationApplication(prepared.ownershipGeneration);
  }
};

/**
 * Self-healing Main authority edge. A live settings read can fence at any
 * point, including flow mode with no later sample/event. Re-probe with bounded
 * exponential backoff; once authority is proven, build a FRESH plan and only
 * then reconcile it. Failed rebuilds and a fence that recloses mid-build both
 * retry rather than applying a stale pre-fence plan.
 */
export class MainOwnershipRecovery {
  private stopped = false;
  private inFlight = false;
  private inFlightOwnershipGeneration: number | null = null;
  private retryAttempt = 0;
  // Preserve retry requests discovered by an actuator during an in-flight reconcile.
  private retryRequestRevision = 0;

  constructor(
    private readonly ctx: MainAuthorityRecoveryRuntime,
    private readonly getMembership: () => HomeMembershipService | undefined,
    private readonly ownershipGenerationRuntime?: OwnershipGenerationRuntime,
    private readonly prepareBeforePlanWork?: OwnershipPreparationHook,
  ) {}

  private readonly getMainStableSampleRevision = (): StableSampleRevision => (
    this.ownershipGenerationRuntime?.getMainStableSampleRevision() ?? { state: 'stable', revision: 0 }
  );

  readonly schedule = (): void => {
    if (this.stopped) return;
    this.retryRequestRevision += 1;
    if (this.ctx.timers.has(MAIN_OWNERSHIP_RECOVERY_TIMER)) return;
    const delayMs = Math.min(
      MAIN_OWNERSHIP_RECOVERY_BASE_DELAY_MS * (2 ** this.retryAttempt),
      MAIN_OWNERSHIP_RECOVERY_MAX_DELAY_MS,
    );
    this.retryAttempt = Math.min(this.retryAttempt + 1, 6);
    this.ctx.timers.registerTimeout(MAIN_OWNERSHIP_RECOVERY_TIMER, setTimeout(() => {
      this.ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
      // Never consume a retry while another rebuild/reconcile is still active.
      // Re-arm it at the bounded backoff cadence instead.
      if (this.inFlight) {
        this.schedule();
        return;
      }
      void this.apply();
    }, delayMs));
  };

  private readonly apply = async (): Promise<void> => {
    if (this.stopped || this.inFlight) return;
    const membership = this.getMembership();
    if (!membership) return;
    this.inFlight = true;
    this.inFlightOwnershipGeneration = membership.getObservedOwnershipGeneration();
    try {
      // Refresh the semantic store baselines/tree on every retry. Without this,
      // a first suspect homes/assignments read can remain fenced forever in
      // flow mode when no later settings or snapshot event arrives.
      membership.recompute();
      const retryRevisionAtStart = this.retryRequestRevision;
      const prepared = await this.prepareRecoveryAuthority(membership, this.retryRequestRevision);
      if (!prepared) return;
      const completed = await this.rebuildAndReconcileAuthority(membership, prepared);
      if (this.stopped || !completed) return;
      // A final point-of-use actuator may have closed on a newer authority
      // fence DURING reconcile and scheduled recovery. Preserve that request;
      // only an apply with no newer retry work may reset/clear the backoff.
      if (this.retryRequestRevision === retryRevisionAtStart) {
        this.retryAttempt = 0;
        this.ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
      }
    } catch (error: unknown) {
      this.ctx.getStructuredLogger('homes').error({
        event: 'home_ownership_ready_apply_failed',
        err: normalizeError(error),
      });
      this.schedule();
    } finally {
      this.inFlight = false;
      this.inFlightOwnershipGeneration = null;
    }
  };

  readonly applyNow = (): void => {
    if (this.inFlight) {
      // Two serialized handlers can recompute the same already-observed
      // homes/pins generation. The active apply read both latest stores, so
      // that second immediate request is duplicate work. A genuinely newer
      // event advances the generation and retains the bounded retry.
      if (
        this.getMembership()?.getObservedOwnershipGeneration()
        !== this.inFlightOwnershipGeneration
      ) this.schedule();
      return;
    }
    this.ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
    void this.apply();
  };

  readonly stop = (): void => {
    this.stopped = true;
    this.ctx.timers.clear(MAIN_OWNERSHIP_RECOVERY_TIMER);
  };

  private async prepareRecoveryAuthority(
    membership: HomeMembershipService,
    retryRevisionBeforeFence: number,
  ): Promise<PreparedRecoveryAuthority | null> {
    const ownershipGeneration = membership.getObservedOwnershipGeneration();
    const generationPending = membership.hasPendingOwnershipGeneration();
    if (!generationPending) {
      if (!membership.isMainHomeActuationFenced()) {
        this.prepareBeforePlanWork?.(false);
        return { ownershipGeneration, generationPending };
      }
      if (retryFencedAuthority(
        membership,
        retryRevisionBeforeFence,
        this.retryRequestRevision,
      )) this.schedule();
      return null;
    }
    const preparation = membership.classifyOwnershipGenerationForPreparation(
      ownershipGeneration,
    );
    if (preparation === 'retry') this.schedule();
    if (preparation !== 'ready') return null;
    // The current observed map and settings have been classified ready, while
    // final actuation remains fenced by the pending generation. Prepare the mode
    // catalogs now so both Main and bundle preparation below build on them.
    this.prepareBeforePlanWork?.(true);
    if (this.ownershipGenerationRuntime && !(await this.ownershipGenerationRuntime.prepare())) {
      this.schedule();
      return null;
    }
    const stillReady = membership.getObservedOwnershipGeneration() === ownershipGeneration
      && membership.classifyOwnershipGenerationForPreparation(ownershipGeneration) === 'ready';
    if (!stillReady) this.schedule();
    return stillReady ? { ownershipGeneration, generationPending } : null;
  }

  private async reconcilePreparedPlans(
    planService: MainAuthorityPlan,
    mainSampleRevision: number,
    generationPending: boolean,
  ): Promise<boolean> {
    let mainReconcileAborted = false;
    // The settlement convergence is a full rebuild now, not the decision-free
    // reconcile it replaced, so it can FAIL where the old call could only no-op.
    // `rebuildPlanFromCache` contains planner errors and resolves `{failed:true}`
    // rather than throwing, so an unchecked result would finalize the generation
    // and flush side effects as though convergence had happened. On the flow power
    // source no later sample is guaranteed, which would strand the prepared
    // actions indefinitely.
    const [mainOutcome, subHomesReconciled] = await Promise.all([
      planService.rebuildPlanFromCache('home_membership_settled', {
        shouldAbort: () => !isStableSampleRevision(this.getMainStableSampleRevision(), mainSampleRevision),
        onAbort: () => {
          mainReconcileAborted = true;
          this.schedule();
        },
      }),
      generationPending && this.ownershipGenerationRuntime
        ? this.ownershipGenerationRuntime.reconcile()
        : Promise.resolve(true),
    ]);
    if (mainOutcome.failed) this.schedule();
    if (
      mainReconcileAborted
      || mainOutcome.failed
      || !subHomesReconciled
      || !isStableSampleRevision(this.getMainStableSampleRevision(), mainSampleRevision)
    ) {
      this.schedule();
      return false;
    }
    return true;
  }

  private async applyAuthorityPlansUnderFence(
    planService: MainAuthorityPlan,
    membership: HomeMembershipService,
    prepared: PreparedRecoveryAuthority,
    mainSampleRevision: number,
  ): Promise<AuthorityPlanApplyResult> {
    let generationApplicationStarted = false;
    try {
      const outcome = await planService.rebuildPlanFromCache('home_ownership_ready');
      if (this.stopped) return { state: 'stopped' };
      if (outcome.failed) {
        this.ctx.getStructuredLogger('homes').warn({
          event: 'home_ownership_ready_rebuild_failed',
        });
        this.schedule();
        return { state: 'retry' };
      }
      const preparedPlansCurrent = isStableSampleRevision(
        this.getMainStableSampleRevision(),
        mainSampleRevision,
      ) && arePreparedSubHomesCurrent(prepared, this.ownershipGenerationRuntime);
      if (!preparedPlansCurrent) {
        this.schedule();
        return { state: 'retry' };
      }
      const generationCommitted = prepared.generationPending
        ? membership.beginPreparedOwnershipGenerationApplication(prepared.ownershipGeneration)
        : !membership.isMainHomeActuationFenced();
      if (!generationCommitted) {
        this.schedule();
        return { state: 'retry' };
      }
      generationApplicationStarted = prepared.generationPending;
      const reconciled = await this.reconcilePreparedPlans(
        planService, mainSampleRevision, prepared.generationPending,
      );
      if (!reconciled) {
        abortOwnershipGenerationApplication(membership, prepared, generationApplicationStarted);
        return { state: 'retry' };
      }
      return { state: 'reconciled', generationApplicationStarted };
    } catch (error) {
      abortOwnershipGenerationApplication(membership, prepared, generationApplicationStarted);
      throw error;
    }
  }

  private async finalizeAuthorityApplication(
    membership: HomeMembershipService,
    prepared: PreparedRecoveryAuthority,
    mainSampleRevision: number,
    generationApplicationStarted: boolean,
  ): Promise<boolean> {
    try {
      const mainShortfallFlushed = await (
        this.ownershipGenerationRuntime?.flushMainShortfallSideEffect() ?? Promise.resolve(true)
      );
      if (
        !mainShortfallFlushed
        || !isStableSampleRevision(this.getMainStableSampleRevision(), mainSampleRevision)
      ) {
        abortOwnershipGenerationApplication(
          membership,
          prepared,
          generationApplicationStarted,
        );
        this.schedule();
        return false;
      }
      if (!prepared.generationPending) return true;
      const completed = membership.completePreparedOwnershipGenerationApplication(
        prepared.ownershipGeneration,
      );
      if (!completed) {
        membership.abortPreparedOwnershipGenerationApplication(prepared.ownershipGeneration);
        this.schedule();
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
  }

  private async rebuildAndReconcileAuthority(
    membership: HomeMembershipService,
    prepared: PreparedRecoveryAuthority,
  ): Promise<boolean> {
    const planService = this.ctx.planService;
    // Initial boot can establish trustworthy ownership before the plan service
    // is wired; normal bootstrap builds that first plan.
    if (!planService) return true;
    const mainSample = this.getMainStableSampleRevision();
    if (mainSample.state === 'pending') {
      this.schedule();
      return false;
    }
    const mainSampleRevision = mainSample.revision;
    const endMainPreparedReconcile = this.ownershipGenerationRuntime
      ?.beginMainPreparedReconcile(mainSampleRevision) ?? (() => undefined);
    let result: AuthorityPlanApplyResult;
    try {
      result = await this.applyAuthorityPlansUnderFence(
        planService, membership, prepared, mainSampleRevision,
      );
    } finally {
      endMainPreparedReconcile();
    }
    if (result.state === 'stopped') return true;
    if (result.state === 'retry') return false;
    return this.finalizeAuthorityApplication(
      membership, prepared, mainSampleRevision, result.generationApplicationStarted,
    );
  }
}
