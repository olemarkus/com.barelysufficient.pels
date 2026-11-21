import type { MeterMonthlyPeakRead } from '../../ports/homeMeterReadings';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { getRawDevice } from './managerHomeyApi';
import { parseHomeyDevicePayload } from './homeyDevicePayload';
import type { PolledMeterReads } from './polledMeterReads';

/** The identity every other device read gives a device (`applyDeviceDriverOverride`). */
type IdentifyDevice = (device: HomeyDeviceLike) => HomeyDeviceLike;

/**
 * The month peak a home's meter reports itself, as the integration its
 * identity picks reads it (`DeviceAdapter.meterMonthlyPeak`); a failed read or
 * a payload without a usable identity is `unavailable`, never no peak.
 */
export async function readMeterMonthlyPeak(
    meterId: string,
    identify: IdentifyDevice,
    /** The same sample's poll reads: a meter the poll just read is not fetched again. */
    polledMeters: PolledMeterReads,
): Promise<MeterMonthlyPeakRead> {
    try {
        const parsed = polledMeters.take('monthly_peak', meterId, Date.now())
            ?? parseHomeyDevicePayload(await getRawDevice(meterId));
        const device = parsed === null ? null : identify(parsed);
        return device === null ? { state: 'unavailable' } : getDeviceAdapter(device).meterMonthlyPeak(device);
    } catch {
        return { state: 'unavailable' };
    }
}
