import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { PlanService } from '../../lib/plan/planService';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { StableSampleRevision } from '../powerSamplePipeline';

const SOURCE_ACTUATION_RETRY_INITIAL_DELAY_MS = 1_000;
const SOURCE_ACTUATION_RETRY_MAX_DELAY_MS = 60_000;
const SOURCE_ACTUATION_RETRY_MAX_EXPONENT = 6;

export type HomeCapacityBundleSourceRecovery = {
  /** Retain one actuation retry after a transient source-authority read fails. */
  schedule: () => void;
};

type SourceRecoveryParams = {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: string;
  planService: PlanService;
  isTornDown: () => boolean;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
  isMeterSourceEpochDiscarded: () => boolean;
  getStableSampleRevision: () => StableSampleRevision;
  beginPreparedReconcile: (sampleRevision: number) => () => void;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
};

const isSourceRecoveryCurrent = (
  params: SourceRecoveryParams,
  sampleRevision: number,
): boolean => {
  if (
    params.isTornDown()
    || params.isMeterSourceEpochDiscarded()
    || !params.isMembershipReady()
    || !params.isMeterSourceAuthorized()
  ) return false;
  const current = params.getStableSampleRevision();
  return current.state === 'stable' && current.revision === sampleRevision;
};

const applySourceRecovery = async (
  params: SourceRecoveryParams,
  sampleRevision: number,
): Promise<boolean> => {
  const endPreparedReconcile = params.beginPreparedReconcile(sampleRevision);
  let reconciledCurrent: boolean;
  try {
    // ONE rebuild: it re-plans AND converges, so the follow-up reconcile that
    // used to force the apply for an unchanged action signature is redundant.
    let rebuildAborted = false;
    const outcome = await params.planService.rebuildPlanFromCache(
      'home_source_authority_recovered',
      () => !isSourceRecoveryCurrent(params, sampleRevision),
      () => { rebuildAborted = true; },
    );
    if (outcome.failed) return false;
    reconciledCurrent = !rebuildAborted && isSourceRecoveryCurrent(params, sampleRevision);
  } finally {
    endPreparedReconcile();
  }
  return reconciledCurrent && params.flushDeferredShortfallSideEffect();
};

/**
 * A final actuator fence can reject an otherwise-current shed when the
 * POWER_SOURCE adapter is transiently unavailable. The committed plan then has
 * the same action signature on every later sample — which used to mean an
 * ordinary rebuild would not re-apply it, so this module owned an explicit
 * reconcile to force the write. The rebuild now applies whenever the executor
 * still has work outstanding, so the retry is a plain rebuild behind the same
 * stable-sample fence as ownership-generation recovery.
 *
 * The retry schedule stays: recovering source authority is what makes the write
 * possible again, and nothing else would prompt a rebuild at that moment.
 */
export const installHomeCapacityBundleSourceRecovery = (
  params: SourceRecoveryParams,
): HomeCapacityBundleSourceRecovery => {
  let retryAttempt = 0;

  const schedule = (): void => {
    if (params.isTornDown() || params.isMeterSourceEpochDiscarded()) return;
    if (params.ctx.timers.has(params.timerKey)) return;
    const delayMs = Math.min(
      SOURCE_ACTUATION_RETRY_INITIAL_DELAY_MS * (2 ** retryAttempt),
      SOURCE_ACTUATION_RETRY_MAX_DELAY_MS,
    );
    retryAttempt = Math.min(retryAttempt + 1, SOURCE_ACTUATION_RETRY_MAX_EXPONENT);
    params.ctx.timers.registerTimeout(params.timerKey, setTimeout(() => {
      params.ctx.timers.clear(params.timerKey);
      void apply();
    }, delayMs));
  };

  const apply = async (): Promise<void> => {
    if (params.isTornDown() || params.isMeterSourceEpochDiscarded()) return;
    if (!params.isMembershipReady() || !params.isMeterSourceAuthorized()) {
      schedule();
      return;
    }
    const sample = params.getStableSampleRevision();
    if (sample.state === 'pending') {
      schedule();
      return;
    }
    try {
      const recovered = await applySourceRecovery(params, sample.revision);
      if (!recovered) {
        schedule();
        return;
      }
      retryAttempt = 0;
    } catch (error: unknown) {
      params.ctx.getStructuredLogger('homes')?.warn({
        event: 'home_source_authority_actuation_retry_failed',
        homeId: params.homeId,
        err: normalizeError(error),
      });
      schedule();
    }
  };

  return { schedule };
};
