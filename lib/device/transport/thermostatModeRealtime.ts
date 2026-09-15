/**
 * A realtime `thermostat_mode` event: a reversible unit switching between
 * heating and cooling while the live feed is connected.
 *
 * The event is the only way a mode change reaches PELS between full reads when
 * the driver publishes capabilities one by one, so dropping it (as the generic
 * tracked-capability filter did) left the snapshot on the old mode and every
 * plan shifted and limited that device the wrong way until the next refresh.
 *
 * Handled apart from the reconcile path on purpose. A mode is not a control
 * target PELS writes, so there is no echo to suppress, and it is not freshness
 * evidence: a device can sit in `cool` for a season without saying anything, so
 * the event bumps no per-capability freshness (`getObservedCapabilityIds` in
 * `managerRuntime.ts` leaves it out for the same reason). It is still a
 * control-relevant change, published as a fact the same way the `device.update`
 * path publishes it.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import { getLogger } from '../../logging/logger';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TransportContext } from './transportContext';

export const THERMOSTAT_MODE_CAPABILITY_ID = 'thermostat_mode';

const moduleLogger = getLogger('device/transport');

/**
 * Whether a reported mode value says anything: a string with content. Anything
 * else leaves the held mode standing.
 */
export function isReportedThermostatMode(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The device's reported mode as PELS keeps it: trimmed and lower-cased.
 * Reported, not interpreted: turning it into a direction is the observer's
 * (`resolveThermalDirection`).
 */
export function normalizeReportedThermostatMode(value: string): string {
    return value.trim().toLowerCase();
}

/** True when the event was a mode event, whether or not it changed anything. */
export function handleThermostatModeCapabilityUpdate(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    if (capabilityId !== THERMOSTAT_MODE_CAPABILITY_ID) return false;
    // A device that does not declare a mode axis has no mode to update.
    if (snapshot.capabilities?.includes(THERMOSTAT_MODE_CAPABILITY_ID) !== true) return true;
    if (!isReportedThermostatMode(value)) return true;
    const mode = normalizeReportedThermostatMode(value);
    if (mode === snapshot.thermostatMode) return true;
    const change = {
        capabilityId,
        previousValue: snapshot.thermostatMode ?? 'absent',
        nextValue: mode,
    };
    const mutableSnapshot = snapshot;
    mutableSnapshot.thermostatMode = mode;
    moduleLogger.info({
        event: 'realtime_capability_drift',
        deviceId: snapshot.id,
        capabilityId,
        changes: [change],
    });
    const cursor = ctx.nextObservationCursor(snapshot.id);
    ctx.dispatchObservedStateChanged({
        source: 'realtime_capability',
        deviceId: snapshot.id,
        ...cursor,
        capabilityId,
    });
    ctx.dispatchObservedControlStateChanged({
        deviceId: snapshot.id,
        ...cursor,
        name: snapshot.name,
        changes: [change],
    });
    return true;
}
