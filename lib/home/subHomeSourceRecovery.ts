import { normalizeError } from '../utils/errorUtils';
import { isCurrentSampleRevision, type SubHomeRecoveryDeps } from './subHomeRecovery';

const SOURCE_ACTUATION_RETRY_INITIAL_DELAY_MS = 1_000;
const SOURCE_ACTUATION_RETRY_MAX_DELAY_MS = 60_000;
const SOURCE_ACTUATION_RETRY_MAX_EXPONENT = 6;

/**
 * A final actuator fence can reject an otherwise-current shed when the
 * POWER_SOURCE adapter is transiently unavailable. The committed plan then has
 * the same action signature on every later sample — which used to mean an
 * ordinary rebuild would not re-apply it, so this lane owned an explicit
 * reconcile to force the write. The rebuild now applies whenever the executor
 * still has work outstanding, so the retry is a plain rebuild behind the same
 * stable-sample fence as ownership-generation recovery.
 *
 * The retry schedule stays: recovering source authority is what makes the write
 * possible again, and nothing else would prompt a rebuild at that moment.
 */
export class SubHomeSourceRecovery {
  private retryAttempt = 0;

  private readonly retryTimerKey: string;

  constructor(private readonly deps: SubHomeRecoveryDeps) {
    this.retryTimerKey = deps.timerKey('sourceActuationRetry');
  }

  /** Retain one actuation retry after a transient source-authority read fails. */
  readonly schedule = (): void => {
    const { runtime, timers } = this.deps;
    if (runtime.isDiscarded()) return;
    if (timers.has(this.retryTimerKey)) return;
    const delayMs = Math.min(
      SOURCE_ACTUATION_RETRY_INITIAL_DELAY_MS * (2 ** this.retryAttempt),
      SOURCE_ACTUATION_RETRY_MAX_DELAY_MS,
    );
    this.retryAttempt = Math.min(this.retryAttempt + 1, SOURCE_ACTUATION_RETRY_MAX_EXPONENT);
    timers.registerTimeout(this.retryTimerKey, setTimeout(() => {
      timers.clear(this.retryTimerKey);
      void this.apply();
    }, delayMs));
  };

  private async apply(): Promise<void> {
    const { runtime, pipeline } = this.deps;
    if (runtime.isDiscarded()) return;
    if (runtime.isAuthorityClosed()) {
      this.schedule();
      return;
    }
    const sample = pipeline.getStableSampleRevision();
    if (sample.state === 'pending') {
      this.schedule();
      return;
    }
    try {
      const recovered = await this.applyRecovery(sample.revision);
      if (!recovered) {
        this.schedule();
        return;
      }
      this.retryAttempt = 0;
    } catch (error: unknown) {
      this.deps.getLogger()?.warn({
        event: 'home_source_authority_actuation_retry_failed',
        homeId: runtime.homeId,
        err: normalizeError(error),
      });
      this.schedule();
    }
  }

  private isCurrent(sampleRevision: number): boolean {
    const { runtime, pipeline } = this.deps;
    return !runtime.isDiscarded()
      && !runtime.isAuthorityClosed()
      && isCurrentSampleRevision(pipeline, sampleRevision);
  }

  private async applyRecovery(sampleRevision: number): Promise<boolean> {
    const endPreparedReconcile = this.deps.beginPreparedReconcile(sampleRevision);
    let reconciledCurrent: boolean;
    try {
      // ONE rebuild: it re-plans AND converges, so the follow-up reconcile that
      // used to force the apply for an unchanged action signature is redundant.
      let rebuildAborted = false;
      const outcome = await this.deps.planService.rebuildPlanFromCache(
        'home_source_authority_recovered',
        {
          shouldAbort: () => !this.isCurrent(sampleRevision),
          onAbort: () => { rebuildAborted = true; },
        },
      );
      // A gated skip applied nothing, so the recovery has not happened — report it
      // as not-recovered and let the retry chain keep running, exactly as a failure
      // does. Reporting success here stops the chain believing the write landed.
      if (outcome.failed || outcome.gated) return false;
      reconciledCurrent = !rebuildAborted && this.isCurrent(sampleRevision);
    } finally {
      endPreparedReconcile();
    }
    return reconciledCurrent && this.deps.flushDeferredShortfallSideEffect();
  }
}
