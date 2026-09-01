import type { Mock } from 'vitest';
import { DeviceTransport, PLAN_LIVE_STATE_OBSERVED_EVENT, OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT } from '../../lib/device/deviceTransport';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import {
    createObservationState,
    mergeFresherCapabilityObservations,
} from '../../lib/device/transport/managerObservation';
import type { LiveFeedHealth } from '../../lib/device/liveFeed';
import type { EvObservedProbe, MeasuredPowerObservedProbe, StateOfChargeObservedProbe, TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { isManagedFilterActive } from '../../setup/appDeviceSupport';
import {
    mockHomeyInstance,
} from '../mocks/homey';
import Homey from 'homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

// Mock the live feed so tests don't attempt a real socket.io connection.
vi.mock('../../lib/device/liveFeed', () => {
    const mockHealth: LiveFeedHealth = {
        subscriptionState: 'subscribed',
        lastLiveEventMs: null,
        liveEventCount: 0,
        ignoredLiveEventCount: 0,
        reconnectCount: 0,
        lastReconnectMs: null,
        lastSuccessfulSubscriptionMs: null,
    };
    return {
        createDeviceLiveFeed: vi.fn(() => ({
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            isHealthy: vi.fn().mockReturnValue(true),
            getHealth: vi.fn().mockReturnValue(mockHealth),
            updateTrackedDevices: vi.fn(),
        })),
    };
});

const mockApiGet = vi.fn();
const mockApiPut = vi.fn().mockResolvedValue(undefined);
const mockGetLiveReport = vi.fn();

const findSnapshotDevice = <T extends { id: string }>(
    snapshot: T[],
    deviceId: string,
): T | undefined => {
    for (const device of snapshot) {
        if (device.id === deviceId) return device;
    }
    return undefined;
};

const buildRealtimeDevices = () => ({
    dev1: {
        id: 'dev1',
        name: 'Heater',
        capabilities: ['measure_power', 'onoff'],
        class: 'heater',
        capabilitiesObj: {
            measure_power: { value: 1000, id: 'measure_power' },
        },
    },
});

// Shared fixtures for the transient-empty-read abandon-grace tests. Kept at
// module scope so the assertions stay flat (no extra describe/callback nesting).
const GRACE_POPULATED_PAYLOAD = {
    dev1: {
        id: 'dev1', name: 'Heater', class: 'heater',
        capabilities: ['measure_power', 'onoff'],
        capabilitiesObj: {
            measure_power: { value: 1000, id: 'measure_power' },
            onoff: { value: true, id: 'onoff' },
        },
    },
};

const snapshotDeviceId = (device: { id: string }): string => device.id;

async function populateSnapshotForGrace(transport: DeviceTransport): Promise<void> {
    await transport.init();
    mockApiGet.mockResolvedValue(GRACE_POPULATED_PAYLOAD);
    await transport.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
    expect(transport.getSnapshot()).toHaveLength(1);
}

describe('DeviceTransport', () => {
    let deviceManager: DeviceTransport;
    let homeyMock: Homey.App;
    let loggerMock: Logger & {
        log: Mock;
        debug: Mock;
        error: Mock;
        structuredLog: Logger['structuredLog'] & { info: Mock; error: Mock; debug: Mock; warn: Mock };
    };
    let debugStructuredMock: Mock;

    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetLiveReport.mockResolvedValue({ items: [] });
        homeyMock = mockHomeyInstance as unknown as Homey.App;

        // Wire mock API functions via spyOn so restoreAllMocks cleans up.
        const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
        mockApiGet.mockImplementation(async (path: string) => originalGet(path));
        vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(mockApiGet);
        vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(mockApiPut);
        vi.spyOn(homeyApi, 'getEnergyLiveReport').mockImplementation(() => mockGetLiveReport());

        loggerMock = {
            log: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            structuredLog: {
                info: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
                warn: vi.fn(),
            } as unknown as Logger['structuredLog'] & { info: Mock; error: Mock; debug: Mock; warn: Mock },
        };
        debugStructuredMock = vi.fn();
        deviceManager = new DeviceTransport(
            homeyMock,
            loggerMock,
            undefined,
            undefined,
            { debugStructured: debugStructuredMock },
        );
    });

    describe('init', () => {
        it('marks SDK ready and logs initialization when checks pass', async () => {
            await deviceManager.init();
            expect(loggerMock.structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
                component: 'devices',
                event: 'device_api_initialized',
            }));
        });

        it('skips initialization if api is missing', async () => {
            const savedApi = (homeyMock as { api?: unknown }).api;
            (homeyMock as { api?: unknown }).api = undefined;
            deviceManager = new DeviceTransport(homeyMock, loggerMock);
            await deviceManager.init();
            expect(loggerMock.log).not.toHaveBeenCalledWith(expect.stringContaining('initialized'));
            expect(loggerMock.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'sdk_api_unavailable_skipping_init' }));
            expect(loggerMock.structuredLog.info).toHaveBeenCalledTimes(1);
            expect(loggerMock.structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
                component: 'devices',
                event: 'device_api_init_skipped',
                reasonCode: 'sdk_api_missing',
                realtimeListenerAttached: false,
            }));
            (homeyMock as { api?: unknown }).api = savedApi;
        });
    });

    describe('parseDeviceListForTests', () => {
        it('materializes the representative thermostat snapshot shape unchanged', () => {
            const parsingDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getControllable: (deviceId) => deviceId === 'thermo-1',
                getManaged: (deviceId) => deviceId === 'thermo-1',
                getBudgetExempt: (deviceId) => deviceId === 'thermo-1',
                getCommunicationModel: (deviceId) => (deviceId === 'thermo-1' ? 'cloud' : 'local'),
            });

            const [parsed] = parsingDeviceManager.parseDeviceListForTests([{
                id: 'thermo-1',
                name: 'Hall Thermostat',
                class: 'thermostat',
                zoneName: 'Hallway',
                capabilities: [
                    'onoff',
                    'measure_temperature',
                    'target_temperature',
                    'measure_power',
                ],
                capabilitiesObj: {
                    onoff: { value: false, id: 'onoff', lastUpdated: '2026-04-01T11:50:00.000Z', setable: true },
                    measure_temperature: {
                        value: 19.5,
                        id: 'measure_temperature',
                        units: '°C',
                        lastUpdated: '2026-04-01T11:52:00.000Z',
                    },
                    target_temperature: {
                        value: 21,
                        id: 'target_temperature',
                        units: '°C',
                        min: 5,
                        max: 30,
                        step: 0.5,
                        lastUpdated: '2026-04-01T11:51:00.000Z',
                    },
                    measure_power: {
                        value: 730,
                        id: 'measure_power',
                        lastUpdated: '2026-04-01T11:53:00.000Z',
                    },
                },
                settings: { load: 900 },
                available: false,
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'thermo-1',
                name: 'Hall Thermostat',
                zone: 'Hallway',
                deviceClass: 'thermostat',
                deviceType: 'temperature',
                communicationModel: 'cloud',
                controllable: true,
                managed: true,
                budgetExempt: true,
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
                temperature: {
                    currentTemperature: 19.5,
                    target: {
                        id: 'target_temperature',
                        value: 21,
                        unit: '°C',
                        min: 5,
                        max: 30,
                        step: 0.5,
                    },
                },
                canSetControl: true,
                available: false,
                powerCapable: true,
                expectedPowerKw: 0.9,
                measuredPowerKw: 0.73,
                expectedPowerSource: 'load-setting',
                lastFreshDataMs: new Date('2026-04-01T11:53:00.000Z').getTime(),
                lastUpdated: new Date('2026-04-01T11:53:00.000Z').getTime(),
                lastLocalWriteMs: undefined,
            }));
            expect(parsed.targets).toEqual([{
                id: 'target_temperature',
                value: 21,
                unit: '°C',
                min: 5,
                max: 30,
                step: 0.5,
            }]);
            expect(parsed.capabilities).toEqual([
                'onoff',
                'measure_temperature',
                'target_temperature',
                'measure_power',
            ]);
        });

        it.each([
            { label: 'omitted', availability: {} },
            { label: 'non-boolean', availability: { available: 'unexpected' as never } },
        ])('resolves $label SDK availability to true at the parser boundary', ({ availability }) => {
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'availability-boundary',
                name: 'Availability Boundary',
                class: 'thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 22, id: 'target_temperature', units: '°C' },
                },
                ...availability,
            }]);

            expect(parsed.available).toBe(true);
        });

        it('drops devices with invalid onoff telemetry when no previous observation can be preserved', () => {
            const parsed = deviceManager.parseDeviceListForTests([{
                id: 'thermo-2',
                name: 'Bedroom Thermostat',
                class: 'thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    onoff: { value: 'unexpected' as unknown as boolean, id: 'onoff' },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 22, id: 'target_temperature', units: '°C' },
                },
            }]);

            expect(parsed).toEqual([]);
            expect(loggerMock.structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_control_state_dropped',
                reasonCode: 'missing_boolean_onoff',
                source: 'snapshot_parse',
                deviceId: 'thermo-2',
                deviceName: 'Bedroom Thermostat',
                capabilityId: 'onoff',
                rawValue: 'unexpected',
                rawValueType: 'string',
            }));
            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_control_state_fallback',
                reasonCode: 'missing_boolean_onoff',
                deviceId: 'thermo-2',
                deviceName: 'Bedroom Thermostat',
                capabilityId: 'onoff',
                rawValue: 'unexpected',
                rawValueType: 'string',
                fallbackCurrentOn: undefined,
            }));
        });

        it('does not create binary settlement evidence from an invalid Date lastUpdated', () => {
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'thermo-invalid-date',
                name: 'Invalid Date Thermostat',
                class: 'thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    onoff: { value: false, id: 'onoff', lastUpdated: new Date('bad timestamp') },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 22, id: 'target_temperature', units: '°C' },
                },
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'thermo-invalid-date',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: undefined,
            }));
        });

        it('reads the plain power capability and ignores dotted sub-capabilities', () => {
            // Modelled on a real device: the Hoiax Connected 300 ships
            // `measure_power` AND `measure_power.leak` / `meter_power.in_tank`,
            // and the Easee charger and Frient HAN do the same. The dotted ones
            // are separate channels (a leak sensor, an export register) and must
            // never be mistaken for the device's own draw.
            //
            // Previously this fixture had ONLY the dotted capability plus a
            // `settings.load`, to exercise the `loadKw` branch of the gate. No
            // such device exists: across a 124-device fleet every device with a
            // dotted power sub-capability also exposes the plain one, and every
            // device with `settings.load` exposes `measure_power` and
            // `meter_power`. The invented shape was the sole evidence for a gate
            // term that admitted nobody.
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'socket-subcap',
                name: 'Socket With Internal Power',
                class: 'socket',
                capabilities: ['onoff', 'measure_power', 'measure_power.leak'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_power: {
                        value: 730,
                        id: 'measure_power',
                        lastUpdated: '2026-04-01T11:53:00.000Z',
                    },
                    'measure_power.leak': {
                        value: 4200,
                        id: 'measure_power.leak',
                        lastUpdated: '2026-04-01T11:53:00.000Z',
                    },
                },
                settings: { load: 900 },
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'socket-subcap',
                powerCapable: true,
                // 0.73 kW from `measure_power`, NOT 4.2 kW from the leak channel.
                measuredPowerKw: 0.73,
                expectedPowerSource: 'load-setting',
                expectedPowerKw: 0.9,
            }));
        });

        it('drops only the temperature facet when a binary device reports a malformed target', () => {
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'thermo-invalid-target',
                name: 'Broken Thermostat',
                class: 'thermostat',
                capabilities: ['measure_temperature', 'target_temperature', 'onoff'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: '21' as unknown as number, id: 'target_temperature', units: '°C', min: 5, max: 35, step: 0.5 },
                },
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'thermo-invalid-target',
                deviceType: 'onoff',
                targets: [],
                binaryControl: { on: true },
            }));
            expect(hasObservedTemperature(parsed)).toBe(false);
            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'target_capability_value_malformed',
                deviceId: 'thermo-invalid-target',
                deviceName: 'Broken Thermostat (thermo-invalid-target)',
                capabilityId: 'target_temperature',
                rawValue: '21',
            }));
        });

        it('keeps the binary facet when exact temperature measurement support is missing', () => {
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'bad-thermo',
                name: 'Broken Thermostat',
                class: 'thermostat',
                capabilities: ['onoff', 'target_temperature'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                },
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'bad-thermo',
                deviceType: 'onoff',
                targets: [],
                binaryControl: { on: true },
            }));
            expect(hasObservedTemperature(parsed)).toBe(false);
        });

        it('drops a temperature-only device when either member of the pair is malformed', () => {
            const parsed = deviceManager.parseDeviceListForTests([{
                id: 'temp-only-broken',
                name: 'Broken Tank',
                class: 'thermostat',
                capabilities: ['measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    measure_temperature: { value: Number.NaN, id: 'measure_temperature' },
                    target_temperature: { value: 60, id: 'target_temperature', units: '°C' },
                },
            }]);

            expect(parsed).toEqual([]);
        });

        // Regression: the driver-id override used to be applied three times along
        // the snapshot pipeline (refreshSnapshot, the private parseDeviceList
        // wrapper, and resolveParseDeviceIdentity). Each lookup invoked
        // getDeviceDriverIdOverride. After the dedup, the override resolves once
        // per device per pipeline call so the provider callback is invoked exactly
        // once per device end-to-end.
        it('invokes getDeviceDriverIdOverride exactly once per device for parseDeviceListForTests', () => {
            const getDeviceDriverIdOverride = vi.fn((deviceId: string) => (
                deviceId === 'dev-a' ? 'homey:app:com.zaptec:go2' : undefined
            ));
            const parsingDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getDeviceDriverIdOverride,
            });

            parsingDeviceManager.parseDeviceListForTests([
                {
                    id: 'dev-a',
                    name: 'Mock A',
                    class: 'socket',
                    driverId: 'homey:app:com.example:mock',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 50, id: 'measure_power' },
                    },
                },
                {
                    id: 'dev-b',
                    name: 'Mock B',
                    class: 'socket',
                    driverId: 'homey:app:com.example:mock',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 80, id: 'measure_power' },
                    },
                },
            ]);

            expect(getDeviceDriverIdOverride).toHaveBeenCalledTimes(2);
            expect(getDeviceDriverIdOverride).toHaveBeenCalledWith('dev-a');
            expect(getDeviceDriverIdOverride).toHaveBeenCalledWith('dev-b');
        });
    });

    describe('runtime managed filter', () => {
        const buildDevice = (id: string, capValue: unknown) => ({
            id,
            name: id,
            class: 'heater',
            capabilities: ['measure_power', 'onoff'],
            capabilitiesObj: {
                measure_power: { value: 1000, id: 'measure_power' },
                onoff: { value: capValue, id: 'onoff' },
            },
        });

        it('drops unmanaged devices from the runtime snapshot when at least one device is explicitly managed', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const ids = dm.getSnapshot().map((d) => d.id);
            expect(ids).toEqual(['dev1']);
            dm.destroy();
        });

        it('keeps unmanaged devices in the runtime snapshot when no device is explicitly managed (fresh-install)', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: () => false,
                isManagedFilterActive: () => false,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const ids = dm.getSnapshot().map((d) => d.id);
            expect(ids.sort()).toEqual(['dev1', 'dev2']);
            dm.destroy();
        });

        it('does not emit device_snapshot_control_state_dropped errors for unmanaged devices with malformed onoff', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                badDev: buildDevice('badDev', null),
            });
            loggerMock.structuredLog.error.mockClear();
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const dropEvents = loggerMock.structuredLog.error.mock.calls
                .filter((call: unknown[]) => (call[0] as { event?: string })?.event === 'device_snapshot_control_state_dropped');
            expect(dropEvents).toEqual([]);
            dm.destroy();
        });
    });

    describe('getUiPickerDevices', () => {
        const buildDevice = (id: string, capValue: unknown) => ({
            id,
            name: id,
            class: 'heater',
            capabilities: ['measure_power', 'onoff'],
            capabilitiesObj: {
                measure_power: { value: 1000, id: 'measure_power' },
                onoff: { value: capValue, id: 'onoff' },
            },
        });

        it('returns only unmanaged-eligible devices and tolerates malformed onoff without an error log', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
                badDev: buildDevice('badDev', null),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            loggerMock.structuredLog.error.mockClear();
            const picker = dm.getUiPickerDevices();
            const ids = picker.map((d) => d.id).sort();
            expect(ids).toEqual(['badDev', 'dev2']);
            const dropEvents = loggerMock.structuredLog.error.mock.calls
                .filter((call: unknown[]) => (call[0] as { event?: string })?.event === 'device_snapshot_control_state_dropped');
            expect(dropEvents).toEqual([]);
            dm.destroy();
        });

        it('keeps unmanaged-eligible devices visible after a targeted refresh that fetches managed-only ids', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);

            // A genuine targeted refresh re-reads only the managed id (dev1) via the
            // by-id path; it does NOT touch the raw-device cache, so the
            // unmanaged-eligible dev2 stays visible in the picker.
            const byIdPath = 'manager/devices/device/dev1';
            mockApiGet.mockImplementation(async (path: string) => {
                if (path === byIdPath) return buildDevice('dev1', false);
                throw new Error(`unexpected full fetch: ${path}`);
            });
            await dm.refreshSnapshot({ targetedRefresh: true, mainMeterSelection: { state: 'unavailable' } });

            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);
            dm.destroy();
        });

        it('refreshes the raw-device cache when a targeted refresh falls back to full (UI picker not stale)', async () => {
            // Regression: when every by-id read fails, the targeted refresh falls
            // back to a FULL read. `latestRawDevices` (the UI-picker source) must be
            // refreshed from that full read, keyed off the resolved fetchSource —
            // not gated on the originally-requested targeted flag.
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            const fullPath = 'manager/devices/device';
            // Initial full read: only dev1 (managed) + dev2 (unmanaged-eligible).
            mockApiGet.mockImplementation(async (path: string) => {
                if (path === fullPath) {
                    return { dev1: buildDevice('dev1', true), dev2: buildDevice('dev2', true) };
                }
                throw new Error(`404 ${path}`); // by-id reads fail
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);

            // The full read now GROWS to include dev3 (also unmanaged-eligible). A
            // targeted refresh whose by-id reads all fail → full fallback. The
            // picker must reflect the grown set, not the pre-failure list.
            mockApiGet.mockImplementation(async (path: string) => {
                if (path === fullPath) {
                    return {
                        dev1: buildDevice('dev1', true),
                        dev2: buildDevice('dev2', true),
                        dev3: buildDevice('dev3', true),
                    };
                }
                throw new Error(`404 ${path}`);
            });
            await dm.refreshSnapshot({ targetedRefresh: true, mainMeterSelection: { state: 'unavailable' } });

            expect(dm.getUiPickerDevices().map((d) => d.id).sort()).toEqual(['dev2', 'dev3']);
            dm.destroy();
        });

        it('does not empty the picker on a single transient empty SDK read', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);

            // A transient empty read is deferred by abandon-grace: the raw-device
            // cache backing the picker must survive the blip, not collapse to [].
            mockApiGet.mockResolvedValue({});
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);
            dm.destroy();
        });

        it('treats an all-false managedDevices map as filter-inactive so implicit-managed devices stay visible', async () => {
            // Regression: when `disableUnsupportedDevices` writes `{id: false}`
            // entries on first boot, the filter must NOT activate from those
            // writes alone. Otherwise any device that had no key in the map
            // (implicitly managed) would silently drop out of the runtime
            // snapshot the moment the first unsupported device gets demoted.
            const explicitDecisions: Record<string, boolean> = { dev1: false, dev2: false };
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => explicitDecisions[deviceId] === true,
                isManagedFilterActive: () => isManagedFilterActive(explicitDecisions),
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            // Filter inactive → both devices remain in the runtime snapshot
            // (with `managed === false`). The settings UI shows them in the
            // managed list with the toggle off so the user can re-enable.
            expect(dm.getSnapshot().map((d) => d.id).sort()).toEqual(['dev1', 'dev2']);
            expect(dm.getUiPickerDevices()).toEqual([]);
            dm.destroy();
        });

        it('keeps managed devices with malformed onoff visible in the picker so the user can toggle them back off', async () => {
            const managedFlags: Record<string, boolean> = { dev1: true, badDev: true };
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => managedFlags[deviceId] === true,
                isManagedFilterActive: () => Object.values(managedFlags).some((v) => v === true),
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                badDev: buildDevice('badDev', null),
            });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(dm.getSnapshot().map((d) => d.id)).toEqual(['dev1']);
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['badDev']);
            dm.destroy();
        });

        it('does not duplicate a previously-valid managed device into the picker on transient malformed onoff', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({ dev1: buildDevice('dev1', true) });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(dm.getSnapshot().map((d) => d.id)).toEqual(['dev1']);
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual([]);

            mockApiGet.mockResolvedValue({ dev1: buildDevice('dev1', null) });
            await dm.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(dm.getSnapshot().map((d) => d.id)).toEqual(['dev1']);
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual([]);
            dm.destroy();
        });
    });

    describe('refreshSnapshot', () => {
        it('populates snapshot with controllable devices', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
                dev2: {
                    id: 'dev2',
                    name: 'Light',
                    class: 'socket',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 120, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(2);
            const heater = findSnapshotDevice(snapshot, 'dev1');
            const light = findSnapshotDevice(snapshot, 'dev2');
            expect(heater?.deviceType).toBe('temperature');
            expect(heater?.expectedPowerKw).toBe(1);
            // Heater exposes `onoff` only in capabilitiesObj, not the capabilities
            // list, so it is not a binary-controlled device: `binaryControl` is
            // absent (the old fabricated `currentOn: true`).
            expect(heater?.binaryControl).toBeUndefined();
            expect(light?.deviceType).toBe('onoff');
            expect(light?.targets).toEqual([]);
        });

        it('abandon-grace: does not clobber a populated snapshot on a single transient empty read', async () => {
            await populateSnapshotForGrace(deviceManager);

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const ids = deviceManager.getSnapshot().map(snapshotDeviceId);
            expect(ids).toEqual(['dev1']);
            expect(loggerMock.structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_empty_deferred',
                reasonCode: 'empty_snapshot_transient',
                consecutiveEmptyReads: 1,
                previousDevicesTotal: 1,
            }));
        });

        it('abandon-grace: keeps the populated snapshot across several empty reads within grace', async () => {
            await populateSnapshotForGrace(deviceManager);

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const ids = deviceManager.getSnapshot().map(snapshotDeviceId);
            expect(ids).toEqual(['dev1']);
        });

        it('abandon-grace: eventually commits the empty snapshot after the consecutive-read threshold', async () => {
            await populateSnapshotForGrace(deviceManager);

            mockApiGet.mockResolvedValue({});
            // Threshold is 3 consecutive empty reads.
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(deviceManager.getSnapshot()).toHaveLength(1);
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getSnapshot()).toHaveLength(0);
            expect(loggerMock.structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_empty_grace_exceeded',
                reasonCode: 'empty_snapshot_committed',
                consecutiveEmptyReads: 3,
                previousDevicesTotal: 1,
            }));
        });

        it('abandon-grace: resets the grace counter once a populated read returns', async () => {
            await populateSnapshotForGrace(deviceManager);

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // Recovery: a populated read clears the run so the next empty read
            // is treated as the first miss again, not the third.
            mockApiGet.mockResolvedValue(GRACE_POPULATED_PAYLOAD);
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(deviceManager.getSnapshot()).toHaveLength(1);

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(deviceManager.getSnapshot()).toHaveLength(1);
            expect(loggerMock.structuredLog.warn).toHaveBeenLastCalledWith(expect.objectContaining({
                event: 'device_snapshot_empty_deferred',
                consecutiveEmptyReads: 1,
            }));
        });

        it('abandon-grace: commits an empty snapshot immediately when there was nothing to protect', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({});

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getSnapshot()).toHaveLength(0);
            expect(loggerMock.structuredLog.warn).not.toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_empty_deferred',
            }));
        });

        it('abandon-grace: commits immediately when the SDK returned devices that all filtered out', async () => {
            await populateSnapshotForGrace(deviceManager);

            // The SDK returns a device, but it has no usable capabilities so it
            // parses to an empty managed snapshot. That is an INTENTIONAL empty
            // (e.g. the last managed device became ineligible), not a transient
            // SDK blip — it must commit immediately, not be held under grace.
            mockApiGet.mockResolvedValue({
                ignored: { id: 'ignored', name: 'Ignored', class: 'other', capabilities: [], capabilitiesObj: {} },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getSnapshot()).toHaveLength(0);
            expect(loggerMock.structuredLog.warn).not.toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_empty_deferred',
            }));
        });

        it('abandon-grace: eventually commits the empty snapshot after the grace window elapses', async () => {
            vi.useFakeTimers();
            try {
                await populateSnapshotForGrace(deviceManager);

                mockApiGet.mockResolvedValue({});
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                // First empty read is deferred (under both the read and time limits).
                expect(deviceManager.getSnapshot()).toHaveLength(1);

                // Cross the time-based grace window without hitting the read threshold.
                vi.advanceTimersByTime(5 * 60 * 1000);
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(deviceManager.getSnapshot()).toHaveLength(0);
                expect(loggerMock.structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
                    event: 'device_snapshot_empty_grace_exceeded',
                    reasonCode: 'empty_snapshot_committed',
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('includes the normalized error in the structured refresh failure log', async () => {
            await deviceManager.init();
            const refreshFailure = new Error('refresh failed');
            vi.spyOn(deviceManager as unknown as { fetchDevicesForSnapshot: () => Promise<unknown> }, 'fetchDevicesForSnapshot').mockRejectedValueOnce(refreshFailure);

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(loggerMock.structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_refresh_failed',
                reasonCode: 'refresh_failed',
                targetedRefresh: false,
                err: refreshFailure,
            }));
            expect(loggerMock.error).not.toHaveBeenCalled();
        });

        it('returns the cumulative home power from the live report as the refresh sample', async () => {
            // The net scalar leaves transport only on the returned sample (the
            // observer-holder push was removed as write-only); generation from
            // the same report is still pushed to observer via the injected
            // `observedStateDispatcher.setGenerationW`.
            const setGenerationW = vi.fn();
            const dispatchingManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'resolved' as const, meterDeviceId: 'meter-main' }),
            }, undefined, {
                observedStateDispatcher: {
                    observedStateChanged: vi.fn(),
                    observedStateRefresh: vi.fn(),
                    observedControlStateChanged: vi.fn(),
                    setGenerationW,
                },
            });
            await dispatchingManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: { measure_power: { value: 500, id: 'measure_power' } },
                },
            });
            mockGetLiveReport.mockResolvedValue({
                items: [
                    { type: 'device', id: 'dev1', values: { W: 500 } },
                    { type: 'cumulative', id: 'meter-main', values: { W: 4500 } },
                ],
                totalGenerated: { W: 1200 },
            });

            const sample = await dispatchingManager.refreshSnapshot({
                mainMeterSelection: { state: 'resolved', meterDeviceId: 'meter-main' },
            });

            // Gross generation from the same payload is pushed alongside net power,
            // stamped with its read time (the holder is shared with the flow
            // source's separate generation reader, whose clock differs).
            expect(setGenerationW).toHaveBeenCalledWith(1200, expect.any(Number));
            expect(sample).toEqual({
                powerW: 4500,
                generationW: 1200,
                meterDeviceId: 'meter-main',
            });
        });

        it('yields no home-power sample when no cumulative item exists', async () => {
            const setGenerationW = vi.fn();
            const dispatchingManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            }, undefined, {
                observedStateDispatcher: {
                    observedStateChanged: vi.fn(),
                    observedStateRefresh: vi.fn(),
                    observedControlStateChanged: vi.fn(),
                    setGenerationW,
                },
            });
            await dispatchingManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: { measure_power: { value: 500, id: 'measure_power' } },
                },
            });
            mockGetLiveReport.mockResolvedValue({
                items: [{ type: 'device', id: 'dev1', values: { W: 500 } }],
            });

            const sample = await dispatchingManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // A report without a cumulative item resolves no whole-home reading,
            // so the refresh yields no sample for the ingest to record.
            expect(sample).toBeNull();
            // No generation signal in the payload -> null pushed (no-op gross-up).
            // Still stamped: "the report carried no generation" is an observation.
            expect(setGenerationW).toHaveBeenCalledWith(null, expect.any(Number));
        });

        it('does not publish empty home power evidence when live power is skipped', async () => {
            const setGenerationW = vi.fn();
            const dispatchingManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            }, undefined, {
                observedStateDispatcher: {
                    observedStateChanged: vi.fn(),
                    observedStateRefresh: vi.fn(),
                    observedControlStateChanged: vi.fn(),
                    setGenerationW,
                },
            });
            await dispatchingManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: { measure_power: { value: 500, id: 'measure_power' } },
                },
            });

            const sample = await dispatchingManager.refreshSnapshot({ includeLivePower: false, mainMeterSelection: { state: 'unavailable' } });

            expect(sample).toBeNull();
            expect(setGenerationW).not.toHaveBeenCalled();
        });

        it('includes airtreatment temperature devices in snapshot', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Nordic S4 REL',
                    class: 'airtreatment',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 250, id: 'measure_power' },
                        measure_temperature: { value: 18, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].deviceClass).toBe('airtreatment');
            expect(snapshot[0].deviceType).toBe('temperature');
            expect(snapshot[0].powerCapable).toBe(true);
            // Non-binary device (no onoff/control capability): it has no binary
            // control, so `binaryControl` is absent. Consumers treat absence as
            // the old fabricated `currentOn: true` — it has no off-switch and may
            // always draw (setpoint-controlled), so it stays sheddable.
            expect(snapshot[0].binaryControl).toBeUndefined();
            expect(snapshot[0].canSetControl).toBeUndefined();
        });

        it('includes EV chargers by default', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { value: true, id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                        measure_power: { value: 7200, id: 'measure_power' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(expect.objectContaining({
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                canSetControl: true,
            }));
        });

        it('skips devices with malformed class values without crashing snapshot refresh', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                badClass: {
                    id: 'badClass',
                    name: 'Malformed Class Device',
                    class: { value: 'heater' },
                    capabilities: ['onoff'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff', setable: true },
                    },
                },
                heater1: {
                    id: 'heater1',
                    name: 'Valid Heater',
                    class: 'heater',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff', setable: true },
                        measure_power: { value: 750, id: 'measure_power' },
                    },
                },
            });

            await expect(deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } })).resolves.toBeNull();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(expect.objectContaining({
                id: 'heater1',
                deviceClass: 'heater',
            }));
        });

        it('includes official EV chargers with charging-state control', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['onoff', 'evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff', setable: true },
                        evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_paused', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = evDeviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(expect.objectContaining({
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: false },
                canSetControl: true,
                evChargingState: 'plugged_in_paused',
            }));
        });

        it('does not derive EV command state when the boolean capability is missing', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                        measure_power: { value: 7100, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = evDeviceManager.getSnapshot();
            expect(snapshot[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evChargingState: 'plugged_in_charging',
            }));
        });

        it('does not use EV charging state as binary command confirmation', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T11:59:59.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'plugged_in_charging',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        measure_power: { value: 7100, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: new Date('2026-04-01T11:59:59.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }));
            expect(evDeviceManager.getBinaryCommandConfirmationSnapshot()[0])
                .toEqual(expect.objectContaining({
                    binaryCommandConfirmation: {
                        state: 'observed',
                        observedValue: false,
                        observedAtMs: new Date('2026-04-01T11:59:59.000Z').getTime(),
                    },
                }));
        });

        it('drops a charger that claims evcharger_charging_state but reports no value', async () => {
            // Contract gate: the capability is a closed Homey enum, so a claimed
            // capability with no readable member is not implemented. The device is
            // dropped exactly as one missing the capability is, rather than admitted
            // with an unknown plug-state every consumer would have to re-handle.
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        evcharger_charging_state: { id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(evDeviceManager.getSnapshot()).toEqual([]);

            evDeviceManager.destroy();
        });

        it('drops a charger whose plug-state value is outside the Homey enum', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_complete', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(evDeviceManager.getSnapshot()).toEqual([]);

            evDeviceManager.destroy();
        });

        it('excludes EV chargers without the official charging capability', async () => {
            const debugStructured = vi.fn();
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            }, undefined, { debugStructured });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Vendor Charger',
                    class: 'evcharger',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 1200, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(evDeviceManager.getSnapshot()).toHaveLength(0);
            // Both official capabilities are required; the plug-state one is checked
            // first because it is required of EVERY charger, including those that
            // control on the amp/step axis and never expose `evcharger_charging`.
            expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_skipped_missing_capability',
                deviceId: 'ev1',
                missingCapability: 'evcharger_charging_state',
            }));
        });

        it('excludes EV chargers without the official charging state capability', async () => {
            const debugStructured = vi.fn();
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            }, undefined, { debugStructured });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Vendor Charger',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { value: true, id: 'evcharger_charging' },
                        measure_power: { value: 1200, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(evDeviceManager.getSnapshot()).toHaveLength(0);
            expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_skipped_missing_capability',
                deviceId: 'ev1',
                missingCapability: 'evcharger_charging_state',
            }));
        });

        it('propagates Homey availability state into snapshot entries', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Unavailable Nordic',
                    class: 'airtreatment',
                    available: false,
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 250, id: 'measure_power' },
                        measure_temperature: { value: 18, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].available).toBe(false);
        });

        it('includes measured power zero when load setting is present', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                    },
                    settings: { load: 600 },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.6, 3);
            expect((snapshot[0] as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBe(0);
        });

        it('treats settings.load=0 as unset configured load and keeps no-power thermostats unsupported', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'VThermo',
                    class: 'thermostat',
                    capabilities: ['onoff', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                    },
                    settings: { load: 0 },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].expectedPowerSource).toBe('default');
            expect(snapshot[0].expectedPowerKw).toBe(1);
            expect(snapshot[0].powerCapable).toBe(false);
        });

        it('marks no-power onoff devices as power-capable when Homey energy estimate exists', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Virtual Light',
                    class: 'socket',
                    capabilities: ['onoff'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                    },
                    energyObj: {
                        approximation: {
                            usageOn: 110,
                            usageOff: 10,
                        },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].expectedPowerSource).toBe('homey-energy');
            expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.1, 6);
            expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.1, 6);
            expect(snapshot[0].powerCapable).toBe(true);
        });

        it('uses Homey energy live report as measured fallback when direct power capabilities are absent', async () => {
            vi.useFakeTimers();
            await deviceManager.init();
            try {
                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Virtual Light',
                        class: 'socket',
                        capabilities: ['onoff'],
                        capabilitiesObj: {
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });
                mockGetLiveReport.mockResolvedValue({
                    items: [
                        {
                            type: 'device',
                            id: 'dev1',
                            values: { W: 125 },
                        },
                    ],
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                const snapshot = deviceManager.getSnapshot();
                expect(snapshot).toHaveLength(1);
                expect((snapshot[0] as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBeCloseTo(0.125, 6);
                expect(snapshot[0].expectedPowerSource).toBe('measured-peak');
                expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.125, 6);
                expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.125, 6);
                expect(snapshot[0].powerCapable).toBe(true);
                expect(snapshot[0].lastFreshDataMs).toBe(new Date('2026-04-01T12:00:00.000Z').getTime());
                expect(mockGetLiveReport).toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps off on/off devices power-capable when Homey energy W metadata exists', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Virtual Light',
                    class: 'socket',
                    capabilities: ['onoff'],
                    capabilitiesObj: {
                        onoff: { value: false, id: 'onoff' },
                    },
                    energyObj: {
                        W: 125,
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].powerCapable).toBe(true);
            expect(snapshot[0].expectedPowerSource).toBe('default');
            expect(snapshot[0].expectedPowerKw).toBe(1);
        });

        it('uses providers to populate priority and controllable fields', async () => {
            const getControllable = vi.fn().mockReturnValue(false);

            deviceManager = new DeviceTransport(homeyMock, loggerMock, { getControllable, getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) });
            await deviceManager.init();

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const snapshot = deviceManager.getSnapshot();

            // No `priority` here any more: a rank is a property of a SET, so it is
            // resolved over the whole device list by `/ui_devices`, not stamped
            // per device while parsing.
            expect(snapshot[0].controllable).toBe(false);
            expect(getControllable).toHaveBeenCalledWith('dev1');
        });

        it('uses exact meter_power delta when measure_power is missing', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        meter_power: { value: 100, id: 'meter_power', lastUpdated: '2026-01-01T00:00:30.000Z' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        meter_power: { value: 101, id: 'meter_power', lastUpdated: '2026-01-01T01:00:30.000Z' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const snapshot = deviceManager.getSnapshot();

            expect((snapshot[0] as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBeCloseTo(1, 3);
            expect(snapshot[0].powerCapable).toBe(true);
            expect(snapshot[0].lastFreshDataMs).toBe(new Date('2026-01-01T01:00:30.000Z').getTime());

            vi.useRealTimers();
        });

        it('handles meter_power resets by ignoring negative deltas', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        meter_power: { value: 100, id: 'meter_power' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        meter_power: { value: 99, id: 'meter_power' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const snapshot = deviceManager.getSnapshot();

            expect((snapshot[0] as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBeUndefined();
            expect(snapshot[0].expectedPowerSource).toBe('default');

            vi.useRealTimers();
        });

        // Regression: previously the override resolved at three sites in the
        // snapshot pipeline (refreshSnapshot, the wrapper parseDeviceList, and
        // resolveParseDeviceIdentity). After the dedup, the provider callback is
        // invoked once per device per refresh.
        it('invokes getDeviceDriverIdOverride exactly once per device in refreshSnapshot', async () => {
            const getDeviceDriverIdOverride = vi.fn((deviceId: string) => (
                deviceId === 'dev-a' ? 'homey:app:com.zaptec:go2' : undefined
            ));
            const refreshDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getDeviceDriverIdOverride,
            });
            await refreshDeviceManager.init();
            mockApiGet.mockResolvedValue({
                'dev-a': {
                    id: 'dev-a',
                    name: 'Mock A',
                    class: 'socket',
                    driverId: 'homey:app:com.example:mock',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 50, id: 'measure_power' },
                    },
                },
                'dev-b': {
                    id: 'dev-b',
                    name: 'Mock B',
                    class: 'socket',
                    driverId: 'homey:app:com.example:mock',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 80, id: 'measure_power' },
                    },
                },
            });

            await refreshDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(getDeviceDriverIdOverride).toHaveBeenCalledTimes(2);
            expect(getDeviceDriverIdOverride).toHaveBeenCalledWith('dev-a');
            expect(getDeviceDriverIdOverride).toHaveBeenCalledWith('dev-b');
        });
    });

    describe('requestTemperatureTarget', () => {
        it('sets the semantic primary temperature target', async () => {
            await deviceManager.init();
            // Seed the snapshot
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature' },
                    },
                    targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
                },
            });
            // We need refreshSnapshot to populate internal state first
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            await deviceManager.requestTemperatureTarget('dev1', 22);

            expect(mockApiPut).toHaveBeenCalledWith(
                'manager/devices/device/dev1/capability/target_temperature',
                { value: 22 },
            );
        });
    });

    describe('Real-time updates', () => {
        beforeEach(async () => {
            mockApiGet.mockResolvedValue(buildRealtimeDevices());
            await deviceManager.init();
        });

        it('reports live feed as healthy after init', async () => {
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(deviceManager.getLiveFeedHealth()?.subscriptionState).toBe('subscribed');
        });

        it('ignores device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => deviceId === 'dev1', getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
            );
            await managedDeviceManager.init();

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Managed heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
                dev2: {
                    id: 'dev2',
                    name: 'Unmanaged heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 900, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            managedDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            // device.update for unmanaged dev2 should be ignored
            managedDeviceManager.injectDeviceUpdateForTest({
                id: 'dev2',
                name: 'Unmanaged heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 2000, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev2')).toBeUndefined();

            managedDeviceManager.destroy();
        });

        it('handles device.update events when a device becomes managed', async () => {
            const managedState: Record<string, boolean> = { dev1: false };
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true, getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
            );
            await managedDeviceManager.init();

            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            managedDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            // device.update should be ignored while unmanaged
            managedDeviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 2000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });
            expect(realtimeListener).not.toHaveBeenCalled();

            managedState.dev1 = true;
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // Now device.update should be handled
            managedDeviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 3000, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });

            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev1')).toEqual(expect.objectContaining({
                measuredPowerKw: 3,
            }));

            managedDeviceManager.destroy();
        });

        it('keeps the snapshot index entry when an unmanaged device.update is ignored', async () => {
            const managedState: Record<string, boolean> = { dev1: true };
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true, getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev1'))
                .toEqual(expect.objectContaining({ id: 'dev1' }));

            managedState.dev1 = false;
            managedDeviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 2000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev1'))
                .toEqual(expect.objectContaining({ id: 'dev1' }));
            managedDeviceManager.destroy();
        });

        it('does not retain malformed temperature evidence from an unmanaged device.update', async () => {
            const managedState: Record<string, boolean> = { dev1: true };
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true, getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
            );
            await managedDeviceManager.init();
            const validDevice = {
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_temperature', 'target_temperature', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_temperature: { value: 20, id: 'measure_temperature' },
                        target_temperature: { value: 21, id: 'target_temperature' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            };
            mockApiGet.mockResolvedValue(validDevice);
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(hasObservedTemperature(
                managedDeviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
            )).toBe(true);

            managedState.dev1 = false;
            managedDeviceManager.injectDeviceUpdateForTest({
                ...validDevice.dev1,
                capabilitiesObj: {
                    ...validDevice.dev1.capabilitiesObj,
                    measure_temperature: { value: Number.NaN, id: 'measure_temperature' },
                },
            });

            managedState.dev1 = true;
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(hasObservedTemperature(
                managedDeviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
            )).toBe(true);
            managedDeviceManager.destroy();
        });

        it('updates local state on power change via device.update', async () => {
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // Verify initial state
            expect((deviceManager.getSnapshot()[0] as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBe(1);
            debugStructuredMock.mockClear();

            // Trigger update 2000W via device.update
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 2000, id: 'measure_power' },
                },
            });

            const snapshot = deviceManager.getSnapshot();
            expect((snapshot[0] as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBe(2);
            expect(snapshot[0].expectedPowerKw).toBe(2);
            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_update_processed',
                source: 'device_update',
                deviceId: 'dev1',
                deviceName: 'Heater',
                reasonCode: 'no_snapshot_change',
                observedControlStateChanged: false,
                changeCount: 0,
                observedCapabilityIds: ['measure_power'],
                previousMeasuredPowerKw: 1,
                nextMeasuredPowerKw: 2,
                measurePowerBecameSignificantlyPositive: false,
            }));
        });

        it('tracks snapshot refresh and device.update sources for debug dumps', async () => {
            // Seed a real timestamped onoff:true baseline so the injected
            // onoff:false below is a genuine on→off change (the shared fixture's
            // value-less onoff would baseline currentOn:false).
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-03-20T05:59:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            let observedSources = deviceManager.getDebugObservedSources('dev1');
            expect(observedSources?.snapshotRefresh).toEqual(expect.objectContaining({
                path: 'snapshot_refresh',
                fetchSource: 'raw_manager_devices',
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    measuredPowerKw: 1,
                }),
            }));

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 500, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });

            observedSources = deviceManager.getDebugObservedSources('dev1');
            expect(observedSources?.deviceUpdate).toEqual(expect.objectContaining({
                path: 'device_update',
                observedControlStateChanged: true,
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    binaryControl: { on: false },
                    measuredPowerKw: 0.5,
                }),
                changes: [{
                    capabilityId: 'onoff',
                    previousValue: 'on',
                    nextValue: 'off',
                }],
            }));
        });

        it('does not erase valid binary evidence when device.update omits the binary value', async () => {
            const previousEvidence = {
                valid: true as const,
                capabilityId: 'onoff' as const,
                observedValue: false,
                observedCapabilityIds: ['onoff'],
                observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: previousEvidence,
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')).toEqual(expect.objectContaining({
                binaryControlObservation: previousEvidence,
            }));
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(previousEvidence);
        });

        it('keeps realtime binary evidence through target-only and power-only device.update payloads', async () => {
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Hall Thermostat',
                targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
                temperature: {
                    currentTemperature: 20,
                    target: { id: 'target_temperature', value: 20, unit: '°C' },
                },
                deviceClass: 'thermostat',
                deviceType: 'temperature',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: true },
            }]);

            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            const realtimeEvidence = deviceManager.getBinarySettleEvidenceByDeviceId('dev1');
            expect(realtimeEvidence).toEqual(expect.objectContaining({
                source: 'realtime_capability',
                capabilityId: 'onoff',
                observedValue: false,
            }));
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(false);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Hall Thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature', 'measure_power'],
                class: 'thermostat',
                capabilitiesObj: {
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                },
            });
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(realtimeEvidence);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(false);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Hall Thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature', 'measure_power'],
                class: 'thermostat',
                capabilitiesObj: {
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(realtimeEvidence);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation)
                .toEqual(realtimeEvidence);
        });

        it('does not infer off when device.update omits onoff after trusted on evidence', async () => {
            const trustedOnEvidence = {
                valid: true as const,
                capabilityId: 'onoff' as const,
                observedValue: true,
                observedCapabilityIds: ['onoff'],
                observedAtMs: new Date('2026-06-03T06:00:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Hall Thermostat',
                targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
                temperature: {
                    currentTemperature: 20,
                    target: { id: 'target_temperature', value: 20, unit: '°C' },
                },
                deviceClass: 'thermostat',
                deviceType: 'temperature',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: true },
                binaryControlObservation: trustedOnEvidence,
            }]);

            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Hall Thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature', 'measure_power'],
                class: 'thermostat',
                capabilitiesObj: {
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });

            const snapshotDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(snapshotDevice?.binaryControl?.on).toBe(true);
            expect(snapshotDevice?.binaryControlObservation).toEqual(trustedOnEvidence);
            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenLastCalledWith(expect.objectContaining({
                changes: [
                    { capabilityId: 'target_temperature', previousValue: '20°C', nextValue: '19°C' },
                ],
            }));
        });

        it('keeps the trusted realtime-off observation when a later pull omits onoff (two-source reconcile)', async () => {
            // 1. Pull with a trusted onoff=true → currentOn:true.
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:00:00.000Z' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-06-03T06:00:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(true);

            // 2. Realtime onoff=false → the freshest trusted observation says OFF.
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(false);

            // 3. Pull where Homey serves a cached device object that OMITS onoff;
            //    the parser now honestly resolves currentOn:false (no value) with
            //    no trusted binary observation.
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:05:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // The consolidated observed truth must remain the trusted realtime
            // OFF: neither the (now honest) false fallback nor a stale pull may
            // diverge from the retained binary evidence.
            const dev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(dev1?.binaryControlObservation?.observedValue).toBe(false);
            expect(dev1?.binaryControl?.on).toBe(false);
        });

        it('logs the binary observation consolidated from pull + retained realtime sources', async () => {
            // Establish a pull baseline, then a realtime push observes onoff=false
            // (retained, freshly stamped). A later pull carries an OLDER onoff
            // timestamp, so the observer consolidates to the retained realtime OFF
            // — and logs both sources + the consolidated result for visibility.
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:00:00.000Z' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-06-03T06:00:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            debugStructuredMock.mockClear();

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:05:00.000Z' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-06-03T06:01:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'binary_observation_consolidated',
                deviceId: 'dev1',
                capabilityId: 'onoff',
                pull: expect.objectContaining({ value: true }),
                retained: expect.objectContaining({ value: false, source: 'realtime_capability' }),
                consolidated: expect.objectContaining({ value: false, winner: 'retained' }),
            }));
        });

        it('counts rather than logs a consolidation where both sources already agree', async () => {
            // Same shape as the test above, except the later pull has caught up to
            // the retained realtime value instead of contradicting it. Nothing is
            // reconciled, so there is no decision to log — the merge records the
            // agreement on a counter instead. This is the case that was 100% of the
            // event's production volume.
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:00:00.000Z' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-06-03T06:00:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            debugStructuredMock.mockClear();
            const agreedBefore = getPerfSnapshot().counts.binary_observation_agreed_total ?? 0;

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:05:00.000Z' },
                        onoff: { value: false, id: 'onoff', lastUpdated: '2026-06-03T06:01:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(debugStructuredMock).not.toHaveBeenCalledWith(expect.objectContaining({
                event: 'binary_observation_consolidated',
            }));
            const agreedAfter = getPerfSnapshot().counts.binary_observation_agreed_total ?? 0;
            expect(agreedAfter - agreedBefore).toBe(1);
            // The agreed value is still what the snapshot reports.
            const dev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(dev1?.binaryControl?.on).toBe(false);
        });

        it('logs, and does not count as agreement, an unchanged snapshot the pull disagreed with', async () => {
            // An unchanged snapshot is not on its own an agreement. Here the older
            // pull carries a malformed `onoff`, parse keeps the retained boolean,
            // and applying it changes nothing — the same "unchanged" signal as an
            // agreement, but the sources plainly disagreed and the retained value
            // is what stands. The `pull` field is the only place that mismatch is
            // visible, so it keeps its line and must not inflate the counter.
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:00:00.000Z' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-06-03T06:00:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            debugStructuredMock.mockClear();
            const agreedBefore = getPerfSnapshot().counts.binary_observation_agreed_total ?? 0;

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:05:00.000Z' },
                        onoff: { value: 'unknown', id: 'onoff', lastUpdated: '2026-06-03T06:01:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'binary_observation_consolidated',
                deviceId: 'dev1',
                capabilityId: 'onoff',
                pull: expect.objectContaining({ value: 'unknown' }),
                consolidated: expect.objectContaining({
                    winner: 'retained',
                    reason: 'retained_over_disagreeing_pull',
                }),
            }));
            const agreedAfter = getPerfSnapshot().counts.binary_observation_agreed_total ?? 0;
            expect(agreedAfter - agreedBefore).toBe(0);
        });

        it('keeps a realtime-off observation when a later pull reports onoff=true with no timestamp', async () => {
            // The morning two-source divergence: a realtime push said OFF, then
            // Homey serves a cached device object on the next pull whose onoff is
            // boolean `true` but carries NO lastUpdated. An unstamped read has no
            // evidence it is newer than the realtime push, so it must not clear
            // the trusted observation — currentOn must stay reconciled to OFF.
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:00:00.000Z' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-06-03T06:00:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(false);

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1', name: 'Heater', class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power', lastUpdated: '2026-06-03T06:05:00.000Z' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const heldDev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(heldDev1?.binaryControl?.on).toBe(false);
            expect(heldDev1?.binaryControlObservation?.observedValue).toBe(false);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')?.observedValue).toBe(false);

            // The hold is not permanent: a newer trusted observation still
            // supersedes it. A realtime push (stamped fresh) observing onoff=true
            // reconciles currentOn back to ON.
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

            const recoveredDev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(recoveredDev1?.binaryControl?.on).toBe(true);
            expect(recoveredDev1?.binaryControlObservation?.observedValue).toBe(true);
        });

        it('honours a timestamp-less device.update push that contradicts prior realtime evidence', async () => {
            // A device.update is a PUSH: the device actively reporting its state.
            // Unlike a cached pull, a timestamp-less push stays authoritative, so a
            // physical toggle delivered as a device.update must still flip currentOn
            // even when it carries no lastUpdated and contradicts prior evidence.
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-06-03T06:00:00.000Z').getTime(),
                    source: 'realtime_capability',
                },
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff', 'measure_power'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });

            const pushedDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(pushedDevice).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                binaryControlObservation: expect.objectContaining({
                    source: 'device_update',
                    observedValue: true,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: expect.any(Number),
                }),
            }));
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff', 'measure_power'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 600, id: 'measure_power' },
                },
            });

            const omittedDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(omittedDevice).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                available: true,
                binaryControlObservation: expect.objectContaining({
                    source: 'device_update',
                    observedValue: true,
                    observedCapabilityIds: ['onoff'],
                }),
            }));
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
        });

        it('records equal timestamp-less device.update binary pushes before stale pulls', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: {
                            value: 1000,
                            id: 'measure_power',
                            lastUpdated: '2026-06-03T06:00:00.000Z',
                        },
                        onoff: {
                            value: true,
                            id: 'onoff',
                            lastUpdated: '2026-06-03T06:00:00.000Z',
                        },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff', 'measure_power'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_power: { value: 1000, id: 'measure_power' },
                },
            });

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: {
                            value: 1000,
                            id: 'measure_power',
                            lastUpdated: '2026-06-03T06:05:00.000Z',
                        },
                        onoff: { value: false, id: 'onoff' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(true);
        });

        it('does not refresh unchanged ON evidence from device.update receipt time', () => {
            vi.useFakeTimers();
            try {
                const originalObservedAtMs = new Date('2026-06-03T06:00:00.000Z').getTime();
                deviceManager.setSnapshotForTests([{
                    available: true,
                    id: 'dev1',
                    expectedPowerKw: 1, expectedPowerSource: 'default',
                    name: 'Heater',
                    targets: [],
                    deviceClass: 'heater',
                    deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                    binaryControl: { on: true },
                    binaryControlObservation: {
                        valid: true,
                        capabilityId: 'onoff',
                        observedValue: true,
                        observedCapabilityIds: ['onoff'],
                        observedAtMs: originalObservedAtMs,
                        source: 'snapshot_refresh',
                    },
                }]);
                vi.setSystemTime(new Date('2026-06-03T06:05:00.000Z'));

                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['onoff', 'measure_power'],
                    class: 'heater',
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 750, id: 'measure_power' },
                    },
                });

                expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation)
                    .toEqual(expect.objectContaining({
                        observedValue: true,
                        observedAtMs: originalObservedAtMs,
                    }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('rejects an older raw EV OFF from a delayed device.update', () => {
            const newerRawObservedAtMs = new Date('2026-06-03T06:05:00.000Z').getTime();
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Charger',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: false },
                evCharging: true,
                evChargingObservedAtMs: newerRawObservedAtMs,
                evChargingState: 'plugged_in_paused',
            }] as (TransportDeviceSnapshot & EvObservedProbe)[]);
            const reconcileListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: false,
                        id: 'evcharger_charging',
                        setable: true,
                        lastUpdated: '2026-06-03T06:04:00.000Z',
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_paused',
                        id: 'evcharger_charging_state',
                        lastUpdated: '2026-06-03T06:05:00.000Z',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                evCharging: true,
                evChargingObservedAtMs: newerRawObservedAtMs,
            }));
            expect(reconcileListener).not.toHaveBeenCalled();
        });

        it('rejects stale raw EV OFF and stale paused state from one delayed update', () => {
            const newerObservedAtMs = new Date('2026-06-03T06:05:00.000Z').getTime();
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Charger',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                evCharging: true,
                evChargingObservedAtMs: newerObservedAtMs,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: newerObservedAtMs,
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: true,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: newerObservedAtMs,
                    source: 'snapshot_refresh',
                },
            }] as (TransportDeviceSnapshot & EvObservedProbe)[]);
            const reconcileListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: false,
                        id: 'evcharger_charging',
                        setable: true,
                        lastUpdated: '2026-06-03T06:04:00.000Z',
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_paused',
                        id: 'evcharger_charging_state',
                        lastUpdated: '2026-06-03T06:04:00.000Z',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                evCharging: true,
                evChargingObservedAtMs: newerObservedAtMs,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: newerObservedAtMs,
            }));
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')?.binaryControlObservation)
                .toEqual(expect.objectContaining({
                    observedValue: true,
                    observedAtMs: newerObservedAtMs,
                    observedCapabilityIds: ['evcharger_charging'],
                }));
            expect(reconcileListener).not.toHaveBeenCalled();
        });

        it('keeps the state clock after a raw EV event and rejects a later stale state', () => {
            const stateObservedAtMs = new Date('2026-06-03T06:05:00.000Z').getTime();
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Charger',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                evCharging: true,
                evChargingObservedAtMs: stateObservedAtMs,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: stateObservedAtMs,
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: true,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: stateObservedAtMs,
                    source: 'snapshot_refresh',
                },
            }] as (TransportDeviceSnapshot & EvObservedProbe)[]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: false,
                        id: 'evcharger_charging',
                        setable: true,
                        lastUpdated: '2026-06-03T06:06:00.000Z',
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_charging',
                        id: 'evcharger_charging_state',
                        lastUpdated: '2026-06-03T06:05:00.000Z',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                evCharging: false,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: stateObservedAtMs,
            }));

            const reconcileListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);
            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: false,
                        id: 'evcharger_charging',
                        setable: true,
                        lastUpdated: '2026-06-03T06:06:00.000Z',
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_paused',
                        id: 'evcharger_charging_state',
                        lastUpdated: '2026-06-03T06:04:30.000Z',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evCharging: false,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: stateObservedAtMs,
            }));
            expect(reconcileListener).not.toHaveBeenCalled();
        });

        it('preserves EV state when stale raw OFF is bundled with timestamp-less paused state', () => {
            const newerObservedAtMs = new Date('2026-06-03T06:05:00.000Z').getTime();
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Charger',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                evCharging: true,
                evChargingObservedAtMs: newerObservedAtMs,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: newerObservedAtMs,
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: true,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: newerObservedAtMs,
                    source: 'snapshot_refresh',
                },
            }] as (TransportDeviceSnapshot & EvObservedProbe)[]);
            const reconcileListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: false,
                        id: 'evcharger_charging',
                        setable: true,
                        lastUpdated: '2026-06-03T06:04:00.000Z',
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_paused',
                        id: 'evcharger_charging_state',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                evCharging: true,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: newerObservedAtMs,
            }));
            expect(reconcileListener).not.toHaveBeenCalled();
        });

        it('preserves the EV state clock after stale raw evidence bundles unchanged timestamp-less state', () => {
            const newerObservedAtMs = new Date('2026-06-03T06:05:00.000Z').getTime();
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Charger',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                evCharging: true,
                evChargingObservedAtMs: newerObservedAtMs,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: newerObservedAtMs,
            }] as (TransportDeviceSnapshot & EvObservedProbe)[]);
            const reconcileListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: false,
                        id: 'evcharger_charging',
                        setable: true,
                        lastUpdated: '2026-06-03T06:04:00.000Z',
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_charging',
                        id: 'evcharger_charging_state',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });
            deviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Charger',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: {
                        value: true,
                        id: 'evcharger_charging',
                        setable: true,
                    },
                    evcharger_charging_state: {
                        value: 'plugged_in_paused',
                        id: 'evcharger_charging_state',
                        lastUpdated: '2026-06-03T06:04:30.000Z',
                    },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                evCharging: true,
                evChargingState: 'plugged_in_charging',
                evChargingStateObservedAtMs: newerObservedAtMs,
            }));
            expect(reconcileListener).not.toHaveBeenCalled();
        });

        it("clears binary evidence and logs when device.update carries invalid direct onoff='unknown'", async () => {
            const previousEvidence = {
                valid: true as const,
                capabilityId: 'onoff' as const,
                observedValue: false,
                observedCapabilityIds: ['onoff'],
                observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: previousEvidence,
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: { value: 'unknown' as unknown as boolean, id: 'onoff' },
                },
            });

            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation).toBeUndefined();
            expect(loggerMock.structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                event: 'binary_settle_evidence_cleared',
                reasonCode: 'invalid_control_payload',
                deviceId: 'dev1',
                deviceName: 'Heater',
                capabilityId: 'onoff',
                source: 'device_update',
                valueType: 'string',
            }));
        });

        it("keeps valid telemetry from device.update when direct onoff='unknown' clears evidence", async () => {
            const previousEvidence = {
                valid: true as const,
                capabilityId: 'onoff' as const,
                observedValue: false,
                observedCapabilityIds: ['onoff'],
                observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            deviceManager.setSnapshotForTests([{
                id: 'dev1',
                expectedPowerKw: 1,
                name: 'Hall Thermostat',
                temperature: { currentTemperature: 20, target: { id: 'target_temperature', value: 20, unit: '°C' } },
                targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
                deviceClass: 'thermostat',
                deviceType: 'temperature',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                measuredPowerKw: 0.1,
                binaryControlObservation: previousEvidence,
            }] as (TransportDeviceSnapshot & MeasuredPowerObservedProbe)[]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Hall Thermostat',
                capabilities: ['onoff', 'measure_temperature', 'measure_power', 'target_temperature'],
                class: 'thermostat',
                capabilitiesObj: {
                    onoff: { value: 'unknown' as unknown as boolean, id: 'onoff' },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    measure_power: { value: 500, id: 'measure_power' },
                    target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                },
            });

            const snapshotDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(snapshotDevice).toEqual(expect.objectContaining({
                measuredPowerKw: 0.5,
                targets: [expect.objectContaining({ id: 'target_temperature', value: 19 })],
            }));
            expect(snapshotDevice?.binaryControlObservation).toBeUndefined();
        });

        it('uses device.update capability lastUpdated as the binary evidence timestamp', async () => {
            const observedAtMs = new Date('2026-04-01T12:00:00.000Z').getTime();
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff', 'measure_power'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: {
                        value: true,
                        id: 'onoff',
                        lastUpdated: new Date(observedAtMs).toISOString(),
                    },
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });

            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(expect.objectContaining({
                source: 'device_update',
                observedValue: true,
                observedAtMs,
            }));
        });

        it('does not reattach cached evidence when an explicit timestamp-less boolean contradicts it', async () => {
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff', 'measure_power'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(true);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation)
                .toEqual(expect.objectContaining({
                    source: 'device_update',
                    observedValue: true,
                }));
        });

        it('keeps currentOn aligned with newer cached evidence when device.update carries stale binary evidence', async () => {
            const newerEvidence = {
                valid: true as const,
                capabilityId: 'onoff' as const,
                observedValue: true,
                observedCapabilityIds: ['onoff'],
                observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: true },
                binaryControlObservation: newerEvidence,
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff', 'measure_power'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: {
                        value: false,
                        id: 'onoff',
                        lastUpdated: '2026-04-01T11:59:00.000Z',
                    },
                    measure_power: { value: 500, id: 'measure_power' },
                },
            });

            const snapshotDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(newerEvidence);
            expect(snapshotDevice?.binaryControlObservation).toEqual(newerEvidence);
            expect(snapshotDevice?.binaryControl?.on).toBe(true);
        });

        it('keeps currentOn aligned with newer cached evidence when snapshot refresh carries stale binary evidence', async () => {
            const newerEvidence = {
                valid: true as const,
                capabilityId: 'onoff' as const,
                observedValue: true,
                observedCapabilityIds: ['onoff'],
                observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: true },
                binaryControlObservation: newerEvidence,
            }]);
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['onoff', 'measure_power'],
                    class: 'heater',
                    capabilitiesObj: {
                        onoff: {
                            value: false,
                            id: 'onoff',
                            lastUpdated: '2026-04-01T11:59:00.000Z',
                        },
                        measure_power: { value: 500, id: 'measure_power' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshotDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(newerEvidence);
            expect(snapshotDevice?.binaryControlObservation).toEqual(newerEvidence);
            expect(snapshotDevice?.binaryControl?.on).toBe(true);
        });

        it('does not reattach cached evidence when snapshot refresh has a contradictory timestamp-less boolean', async () => {
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }]);
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['onoff', 'measure_power'],
                    class: 'heater',
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 500, id: 'measure_power' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControl?.on).toBe(true);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation).toBeUndefined();
        });

        it('clears binary evidence when a device disappears from snapshot refresh', async () => {
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }]);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeDefined();

            // A single empty read is held under abandon-grace; drive past the
            // consecutive-read threshold so the genuinely-gone device commits.
            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
        });

        it('clears binary evidence on destroy', async () => {
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'dev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                binaryCapabilityId: 'onoff',
                binaryControl: { on: false },
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }]);

            deviceManager.destroy();

            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
        });

        it('uses a newer raw EV command observation even when charging state has no timestamp', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            const previousEvidence = {
                valid: true as const,
                capabilityId: 'evcharger_charging' as const,
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging'],
                observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            evDeviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Easee',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                evCharging: false,
                evChargingState: 'plugged_in_paused',
                binaryControlObservation: previousEvidence,
            }] as (TransportDeviceSnapshot & EvObservedProbe & StateOfChargeObservedProbe)[]);
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'plugged_in_paused',
                            id: 'evcharger_charging_state',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }));

            evDeviceManager.destroy();
        });

        it('preserves newer raw EV command evidence when snapshot refresh has a stale command timestamp', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            const newerEvidence = {
                valid: true as const,
                capabilityId: 'evcharger_charging' as const,
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging'],
                observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            evDeviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Easee',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: true },
                evCharging: false,
                evChargingState: 'plugged_in_paused',
                binaryControlObservation: newerEvidence,
            }] as (TransportDeviceSnapshot & EvObservedProbe & StateOfChargeObservedProbe)[]);
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T11:59:00.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'plugged_in_paused',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T11:59:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControlObservation: newerEvidence,
            }));

            evDeviceManager.destroy();
        });

        it('keeps raw EV command evidence separate from fresher charging state', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            const previousRawEvidence = {
                valid: true as const,
                capabilityId: 'evcharger_charging' as const,
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging'],
                observedAtMs: new Date('2026-04-01T11:59:00.000Z').getTime(),
                source: 'snapshot_refresh' as const,
            };
            evDeviceManager.setSnapshotForTests([{
                available: true,
                id: 'ev1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Easee',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                binaryControl: { on: false },
                evCharging: false,
                binaryControlObservation: previousRawEvidence,
            }]);
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T11:59:00.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'plugged_in_charging',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        measure_power: { value: 7100, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const expectedRawEvidence = {
                valid: true,
                capabilityId: 'evcharger_charging',
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging'],
                observedAtMs: new Date('2026-04-01T11:59:00.000Z').getTime(),
                source: 'snapshot_refresh',
            };
            expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evChargingState: 'plugged_in_charging',
                binaryControlObservation: expectedRawEvidence,
            }));
            expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(expectedRawEvidence);

            evDeviceManager.destroy();
        });

        it('does not replace raw EV command evidence with realtime charging state', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                const previousRawEvidence = {
                    valid: true as const,
                    capabilityId: 'evcharger_charging' as const,
                    observedValue: true,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh' as const,
                };
                evDeviceManager.setSnapshotForTests([{
                    available: true,
                    id: 'ev1',
                    expectedPowerKw: 1, expectedPowerSource: 'default',
                    name: 'Easee',
                    targets: [],
                    deviceClass: 'evcharger',
                    deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                    binaryControl: { on: true },
                    evCharging: true,
                    binaryControlObservation: previousRawEvidence,
                }]);

                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_paused');

                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(previousRawEvidence);
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                    // Charging-state evidence remains separate from the raw
                    // command permission, which stays armed.
                    binaryControl: { on: true },
                    evCharging: true,
                    evChargingState: 'plugged_in_paused',
                    binaryControlObservation: previousRawEvidence,
                }));

                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(previousRawEvidence);
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                    binaryControl: { on: true },
                    evCharging: true,
                    evChargingObservedAtMs: previousRawEvidence.observedAtMs,
                    evChargingState: undefined,
                    evChargingStateObservedAtMs: undefined,
                    binaryControlObservation: previousRawEvidence,
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps raw EV command evidence when realtime charging state is unknown', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                const previousEvidence = {
                    valid: true as const,
                    capabilityId: 'evcharger_charging' as const,
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'realtime_capability' as const,
                };
                evDeviceManager.setSnapshotForTests([{
                    available: true,
                    id: 'ev1',
                    expectedPowerKw: 1, expectedPowerSource: 'default',
                    name: 'Easee',
                    targets: [],
                    deviceClass: 'evcharger',
                    deviceType: 'onoff',
                binaryCapabilityId: 'evcharger_charging',
                    binaryControl: { on: true },
                    evCharging: false,
                    evChargingState: 'plugged_in_paused',
                    binaryControlObservation: previousEvidence,
            }] as (TransportDeviceSnapshot & EvObservedProbe & StateOfChargeObservedProbe)[]);

                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'mystery');

                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(previousEvidence);
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')?.binaryControlObservation)
                    .toEqual(previousEvidence);

                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toBeUndefined();
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')?.binaryControlObservation)
                    .toBeUndefined();

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('prunes stale debug sources and ignores no-op realtime updates for removed devices', async () => {
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            expect(deviceManager.getDebugObservedSources('dev1')?.snapshotRefresh).toBeDefined();

            // A single empty read is held under abandon-grace; drive past the
            // consecutive-read threshold so the genuinely-gone device commits.
            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getDebugObservedSources('dev1')).toBeNull();

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(deviceManager.getDebugObservedSources('dev1')).toBeNull();
        });

        it('emits reconcile event when onoff changes via device.update', async () => {
            // Seed a real timestamped onoff:true baseline so the injected
            // onoff:false below is a genuine true→false change (the shared
            // fixture's value-less onoff would baseline currentOn:false).
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-03-20T05:59:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);
            debugStructuredMock.mockClear();

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
            }));
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                observationSeq: 2,
                observedAtMs: expect.any(Number),
                name: 'Heater',
                changes: [{
                    capabilityId: 'onoff',
                    previousValue: 'on',
                    nextValue: 'off',
                }],
            }));
            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_update_processed',
                source: 'device_update',
                deviceId: 'dev1',
                reasonCode: 'control_state_changed',
                observedControlStateChanged: true,
                changeCount: 1,
                binaryCapabilityId: 'onoff',
                rawBinaryObserved: true,
                rawBinaryValue: false,
                previousCurrentOn: true,
                nextCurrentOn: false,
            }));
        });

        it('publishes the observed realtime confirmation of a local onoff write', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', true);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));
            expect(realtimeListener).toHaveBeenCalledOnce();
        });

        it('publishes the observed realtime confirmation before the local write resolves', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                },
            });

            let resolveWrite: (() => void) | undefined;
            mockApiPut.mockImplementationOnce(() => new Promise<void>((resolve) => {
                resolveWrite = resolve;
            }));

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            const setCapabilityPromise = deviceManager.setCapability('dev1', 'onoff', true);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));
            expect(realtimeListener).toHaveBeenCalledOnce();

            resolveWrite?.();
            await setCapabilityPromise;
        });

        it('does not fabricate drift when an accepted write has not changed observed state', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const liveStateListener = vi.fn();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', false);

            // Contradictory device.update (fight-back from device) — first observation decides
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
            // The accepted write publishes unchanged observer truth once. The
            // equal device.update adds no second control-state transition.
            expect(liveStateListener).toHaveBeenCalledOnce();
            expect(liveStateListener.mock.calls[0][0]).toEqual(expect.objectContaining({
                source: 'realtime_capability',
                deviceId: 'dev1',
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));
        });

        it('keeps equal realtime control truth quiet after an accepted write', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.setCapability('dev1', 'onoff', false);

            const currentOnAtReconcile: unknown[] = [];
            const liveStateListener = vi.fn();
            const realtimeListener = vi.fn(() => {
                currentOnAtReconcile.push(deviceManager.getSnapshot()[0]?.binaryControl?.on);
            });
            deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(liveStateListener).not.toHaveBeenCalled();
            expect(currentOnAtReconcile).toEqual([]);
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));
        });

        it('publishes a matching realtime onoff confirmation as observed truth', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.setCapability('dev1', 'onoff', false);

            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
            }));
        });

        it('after the settle window, a device.update that drops the onoff capability revokes binary status (capability presence is the source of truth — no latch)', async () => {
            vi.useFakeTimers();
            try {
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Thermostat',
                        class: 'thermostat',
                        capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
                        capabilitiesObj: {
                            onoff: { value: true, id: 'onoff' },
                            target_temperature: { value: 20, id: 'target_temperature', units: '°C', min: 5, max: 40, step: 0.5 },
                            measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                            measure_power: { value: 360, id: 'measure_power' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: true } }));

                await vi.advanceTimersByTimeAsync(90_000);
                expect(realtimeListener).not.toHaveBeenCalled();

                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Thermostat',
                    class: 'thermostat',
                    capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
                    capabilitiesObj: {
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C', min: 5, max: 40, step: 0.5 },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                        measure_power: { value: 360, id: 'measure_power' },
                    },
                });

                // After the settle window expires the held off-state is released.
                // This update omits the `onoff` capability, so the control capability
                // is absent THIS cycle: capability presence is the source of truth for
                // binary status, so the device is no longer binary (the prior off-state
                // is NOT latched present). The reconcile fires once for the target change.
                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: [
                        { capabilityId: 'target_temperature', previousValue: '20°C', nextValue: '21°C' },
                    ],
                }));
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    // Binary status revoked: no control capability this cycle → non-binary.
                    binaryControl: undefined,
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 21 })],
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('first confirming device.update settles the window; subsequent fight-back triggers normal reconcile', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', false);

            // First update confirms the local write — settle window closes
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });
            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: false } }));

            // Second update fights back — settle window is gone, treated as normal drift
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(realtimeListener).toHaveBeenCalledTimes(2);
            expect(realtimeListener).toHaveBeenLastCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: true } }));
        });

        it('first contradictory device.update triggers drift; subsequent observations are normal', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', false);

            // First observation is contradictory — drift emitted immediately, window closed
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));
        });

        it('drops a pending binary settle window when the device disappears before expiry', async () => {
            vi.useFakeTimers();
            try {
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.setSnapshotForTests([]);

                await vi.advanceTimersByTimeAsync(90_000);

                expect(realtimeListener).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it('drops a pending binary settle window when a device.update removes the device before expiry', async () => {
            vi.useFakeTimers();
            try {
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });

                await vi.advanceTimersByTimeAsync(90_000);

                expect(deviceManager.getSnapshot()).toEqual([]);
                expect(realtimeListener).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not preserve the old desired onoff value after settle timeout; a binary-less device.update honestly resolves currentOn:false', async () => {
            vi.useFakeTimers();
            try {
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: true },
                }));

                await vi.advanceTimersByTimeAsync(90_000);

                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 900, id: 'measure_power' },
                    },
                });

                // The held off-state is released after the settle window, but the
                // binary-less update no longer re-synthesizes the old optimistic
                // on-state — it honestly resolves currentOn:false, which matches the
                // existing off-state, so there is no onoff change to reconcile.
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                }));
                expect(realtimeListener).not.toHaveBeenCalledWith(expect.objectContaining({
                    changes: expect.arrayContaining([
                        expect.objectContaining({ capabilityId: 'onoff' }),
                    ]),
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        describe('binary settle — first observation decides', () => {
            const heaterOnDevice = () => ({
                id: 'dev1',
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'onoff'],
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });
            const heaterOffDevice = () => ({
                id: 'dev1',
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'onoff'],
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });

            it('pending off write + capability event off => settles immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: false } }));
            });

            it('pending off write + capability event on => drift immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: true } }));
            });

            it('pending off write + device.update with off => settles immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectDeviceUpdateForTest(heaterOffDevice());

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: false } }));
            });

            it('pending off write + device.update with on => drift immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectDeviceUpdateForTest(heaterOnDevice());

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: true } }));
            });

            it('pending on write + capability event on => settles immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOffDevice() });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', true);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: true } }));
            });

            it('pending on write + capability event off => drift immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOffDevice() });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', true);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: false } }));
            });

            it('observes EV command acceptance from the raw capability while state remains paused', async () => {
                vi.useFakeTimers();
                try {
                    const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                    });
                    await evDeviceManager.init();
                    mockApiGet.mockResolvedValue({
                        ev1: {
                            id: 'ev1',
                            name: 'Easee',
                            class: 'evcharger',
                            capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                            capabilitiesObj: {
                                evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                                evcharger_charging_state: {
                                    value: 'plugged_in_paused',
                                    id: 'evcharger_charging_state',
                                    lastUpdated: '2026-04-01T12:00:00.000Z',
                                },
                                measure_power: { value: 0, id: 'measure_power' },
                            },
                        },
                    });
                    await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const realtimeListener = vi.fn();
                    evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                    await evDeviceManager.setCapability('ev1', 'evcharger_charging', true);
                    evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging', true);

                    expect(realtimeListener).toHaveBeenCalledOnce();
                    expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                        binaryControl: { on: true },
                        evCharging: true,
                        evChargingState: 'plugged_in_paused',
                        binaryControlObservation: expect.objectContaining({
                            observedValue: true,
                            observedCapabilityIds: ['evcharger_charging'],
                        }),
                    }));

                    evDeviceManager.destroy();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('emits a raw EV control-axis ON transition while session state remains paused', async () => {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) });
                await evDeviceManager.init();
                mockApiGet.mockResolvedValue({
                    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: {
                                value: false,
                                id: 'evcharger_charging',
                                setable: true,
                            },
                            evcharger_charging_state: {
                                value: 'plugged_in_paused',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-04-01T12:00:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging', true);

                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'ev1',
                    changes: [{
                        capabilityId: 'evcharger_charging',
                        observedCapabilityId: 'evcharger_charging',
                        previousValue: 'off',
                        nextValue: 'on',
                    }],
                }));
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: true },
                    evCharging: true,
                    evChargingState: 'plugged_in_paused',
                }));
                evDeviceManager.destroy();
            });

            it('prefers bundled raw EV axis changes over simultaneous non-charging state changes', async () => {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) });
                await evDeviceManager.init();
                const evDevice = (charging: boolean, state: string) => ({
                    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: charging,
                            id: 'evcharger_charging',
                            setable: true,
                        },
                        evcharger_charging_state: {
                            value: state,
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });
                mockApiGet.mockResolvedValue({ ev1: evDevice(true, 'plugged_in') });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                // Full refresh treats session state as effective binary evidence;
                // seed the distinct raw control axis before exercising a bundled
                // update where both raw and state fields change.
                evDeviceManager.injectCapabilityUpdateForTest(
                    'ev1',
                    'evcharger_charging',
                    true,
                );
                const realtimeListener = vi.fn();
                evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                evDeviceManager.injectDeviceUpdateForTest(evDevice(false, 'plugged_in_paused'));
                evDeviceManager.injectDeviceUpdateForTest(evDevice(true, 'plugged_in'));

                expect(realtimeListener).toHaveBeenNthCalledWith(1, expect.objectContaining({
                    deviceId: 'ev1',
                    changes: [expect.objectContaining({
                        capabilityId: 'evcharger_charging',
                        observedCapabilityId: 'evcharger_charging',
                        previousValue: 'on',
                        nextValue: 'off',
                    })],
                }));
                expect(realtimeListener).toHaveBeenNthCalledWith(2, expect.objectContaining({
                    deviceId: 'ev1',
                    changes: [expect.objectContaining({
                        capabilityId: 'evcharger_charging',
                        observedCapabilityId: 'evcharger_charging',
                        previousValue: 'off',
                        nextValue: 'on',
                    })],
                }));
                evDeviceManager.destroy();
            });

            it('keeps EV charging-state changes separate from binary command drift', async () => {
                vi.useFakeTimers();
                try {
                    const evDeviceManager = new DeviceTransport(homeyMock, loggerMock);
                    await evDeviceManager.init();
                    mockApiGet.mockResolvedValue({
                        ev1: {
                            id: 'ev1',
                            name: 'Easee',
                            class: 'evcharger',
                            capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                            capabilitiesObj: {
                                evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                                evcharger_charging_state: {
                                    value: 'plugged_in_paused',
                                    id: 'evcharger_charging_state',
                                    lastUpdated: '2026-04-01T12:00:00.000Z',
                                },
                                measure_power: { value: 0, id: 'measure_power' },
                            },
                        },
                    });
                    await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const liveStateListener = vi.fn();
                    const realtimeListener = vi.fn();
                    evDeviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                    await evDeviceManager.setCapability('ev1', 'evcharger_charging', true);
                    vi.setSystemTime(new Date('2026-04-01T12:00:01.000Z'));
                    evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_out');

                    expect(realtimeListener).not.toHaveBeenCalled();
                    expect(liveStateListener).toHaveBeenCalledTimes(2);
                    expect(liveStateListener.mock.calls[1][0]).toEqual(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'ev1',
                        capabilityId: 'evcharger_charging_state',
                    }));
                    expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                        binaryControl: { on: false },
                        evChargingState: 'plugged_out',
                    }));

                    evDeviceManager.destroy();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('pending binary write + no observation before timeout => timeout path runs, reconcile if state differs', async () => {
                vi.useFakeTimers();
                try {
                    mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const realtimeListener = vi.fn();
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                    // Accepted writes do not fabricate observed state.
                    await deviceManager.setCapability('dev1', 'onoff', false);
                    // No binary observations arrive
                await vi.advanceTimersByTimeAsync(90_000);

                    // Transport owns no timeout lifecycle; observer settlement does.
                    expect(realtimeListener).not.toHaveBeenCalled();
                    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ binaryControl: { on: true } }));
                } finally {
                    vi.useRealTimers();
                }
            });
        });

        it('preserves local onoff state after a successful binary write', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
            }));

            await deviceManager.setCapability('dev1', 'onoff', true);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
            }));
            expect(deviceManager.getDebugObservedSources('dev1')?.localWrites.onoff).toEqual(expect.objectContaining({
                path: 'local_write',
                capabilityId: 'onoff',
                value: true,
                preservedLocalState: false,
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    binaryControl: { on: false },
                }),
            }));
        });

        it('keeps a target write pending until realtime confirmation arrives', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '\u00B0C' },
                        target_temperature: { value: 22, id: 'target_temperature', units: '\u00B0C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getSnapshot()[0]?.targets[0]).toEqual(expect.objectContaining({
                id: 'target_temperature',
                value: 22,
            }));

            await deviceManager.setCapability('dev1', 'target_temperature', 18);

            expect(deviceManager.getSnapshot()[0]?.targets[0]).toEqual(expect.objectContaining({
                id: 'target_temperature',
                value: 22,
            }));
            expect(deviceManager.getSnapshot()[0]?.lastLocalWriteMs).toBeDefined();
            expect(deviceManager.getDebugObservedSources('dev1')?.localWrites.target_temperature).toEqual(
                expect.objectContaining({
                    path: 'local_write',
                    capabilityId: 'target_temperature',
                    value: 18,
                    preservedLocalState: false,
                }),
            );
        });

        it('admits only the exact target_temperature capability', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Multi-zone Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'target_temperature.zone1', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '\u00B0C' },
                        target_temperature: { value: 22, id: 'target_temperature', units: '\u00B0C' },
                        'target_temperature.zone1': { value: 20, id: 'target_temperature.zone1', units: '\u00B0C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snap = deviceManager.getSnapshot()[0] as TransportDeviceSnapshot | undefined;
            expect(snap?.targets).toHaveLength(1);
            expect(snap?.targets[0]).toEqual(expect.objectContaining({ id: 'target_temperature', value: 22 }));
            expect(snap?.temperature?.target.id).toBe('target_temperature');
        });

        it('does not change observed onoff state after an accepted binary write', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            await deviceManager.setCapability('dev1', 'onoff', true);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
            }));
        });

        it('does not trust optimistic local off when a later pull omits onoff', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: {
                            value: true,
                            id: 'onoff',
                            lastUpdated: '2026-06-03T06:00:00.000Z',
                        },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            await deviceManager.setCapability('dev1', 'onoff', false);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                binaryControlObservation: expect.objectContaining({
                    observedValue: true,
                }),
            }));

            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const snapshotDevice = deviceManager.getSnapshot()[0];
            expect(snapshotDevice).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                available: true,
                binaryControlObservation: expect.objectContaining({
                    observedValue: true,
                }),
            }));
            expect(resolveCommandableNow(snapshotDevice)).toBe(true);
        });

        it('emits reconcile event when target temperature changes via device.update', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 18, id: 'target_temperature', units: '°C' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 18 })],
            }));
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                observationSeq: 2,
                observedAtMs: expect.any(Number),
                name: 'Heater',
                changes: [{
                    capabilityId: 'target_temperature',
                    previousValue: '20°C',
                    nextValue: '18°C',
                }],
            }));
        });

        it('applies target temperature from device.update and snapshot refresh uses latest API value', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: {
                            value: 23,
                            id: 'target_temperature',
                            units: '°C',
                            lastUpdated: '2026-03-12T19:22:37.776Z',
                        },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // device.update changes target to 26.5
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 26.5, id: 'target_temperature', units: '°C' },
                    onoff: { value: true, id: 'onoff' },
                },
            });
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
            }));

            // Snapshot refresh returns the new target value
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: {
                            value: 26.5,
                            id: 'target_temperature',
                            units: '°C',
                        },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
            }));
        });

        it('keeps a newer fetched target when it matches a later local write even if an older realtime target exists', async () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 23,
                                id: 'target_temperature',
                                units: '°C',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 23, id: 'target_temperature', units: '°C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                await deviceManager.setCapability('dev1', 'target_temperature', 16);

                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 0, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 16,
                                id: 'target_temperature',
                                units: '°C',
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 16 })],
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('preserves a newer target write across a stale snapshot refresh even when snapshot lastUpdated is stale', async () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 23,
                                id: 'target_temperature',
                                units: '°C',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    lastFreshDataMs: new Date('2026-03-20T05:59:00.000Z').getTime(),
                    lastLocalWriteMs: undefined,
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 23 })],
                }));

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                await deviceManager.setCapability('dev1', 'target_temperature', 16);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    lastLocalWriteMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 23 })],
                }));

                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 23,
                                id: 'target_temperature',
                                units: '°C',
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    lastFreshDataMs: new Date('2026-03-20T05:59:30.000Z').getTime(),
                    lastLocalWriteMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 16 })],
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('overwrites a stale target observation with a newer local target write during refreshes', async () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 23,
                                id: 'target_temperature',
                                units: '°C',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 23 })],
                }));

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                await deviceManager.setCapability('dev1', 'target_temperature', 16);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    lastLocalWriteMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 23 })],
                }));

                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 16,
                                id: 'target_temperature',
                                units: '°C',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 16 })],
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('uses the latest tracked capability timestamp as the freshness baseline (not wall-clock)', async () => {
            vi.useFakeTimers();
            try {
                await deviceManager.init();
                vi.setSystemTime(new Date('2026-03-20T06:10:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: {
                                value: 1000,
                                id: 'measure_power',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            onoff: {
                                value: true,
                                id: 'onoff',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    lastFreshDataMs: new Date('2026-03-20T05:59:00.000Z').getTime(),
                    lastUpdated: new Date('2026-03-20T05:59:00.000Z').getTime(),
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('preserves fresher power observed from device.update across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                await deviceManager.init();
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: {
                                value: 1000,
                                id: 'measure_power',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 2865, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });

                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    measuredPowerKw: 2.865,
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));

                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: {
                                value: 1000,
                                id: 'measure_power',
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    measuredPowerKw: 2.865,
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));
                expect(loggerMock.debug).toHaveBeenCalledWith(expect.objectContaining({
                    event: 'snapshot_refresh_preserved_newer',
                    source: 'device_update',
                    capabilityId: 'measure_power',
                    deviceId: 'dev1',
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('applies target temperature change from device.update and emits reconcile', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            // device.update with target changed from 20 to 18
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 18, id: 'target_temperature', units: '°C' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            // The target change is applied to the snapshot
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 18 })],
            }));
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                observationSeq: 2,
                observedAtMs: expect.any(Number),
                name: 'Heater',
                changes: [{
                    capabilityId: 'target_temperature',
                    previousValue: '20°C',
                    nextValue: '18°C',
                }],
            }));

            // Subsequent device.update with same value does not trigger reconcile
            realtimeListener.mockClear();
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 18, id: 'target_temperature', units: '°C' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
        });

        it('keeps observable onoff devices when snapshot data omits the boolean value, falls back to currentOn:false and logs the anomaly', async () => {
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            // A binary device whose onoff capability carries no value is a
            // should-never-happen anomaly. The parser no longer fabricates an
            // optimistic true — it resolves honestly to currentOn:false (and
            // still emits no timestamped binary evidence).
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                measuredPowerKw: 1,
                binaryControlObservation: undefined,
                available: false,
                lastFreshDataMs: undefined,
            }));
            expect(resolveCommandableNow(deviceManager.getSnapshot()[0])).toBe(false);
            expect(loggerMock.structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_control_state_dropped',
                reasonCode: 'missing_boolean_onoff',
                source: 'snapshot_parse',
                deviceId: 'dev1',
                deviceName: 'Heater',
                capabilityId: 'onoff',
                rawValue: null,
                rawValueType: 'undefined',
            }));
            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_control_state_fallback',
                reasonCode: 'missing_boolean_onoff',
                deviceId: 'dev1',
                deviceName: 'Heater',
                capabilityId: 'onoff',
                rawValue: null,
                rawValueType: 'undefined',
                fallbackCurrentOn: false,
            }));
        });

        it('updates local state on generic device.update events', async () => {
            // Seed a real timestamped onoff:true baseline so the injected
            // onoff:true below is genuinely a no-change (the shared fixture's
            // value-less onoff would now baseline currentOn:false, making this a
            // spurious false→true change).
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-03-20T05:59:00.000Z' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 2865, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
                measuredPowerKw: 2.865,
                expectedPowerKw: 2.865,
            }));
            expect(realtimeListener).not.toHaveBeenCalled();
        });

        it('records device.update freshness before emitting reconcile', async () => {
            vi.useFakeTimers();
            try {
                await deviceManager.init();
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: {
                                value: 1000,
                                id: 'measure_power',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            onoff: {
                                value: true,
                                id: 'onoff',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                const freshnessSeenAtEmit: Array<number | undefined> = [];
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, () => {
                    freshnessSeenAtEmit.push(deviceManager.getSnapshot()[0]?.lastFreshDataMs);
                });

                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                });

                expect(freshnessSeenAtEmit).toEqual([
                    new Date('2026-03-20T06:05:00.000Z').getTime(),
                ]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('treats ev state-only device.update events as fresh observations', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_paused', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evChargingState: 'plugged_in_paused',
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('turns paused EV device.update payloads off and reconciles when evcharger_charging is false', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { value: true, id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            evDeviceManager.injectDeviceUpdateForTest({
                id: 'ev1',
                name: 'Easee',
                class: 'evcharger',
                capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                capabilitiesObj: {
                    evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                    evcharger_charging_state: { value: 'plugged_in_paused', id: 'evcharger_charging_state' },
                    measure_power: { value: 0, id: 'measure_power' },
                },
            });

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'ev1',
                changes: [expect.objectContaining({
                    capabilityId: 'evcharger_charging',
                    previousValue: 'on',
                    nextValue: 'off',
                })],
            }));
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evCharging: false,
                evChargingState: 'plugged_in_paused',
            }));

            evDeviceManager.destroy();
        });

        it('keeps binary command state unchanged when charging state changes to plugged_out', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_out');

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evChargingState: 'plugged_out',
            }));

            evDeviceManager.destroy();
        });

        it('does not emit a binary reconcile when evcharger_charging_state stays within the same derived on-state', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_paused');

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evChargingState: 'plugged_in_paused',
            }));

            evDeviceManager.destroy();
        });

        it('keeps EV state of charge valid across in-session charging-state changes', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_paused',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 51,
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_charging');

                // The sub-state change post-dates the SoC report by five minutes.
                // No disconnect was observed, so it is the same session and the
                // reading stands — there is no session anchor to move.
                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 51,
                    level: { kind: 'known', percent: 51 },
                }));
                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge?.sessionStartedAtMs).toBeUndefined();

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('accepts a realtime EV state of charge reported on a connected charger', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_battery', 52);

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 52,
                    level: { kind: 'known', percent: 52 },
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('emits observed state for device.update EV state of charge changes without a control-state change', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 51,
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                const liveStateListener = vi.fn();
                const reconcileListener = vi.fn();
                evDeviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: [
                        'evcharger_charging',
                        'evcharger_charging_state',
                        'measure_power',
                        'measure_battery',
                    ],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: {
                            value: 'plugged_in_charging',
                            id: 'evcharger_charging_state',
                        },
                        measure_battery: {
                            id: 'measure_battery',
                            value: 52,
                            lastUpdated: '2026-03-20T06:05:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 52,
                    level: { kind: 'known', percent: 52 },
                    capabilityId: 'measure_battery',
                }));
                expect(liveStateListener).toHaveBeenCalledOnce();
                expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                    source: 'device_update',
                    deviceId: 'ev1',
                    observedCapabilityIds: ['measure_battery'],
                }));
                expect(reconcileListener).not.toHaveBeenCalled();

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('ignores realtime state of charge capability updates for non-EV devices', () => {
            deviceManager.setSnapshotForTests([{
                available: true,
                id: 'sensor1',
                expectedPowerKw: 1, expectedPowerSource: 'default',
                name: 'Battery Sensor',
                deviceClass: 'sensor',
                binaryControl: { on: true },
                targets: [],
                powerCapable: false,
                capabilities: ['measure_battery'],
            }]);

            deviceManager.injectCapabilityUpdateForTest('sensor1', 'measure_battery', 48);

            expect((deviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toBeUndefined();
        });

        it('keeps a raw EV off observation when charging state reports charging', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
            });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', value: false, setable: true },
                        evcharger_charging_state: { value: 'plugged_in_paused', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_charging');

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evCharging: false,
                evChargingState: 'plugged_in_charging',
            }));

            evDeviceManager.destroy();
        });

        it('preserves fresher ev charger state across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: { value: 'plugged_in_paused', id: 'evcharger_charging_state' },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evChargingState: 'plugged_in_paused',
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('preserves the preferred EV state of charge capability across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 55,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_battery', 61);
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_soc_level', 72);

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 55,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 61,
                    capabilityId: 'measure_battery',
                    level: { kind: 'known', percent: 61 },
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('preserves EV state of charge from device.update across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: [
                        'evcharger_charging',
                        'evcharger_charging_state',
                        'measure_power',
                        'measure_battery',
                    ],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: {
                            value: 'plugged_in_charging',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-03-20T06:00:00.000Z',
                        },
                        measure_battery: {
                            id: 'measure_battery',
                            value: 61,
                            lastUpdated: '2026-03-20T06:00:01.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 61,
                    capabilityId: 'measure_battery',
                    level: { kind: 'known', percent: 61 },
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('preserves non-measure-battery EV state of charge from device.update across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: [
                        'evcharger_charging',
                        'evcharger_charging_state',
                        'measure_power',
                        'measure_soc_level',
                    ],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: {
                            value: 'plugged_in_charging',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-03-20T06:00:00.000Z',
                        },
                        measure_soc_level: {
                            id: 'measure_soc_level',
                            value: 61,
                            lastUpdated: '2026-03-20T06:00:01.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 61,
                    capabilityId: 'measure_soc_level',
                    level: { kind: 'known', percent: 61 },
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not preserve EV state of charge when only derived status changes', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    observedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    level: { kind: 'known', percent: 50 },
                }));

                // The level goes because the SESSION ended, not because time
                // passed: a level is retired by a plug-out and by nothing else.
                vi.setSystemTime(new Date('2026-03-20T06:45:00.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: [
                        'evcharger_charging',
                        'evcharger_charging_state',
                        'measure_power',
                        'measure_battery',
                    ],
                    capabilitiesObj: {
                        evcharger_charging: { id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: {
                            value: 'plugged_out',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-03-20T06:44:00.000Z',
                        },
                        measure_battery: {
                            id: 'measure_battery',
                            value: 50,
                            lastUpdated: '2026-03-20T06:00:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });
                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    observedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    level: { kind: 'unavailable', reasonCode: 'not_connected' },
                }));

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    observedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    level: { kind: 'unavailable', reasonCode: 'not_connected' },
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('clears older retained EV state of charge observations for other SoC capabilities', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 55,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_soc_level', 61);
                vi.setSystemTime(new Date('2026-03-20T06:00:02.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_battery', 70);

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 70,
                                lastUpdated: '2026-03-20T06:00:03.000Z',
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 55,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 70,
                    capabilityId: 'measure_battery',
                }));

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                            'measure_soc_level',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 70,
                            },
                            measure_soc_level: {
                                id: 'measure_soc_level',
                                value: 55,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 70,
                    capabilityId: 'measure_battery',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('clears retained EV state of charge after a native snapshot catches up', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_battery', 61);

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 61,
                                lastUpdated: '2026-03-20T06:00:02.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: [
                            'evcharger_charging',
                            'evcharger_charging_state',
                            'measure_power',
                            'measure_battery',
                        ],
                        capabilitiesObj: {
                            evcharger_charging: { id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: {
                                value: 'plugged_in_charging',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T06:00:00.000Z',
                            },
                            measure_battery: {
                                id: 'measure_battery',
                                value: 50,
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });
                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect((evDeviceManager.getSnapshot()[0] as TargetDeviceSnapshot & StateOfChargeObservedProbe).stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    capabilityId: 'measure_battery',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not preserve synthesized ev state from device.update across snapshot refreshes', async () => {
            vi.useFakeTimers();
            try {
                const disconnectedReportedAt = new Date('2026-03-20T05:59:00.000Z').getTime();
                const connectedReportedAt = new Date('2026-03-20T06:00:02.000Z').getTime();
                const flowReportedCapabilities = {
                    evcharger_charging: { value: false, reportedAt: disconnectedReportedAt, source: 'flow' as const },
                    'alarm_generic.car_connected': {
                        value: false,
                        reportedAt: disconnectedReportedAt,
                        source: 'flow' as const,
                    },
                    pels_evcharger_resumable: {
                        value: false,
                        reportedAt: disconnectedReportedAt,
                        source: 'flow' as const,
                    },
                };
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                    getFlowReportedCapabilities: () => flowReportedCapabilities,
                });
                await evDeviceManager.init();

                vi.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Zaptec',
                        class: 'evcharger',
                        capabilities: ['measure_power'],
                        capabilitiesObj: {
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    evChargingState: 'plugged_out',
                }));

                vi.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    capabilities: ['measure_power'],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                flowReportedCapabilities['alarm_generic.car_connected'] = {
                    value: true,
                    reportedAt: connectedReportedAt,
                    source: 'flow',
                };
                flowReportedCapabilities.pels_evcharger_resumable = {
                    value: true,
                    reportedAt: connectedReportedAt,
                    source: 'flow',
                };

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    evChargingState: 'plugged_in_paused',
                }));
                expect(loggerMock.debug).not.toHaveBeenCalledWith(expect.objectContaining({
                    event: 'snapshot_refresh_preserved_newer',
                    capabilityId: 'evcharger_charging_state',
                    deviceId: 'ev1',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not fabricate drift when an accepted write has not changed observed state', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', false);
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));

            // The device still reports the previously observed value.
            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: true },
            }));
        });

        it('publishes matching device.update binary confirmation as observed state', async () => {
            vi.useFakeTimers();
            try {
                mockApiGet.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            onoff: { value: true, id: 'onoff' },
                        },
                    },
                });

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);

                deviceManager.injectDeviceUpdateForTest({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                });

                await vi.advanceTimersByTimeAsync(90_000);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('observes Zaptec raw off independently from a still-charging state', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                    getNativeEvWiringEnabled: () => true,
                });
                await evDeviceManager.init();
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Zaptec',
                        class: 'evcharger',
                        driverId: 'homey:app:com.zaptec:go',
                        ownerUri: 'homey:app:com.zaptec',
                        capabilities: [
                            'measure_power',
                            'charging_button',
                            'charge_mode',
                            'alarm_generic.car_connected',
                        ],
                        capabilitiesObj: {
                            measure_power: { value: 0, id: 'measure_power' },
                            charging_button: { value: true, id: 'charging_button', setable: true },
                            charge_mode: { value: 'Charging', id: 'charge_mode' },
                            'alarm_generic.car_connected': {
                                value: true,
                                id: 'alarm_generic.car_connected',
                            },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: true },
                    binaryCapabilityId: 'evcharger_charging',
                    binaryWriteCapabilityId: 'charging_button',
                }));

                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    driverId: 'homey:app:com.zaptec:go',
                    ownerUri: 'homey:app:com.zaptec',
                    capabilities: [
                        'measure_power',
                        'charging_button',
                        'charge_mode',
                        'alarm_generic.car_connected',
                    ],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                        charging_button: { value: false, id: 'charging_button', setable: true },
                        charge_mode: { value: 'Charging', id: 'charge_mode' },
                        'alarm_generic.car_connected': {
                            value: true,
                            id: 'alarm_generic.car_connected',
                        },
                    },
                });

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evCharging: false,
                    evChargingState: 'plugged_in_charging',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('observes a delayed raw EV off while charging state still says charging', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                    getNativeEvWiringEnabled: () => true,
                });
                await evDeviceManager.init();
                const zaptecPayload = (chargingButton: boolean) => ({
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    driverId: 'homey:app:com.zaptec:go',
                    ownerUri: 'homey:app:com.zaptec',
                    capabilities: [
                        'measure_power',
                        'charging_button',
                        'charge_mode',
                        'alarm_generic.car_connected',
                    ],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                        charging_button: { value: chargingButton, id: 'charging_button', setable: true },
                        charge_mode: { value: 'Charging', id: 'charge_mode' },
                        'alarm_generic.car_connected': {
                            value: true,
                            id: 'alarm_generic.car_connected',
                        },
                    },
                });
                mockApiGet.mockResolvedValue({ ev1: zaptecPayload(true) });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);

                await vi.advanceTimersByTimeAsync(30_000);

                evDeviceManager.injectDeviceUpdateForTest(zaptecPayload(false));

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evCharging: false,
                    evChargingState: 'plugged_in_charging',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps raw EV command evidence when charging state disagrees', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { value: true, id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                            measure_power: { value: 7000, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'plugged_in_charging',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        measure_power: { value: 7000, id: 'measure_power' },
                    },
                });

                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evChargingState: 'plugged_in_charging',
                    binaryControlObservation: {
                        valid: true,
                        capabilityId: 'evcharger_charging',
                        observedValue: false,
                        observedCapabilityIds: ['evcharger_charging'],
                        observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                        source: 'device_update',
                    },
                }));
                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual({
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                    source: 'device_update',
                });

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('records raw EV command evidence even when charging state lacks a timestamp', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                });
                await evDeviceManager.init();
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { value: true, id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: { value: 'plugged_in_charging', id: 'evcharger_charging_state' },
                            measure_power: { value: 7000, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: {
                            value: false,
                            id: 'evcharger_charging',
                            setable: true,
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'plugged_in_paused',
                            id: 'evcharger_charging_state',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evChargingState: 'plugged_in_paused',
                }));
                expect(evDeviceManager.getSnapshot()[0].binaryControlObservation).toEqual(expect.objectContaining({
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                }));
                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(expect.objectContaining({
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('records idempotent raw EV pause confirmation from device.update', async () => {
            vi.useFakeTimers();
            try {
                    const evDeviceManager = new DeviceTransport(homeyMock, loggerMock);
                await evDeviceManager.init();
                mockApiGet.mockResolvedValue({
                    ev1: {
                        id: 'ev1',
                        name: 'Easee',
                        class: 'evcharger',
                        capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                        capabilitiesObj: {
                            evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                            evcharger_charging_state: { value: 'plugged_in_paused', id: 'evcharger_charging_state' },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                const realtimeListener = vi.fn();
                evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                vi.setSystemTime(new Date('2026-04-01T11:59:59.000Z'));
                await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);

                evDeviceManager.injectDeviceUpdateForTest({
                    id: 'ev1',
                    name: 'Easee',
                    class: 'evcharger',
                    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
                    capabilitiesObj: {
                        evcharger_charging: { value: false, id: 'evcharger_charging', setable: true },
                        evcharger_charging_state: {
                            value: 'plugged_in_paused',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T12:00:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                });

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    binaryControl: { on: false },
                    evCharging: false,
                    evChargingState: 'plugged_in_paused',
                    binaryControlObservation: expect.objectContaining({
                        observedValue: false,
                        observedCapabilityIds: ['evcharger_charging'],
                    }),
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('normalizes Zaptec proprietary capability updates at the observation boundary', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
                getNativeEvWiringEnabled: () => true,
                });
            await evDeviceManager.init();
            mockApiGet.mockResolvedValue({
                ev1: {
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    driverId: 'homey:app:com.zaptec:go',
                    ownerUri: 'homey:app:com.zaptec',
                    capabilities: [
                        'measure_power',
                        'charging_button',
                        'charge_mode',
                        'alarm_generic.car_connected',
                    ],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
                        charging_button: { value: true, id: 'charging_button', setable: true },
                        charge_mode: { value: 'Charging', id: 'charge_mode' },
                        'alarm_generic.car_connected': {
                            value: true,
                            id: 'alarm_generic.car_connected',
                        },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            evDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);
            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'charging_button', false);

            expect(realtimeListener).toHaveBeenCalledOnce();
            // The normalized raw echo IS the acknowledgement of the write, so it
            // settles the window here rather than leaving it open for the
            // plug-state. The binary command axis follows the normalized raw
            // readback independently from physical charging state.
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControl: { on: false },
                evChargingState: 'plugged_in_charging',
            }));

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'charge_mode', 'Charging finished');

            // Physical charging state changes independently and does not add a
            // second binary-command transition.
            expect(realtimeListener).toHaveBeenCalledTimes(1);
            expect(realtimeListener.mock.calls[0][0]).toEqual(expect.objectContaining({
                deviceId: 'ev1',
                changes: [expect.objectContaining({
                    capabilityId: 'evcharger_charging',
                    observedCapabilityId: 'evcharger_charging',
                    previousValue: 'on',
                    nextValue: 'off',
                })],
            }));
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                // Finished updates physical charging state independently from
                // the already-observed raw command permission.
                binaryControl: { on: false },
                evChargingState: 'plugged_in',
            }));

            evDeviceManager.destroy();
        });

        it('ignores generic device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: () => false, getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            managedDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 2865, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev1')).toBeUndefined();

            managedDeviceManager.destroy();
        });

        it('does not emit reconcile event for temperature-only generic device changes', async () => {
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
            const realtimeListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff', 'measure_temperature', 'target_temperature'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 1000, id: 'measure_power' },
                    onoff: { value: true, id: 'onoff' },
                    measure_temperature: { value: 23, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();
        });

        it('cleans up live feed and EventEmitter listeners on destroy', async () => {
            await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const planListener = vi.fn();
            deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, planListener);
            expect(deviceManager.listenerCount(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT)).toBe(1);

            deviceManager.destroy();

            // EventEmitter listeners are removed
            expect(deviceManager.listenerCount(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT)).toBe(0);
            // Live feed health is gone after destroy
            expect(deviceManager.getLiveFeedHealth()).toBeNull();
        });

        describe('per-capability realtime updates', () => {
            const buildOnoffDevice = () => ({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['onoff', 'measure_power'],
                    class: 'heater',
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 500, id: 'measure_power' },
                    },
                },
            });
            const buildTempDevice = () => ({
                dev1: {
                    id: 'dev1',
                    name: 'Thermostat',
                    capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
                    class: 'thermostat',
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C', min: 5, max: 40, step: 0.5 },
                        measure_temperature: { value: 20, id: 'measure_temperature' },
                        measure_power: { value: 360, id: 'measure_power' },
                    },
                },
            });

            it('triggers reconcile when onoff is changed externally via capability event', async () => {
                mockApiGet.mockResolvedValue(buildOnoffDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: expect.arrayContaining([
                        expect.objectContaining({ capabilityId: 'onoff' }),
                    ]),
                }));
                expect(deviceManager.getSnapshot().find((d) => d.id === 'dev1')?.binaryControl?.on).toBe(false);
            });

            it('triggers reconcile when target_temperature is changed externally via capability event', async () => {
                mockApiGet.mockResolvedValue(buildTempDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 23.5);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: expect.arrayContaining([
                        expect.objectContaining({ capabilityId: 'target_temperature' }),
                    ]),
                }));
                expect(
                    deviceManager.getSnapshot()
                        .find((d) => d.id === 'dev1')
                        ?.targets.find((t) => t.id === 'target_temperature')?.value,
                ).toBe(23.5);
            });

            it('suppresses capability echo for own recent writes', async () => {
                mockApiGet.mockResolvedValue(buildTempDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                // Simulate PELS writing target_temperature (records a local write)
                mockApiPut.mockResolvedValue({});
                await deviceManager.setCapability('dev1', 'target_temperature', 16);

                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                // Same value echoed back from the live feed — should be suppressed
                deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 16);

                expect(realtimeListener).not.toHaveBeenCalled();
            });

            it('ignores normalized target_temperature echoes until device.update confirms the write', async () => {
                mockApiGet.mockResolvedValue(buildTempDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                mockApiPut.mockResolvedValue({});
                await deviceManager.setCapability('dev1', 'target_temperature', 21.5);

                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 21.49);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(
                    deviceManager.getSnapshot()
                        .find((d) => d.id === 'dev1')
                        ?.targets.find((t) => t.id === 'target_temperature')?.value,
                ).toBe(20);
            });

            it('ignores capability events for untracked devices', async () => {
                mockApiGet.mockResolvedValue(buildOnoffDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                deviceManager.injectCapabilityUpdateForTest('unknown-device', 'onoff', false);

                expect(realtimeListener).not.toHaveBeenCalled();
            });

            it('ignores capability events when value is unchanged', async () => {
                mockApiGet.mockResolvedValue(buildOnoffDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                const realtimeListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

                // Same value as current snapshot state
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

                expect(realtimeListener).not.toHaveBeenCalled();
            });

            it('dedupes identical capability receipt logs within a short window', async () => {
                vi.useFakeTimers();
                try {
                    const debugStructured = vi.fn();
                    deviceManager = new DeviceTransport(homeyMock, loggerMock, undefined, undefined, { debugStructured });
                    mockApiGet.mockResolvedValue(buildTempDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 18);
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 18);
                    vi.advanceTimersByTime(2500);
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 19);

                    const receivedEvents = debugStructured.mock.calls
                        .map(([payload]) => payload)
                        .filter((payload) => payload.event === 'device_capability_event_received');
                    expect(receivedEvents).toHaveLength(2);
                } finally {
                    vi.useRealTimers();
                }
            });

            it('suppresses temperature chatter from capability receipt logs', async () => {
                const debugStructured = vi.fn();
                deviceManager = new DeviceTransport(homeyMock, loggerMock, undefined, undefined, { debugStructured });
                mockApiGet.mockResolvedValue(buildTempDevice());
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);

                expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
                    event: 'device_capability_event_received',
                    capabilityId: 'measure_temperature',
                }));
            });
        });

        describe('tracked capability freshness and reconcile semantics', () => {
            const buildOnoffDevice = () => ({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['onoff', 'measure_power'],
                    class: 'heater',
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:59:00.000Z' },
                        measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:59:00.000Z' },
                    },
                },
            });

            const buildThermostatDevice = () => ({
                dev1: {
                    id: 'dev1',
                    name: 'Thermostat',
                    capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
                    class: 'thermostat',
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:59:00.000Z' },
                        target_temperature: {
                            value: 20,
                            id: 'target_temperature',
                            units: '°C',
                            min: 5,
                            max: 40,
                            step: 0.5,
                            lastUpdated: '2026-04-01T11:59:00.000Z',
                        },
                        measure_temperature: { value: 19, id: 'measure_temperature', units: '°C', lastUpdated: '2026-04-01T11:59:00.000Z' },
                        measure_power: { value: 360, id: 'measure_power', lastUpdated: '2026-04-01T11:59:00.000Z' },
                    },
                },
            });

            it('realtime onoff update advances freshness and triggers reconcile', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildOnoffDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.binaryControl?.on).toBe(false);
                    expect(snapshot.lastFreshDataMs).toBeGreaterThan(freshnessAtRefresh!);
                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'dev1',
                        capabilityId: 'onoff',
                    }));
                    expect(reconcileListener).toHaveBeenCalledOnce();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('realtime target_temperature update advances freshness and triggers reconcile', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 22);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.targets.find((t) => t.id === 'target_temperature')?.value).toBe(22);
                    expect(snapshot.lastFreshDataMs).toBeGreaterThan(freshnessAtRefresh!);
                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'dev1',
                        capabilityId: 'target_temperature',
                    }));
                    expect(reconcileListener).toHaveBeenCalledOnce();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('keeps target_temperature capability echoes suppressed until device.update confirms the write', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                            capabilitiesObj: {
                                measure_power: { value: 1000, id: 'measure_power' },
                                measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                                target_temperature: {
                                    value: 23,
                                    id: 'target_temperature',
                                    units: '°C',
                                },
                                onoff: { value: true, id: 'onoff' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    mockApiPut.mockResolvedValue({});
                    await deviceManager.setCapability('dev1', 'target_temperature', 18);

                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 18);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.targets.find((t) => t.id === 'target_temperature')?.value).toBe(23);
                    expect(snapshot.lastFreshDataMs).toBeUndefined();
                    expect(liveStateListener).not.toHaveBeenCalled();
                    expect(reconcileListener).not.toHaveBeenCalled();

                    deviceManager.injectDeviceUpdateForTest({
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: {
                                value: 18,
                                id: 'target_temperature',
                                units: '°C',
                            },
                            onoff: { value: true, id: 'onoff' },
                        },
                    });

                    expect(deviceManager.getSnapshot()[0].targets.find((t) => t.id === 'target_temperature')?.value)
                        .toBe(18);
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs)
                        .toBe(new Date('2026-04-01T12:01:00.000Z').getTime());
                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        source: 'device_update',
                        deviceId: 'dev1',
                    }));
                } finally {
                    vi.useRealTimers();
                }
            });

            it('realtime measure_power update advances freshness and does not trigger reconcile', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildOnoffDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_power', 2000);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect((snapshot as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBe(2);
                    expect(snapshot.lastFreshDataMs).toBeGreaterThan(freshnessAtRefresh!);
                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'dev1',
                        capabilityId: 'measure_power',
                    }));
                    expect(reconcileListener).not.toHaveBeenCalled();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('realtime measure_power ignores a non-finite reading (present implies finite)', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildOnoffDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_power', 2000);
                    const freshnessBefore = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    // NaN/Infinity are `number`s in JS; the freshness-only seam must
                    // drop them (no write, no freshness bump) so the power sum and
                    // shed decisions never see junk.
                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_power', Number.NaN);
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_power', Number.POSITIVE_INFINITY);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect((snapshot as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBe(2);
                    expect(snapshot.lastFreshDataMs).toBe(freshnessBefore);
                } finally {
                    vi.useRealTimers();
                }
            });

            it('flags when measure_power wakes from insignificant to significant', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            capabilities: ['onoff', 'measure_power'],
                            class: 'heater',
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:59:00.000Z' },
                                measure_power: { value: 0, id: 'measure_power', lastUpdated: '2026-04-01T11:59:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    const liveStateListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_power', 2000);

                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'dev1',
                        capabilityId: 'measure_power',
                        measurePowerBecameSignificantlyPositive: true,
                    }));
                } finally {
                    vi.useRealTimers();
                }
            });

            it('realtime measure_temperature update advances freshness and does not trigger reconcile', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);

                    const snapshot = deviceManager.getSnapshot()[0] as TargetDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe;
                    if (!hasObservedTemperature(snapshot)) throw new Error('expected observed temperature');
                    expect(snapshot.temperature.currentTemperature).toBe(21);
                    expect(snapshot.temperature.target.value).toBe(20);
                    expect(snapshot.lastFreshDataMs).toBeGreaterThan(freshnessAtRefresh!);
                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'dev1',
                        capabilityId: 'measure_temperature',
                    }));
                    expect(reconcileListener).not.toHaveBeenCalled();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('realtime measure_temperature removes the complete temperature facet on a non-finite reading', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);
                    const freshnessBefore = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    // Keep the targeted recovery pull malformed too, so this assertion
                    // observes the boundary state rather than immediately recovering.
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            ...buildThermostatDevice().dev1,
                            capabilitiesObj: {
                                ...buildThermostatDevice().dev1.capabilitiesObj,
                                measure_temperature: { value: Number.NaN, id: 'measure_temperature' },
                            },
                        },
                    });
                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', Number.NaN);

                    const snapshot = deviceManager.getSnapshot()[0] as TargetDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe;
                    expect(hasObservedTemperature(snapshot)).toBe(false);
                    expect(snapshot.targets).not.toContainEqual(expect.objectContaining({ id: 'target_temperature' }));
                    expect(snapshot.deviceType).toBe('onoff');
                    expect(snapshot.binaryControl).toEqual({ on: true });
                    expect(snapshot.lastFreshDataMs).toBe(freshnessBefore);
                    expect(liveStateListener).toHaveBeenCalledWith(expect.objectContaining({
                        deviceId: 'dev1',
                        capabilityId: 'measure_temperature',
                    }));
                    expect(reconcileListener).toHaveBeenCalledWith(expect.objectContaining({
                        deviceId: 'dev1',
                        changes: [expect.objectContaining({
                            capabilityId: 'target_temperature',
                            nextValue: 'absent',
                        })],
                    }));

                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const refreshed = deviceManager.getSnapshot()[0] as TransportDeviceSnapshot;
                    expect(hasObservedTemperature(refreshed)).toBe(false);
                    expect(refreshed.lastFreshDataMs).toBe(freshnessBefore);
                } finally {
                    vi.useRealTimers();
                }
            });

            it.each([
                { capabilityId: 'measure_temperature', validValue: 21 },
                { capabilityId: 'target_temperature', validValue: 22 },
            ] as const)(
                'recovers the atomic temperature facet after $capabilityId becomes valid again',
                async ({ capabilityId, validValue }) => {
                    await deviceManager.init();
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const reconcileListener = vi.fn();
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', capabilityId, Number.NaN);
                    expect(hasObservedTemperature(
                        deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                    )).toBe(false);

                    deviceManager.injectCapabilityUpdateForTest('dev1', capabilityId, validValue);

                    await vi.waitFor(() => {
                        const recovered = deviceManager.getSnapshot()[0] as TransportDeviceSnapshot;
                        expect(hasObservedTemperature(recovered)).toBe(true);
                    });
                    const recovered = deviceManager.getSnapshot()[0] as TransportDeviceSnapshot;
                    if (!hasObservedTemperature(recovered)) throw new Error('expected recovered temperature facet');
                    expect(Number.isFinite(recovered.temperature.currentTemperature)).toBe(true);
                    expect(Number.isFinite(recovered.temperature.target.value)).toBe(true);
                    expect(reconcileListener).toHaveBeenCalledTimes(2);
                },
            );

            it('keeps recovery pending across two stale pulls until a later coherent refresh', async () => {
                await deviceManager.init();
                const validDevices = buildThermostatDevice();
                const staleDevices = {
                    dev1: {
                        ...validDevices.dev1,
                        capabilitiesObj: {
                            ...validDevices.dev1.capabilitiesObj,
                            measure_temperature: { value: Number.NaN, id: 'measure_temperature' },
                        },
                    },
                };
                mockApiGet.mockResolvedValue(staleDevices);
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(hasObservedTemperature(
                    deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                )).toBe(false);

                mockApiGet.mockClear();
                let targetedReadCount = 0;
                mockApiGet.mockImplementation(async (path: string) => {
                    if (path === 'manager/devices/device/dev1') {
                        targetedReadCount += 1;
                        return staleDevices.dev1;
                    }
                    return validDevices;
                });
                const reconcileListener = vi.fn();
                deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);
                const refreshSpy = vi.spyOn(deviceManager, 'refreshSnapshot');
                deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);

                await vi.waitFor(() => {
                    expect(refreshSpy).toHaveBeenCalledWith({
                        targetedRefresh: true,
                        mainMeterSelection: expect.anything(),
                    });
                });
                const firstRefresh = refreshSpy.mock.results[0];
                if (!firstRefresh) throw new Error('Expected an opportunistic recovery refresh');
                await firstRefresh.value;
                expect(hasObservedTemperature(
                    deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                )).toBe(false);
                await deviceManager.refreshSnapshot({ targetedRefresh: true, mainMeterSelection: { state: 'unavailable' } });
                expect(targetedReadCount).toBe(2);
                expect(hasObservedTemperature(
                    deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                )).toBe(false);

                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                expect(hasObservedTemperature(
                    deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                )).toBe(true);
                expect(reconcileListener).toHaveBeenCalledOnce();
            });

            it('retires malformed rejection evidence only when a known newer finite pull arrives', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    const validDevices = buildThermostatDevice();
                    mockApiGet.mockResolvedValue(validDevices);
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', Number.NaN);
                    expect(hasObservedTemperature(
                        deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                    )).toBe(false);

                    const newerDevices = {
                        dev1: {
                            ...validDevices.dev1,
                            capabilitiesObj: {
                                ...validDevices.dev1.capabilitiesObj,
                                measure_temperature: {
                                    ...validDevices.dev1.capabilitiesObj.measure_temperature,
                                    value: 20,
                                    lastUpdated: '2026-04-01T12:02:00.000Z',
                                },
                            },
                        },
                    };
                    vi.setSystemTime(new Date('2026-04-01T12:03:00.000Z'));
                    mockApiGet.mockResolvedValue(newerDevices);
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    expect(hasObservedTemperature(
                        deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                    )).toBe(true);

                    mockApiGet.mockResolvedValue(validDevices);
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    expect(hasObservedTemperature(
                        deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                    )).toBe(true);
                } finally {
                    vi.useRealTimers();
                }
            });

            it('drops a temperature-only device on malformed realtime data and recovers it when valid again', async () => {
                await deviceManager.init();
                const thermostat = buildThermostatDevice().dev1;
                const { onoff: _onoff, ...temperatureCapabilities } = thermostat.capabilitiesObj;
                const temperatureOnlyDevice = {
                    dev1: {
                        ...thermostat,
                        capabilities: thermostat.capabilities.filter((capabilityId) => capabilityId !== 'onoff'),
                        capabilitiesObj: temperatureCapabilities,
                    },
                };
                mockApiGet.mockResolvedValue(temperatureOnlyDevice);
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(hasObservedTemperature(
                    deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                )).toBe(true);

                deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', Number.NaN);
                expect(deviceManager.getSnapshot()).toEqual([]);

                // Homey may serve a cached finite pair after the newer malformed
                // realtime observation. The retained rejection must win even
                // though removing this temperature-only device also removed its
                // previous snapshot entry.
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(deviceManager.getSnapshot()).toEqual([]);

                const { lastUpdated: _lastUpdated, ...measurementWithoutFreshness } = temperatureCapabilities.measure_temperature;
                mockApiGet.mockResolvedValue({
                    dev1: {
                        ...temperatureOnlyDevice.dev1,
                        capabilitiesObj: {
                            ...temperatureCapabilities,
                            measure_temperature: measurementWithoutFreshness,
                        },
                    },
                });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                expect(deviceManager.getSnapshot()).toEqual([]);

                deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);
                await vi.waitFor(() => {
                    expect(hasObservedTemperature(
                        deviceManager.getSnapshot()[0] as TransportDeviceSnapshot,
                    )).toBe(true);
                });
            });

            it('includes an evicted temperature-only device in its targeted recovery fetch', async () => {
                await deviceManager.init();
                const thermostat = buildThermostatDevice().dev1;
                const { onoff: _onoff, ...temperatureCapabilities } = thermostat.capabilitiesObj;
                const temperatureOnlyDevice = {
                    ...thermostat,
                    capabilities: thermostat.capabilities.filter((capabilityId) => capabilityId !== 'onoff'),
                    capabilitiesObj: temperatureCapabilities,
                };
                const binarySurvivor = {
                    id: 'dev2',
                    name: 'Binary survivor',
                    class: 'socket',
                    capabilities: ['onoff', 'measure_power'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                        measure_power: { value: 500, id: 'measure_power' },
                    },
                };
                mockApiGet.mockResolvedValue({ dev1: temperatureOnlyDevice, dev2: binarySurvivor });
                await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', Number.NaN);
                expect(deviceManager.getSnapshot().map(snapshotDeviceId)).toEqual(['dev2']);

                mockApiGet.mockImplementation(async (path: string) => {
                    if (path === 'manager/devices/device/dev1') return temperatureOnlyDevice;
                    if (path === 'manager/devices/device/dev2') return binarySurvivor;
                    throw new Error(`Unexpected recovery path: ${path}`);
                });
                deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);

                await vi.waitFor(() => {
                    const recovered = findSnapshotDevice(
                        deviceManager.getSnapshot(),
                        'dev1',
                    ) as TransportDeviceSnapshot | undefined;
                    expect(recovered === undefined ? false : hasObservedTemperature(recovered)).toBe(true);
                });
                expect(mockApiGet).toHaveBeenCalledWith('manager/devices/device/dev1');
            });

            it('local writes do not advance freshness', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    mockApiPut.mockResolvedValue({});

                    // Local onoff write
                    await deviceManager.setCapability('dev1', 'onoff', false);
                    expect(deviceManager.getSnapshot()[0].binaryControl?.on).toBe(true);
                    expect(deviceManager.getSnapshot()[0].lastLocalWriteMs).toBe(
                        new Date('2026-04-01T12:01:00.000Z').getTime(),
                    );
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAtRefresh);

                    vi.setSystemTime(new Date('2026-04-01T12:02:00.000Z'));

                    // Local target_temperature write stays pending until a confirmation observation.
                    await deviceManager.setCapability('dev1', 'target_temperature', 18);
                    expect(deviceManager.getSnapshot()[0].targets.find((t) => t.id === 'target_temperature')?.value).toBe(20);
                    expect(deviceManager.getSnapshot()[0].lastLocalWriteMs).toBe(
                        new Date('2026-04-01T12:02:00.000Z').getTime(),
                    );
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAtRefresh);
                } finally {
                    vi.useRealTimers();
                }
            });

            it('snapshot refresh does not advance lastFreshDataMs when retained observations are older than current time', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: {
                                    value: true,
                                    id: 'onoff',
                                    lastUpdated: '2026-04-01T11:59:00.000Z',
                                },
                                measure_power: {
                                    value: 500,
                                    id: 'measure_power',
                                    lastUpdated: '2026-04-01T11:59:00.000Z',
                                },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    // Realtime onoff event at T1 — establishes in-memory observation
                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
                    const freshnessAfterRealtime = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(freshnessAfterRealtime).toBe(new Date('2026-04-01T12:01:00.000Z').getTime());

                    // Advance wall-clock time well past T1 before the next snapshot refresh
                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: {
                                    value: false,
                                    id: 'onoff',
                                    lastUpdated: '2026-04-01T11:59:30.000Z',
                                },
                                measure_power: {
                                    value: 500,
                                    id: 'measure_power',
                                    lastUpdated: '2026-04-01T11:59:30.000Z',
                                },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    // lastFreshDataMs must NOT advance to the refresh wall-clock time (12:10)
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterRealtime);
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).not.toBe(
                        new Date('2026-04-01T12:10:00.000Z').getTime(),
                    );
                } finally {
                    vi.useRealTimers();
                }
            });

            it('snapshot refresh does not advance freshness when no retained observations and tracked timestamps unchanged', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    // Initial refresh: tracked capabilities have T0 timestamps
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:55:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAfterFirstRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(freshnessAfterFirstRefresh).toBe(new Date('2026-04-01T11:55:00.000Z').getTime());

                    // Advance wall clock; second refresh with same (no newer) tracked timestamps — no retained obs
                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:55:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    // Must stay at T0, not advance to wall-clock (12:10)
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterFirstRefresh);
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).not.toBe(
                        new Date('2026-04-01T12:10:00.000Z').getTime(),
                    );
                } finally {
                    vi.useRealTimers();
                }
            });

            it('snapshot refresh preserves a fresher unknown target reading from device_update', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    expect(deviceManager.getSnapshot()[0].targets.find((t) => t.id === 'target_temperature')?.value).toBe(20);

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    deviceManager.injectDeviceUpdateForTest({
                        id: 'dev1',
                        name: 'Thermostat',
                        class: 'thermostat',
                        capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
                        capabilitiesObj: {
                            onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T12:01:00.000Z' },
                            target_temperature: {
                                value: 'unknown' as unknown as number,
                                id: 'target_temperature',
                                units: '°C',
                                min: 5,
                                max: 40,
                                step: 0.5,
                            },
                            measure_temperature: { value: 19, id: 'measure_temperature', units: '°C', lastUpdated: '2026-04-01T12:01:00.000Z' },
                            measure_power: { value: 360, id: 'measure_power', lastUpdated: '2026-04-01T12:01:00.000Z' },
                        },
                    });

                    expect(deviceManager.getSnapshot()[0].targets.find((t) => t.id === 'target_temperature')?.value).toBeUndefined();

                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Thermostat',
                            capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
                            class: 'thermostat',
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:59:30.000Z' },
                                target_temperature: {
                                    value: 20,
                                    id: 'target_temperature',
                                    units: '°C',
                                    min: 5,
                                    max: 40,
                                    step: 0.5,
                                    lastUpdated: '2026-04-01T11:59:30.000Z',
                                },
                                measure_temperature: { value: 19, id: 'measure_temperature', units: '°C', lastUpdated: '2026-04-01T11:59:30.000Z' },
                                measure_power: { value: 360, id: 'measure_power', lastUpdated: '2026-04-01T11:59:30.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    expect(deviceManager.getSnapshot()[0].targets.find((t) => t.id === 'target_temperature')?.value).toBeUndefined();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('snapshot refresh advances freshness when a tracked capability has a newer timestamp', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    // Initial refresh: tracked capabilities have T0 timestamps
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:55:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAfterFirstRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(freshnessAfterFirstRefresh).toBe(new Date('2026-04-01T11:55:00.000Z').getTime());

                    // Second refresh: measure_power has a newer timestamp T1 > T0
                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 600, id: 'measure_power', lastUpdated: '2026-04-01T12:05:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    // Must advance to T1 (the newer tracked capability timestamp)
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(
                        new Date('2026-04-01T12:05:00.000Z').getTime(),
                    );
                } finally {
                    vi.useRealTimers();
                }
            });

            it('snapshot refresh ignores newer timestamps on untracked capabilities', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    // Initial refresh: tracked capabilities have T0 timestamps
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power', 'alarm_battery'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                alarm_battery: { value: false, id: 'alarm_battery', lastUpdated: '2026-04-01T11:55:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAfterFirstRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(freshnessAfterFirstRefresh).toBe(new Date('2026-04-01T11:55:00.000Z').getTime());

                    // Second refresh: only alarm_battery (untracked) has a newer timestamp
                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power', 'alarm_battery'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                alarm_battery: { value: true, id: 'alarm_battery', lastUpdated: '2026-04-01T12:08:00.000Z' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    // Must stay at T0 — alarm_battery is untracked so its newer timestamp is ignored
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterFirstRefresh);
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).not.toBe(
                        new Date('2026-04-01T12:08:00.000Z').getTime(),
                    );
                } finally {
                    vi.useRealTimers();
                }
            });

            it('preserves previous currentOn but does not refresh freshness when onoff disappears without other signs of life', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: {
                                    value: true,
                                    id: 'onoff',
                                    lastUpdated: '2026-04-01T11:59:00.000Z',
                                },
                                measure_power: {
                                    value: 1000,
                                    id: 'measure_power',
                                    lastUpdated: '2026-04-01T11:59:00.000Z',
                                },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAfterFirstRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(deviceManager.getSnapshot()[0].binaryControl?.on).toBe(true);

                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: {
                                    id: 'onoff',
                                    lastUpdated: '2026-04-01T12:10:00.000Z',
                                },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ targetedRefresh: true, mainMeterSelection: { state: 'unavailable' } });

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.binaryControl?.on).toBe(true);
                    expect(snapshot.lastFreshDataMs).toBe(freshnessAfterFirstRefresh);
                    expect(snapshot.lastFreshDataMs).not.toBe(new Date('2026-04-01T12:10:00.000Z').getTime());
                    expect(loggerMock.structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                        event: 'device_snapshot_control_state_dropped',
                        reasonCode: 'missing_boolean_onoff',
                        deviceId: 'dev1',
                        capabilityId: 'onoff',
                    }));
                } finally {
                    vi.useRealTimers();
                }
            });

            it('preserves previous currentOn while accepting fresh non-binary evidence from the same device update', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: {
                                    value: false,
                                    id: 'onoff',
                                    lastUpdated: '2026-04-01T11:59:00.000Z',
                                },
                                measure_power: {
                                    value: 0,
                                    id: 'measure_power',
                                    lastUpdated: '2026-04-01T11:59:00.000Z',
                                },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const reconcileListener = vi.fn();
                    deviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, reconcileListener);

                    deviceManager.injectDeviceUpdateForTest({
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['onoff', 'measure_power'],
                        capabilitiesObj: {
                            onoff: { value: 'unknown' as unknown as boolean, id: 'onoff' },
                            measure_power: { value: 500, id: 'measure_power' },
                        },
                    });

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.binaryControl?.on).toBe(false);
                    expect((snapshot as TargetDeviceSnapshot & MeasuredPowerObservedProbe).measuredPowerKw).toBe(0.5);
                    expect(snapshot.lastFreshDataMs).toBe(new Date('2026-04-01T12:01:00.000Z').getTime());
                    expect(snapshot.binaryControlObservation).toBeUndefined();
                    expect(reconcileListener).not.toHaveBeenCalled();
                    expect(loggerMock.structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                        event: 'binary_settle_evidence_cleared',
                        reasonCode: 'invalid_control_payload',
                        deviceId: 'dev1',
                        capabilityId: 'onoff',
                        source: 'device_update',
                    }));
                } finally {
                    vi.useRealTimers();
                }
            });
        });

        describe('stale-targeted refresh freshness policy', () => {
            // Builds a mock that returns the right shape for both the full-device-list path
            // (manager/devices/device → Record<id, device>) and the per-device path used by
            // targeted fetch (manager/devices/device/{id} → device object directly).
            const buildPathAwareMock = (deviceData: Record<string, unknown>) =>
                async (path: string) => {
                    const perDevicePrefix = 'manager/devices/device/';
                    if (path.startsWith(perDevicePrefix)) {
                        const id = path.slice(perDevicePrefix.length);
                        return deviceData[id] ?? null;
                    }
                    return deviceData;
                };

            it('advances freshness when any tracked capability lastUpdated advances on a refresh', async () => {
                // Device-level liveness: a single capability reporting recently is enough
                // to prove the device is online for the whole device.
                vi.useFakeTimers();
                try {
                    await deviceManager.init();

                    const initialAt = new Date('2026-04-01T11:55:00.000Z').toISOString();
                    const deviceData = {
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: initialAt },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: initialAt },
                            },
                        },
                    };
                    mockApiGet.mockImplementation(buildPathAwareMock(deviceData));

                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(new Date(initialAt).getTime());

                    // measure_power gets a new lastUpdated; onoff stays at the old value.
                    const updatedAt = new Date('2026-04-01T12:05:00.000Z').toISOString();
                    deviceData.dev1.capabilitiesObj.measure_power.lastUpdated = updatedAt;
                    vi.setSystemTime(new Date('2026-04-01T12:06:00.000Z'));
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(new Date(updatedAt).getTime());
                } finally {
                    vi.useRealTimers();
                }
            });

            it('does not fabricate freshness when a targeted refresh sees unchanged capability timestamps', async () => {
                // Homey serves cached capability values even when the device has been silent
                // for hours. A successful poll is not by itself evidence the device is alive;
                // only Homey's per-capability `lastUpdated` proves new observation. The
                // Silence is not a fault: a driver only republishes on value change.
                vi.useFakeTimers();
                try {
                    await deviceManager.init();

                    const deviceData = {
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { value: true, id: 'onoff', lastUpdated: '2026-04-01T11:55:00.000Z' },
                                measure_power: { value: 500, id: 'measure_power', lastUpdated: '2026-04-01T11:55:00.000Z' },
                            },
                        },
                    };
                    mockApiGet.mockImplementation(buildPathAwareMock(deviceData));

                    // Initial refresh — freshness comes from tracked capability timestamps
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    const freshnessAfterInit = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(freshnessAfterInit).toBe(new Date('2026-04-01T11:55:00.000Z').getTime());

                    // Advance 6 minutes — device's capability timestamps still report 11:55.
                    vi.setSystemTime(new Date('2026-04-01T12:06:00.000Z'));

                    // Normal refresh with unchanged timestamps: freshness must NOT advance.
                    await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterInit);

                    // Targeted refresh with unchanged timestamps: also must NOT advance —
                    // the poll itself is not evidence the device communicated.
                    await deviceManager.refreshSnapshot({ targetedRefresh: true, mainMeterSelection: { state: 'unavailable' } });
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterInit);
                } finally {
                    vi.useRealTimers();
                }
            });

            it('preserves the parsed lastFreshDataMs across merge when no new capability evidence arrived', () => {
                // The merge step never fabricates freshness on its own. The snapshot's
                // `lastFreshDataMs` is already set by `parseDevice` from Homey's per-capability
                // `lastUpdated`, and the merge only carries forward fresher prior observations.
                const observationState = createObservationState();
                const initialFreshAt = new Date('2026-04-01T11:55:00.000Z').getTime();
                const previousSnapshot: (TransportDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe)[] = [{
                    available: true,
                    id: 'ev1',
                    expectedPowerKw: 1, expectedPowerSource: 'default',
                    name: 'Zaptec',
                    deviceClass: 'evcharger',
                    capabilities: ['evcharger_charging'],
                    binaryControl: { on: true },
                binaryCapabilityId: 'evcharger_charging',
                    targets: [],
                    powerCapable: false,
                    lastFreshDataMs: initialFreshAt,
                }];
                const nextSnapshot: (TransportDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe)[] = [{
                    ...previousSnapshot[0],
                    binaryControlObservation: {
                        valid: true,
                        capabilityId: 'evcharger_charging',
                        observedValue: true,
                        observedCapabilityIds: ['evcharger_charging'],
                        observedAtMs: initialFreshAt,
                        source: 'snapshot_refresh',
                    },
                }];
                const sourceDevice: HomeyDeviceLike = {
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    capabilities: ['charge_mode'],
                    capabilitiesObj: {
                        charge_mode: { value: 'active' },
                    },
                };

                mergeFresherCapabilityObservations({
                    state: observationState,
                    previousSnapshot,
                    nextSnapshot,
                    devices: [sourceDevice],
                    logger: loggerMock,
                });

                expect(nextSnapshot[0].lastFreshDataMs).toBe(initialFreshAt);
                expect(nextSnapshot[0].lastUpdated).toBe(initialFreshAt);
            });

            it('preserves a newer exact target-power observation over an older refresh', () => {
                const observationState = createObservationState();
                const realtimeObservedAtMs = new Date('2026-04-01T12:00:00.000Z').getTime();
                const refreshObservedAtMs = new Date('2026-04-01T11:59:00.000Z').getTime();
                const previousSnapshot: TransportDeviceSnapshot[] = [{
                    available: true,
                    id: 'ev1',
                    expectedPowerKw: 1, expectedPowerSource: 'default',
                    name: 'Zaptec',
                    deviceClass: 'evcharger',
                    capabilities: ['target_power'],
                    targets: [],
                    powerCapable: false,
                    reportedStepId: '25a',
                    reportedStepPowerW: 5750,
                    reportedStepObservedAtMs: realtimeObservedAtMs,
                }];
                const nextSnapshot: TransportDeviceSnapshot[] = [{
                    ...previousSnapshot[0],
                    reportedStepId: '24a',
                    reportedStepPowerW: 5520,
                    reportedStepObservedAtMs: refreshObservedAtMs,
                }];
                const sourceDevice: HomeyDeviceLike = {
                    id: 'ev1',
                    name: 'Zaptec',
                    class: 'evcharger',
                    capabilities: ['target_power'],
                    capabilitiesObj: {
                        target_power: {
                            value: 5520,
                            lastUpdated: new Date(refreshObservedAtMs).toISOString(),
                        },
                    },
                };

                mergeFresherCapabilityObservations({
                    state: observationState,
                    previousSnapshot,
                    nextSnapshot,
                    devices: [sourceDevice],
                    logger: loggerMock,
                });

                expect(nextSnapshot[0]).toMatchObject({
                    reportedStepId: '25a',
                    reportedStepPowerW: 5750,
                    reportedStepObservedAtMs: realtimeObservedAtMs,
                });
            });
        });

        it('ignores device.update events for a device that stops being managed', async () => {
            const managedState: Record<string, boolean> = { dev1: true };
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true, getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            managedState.dev1 = false;
            await managedDeviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });

            const realtimeListener = vi.fn();
            managedDeviceManager.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, realtimeListener);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['measure_power', 'onoff'],
                class: 'heater',
                capabilitiesObj: {
                    measure_power: { value: 5000, id: 'measure_power' },
                    onoff: { value: false, id: 'onoff' },
                },
            });

            expect(realtimeListener).not.toHaveBeenCalled();

            managedDeviceManager.destroy();
        });
    });
});
