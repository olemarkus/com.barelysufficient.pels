import type { MeterMonthlyPeakRead } from '../../ports/homeMeterReadings';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { getRawDevice } from './managerHomeyApi';
import { parseHomeyDevicePayload } from './homeyDevicePayload';

/** The identity every other device read gives a device (`applyDeviceDriverOverride`). */
type IdentifyDevice = (device: HomeyDeviceLike) => HomeyDeviceLike;

/**
 * The month peak a home's meter reports itself, as the integration its
 * identity picks reads it (`DeviceAdapter.meterMonthlyPeak`); a failed read or
 * a payload without a usable identity is `unavailable`, never no peak.
 */
export async function readMeterMonthlyPeak(meterId: string, identify: IdentifyDevice): Promise<MeterMonthlyPeakRead> {
    try {
        const parsed = parseHomeyDevicePayload(await getRawDevice(meterId));
        const device = parsed === null ? null : identify(parsed);
        return device === null ? { state: 'unavailable' } : getDeviceAdapter(device).meterMonthlyPeak(device);
    } catch {
        return { state: 'unavailable' };
    }
}
