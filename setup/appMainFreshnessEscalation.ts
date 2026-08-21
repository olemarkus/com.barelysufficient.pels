import { installPowerSampleFreshnessEscalation } from './powerSampleFreshnessEscalation';
import { requireConfiguredPowerSource } from './powerSourceSettings';
import { requirePlanService } from './appInit/contextGuards';
import { MAIN_HOME_ID } from '../lib/utils/settingsKeys';
import { normalizeError } from '../lib/utils/errorUtils';
import type { AppContext } from '../lib/app/appContext';

/**
 * Main's silent-meter clock.
 *
 * Sub-homes have had one since R7b P1#4; main never did, and until the
 * device-observation rebuild trigger went away it did not show — device chatter
 * happened to drive a rebuild often enough that a dead meter still escalated.
 * With a whole-home reading as the primary trigger
 * (`lib/plan/planRebuildTrigger.ts`), the meter dying takes the trigger with it,
 * so main needs the clock explicitly.
 *
 * Gated to `homey_energy`: under `power_source = flow` the samples are the
 * owner's Flow, and `FlowPowerSampleFreshnessClock` owns that escalation.
 */
/**
 * `requireConfiguredPowerSource` THROWS on a suspect settings read, and this runs
 * inside an interval — an escape there is an unhandled timer rejection. A read we
 * could not make is not evidence the meter is being sampled, so a suspect read
 * declines to escalate and waits for the next tick. Conservative in the right
 * direction: it delays a shed rather than firing one on a source PELS is unsure of.
 */
function isSampledByHomeyEnergyPoll(ctx: AppContext): boolean {
  try {
    return requireConfiguredPowerSource(ctx.homey.settings) === 'homey_energy';
  } catch (error) {
    ctx.getStructuredLogger('power')?.debug({
      event: 'main_freshness_escalation_power_source_read_failed',
      err: normalizeError(error),
    });
    return false;
  }
}

export function installMainFreshnessEscalation(
  ctx: AppContext,
  isTornDown: () => boolean,
): void {
  installPowerSampleFreshnessEscalation({
    ctx,
    homeId: MAIN_HOME_ID,
    timerKey: 'mainFreshnessEscalation',
    logger: () => ctx.getStructuredLogger('power'),
    rebuild: () => requirePlanService(ctx).rebuildPlanFromCache('freshness_heartbeat'),
    getLastSampleAtMs: () => ctx.powerTracker.lastTimestamp,
    isTornDown,
    isMeterSampled: () => isSampledByHomeyEnergyPoll(ctx),
  });
}
