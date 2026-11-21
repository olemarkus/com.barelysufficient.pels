import type { MeterImportCounter } from '../../ports/homeMeterReadings';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDebugEmitter } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import { resolveHomeyHttpStatusCode } from '../../utils/homeyHttpStatusError';
import { toCapabilityTimestampMs } from '../managerControl';
import { getRawDevice } from './managerHomeyApi';
import { parseHomeyDevicePayload } from './homeyDevicePayload';

const emitDeviceDebug = getDebugEmitter('devices', 'devices');

/** Homey's capability for a meter's cumulative grid import, in kWh. */
const IMPORT_COUNTER_CAPABILITY = 'meter_power.imported';

/**
 * The meter's import counter as its device payload holds it: finite, not
 * negative, and dated by Homey. A meter without the capability, and a value
 * that fails, both read as no counter: the consumer keeps the one it last
 * accepted, never a zero.
 */
export function resolveMeterImportCounter(device: HomeyDeviceLike): MeterImportCounter | null {
    const entry = device.capabilitiesObj?.[IMPORT_COUNTER_CAPABILITY];
    const value: unknown = entry?.value;
    const observedAtMs = toCapabilityTimestampMs(entry?.lastUpdated);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || observedAtMs === undefined) return null;
    return { meterDeviceId: device.id, importedKWh: value, observedAtMs };
}

/**
 * The requested meters' import counters, from devices already fetched; a
 * meter not among them, or without one, is not a key.
 */
export function resolveMeterImportCounters(
    devices: readonly HomeyDeviceLike[],
    meterDeviceIds: readonly string[],
): Record<string, MeterImportCounter> {
    return Object.fromEntries(devices.flatMap((device) => {
        if (!meterDeviceIds.includes(device.id)) return [];
        const counter = resolveMeterImportCounter(device);
        return counter === null ? [] : [[counter.meterDeviceId, counter] as const];
    }));
}

/**
 * The counter rides the whole-home power sample, so its read never holds one
 * back for long: a meter device that has not answered by then gives no counter
 * for this sample.
 */
const IMPORT_COUNTER_READ_DEADLINE_MS = 2_000;

type PolledMeterDeviceRead = { counter: MeterImportCounter | null; device: HomeyDeviceLike } | 'removed' | null;

async function readPolledMeterDevice(meterDeviceId: string): Promise<PolledMeterDeviceRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            emitDeviceDebug({ event: 'meter_import_counter_read_slow', meterDeviceId });
            resolve(null);
        }, IMPORT_COUNTER_READ_DEADLINE_MS);
    });
    const read = getRawDevice(meterDeviceId).then((raw): PolledMeterDeviceRead => {
        const device = parseHomeyDevicePayload(raw);
        return device === null ? null : { counter: resolveMeterImportCounter(device), device };
    }).catch((error: unknown) => {
        if (resolveHomeyHttpStatusCode(error) === 404) return 'removed' as const;
        emitDeviceDebug({
            event: 'meter_import_counter_read_failed', meterDeviceId, error: normalizeError(error).message,
        });
        return null;
    });
    try {
        return await Promise.race([read, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Use the same targeted device reads for import counters and deletion
 * evidence. A timeout, malformed payload or device without a counter
 * contributes neither. Only a device lookup's 404 proves absence.
 */
export async function readPolledMeterDevices(meterDeviceIds: readonly string[]) {
    const reads = await Promise.all(meterDeviceIds.map(async (id) => ({
        id, result: await readPolledMeterDevice(id),
    })));
    return {
        importCounters: Object.fromEntries(reads.flatMap(({ result }) => (
            result === null || result === 'removed' || result.counter === null
                ? [] : [[result.counter.meterDeviceId, result.counter] as const]
        ))),
        removedMeterDeviceIds: reads.flatMap(({ id, result }) => result === 'removed' ? [id] : []),
        /** The meter payloads read, for the readers that follow the same sample. */
        devices: reads.flatMap(({ result }) => (result === null || result === 'removed' ? [] : [result.device])),
    };
}
