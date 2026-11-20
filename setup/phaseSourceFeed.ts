import type { AppContext } from '../lib/app/appContext';
import { readMainFusePhaseSource, resolvePhaseMeter, type PhaseMeter } from '../lib/power/mainFusePhaseSource';
import type { PowerSource } from '../lib/power/powerSource';
import { readMainMeterSelection } from './mainMeterSettings';
import { requireConfiguredPowerSource } from './powerSourceSettings';

export function readMainPhaseMeter(
  settings: Parameters<typeof readMainMeterSelection>[0],
  getPowerSource: () => PowerSource = () => requireConfiguredPowerSource(settings),
): PhaseMeter | null {
  try {
    return resolvePhaseMeter(
      readMainFusePhaseSource(settings), getPowerSource(), () => readMainMeterSelection(settings),
    );
  } catch {
    return null;
  }
}

/**
 * Read the owner's phase meter beside a Flow sample without holding the sample:
 * a slow device read leaves this sample with the last accepted phases. With no
 * phase meter picked, phases read as none rather than a set frozen at its last read.
 */
export function observeFlowSamplePhases(ctx: AppContext, powerW: number, nowMs: number): void {
  const guard = ctx.capacityGuard;
  if (guard === undefined) return;
  const settings = ctx.homey.settings;
  const meter = resolvePhaseMeter(readMainFusePhaseSource(settings), 'flow', () => readMainMeterSelection(settings));
  if (meter === null) {
    guard.phaseReadings.reset();
    return;
  }
  const manager = ctx.deviceManager;
  if (manager === undefined) return;
  guard.phaseReadFlight.begin(
    () => manager.readMeterPhases(meter.meterDeviceId, meter.capabilities),
    (read) => guard.phaseReadings.admitCurrent(
      meter, readMainPhaseMeter(settings), read, powerW, nowMs, ctx.getNow().getTime(),
    ),
    nowMs,
    () => ctx.getNow().getTime(),
  );
}
