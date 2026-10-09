/**
 * A malformed realtime temperature reading is retained as a rejection, and it
 * evicts a device with no other control facet. A whole-device `device.update`
 * may later re-admit that device; it must answer to the retained rejection by
 * the same rule a refresh does (`observationMerge.ts`): only a pair dated at or
 * after the rejection retires it.
 *
 * Every read Homey serves after the malformed report carries the malformed
 * value until the device reports again, and the read contract ignores such a
 * read outright. A conforming read carrying the pair from BEFORE the rejection
 * is therefore a race, and the cases below model its two forms: a
 * `device.update` frame delivered late or out of order, and a refresh whose
 * fetch was issued before the rejection and is merged after it.
 *
 * Driven through the real refresh: devices are served by `seedTransportDevices`,
 * frames arrive through the release-branch live-feed adapter below.
 */
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { DEVICES_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import Homey from 'homey';

/*
 * Release-branch adapter (3.11.x). On main this spec uses the shared live-feed
 * socket fake and `seedTransportDevices` from the test helpers; this base
 * predates that harness. The adapter keeps the contract the spec relies on: a
 * refresh is the transport's real refresh against a served device list, every
 * frame crosses a JSON wire (NaN arrives as null), a `device.update` always
 * reaches the transport, and a capability frame reaches only a device the last
 * committed refresh listed, as the feed subscribes, and throws otherwise.
 */
let feedTransport: DeviceTransport | null = null;
let subscribedDeviceIds = new Set<string>();

const onTheWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

const initWithLiveFeed = async (transport: DeviceTransport): Promise<void> => {
    feedTransport = transport;
    subscribedDeviceIds = new Set();
    await transport.init();
};

const seedTransportDevices = async (
    transport: DeviceTransport,
    devices: readonly HomeyDeviceLike[],
): Promise<void> => {
    const served = new Map(devices.map((device) => [device.id, device]));
    let serving = true;
    setRestClient({
        get: async (path) => {
            if (serving && path === DEVICES_API_PATH) return Object.fromEntries(served);
            const byId = serving && path.startsWith(`${DEVICES_API_PATH}/`) ? path.slice(DEVICES_API_PATH.length + 1) : null;
            if (byId !== null && !byId.includes('/')) {
                const device = served.get(byId);
                if (!device) throw new Error(`Mock API GET 404 for device: ${byId}`);
                return device;
            }
            return mockHomeyInstance.api.get(path);
        },
        put: (path, body) => mockHomeyInstance.api.put(path, body),
    });
    try {
        await transport.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' }, includeLivePower: false });
    } finally {
        serving = false;
    }
    subscribedDeviceIds = new Set(transport.getSnapshot().map((device) => device.id));
};

const emitDeviceUpdate = (device: HomeyDeviceLike): void => {
    if (feedTransport === null) throw new Error('No live feed; call initWithLiveFeed() first');
    feedTransport.injectDeviceUpdateForTest(onTheWire(device));
};

const emitCapability = async (deviceId: string, capabilityId: string, value: unknown): Promise<void> => {
    if (feedTransport === null || !subscribedDeviceIds.has(deviceId)) {
        throw new Error(`No live feed subscription for homey:device:${deviceId}`);
    }
    const frame = onTheWire({ capabilityId, value });
    feedTransport.injectCapabilityUpdateForTest(deviceId, frame.capabilityId, frame.value);
};

const DEVICE_ID = 'dev1';

/** Either member of the pair can carry the malformed reading that rejects it. */
const REJECTED_CAPABILITIES = [
    { rejectedCapabilityId: 'measure_temperature' },
    { rejectedCapabilityId: 'target_temperature' },
] as const;

type Reading = { value: number; at: string };
type TemperaturePair = { measured: Reading; target: Reading };

/** Both members of the pair dated together, as one report sets them. */
const pairAt = (measured: number, target: number, at: string): TemperaturePair => ({
    measured: { value: measured, at },
    target: { value: target, at },
});

const PRE_REJECTION_PAIR = pairAt(19, 20, '2026-04-01T11:59:00.000Z');
const REJECTED_AT = '2026-04-01T12:01:00.000Z';
const NEWER_PAIR = pairAt(21, 22, '2026-04-01T12:02:30.000Z');

const temperatureCapabilities = ({ measured, target }: TemperaturePair) => ({
    target_temperature: {
        value: target.value,
        id: 'target_temperature',
        units: '°C',
        min: 5,
        max: 40,
        step: 0.5,
        lastUpdated: target.at,
    },
    measure_temperature: {
        value: measured.value, id: 'measure_temperature', units: '°C', lastUpdated: measured.at,
    },
    measure_power: { value: 360, id: 'measure_power', lastUpdated: measured.at },
});

/** A thermostat with no binary or stepped control: its temperature pair is its only control facet. */
const temperatureOnlyDevice = (pair: TemperaturePair) => ({
    id: DEVICE_ID,
    name: 'Thermostat',
    class: 'thermostat',
    capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
    capabilitiesObj: temperatureCapabilities(pair),
});

/** The same thermostat with an `onoff` axis, which keeps it planned without its temperature facet. */
const binaryThermostat = (pair: TemperaturePair) => ({
    id: DEVICE_ID,
    name: 'Thermostat',
    class: 'thermostat',
    capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
    capabilitiesObj: {
        onoff: { value: true, id: 'onoff', lastUpdated: pair.measured.at },
        ...temperatureCapabilities(pair),
    },
});

/** Homey's read of the device after the malformed report, which the read contract ignores. */
const malformedRead = (pair: TemperaturePair, rejectedCapabilityId: string) => {
    const device = temperatureOnlyDevice(pair);
    return {
        ...device,
        capabilitiesObj: {
            ...device.capabilitiesObj,
            [rejectedCapabilityId]: { id: rejectedCapabilityId, value: null, lastUpdated: REJECTED_AT },
        },
    };
};

const snapshotEntry = (transport: DeviceTransport): TransportDeviceSnapshot | undefined => (
    transport.getSnapshotByDeviceId(DEVICE_ID)
);

const observedTemperature = (transport: DeviceTransport): { measured: number; target: number } | null => {
    const entry = snapshotEntry(transport);
    if (entry === undefined || !hasObservedTemperature(entry)) return null;
    return { measured: entry.temperature.currentTemperature, target: entry.temperature.target.value };
};

const buildTransportLogger = () => ({
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    structuredLog: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
});

/** Whether the live feed still delivers this device's capability frames. */
const isSubscribed = async (): Promise<boolean> => {
    // A null reading reaches nothing PELS keeps for a device out of the
    // snapshot, so the probe itself is a no-op when it is delivered.
    try {
        await emitCapability(DEVICE_ID, 'measure_temperature', null);
        return true;
    } catch {
        return false;
    }
};

describe('a retained temperature rejection across a device.update', () => {
    let logCapture: LoggerCapture;
    let transportLogger: ReturnType<typeof buildTransportLogger>;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        logCapture = captureLogger();
        transportLogger = buildTransportLogger();
    });

    const buildTransport = (): DeviceTransport => createTestDeviceTransport(
        mockHomeyInstance as unknown as Homey.App,
        transportLogger as unknown as Logger,
    );

    afterEach(() => {
        logCapture.restore();
        vi.useRealTimers();
    });

    /**
     * The device is seeded on the pre-rejection pair and rejected by a malformed
     * realtime reading. The next refresh serves Homey's read of the malformed
     * value, which the read contract ignores, so it commits without the device:
     * the live feed has dropped its subscription by the time a `device.update`
     * arrives.
     */
    const evictTemperatureOnlyDevice = async (rejectedCapabilityId: string): Promise<DeviceTransport> => {
        const transport = buildTransport();
        await initWithLiveFeed(transport);
        vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
        await seedTransportDevices(transport, [temperatureOnlyDevice(PRE_REJECTION_PAIR)]);
        expect(observedTemperature(transport)).toEqual({ measured: 19, target: 20 });

        vi.setSystemTime(new Date(REJECTED_AT));
        await emitCapability(DEVICE_ID, rejectedCapabilityId, Number.NaN);
        expect(snapshotEntry(transport)).toBeUndefined();

        vi.setSystemTime(new Date('2026-04-01T12:02:00.000Z'));
        await seedTransportDevices(transport, [malformedRead(PRE_REJECTION_PAIR, rejectedCapabilityId)]);
        expect(transportLogger.structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
            event: 'device_read_ignored', deviceId: DEVICE_ID, source: 'device_fetch',
        }));
        expect(snapshotEntry(transport)).toBeUndefined();
        expect(await isSubscribed()).toBe(false);
        return transport;
    };

    it.each(REJECTED_CAPABILITIES)(
        'keeps the device out on a late device.update carrying the pair a $rejectedCapabilityId rejection superseded',
        async ({ rejectedCapabilityId }) => {
            const transport = await evictTemperatureOnlyDevice(rejectedCapabilityId);

            // A frame Homey sent before the malformed report, delivered after it.
            vi.setSystemTime(new Date('2026-04-01T12:03:00.000Z'));
            emitDeviceUpdate(temperatureOnlyDevice(PRE_REJECTION_PAIR));
            expect(snapshotEntry(transport)).toBeUndefined();
            expect(logCapture.findEvents('device_update_preserved_newer')).toEqual([
                expect.objectContaining({
                    deviceId: DEVICE_ID,
                    capabilityId: rejectedCapabilityId,
                    source: 'realtime_capability',
                    observedAtMs: Date.parse(REJECTED_AT),
                    fetchedLastUpdatedMs: Date.parse(PRE_REJECTION_PAIR.measured.at),
                }),
            ]);

            // A refresh whose fetch was issued before the rejection, merged now:
            // the rejection still stands, so it keeps the device out too.
            vi.setSystemTime(new Date('2026-04-01T12:04:00.000Z'));
            await seedTransportDevices(transport, [temperatureOnlyDevice(PRE_REJECTION_PAIR)]);
            expect(snapshotEntry(transport)).toBeUndefined();
            expect(await isSubscribed()).toBe(false);
        },
    );

    it.each(REJECTED_CAPABILITIES)(
        're-admits the device on a device.update dated after a $rejectedCapabilityId rejection, '
            + 'and an in-flight pre-rejection fetch keeps it',
        async ({ rejectedCapabilityId }) => {
            const transport = await evictTemperatureOnlyDevice(rejectedCapabilityId);

            vi.setSystemTime(new Date('2026-04-01T12:03:00.000Z'));
            emitDeviceUpdate(temperatureOnlyDevice(NEWER_PAIR));
            expect(observedTemperature(transport)).toEqual({ measured: 21, target: 22 });

            // A refresh whose fetch was issued before the rejection, merged now.
            // The newer pair retired the rejection and is itself retained, so
            // that fetch neither evicts the device nor rolls its reading back.
            vi.setSystemTime(new Date('2026-04-01T12:04:00.000Z'));
            await seedTransportDevices(transport, [temperatureOnlyDevice(PRE_REJECTION_PAIR)]);
            expect(observedTemperature(transport)).toEqual({ measured: 21, target: 22 });

            // Committed back in, the device is subscribed again and hears realtime readings.
            await emitCapability(DEVICE_ID, 'measure_temperature', 21.5);
            expect(observedTemperature(transport)).toEqual({ measured: 21.5, target: 22 });
        },
    );

    it('retains each member of a re-admitted pair only where nothing newer is already held', async () => {
        const transport = buildTransport();
        await initWithLiveFeed(transport);
        vi.setSystemTime(new Date('2026-04-01T11:59:30.000Z'));
        await seedTransportDevices(transport, [temperatureOnlyDevice(PRE_REJECTION_PAIR)]);

        vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
        await emitCapability(DEVICE_ID, 'measure_temperature', 21);
        vi.setSystemTime(new Date(REJECTED_AT));
        await emitCapability(DEVICE_ID, 'target_temperature', Number.NaN);
        expect(snapshotEntry(transport)).toBeUndefined();

        // The members carry their own stamps: the target is newer than the
        // rejection and retires it, the measurement is older than the 21 PELS
        // accepted at 12:00 and must not replace it.
        vi.setSystemTime(new Date('2026-04-01T12:03:00.000Z'));
        emitDeviceUpdate(temperatureOnlyDevice({
            measured: { value: 19, at: '2026-04-01T11:59:00.000Z' },
            target: { value: 22, at: '2026-04-01T12:02:00.000Z' },
        }));
        expect(observedTemperature(transport)).not.toBeNull();

        // A refresh whose fetch was issued before the rejection, merged now.
        vi.setSystemTime(new Date('2026-04-01T12:04:00.000Z'));
        await seedTransportDevices(transport, [temperatureOnlyDevice(PRE_REJECTION_PAIR)]);
        expect(observedTemperature(transport)).toEqual({ measured: 21, target: 22 });
    });

    // The binary axis keeps this device planned through the rejection. A stale
    // pair must still not bring back the temperature facet the rejection removed,
    // nor overwrite the rejection; a newer one does.
    it('keeps a stale temperature facet off a device that stays planned on its binary axis', async () => {
        const transport = buildTransport();
        await initWithLiveFeed(transport);
        vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
        await seedTransportDevices(transport, [binaryThermostat(PRE_REJECTION_PAIR)]);
        expect(observedTemperature(transport)).toEqual({ measured: 19, target: 20 });

        vi.setSystemTime(new Date(REJECTED_AT));
        await emitCapability(DEVICE_ID, 'measure_temperature', Number.NaN);
        expect(snapshotEntry(transport)).toBeDefined();
        expect(observedTemperature(transport)).toBeNull();

        // A frame Homey sent before the malformed report, delivered after it.
        vi.setSystemTime(new Date('2026-04-01T12:03:00.000Z'));
        emitDeviceUpdate(binaryThermostat(PRE_REJECTION_PAIR));
        expect(snapshotEntry(transport)).toBeDefined();
        expect(observedTemperature(transport)).toBeNull();

        // A refresh whose fetch was issued before the rejection, merged now.
        vi.setSystemTime(new Date('2026-04-01T12:04:00.000Z'));
        await seedTransportDevices(transport, [binaryThermostat(PRE_REJECTION_PAIR)]);
        expect(observedTemperature(transport)).toBeNull();

        vi.setSystemTime(new Date('2026-04-01T12:05:00.000Z'));
        emitDeviceUpdate(binaryThermostat(NEWER_PAIR));
        expect(observedTemperature(transport)).toEqual({ measured: 21, target: 22 });
    });

    it('keeps a pair restored on a binary-axis device at the time Homey dated it, not its delivery time', async () => {
        const transport = buildTransport();
        await initWithLiveFeed(transport);
        vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
        await seedTransportDevices(transport, [binaryThermostat(PRE_REJECTION_PAIR)]);

        vi.setSystemTime(new Date(REJECTED_AT));
        await emitCapability(DEVICE_ID, 'measure_temperature', Number.NaN);
        expect(observedTemperature(transport)).toBeNull();

        // The pair Homey dated 12:02:30, in a frame delivered at 12:05.
        vi.setSystemTime(new Date('2026-04-01T12:05:00.000Z'));
        emitDeviceUpdate(binaryThermostat(NEWER_PAIR));
        expect(observedTemperature(transport)).toEqual({ measured: 21, target: 22 });

        // A refresh reading Homey dated 12:04, after the pair but before its
        // delivery, is the newer evidence and wins.
        vi.setSystemTime(new Date('2026-04-01T12:06:00.000Z'));
        await seedTransportDevices(transport, [binaryThermostat(pairAt(23, 24, '2026-04-01T12:04:00.000Z'))]);
        expect(observedTemperature(transport)).toEqual({ measured: 23, target: 24 });
    });
});
