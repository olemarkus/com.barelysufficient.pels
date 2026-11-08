import type { AppContext } from '../lib/app/appContext';
import { readMainFusePhaseSource } from '../lib/power/mainFusePhaseSource';

/**
 * Read the owner's phase meter beside a Flow sample without holding the sample:
 * a slow device read leaves this sample with the last accepted phases. With no
 * phase meter picked, phases read as none rather than a set frozen at its last read.
 */
export function observeFlowSamplePhases(ctx: AppContext, powerW: number, nowMs: number): void {
  const guard = ctx.capacityGuard;
  if (guard === undefined) return;
  const { meterDeviceId, capabilities } = readMainFusePhaseSource(ctx.homey.settings);
  if (meterDeviceId === null) {
    guard.phaseReadings.reset();
    return;
  }
  const manager = ctx.deviceManager;
  if (manager === undefined) return;
  guard.phaseReadFlight.begin(
    () => manager.readMeterPhases(meterDeviceId, capabilities),
    (read) => guard.phaseReadings.admit(read, powerW, ctx.getNow().getTime()),
    nowMs,
    () => ctx.getNow().getTime(),
  );
}
