import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import { fetchLivePowerReport as fetchLivePowerReportFromSdk, type LivePowerReport } from './managerFetch';
import type { TransportContext } from './transportContext';

/**
 * Resolve one live report against a producer-clean Main meter selection. The
 * selection is an argument, never re-read here: the caller owns which authority
 * this report belongs to (a refresh cycle carries the one it captured at the
 * start, so a mid-flight switch cannot slip a report in under the new meter).
 */
export async function fetchLivePowerReport(
  ctx: TransportContext,
  selection: MainMeterSelection,
): Promise<LivePowerReport> {
  const report = await fetchLivePowerReportFromSdk({
    logger: ctx.logger,
    debugStructured: ctx.debugStructured,
    meterDeviceId: selection.state === 'resolved' ? selection.meterDeviceId : null,
    preferredAutomaticMeterDeviceId: ctx.automaticHomeMeterState.preferredDeviceId,
    additionalMeterDeviceIds: ctx.providers.getAdditionalMeterDeviceIds?.() ?? [],
  });
  return selection.state === 'resolved'
    ? report
    : {
      ...report,
      homeMeterResolution: 'unavailable',
      homePowerW: null,
      resolvedHomeMeterDeviceId: null,
    };
}
