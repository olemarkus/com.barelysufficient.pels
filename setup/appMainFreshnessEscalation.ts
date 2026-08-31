import { installPowerSampleFreshnessEscalation } from './powerSampleFreshnessEscalation';
import { requirePlanService } from './appInit/contextGuards';
import { MAIN_HOME_ID } from '../lib/utils/settingsKeys';
import type { AppContext } from '../lib/app/appContext';

/**
 * Main's silent-meter clock — SOURCE-AGNOSTIC (owner ruling 2026-08-31).
 *
 * It used to be gated to `homey_energy`, with the Flow source's fail-closed
 * escalation living in `FlowPowerSampleFreshnessClock`. Both sources now share
 * this one clock and the one silence policy behind it
 * (`lib/power/meterSilence.ts`): a silent Flow and a dead meter are the same
 * absence, answered the same way — one fail-closed shed pass, then the
 * composed plan-build gate blocks until an admitted sample returns.
 */
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
    meterSilence: ctx.meterSilenceMonitor,
    getLastSampleAtMs: () => ctx.powerTracker.lastTimestamp,
    isTornDown,
    isMeterSampled: () => true,
  });
}
