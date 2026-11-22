import { MeterSilenceEscalation } from '../lib/power/meterSilenceEscalation';
import { MeterSilenceNotice } from '../lib/power/meterSilenceNotice';
import { readConfiguredPowerSource } from './powerSourceSettings';
import { requireDeviceManager, requirePlanService } from './appInit/contextGuards';
import { MAIN_HOME_ID } from '../lib/utils/settingsKeys';
import type { AppContext } from '../lib/app/appContext';

/**
 * Main's silent-meter clock — SOURCE-AGNOSTIC (owner ruling 2026-08-31).
 *
 * It used to be gated to `homey_energy`, with the Flow source's fail-closed
 * escalation living in a separate Flow-source clock. Both sources now share
 * this one clock and the one silence policy behind it
 * (`lib/power/meterSilence.ts`): a silent Flow and a dead meter are the same
 * absence, answered the same way — one fail-closed shed pass, then the
 * composed plan-build gate blocks until a new reading returns.
 */
export function installMainFreshnessEscalation(
  ctx: AppContext,
  isTornDown: () => boolean,
  isActuationFenced: () => boolean,
): void {
  new MeterSilenceEscalation({
    homeId: MAIN_HOME_ID,
    timers: ctx.timers,
    timerKey: 'mainFreshnessEscalation',
    logger: () => ctx.getStructuredLogger('power'),
    rebuild: () => requirePlanService(ctx).rebuildPlanFromCache('freshness_heartbeat'),
    meterSilence: ctx.meterSilenceMonitor,
    isTornDown,
    isMeterSampled: () => true,
    isSnapshotWarm: () => requireDeviceManager(ctx).hasWarmSnapshot(),
    isActuationFenced,
  }).start();
}

const MAIN_METER_SILENCE_NOTICE_CHECK_MS = 30 * 1000;

/** Main's timeline notice for the fail-closed pass and its end (`lib/power/meterSilenceNotice.ts`). */
export function installMainMeterSilenceNotice(ctx: AppContext, isTornDown: () => boolean): void {
  const notice = new MeterSilenceNotice({
    meterSilence: ctx.meterSilenceMonitor,
    notifications: ctx.homey.notifications,
    readPowerSource: () => {
      const read = readConfiguredPowerSource(ctx.homey.settings);
      return read.state === 'resolved' ? read.value : null;
    },
    nowMs: () => Date.now(),
    logger: () => ctx.getStructuredLogger('power'),
  });
  ctx.timers.registerInterval('mainMeterSilenceNotice', setInterval(() => {
    if (!isTornDown()) void notice.check();
  }, MAIN_METER_SILENCE_NOTICE_CHECK_MS));
}
