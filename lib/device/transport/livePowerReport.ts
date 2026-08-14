import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import { fetchLivePowerReport as fetchLivePowerReportFromSdk, type LivePowerReport } from './managerFetch';
import type { TransportContext } from './transportContext';

/** Resolve one live report against a producer-clean Main meter selection. */
export async function fetchLivePowerReport(
  ctx: TransportContext,
  mainMeterSelection?: MainMeterSelection,
): Promise<LivePowerReport> {
  const selection: MainMeterSelection = mainMeterSelection
    ?? ctx.providers.getHomeyEnergyMeterSelection?.()
    ?? { state: 'resolved', meterDeviceId: null };
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
