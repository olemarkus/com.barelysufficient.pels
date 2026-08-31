import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import { fetchLivePowerReport as fetchLivePowerReportFromSdk, type LivePowerReport } from './managerFetch';
import type { TransportContext } from './transportContext';

/**
 * Resolve one live report against a producer-clean Main meter selection. The
 * selection is an argument, never re-read here: the caller owns which
 * authority this report belongs to (a refresh cycle carries the one it
 * captured at the start, so a mid-flight switch cannot slip a report in under
 * the new meter). An `unavailable` selection still fetches — the per-device
 * lanes and sub-meter readings stay populated — and the whole-home half comes
 * back honestly absent from `resolveHomeReading`.
 */
export async function fetchLivePowerReport(
  ctx: TransportContext,
  selection: MainMeterSelection,
): Promise<LivePowerReport> {
  return fetchLivePowerReportFromSdk({
    logger: ctx.logger,
    debugStructured: ctx.debugStructured,
    meterSelection: selection,
    additionalMeterDeviceIds: ctx.providers.getAdditionalMeterDeviceIds?.() ?? [],
  });
}
