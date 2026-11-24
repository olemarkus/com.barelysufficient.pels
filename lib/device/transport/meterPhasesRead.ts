import type { MainFusePhaseCapabilities } from '../../../packages/shared-domain/src/settings/mainFusePhaseSource';
import type { MeterPhasesRead } from '../../ports/homeMeterReadings';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { getRawDevice } from './managerHomeyApi';
import { parseHomeyDevicePayload } from './homeyDevicePayload';

/** The identity every other device read gives a device (`applyDeviceDriverOverride`). */
type IdentifyDevice = (device: HomeyDeviceLike) => HomeyDeviceLike;

/**
 * The meter's per-phase evidence, read through its integration so the
 * capability names and quantities are resolved together. A failed read or a
 * payload without a usable identity is unavailable.
 */
export async function readMeterPhases(
    meterDeviceId: string,
    ownerChoice: MainFusePhaseCapabilities | null,
    identify: IdentifyDevice,
    /** The same sample's poll read of this meter, when there is one: it is not fetched again. */
    polledRead?: HomeyDeviceLike,
): Promise<MeterPhasesRead> {
    try {
        const parsed = polledRead ?? parseHomeyDevicePayload(await getRawDevice(meterDeviceId));
        if (parsed === null) return { state: 'unavailable' };
        const device = identify(parsed);
        return getDeviceAdapter(device).meterPhases(device, ownerChoice);
    } catch {
        return { state: 'unavailable' };
    }
}
