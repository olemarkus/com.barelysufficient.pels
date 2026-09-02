import { normalizeError } from '../../utils/errorUtils';
import { updateHomePowerFromReport, type HomePowerSampleWithIdentity } from './resolvedHomeMeterDispatch';
import { fetchLivePowerReport } from './livePowerReport';
import type { TransportContext } from './transportContext';

/**
 * Read Main and area meters from one report. Area fan-out shares the poll
 * source's generation/source authorization gate.
 */
export async function pollHomePowerWithMeterFanOut(
  ctx: TransportContext,
  authorizeFanOut?: () => boolean,
): Promise<HomePowerSampleWithIdentity | null> {
  const selection = ctx.resolveMainMeterSelection();
  const report = await fetchLivePowerReport(ctx, selection);
  const authorized = authorizeFanOut === undefined || authorizeFanOut();
  const onAdditionalMeterReadings = ctx.providers.onAdditionalMeterReadings;
  if (
    report.state === 'measured'
    && onAdditionalMeterReadings && authorized
    && Object.keys(report.additionalMeterPowerW).length > 0
  ) {
    try {
      onAdditionalMeterReadings(report.additionalMeterPowerW, Date.now());
    } catch (error) {
      ctx.logger.debug({
        event: 'additional_meter_readings_dispatch_failed',
        error: normalizeError(error).message,
      });
    }
  }
  return updateHomePowerFromReport(ctx, report);
}
