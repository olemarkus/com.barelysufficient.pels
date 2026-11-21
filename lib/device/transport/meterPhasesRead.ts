import type { MainFusePhaseCapabilities } from '../../../packages/shared-domain/src/settings/mainFusePhaseSource';
import type { MeterPhasesRead } from '../../ports/homeMeterReadings';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { resolveMeterPhases } from '../meterPhases';
import { getRawDevice } from './managerHomeyApi';
import { parseHomeyDevicePayload } from './homeyDevicePayload';

/** The identity every other device read gives a device (`applyDeviceDriverOverride`). */
type IdentifyDevice = (device: HomeyDeviceLike) => HomeyDeviceLike;

/**
 * The meter's per-phase capabilities, read from the view its integration gives
 * it (`DeviceAdapter.projectRead`), so a meter app that keeps its phases under
 * its own capability names is read under the standard ones. A failed read or a
 * payload without a usable identity is `unavailable`, never no phases.
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
        const [view] = getDeviceAdapter(device).projectRead(device);
        return view === undefined ? { state: 'unavailable' } : resolveMeterPhases(view, ownerChoice);
    } catch {
        return { state: 'unavailable' };
    }
}
