import { normalizeError } from '../../utils/errorUtils';
import { getDebugEmitter } from '../../logging/logger';
import { updateHomePowerFromReport, type HomePowerSampleWithIdentity } from './resolvedHomeMeterDispatch';
import { fetchLivePowerReport } from './livePowerReport';
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import type { Logger } from '../../utils/types';
import type { DeviceTransportParseProviders } from './managerParseDevice';

const emitDeviceDebug = getDebugEmitter('devices', 'devices');

/**
 * Read Main and area meters from one report. Area fan-out shares the poll
 * source's generation/source authorization gate.
 */
export async function pollHomePowerWithMeterFanOut(
  logger: Logger,
  providers: DeviceTransportParseProviders,
  setGenerationW: (watts: number | null, observedAtMs: number) => void,
  selection: MainMeterSelection,
  authorizeFanOut?: () => boolean,
): Promise<HomePowerSampleWithIdentity | null> {
  const report = await fetchLivePowerReport(logger, providers, selection);
  const authorized = authorizeFanOut === undefined || authorizeFanOut();
  const onAdditionalMeterReadings = providers.onAdditionalMeterReadings;
  if (
    report.state === 'measured'
    && onAdditionalMeterReadings && authorized
    && Object.keys(report.additionalMeterPowerW).length > 0
  ) {
    try {
      onAdditionalMeterReadings(report.additionalMeterPowerW, Date.now());
    } catch (error) {
      emitDeviceDebug({
        event: 'additional_meter_readings_dispatch_failed',
        error: normalizeError(error).message,
      });
    }
  }
  return updateHomePowerFromReport(setGenerationW, report);
}
