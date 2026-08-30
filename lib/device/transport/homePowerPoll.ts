import { normalizeError } from '../../utils/errorUtils';
import { updateHomePowerFromReport, type HomePowerSampleWithIdentity } from './resolvedHomeMeterDispatch';
import { fetchLivePowerReport } from './livePowerReport';
import type { TransportContext } from './transportContext';

export type PolledHomePowerSample = HomePowerSampleWithIdentity & {
  /** Automatic candidate retained only after the power pipeline admits this sample. */
  automaticHomeMeterDeviceId: string | null;
};

/**
 * Read Main and area meters from one report. Area fan-out and Automatic meter
 * retention share the poll source's generation/source authorization gate.
 */
export async function pollHomePowerWithMeterFanOut(
  ctx: TransportContext,
  authorizeFanOut?: () => boolean,
): Promise<PolledHomePowerSample | null> {
  const selection = ctx.resolveMainMeterSelection();
  const report = await fetchLivePowerReport(ctx, selection);
  const authorized = authorizeFanOut === undefined || authorizeFanOut();
  const onAdditionalMeterReadings = ctx.providers.onAdditionalMeterReadings;
  if (onAdditionalMeterReadings && authorized && Object.keys(report.additionalMeterPowerW).length > 0) {
    try {
      onAdditionalMeterReadings(report.additionalMeterPowerW, Date.now());
    } catch (error) {
      ctx.logger.debug({
        event: 'additional_meter_readings_dispatch_failed',
        error: normalizeError(error).message,
      });
    }
  }
  const sample = updateHomePowerFromReport(ctx, report);
  if (sample === null) return null;
  return {
    ...sample,
    automaticHomeMeterDeviceId: selection.state === 'resolved'
      && selection.meterDeviceId === null
      && report.homeMeterResolution === 'resolved'
      ? report.resolvedHomeMeterDeviceId
      : null,
  };
}
