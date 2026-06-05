import { DeviceTransport, type DeviceTransportBinarySettleOps, PLAN_LIVE_STATE_OBSERVED_EVENT, PLAN_RECONCILE_REALTIME_UPDATE_EVENT } from '../../lib/device/deviceTransport';
import {
    createObservationState,
    mergeFresherCapabilityObservations,
} from '../../lib/device/transport/managerObservation';
import {
    clearAllPendingBinarySettleWindows,
    clearPendingBinarySettleWindow,
    createBinarySettleState,
    hasPendingBinarySettleWindow,
    notePendingBinarySettleObservation,
    startPendingBinarySettleWindow,
} from '../../lib/observer/binarySettle';
import type { LiveFeedHealth } from '../../lib/device/liveFeed';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { isManagedFilterActive } from '../../lib/app/appDeviceSupport';
import {
    mockHomeyInstance,
} from '../mocks/homey';
import Homey from 'homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';

// Real observer binarySettle ops + state — only the EV settle tests below
// need these (transport's default is inert; production wiring DIs them).
function withRealBinarySettle() {
    const state = createBinarySettleState();
    const ops: DeviceTransportBinarySettleOps = {
        start: startPendingBinarySettleWindow,
        note: notePendingBinarySettleObservation,
        hasWindow: hasPendingBinarySettleWindow,
        clear: clearPendingBinarySettleWindow,
        clearAll: clearAllPendingBinarySettleWindows,
    };
    return { binarySettleState: state, binarySettleOps: ops };
}

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
    await transport.refreshSnapshot();
    expect(transport.getSnapshot()).toHaveLength(1);
}

describe('DeviceTransport', () => {
    let deviceManager: DeviceTransport;
    let homeyMock: Homey.App;
    let loggerMock: {
        log: vi.Mock;
        debug: vi.Mock;
        error: vi.Mock;
        structuredLog: { info: vi.Mock; error: vi.Mock; debug: vi.Mock; warn: vi.Mock };
    };
    let debugStructuredMock: vi.Mock;

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
            },
        };
        debugStructuredMock = vi.fn();
        deviceManager = new DeviceTransport(
            homeyMock,
            loggerMock,
            undefined,
            undefined,
            { debugStructured: debugStructuredMock, ...withRealBinarySettle() },
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
            const savedApi = (homeyMock as any).api;
            (homeyMock as any).api = undefined;
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
            (homeyMock as any).api = savedApi;
        });
    });

    describe('parseDeviceListForTests', () => {
        it('materializes the representative thermostat snapshot shape unchanged', () => {
            const parsingDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getPriority: (deviceId) => (deviceId === 'thermo-1' ? 7 : 0),
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
                priority: 7,
                controllable: true,
                managed: true,
                budgetExempt: true,
                controlCapabilityId: 'onoff',
                currentOn: false,
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'onoff',
                    observedValue: false,
                    observedCapabilityIds: ['onoff'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
                currentTemperature: 19.5,
                canSetControl: true,
                available: false,
                powerCapable: true,
                powerKw: 0.9,
                measuredPowerKw: 0.73,
                expectedPowerKw: 0.9,
                expectedPowerSource: 'load-setting',
                loadKw: 0.9,
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

        it('drops devices with invalid onoff telemetry when no previous observation can be preserved', () => {
            const parsed = deviceManager.parseDeviceListForTests([{
                id: 'thermo-2',
                name: 'Bedroom Thermostat',
                class: 'thermostat',
                capabilities: ['onoff', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    onoff: { value: 'unexpected', id: 'onoff' },
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
                controlCapabilityId: 'onoff',
                currentOn: false,
                binaryControlObservation: undefined,
            }));
        });

        it('ignores dotted power sub-capabilities when resolving measured power', () => {
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'socket-subcap',
                name: 'Socket With Internal Power',
                class: 'socket',
                capabilities: ['onoff', 'measure_power.internal'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    'measure_power.internal': {
                        value: 730,
                        id: 'measure_power.internal',
                        lastUpdated: '2026-04-01T11:53:00.000Z',
                    },
                },
                settings: { load: 900 },
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'socket-subcap',
                powerCapable: true,
                measuredPowerKw: undefined,
                expectedPowerSource: 'load-setting',
                powerKw: 0.9,
            }));
        });

        it('keeps temperature devices when target capability values are malformed and preserves an unknown current target', () => {
            const [parsed] = deviceManager.parseDeviceListForTests([{
                id: 'thermo-invalid-target',
                name: 'Broken Thermostat',
                class: 'thermostat',
                capabilities: ['measure_temperature', 'target_temperature', 'onoff'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: '21', id: 'target_temperature', units: '°C', min: 5, max: 35, step: 0.5 },
                },
            }]);

            expect(parsed).toEqual(expect.objectContaining({
                id: 'thermo-invalid-target',
                deviceType: 'temperature',
                targets: [expect.objectContaining({
                    id: 'target_temperature',
                    min: 5,
                    max: 35,
                    step: 0.5,
                })],
            }));
            expect(loggerMock.debug).toHaveBeenCalledWith(
                expect.stringContaining('Skipping malformed target_temperature value for Broken Thermostat (thermo-invalid-target)'),
            );
        });

        it('skips partial temperature devices that are missing measure_temperature', () => {
            const parsed = deviceManager.parseDeviceListForTests([{
                id: 'bad-thermo',
                name: 'Broken Thermostat',
                class: 'thermostat',
                capabilities: ['onoff', 'target_temperature'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff' },
                    target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
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
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot();
            const ids = dm.getSnapshot().map((d) => d.id);
            expect(ids).toEqual(['dev1']);
            dm.destroy();
        });

        it('keeps unmanaged devices in the runtime snapshot when no device is explicitly managed (fresh-install)', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getManaged: () => false,
                isManagedFilterActive: () => false,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot();
            const ids = dm.getSnapshot().map((d) => d.id);
            expect(ids.sort()).toEqual(['dev1', 'dev2']);
            dm.destroy();
        });

        it('does not emit device_snapshot_control_state_dropped errors for unmanaged devices with malformed onoff', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                badDev: buildDevice('badDev', null),
            });
            loggerMock.structuredLog.error.mockClear();
            await dm.refreshSnapshot();
            const dropEvents = loggerMock.structuredLog.error.mock.calls
                .filter(([payload]: [unknown]) => (payload as { event?: string })?.event === 'device_snapshot_control_state_dropped');
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
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
                badDev: buildDevice('badDev', null),
            });
            await dm.refreshSnapshot();
            loggerMock.structuredLog.error.mockClear();
            const picker = dm.getUiPickerDevices();
            const ids = picker.map((d) => d.id).sort();
            expect(ids).toEqual(['badDev', 'dev2']);
            const dropEvents = loggerMock.structuredLog.error.mock.calls
                .filter(([payload]: [unknown]) => (payload as { event?: string })?.event === 'device_snapshot_control_state_dropped');
            expect(dropEvents).toEqual([]);
            dm.destroy();
        });

        it('keeps unmanaged-eligible devices visible after a targeted refresh that fetches managed-only ids', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot();
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);

            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', false),
            });
            await dm.refreshSnapshot({ targetedRefresh: true });

            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);
            dm.destroy();
        });

        it('does not empty the picker on a single transient empty SDK read', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot();
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['dev2']);

            // A transient empty read is deferred by abandon-grace: the raw-device
            // cache backing the picker must survive the blip, not collapse to [].
            mockApiGet.mockResolvedValue({});
            await dm.refreshSnapshot();

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
                getManaged: (deviceId) => explicitDecisions[deviceId] === true,
                isManagedFilterActive: () => isManagedFilterActive(explicitDecisions),
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                dev2: buildDevice('dev2', true),
            });
            await dm.refreshSnapshot();
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
                getManaged: (deviceId) => managedFlags[deviceId] === true,
                isManagedFilterActive: () => Object.values(managedFlags).some((v) => v === true),
            });
            await dm.init();
            mockApiGet.mockResolvedValue({
                dev1: buildDevice('dev1', true),
                badDev: buildDevice('badDev', null),
            });
            await dm.refreshSnapshot();
            expect(dm.getSnapshot().map((d) => d.id)).toEqual(['dev1']);
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual(['badDev']);
            dm.destroy();
        });

        it('does not duplicate a previously-valid managed device into the picker on transient malformed onoff', async () => {
            const dm = new DeviceTransport(homeyMock, loggerMock, {
                getManaged: (deviceId) => deviceId === 'dev1',
                isManagedFilterActive: () => true,
            });
            await dm.init();
            mockApiGet.mockResolvedValue({ dev1: buildDevice('dev1', true) });
            await dm.refreshSnapshot();
            expect(dm.getSnapshot().map((d) => d.id)).toEqual(['dev1']);
            expect(dm.getUiPickerDevices().map((d) => d.id)).toEqual([]);

            mockApiGet.mockResolvedValue({ dev1: buildDevice('dev1', null) });
            await dm.refreshSnapshot();
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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(2);
            const heater = findSnapshotDevice(snapshot, 'dev1');
            const light = findSnapshotDevice(snapshot, 'dev2');
            expect(heater?.deviceType).toBe('temperature');
            expect(heater?.powerKw).toBe(1);
            expect(heater?.currentOn).toBe(true);
            expect(light?.deviceType).toBe('onoff');
            expect(light?.targets).toEqual([]);
        });

        it('abandon-grace: does not clobber a populated snapshot on a single transient empty read', async () => {
            await populateSnapshotForGrace(deviceManager);

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot();

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
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();

            const ids = deviceManager.getSnapshot().map(snapshotDeviceId);
            expect(ids).toEqual(['dev1']);
        });

        it('abandon-grace: eventually commits the empty snapshot after the consecutive-read threshold', async () => {
            await populateSnapshotForGrace(deviceManager);

            mockApiGet.mockResolvedValue({});
            // Threshold is 3 consecutive empty reads.
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getSnapshot()).toHaveLength(1);
            await deviceManager.refreshSnapshot();

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
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();

            // Recovery: a populated read clears the run so the next empty read
            // is treated as the first miss again, not the third.
            mockApiGet.mockResolvedValue(GRACE_POPULATED_PAYLOAD);
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getSnapshot()).toHaveLength(1);

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getSnapshot()).toHaveLength(1);
            expect(loggerMock.structuredLog.warn).toHaveBeenLastCalledWith(expect.objectContaining({
                event: 'device_snapshot_empty_deferred',
                consecutiveEmptyReads: 1,
            }));
        });

        it('abandon-grace: commits an empty snapshot immediately when there was nothing to protect', async () => {
            await deviceManager.init();
            mockApiGet.mockResolvedValue({});

            await deviceManager.refreshSnapshot();

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
            await deviceManager.refreshSnapshot();

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
                await deviceManager.refreshSnapshot();
                // First empty read is deferred (under both the read and time limits).
                expect(deviceManager.getSnapshot()).toHaveLength(1);

                // Cross the time-based grace window without hitting the read threshold.
                vi.advanceTimersByTime(5 * 60 * 1000);
                await deviceManager.refreshSnapshot();

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
            vi.spyOn(deviceManager as never, 'fetchDevicesForSnapshot').mockRejectedValueOnce(refreshFailure);

            await deviceManager.refreshSnapshot();

            expect((loggerMock as any).structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_snapshot_refresh_failed',
                reasonCode: 'refresh_failed',
                targetedRefresh: false,
                err: refreshFailure,
            }));
            expect(loggerMock.error).not.toHaveBeenCalled();
        });

        it('pushes cumulative home power from live report to the observer dispatcher', async () => {
            // PR2a of the observer/transport split: transport no longer caches
            // home power; it pushes the Homey-SDK-sourced scalar to observer via
            // the injected `observedStateDispatcher.setHomePowerW`.
            const setHomePowerW = vi.fn();
            const dispatchingManager = new DeviceTransport(homeyMock, loggerMock, undefined, undefined, {
                ...withRealBinarySettle(),
                observedStateDispatcher: {
                    observedStateChanged: vi.fn(),
                    observedStateRefresh: vi.fn(),
                    planReconcile: vi.fn(),
                    setHomePowerW,
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
                    { type: 'cumulative', values: { W: 4500 } },
                ],
            });

            await dispatchingManager.refreshSnapshot();

            expect(setHomePowerW).toHaveBeenCalledWith(4500);
        });

        it('pushes null home power when no cumulative item exists', async () => {
            const setHomePowerW = vi.fn();
            const dispatchingManager = new DeviceTransport(homeyMock, loggerMock, undefined, undefined, {
                ...withRealBinarySettle(),
                observedStateDispatcher: {
                    observedStateChanged: vi.fn(),
                    observedStateRefresh: vi.fn(),
                    planReconcile: vi.fn(),
                    setHomePowerW,
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

            await dispatchingManager.refreshSnapshot();

            expect(setHomePowerW).toHaveBeenCalledWith(null);
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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].deviceClass).toBe('airtreatment');
            expect(snapshot[0].deviceType).toBe('temperature');
            expect(snapshot[0].powerCapable).toBe(true);
            // Non-binary device (no onoff/control capability): currentOn stays
            // `true` — it has no off-switch and may always draw (setpoint-
            // controlled), so it must remain sheddable. Only a BINARY device with
            // a missing onoff value resolves to the non-optimistic `false`.
            expect(snapshot[0].currentOn).toBe(true);
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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(expect.objectContaining({
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                controlCapabilityId: 'evcharger_charging',
                currentOn: true,
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

            await expect(deviceManager.refreshSnapshot()).resolves.toBeUndefined();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(expect.objectContaining({
                id: 'heater1',
                deviceClass: 'heater',
            }));
        });

        it('includes official EV chargers with charging-state control', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();

            const snapshot = evDeviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(expect.objectContaining({
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                controlCapabilityId: 'evcharger_charging',
                currentOn: false,
                canSetControl: true,
                evChargingState: 'plugged_in_paused',
            }));
        });

        it('derives EV charging state when the boolean capability is missing', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();

            const snapshot = evDeviceManager.getSnapshot();
            expect(snapshot[0]).toEqual(expect.objectContaining({
                currentOn: true,
                evChargingState: 'plugged_in_charging',
            }));
        });

        it('uses EV charging state as settlement evidence before the raw charging boolean', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();

            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: true,
                    observedCapabilityIds: ['evcharger_charging_state'],
                    observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }));
        });

        it('uses raw EV boolean settlement evidence only when state is absent and fresh', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();

            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                binaryControlObservation: {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging'],
                    observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                    source: 'snapshot_refresh',
                },
            }));

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
                            lastUpdated: '2026-04-01T12:01:00.000Z',
                        },
                        evcharger_charging_state: {
                            value: 'mystery',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T12:01:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot();

            expect(evDeviceManager.getSnapshot()[0].binaryControlObservation).toBeUndefined();
        });

        it('excludes EV chargers without the official charging capability', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            });
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

            await evDeviceManager.refreshSnapshot();

            expect(evDeviceManager.getSnapshot()).toHaveLength(0);
            expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining('missing evcharger_charging'));
        });

        it('excludes EV chargers without the official charging state capability', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            });
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

            await evDeviceManager.refreshSnapshot();

            expect(evDeviceManager.getSnapshot()).toHaveLength(0);
            expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining('missing evcharger_charging_state'));
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

            await deviceManager.refreshSnapshot();

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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.6, 3);
            expect(snapshot[0].measuredPowerKw).toBe(0);
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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].loadKw).toBeUndefined();
            expect(snapshot[0].expectedPowerSource).toBe('default');
            expect(snapshot[0].powerKw).toBe(1);
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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].expectedPowerSource).toBe('homey-energy');
            expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.1, 6);
            expect(snapshot[0].powerKw).toBeCloseTo(0.1, 6);
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

                await deviceManager.refreshSnapshot();

                const snapshot = deviceManager.getSnapshot();
                expect(snapshot).toHaveLength(1);
                expect(snapshot[0].measuredPowerKw).toBeCloseTo(0.125, 6);
                expect(snapshot[0].expectedPowerSource).toBe('measured-peak');
                expect(snapshot[0].expectedPowerKw).toBeCloseTo(0.125, 6);
                expect(snapshot[0].powerKw).toBeCloseTo(0.125, 6);
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

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0].powerCapable).toBe(true);
            expect(snapshot[0].expectedPowerSource).toBe('default');
            expect(snapshot[0].powerKw).toBe(1);
        });

        it('uses providers to populate priority and controllable fields', async () => {
            const getPriority = vi.fn().mockReturnValue(1);
            const getControllable = vi.fn().mockReturnValue(false);

            deviceManager = new DeviceTransport(homeyMock, loggerMock, { getPriority, getControllable });
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

            await deviceManager.refreshSnapshot();
            const snapshot = deviceManager.getSnapshot();

            expect(snapshot[0].priority).toBe(1);
            expect(snapshot[0].controllable).toBe(false);
            expect(getPriority).toHaveBeenCalledWith('dev1');
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

            await deviceManager.refreshSnapshot();

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

            await deviceManager.refreshSnapshot();
            const snapshot = deviceManager.getSnapshot();

            expect(snapshot[0].measuredPowerKw).toBeCloseTo(1, 3);
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

            await deviceManager.refreshSnapshot();

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

            await deviceManager.refreshSnapshot();
            const snapshot = deviceManager.getSnapshot();

            expect(snapshot[0].measuredPowerKw).toBeUndefined();
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

            await refreshDeviceManager.refreshSnapshot();

            expect(getDeviceDriverIdOverride).toHaveBeenCalledTimes(2);
            expect(getDeviceDriverIdOverride).toHaveBeenCalledWith('dev-a');
            expect(getDeviceDriverIdOverride).toHaveBeenCalledWith('dev-b');
        });
    });

    describe('applyDeviceTargets', () => {
        it('sets capabilities for mapped devices', async () => {
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
            await deviceManager.refreshSnapshot();

            const targets = { dev1: 22 };
            await deviceManager.applyDeviceTargets(targets, 'test');

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
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getLiveFeedHealth()?.subscriptionState).toBe('subscribed');
        });

        it('ignores device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => deviceId === 'dev1' },
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

            await managedDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                { getManaged: (deviceId) => managedState[deviceId] === true },
            );
            await managedDeviceManager.init();

            await managedDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
            await managedDeviceManager.refreshSnapshot();

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
                { getManaged: (deviceId) => managedState[deviceId] === true },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot();

            const getSnapshotById = (managedDeviceManager as any).getBinarySettleDeps().getSnapshotById as
                (deviceId: string) => unknown;
            expect(getSnapshotById('dev1')).toEqual(expect.objectContaining({ id: 'dev1' }));

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

            expect(getSnapshotById('dev1')).toEqual(expect.objectContaining({ id: 'dev1' }));
            managedDeviceManager.destroy();
        });

        it('updates local state on power change via device.update', async () => {
            await deviceManager.refreshSnapshot();

            // Verify initial state
            expect(deviceManager.getSnapshot()[0].measuredPowerKw).toBe(1);
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
            expect(snapshot[0].measuredPowerKw).toBe(2);
            expect(snapshot[0].powerKw).toBe(2);
            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'device_update_processed',
                source: 'device_update',
                deviceId: 'dev1',
                deviceName: 'Heater',
                reasonCode: 'no_snapshot_change',
                hadChanges: false,
                shouldReconcilePlan: false,
                rawChangeCount: 0,
                filteredChangeCount: 0,
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
            await deviceManager.refreshSnapshot();

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
                shouldReconcilePlan: true,
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    currentOn: false,
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
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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
                id: 'dev1',
                name: 'Hall Thermostat',
                targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
                deviceClass: 'thermostat',
                deviceType: 'temperature',
                controlCapabilityId: 'onoff',
                currentOn: true,
            }]);

            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            const realtimeEvidence = deviceManager.getBinarySettleEvidenceByDeviceId('dev1');
            expect(realtimeEvidence).toEqual(expect.objectContaining({
                source: 'realtime_capability',
                capabilityId: 'onoff',
                observedValue: false,
            }));
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(false);

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
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(false);

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
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation)
                .toEqual(realtimeEvidence);
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
            await deviceManager.refreshSnapshot();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(true);

            // 2. Realtime onoff=false → the freshest trusted observation says OFF.
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(false);

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
            await deviceManager.refreshSnapshot();

            // The consolidated observed truth must remain the trusted realtime
            // OFF: neither the (now honest) false fallback nor a stale pull may
            // diverge from the retained binary evidence.
            const dev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(dev1?.binaryControlObservation?.observedValue).toBe(false);
            expect(dev1?.currentOn).toBe(false);
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
            await deviceManager.refreshSnapshot();
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
            await deviceManager.refreshSnapshot();

            expect(debugStructuredMock).toHaveBeenCalledWith(expect.objectContaining({
                event: 'binary_observation_consolidated',
                deviceId: 'dev1',
                capabilityId: 'onoff',
                pull: expect.objectContaining({ value: true }),
                retained: expect.objectContaining({ value: false, source: 'realtime_capability' }),
                consolidated: expect.objectContaining({ value: false, winner: 'retained' }),
            }));
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
            await deviceManager.refreshSnapshot();
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(false);

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
            await deviceManager.refreshSnapshot();

            const heldDev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(heldDev1?.currentOn).toBe(false);
            expect(heldDev1?.binaryControlObservation?.observedValue).toBe(false);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')?.observedValue).toBe(false);

            // The hold is not permanent: a newer trusted observation still
            // supersedes it. A realtime push (stamped fresh) observing onoff=true
            // reconciles currentOn back to ON.
            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

            const recoveredDev1 = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(recoveredDev1?.currentOn).toBe(true);
            expect(recoveredDev1?.binaryControlObservation?.observedValue).toBe(true);
        });

        it('honours a timestamp-less device.update push that contradicts prior realtime evidence', async () => {
            // A device.update is a PUSH: the device actively reporting its state.
            // Unlike a cached pull, a timestamp-less push stays authoritative, so a
            // physical toggle delivered as a device.update must still flip currentOn
            // even when it carries no lastUpdated and contradicts prior evidence.
            deviceManager.setSnapshotForTests([{
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(true);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
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
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
                binaryControlObservation: previousEvidence,
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Heater',
                capabilities: ['onoff'],
                class: 'heater',
                capabilitiesObj: {
                    onoff: { value: 'unknown', id: 'onoff' },
                },
            });

            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(false);
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
                name: 'Hall Thermostat',
                targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
                deviceClass: 'thermostat',
                deviceType: 'temperature',
                controlCapabilityId: 'onoff',
                currentOn: false,
                measuredPowerKw: 0.1,
                binaryControlObservation: previousEvidence,
            }]);

            deviceManager.injectDeviceUpdateForTest({
                id: 'dev1',
                name: 'Hall Thermostat',
                capabilities: ['onoff', 'measure_temperature', 'measure_power', 'target_temperature'],
                class: 'thermostat',
                capabilitiesObj: {
                    onoff: { value: 'unknown', id: 'onoff' },
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
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(true);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation).toBeUndefined();
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
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: true,
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
            expect(snapshotDevice?.currentOn).toBe(true);
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
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: true,
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

            await deviceManager.refreshSnapshot();

            const snapshotDevice = findSnapshotDevice(deviceManager.getSnapshot(), 'dev1');
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toEqual(newerEvidence);
            expect(snapshotDevice?.binaryControlObservation).toEqual(newerEvidence);
            expect(snapshotDevice?.currentOn).toBe(true);
        });

        it('does not reattach cached evidence when snapshot refresh has a contradictory timestamp-less boolean', async () => {
            deviceManager.setSnapshotForTests([{
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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

            await deviceManager.refreshSnapshot();

            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.currentOn).toBe(true);
            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
            expect(findSnapshotDevice(deviceManager.getSnapshot(), 'dev1')?.binaryControlObservation).toBeUndefined();
        });

        it('clears binary evidence when a device disappears from snapshot refresh', async () => {
            deviceManager.setSnapshotForTests([{
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();

            expect(deviceManager.getBinarySettleEvidenceByDeviceId('dev1')).toBeUndefined();
        });

        it('clears binary evidence on destroy', async () => {
            deviceManager.setSnapshotForTests([{
                id: 'dev1',
                name: 'Heater',
                targets: [],
                deviceClass: 'heater',
                deviceType: 'onoff',
                controlCapabilityId: 'onoff',
                currentOn: false,
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

        it('preserves EV state-derived binary evidence when snapshot refresh has no state timestamp', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            });
            await evDeviceManager.init();
            const previousEvidence = {
                valid: true as const,
                capabilityId: 'evcharger_charging' as const,
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging_state'],
                observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            evDeviceManager.setSnapshotForTests([{
                id: 'ev1',
                name: 'Easee',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                controlCapabilityId: 'evcharger_charging',
                currentOn: true,
                evCharging: false,
                evChargingState: 'plugged_in_paused',
                binaryControlObservation: previousEvidence,
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

            await evDeviceManager.refreshSnapshot();

            expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControlObservation: previousEvidence,
            }));

            evDeviceManager.destroy();
        });

        it('preserves newer EV state-derived binary evidence when snapshot refresh has stale state timestamp', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            });
            await evDeviceManager.init();
            const newerEvidence = {
                valid: true as const,
                capabilityId: 'evcharger_charging' as const,
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging_state'],
                observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                source: 'realtime_capability' as const,
            };
            evDeviceManager.setSnapshotForTests([{
                id: 'ev1',
                name: 'Easee',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                controlCapabilityId: 'evcharger_charging',
                currentOn: true,
                evCharging: false,
                evChargingState: 'plugged_in_paused',
                binaryControlObservation: newerEvidence,
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
                            value: 'plugged_in_paused',
                            id: 'evcharger_charging_state',
                            lastUpdated: '2026-04-01T11:59:00.000Z',
                        },
                        measure_power: { value: 0, id: 'measure_power' },
                    },
                },
            });

            await evDeviceManager.refreshSnapshot();

            expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                binaryControlObservation: newerEvidence,
            }));

            evDeviceManager.destroy();
        });

        it('keeps fresh EV state-derived binary evidence when previous snapshot had raw EV evidence', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
            });
            await evDeviceManager.init();
            const previousRawEvidence = {
                valid: true as const,
                capabilityId: 'evcharger_charging' as const,
                observedValue: false,
                observedCapabilityIds: ['evcharger_charging'],
                observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                source: 'snapshot_refresh' as const,
            };
            evDeviceManager.setSnapshotForTests([{
                id: 'ev1',
                name: 'Easee',
                targets: [],
                deviceClass: 'evcharger',
                deviceType: 'onoff',
                controlCapabilityId: 'evcharger_charging',
                currentOn: false,
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

            await evDeviceManager.refreshSnapshot();

            const expectedStateEvidence = {
                valid: true,
                capabilityId: 'evcharger_charging',
                observedValue: true,
                observedCapabilityIds: ['evcharger_charging_state'],
                observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                source: 'snapshot_refresh',
            };
            expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                currentOn: true,
                evChargingState: 'plugged_in_charging',
                binaryControlObservation: expectedStateEvidence,
            }));
            expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(expectedStateEvidence);

            evDeviceManager.destroy();
        });

        it('persists realtime EV state-derived binary evidence over older raw EV cache evidence', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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
                    id: 'ev1',
                    name: 'Easee',
                    targets: [],
                    deviceClass: 'evcharger',
                    deviceType: 'onoff',
                    controlCapabilityId: 'evcharger_charging',
                    currentOn: true,
                    evCharging: true,
                    binaryControlObservation: previousRawEvidence,
                }]);

                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_paused');

                const expectedStateEvidence = {
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging_state'],
                    observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                    source: 'realtime_capability',
                };
                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(expectedStateEvidence);
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                    // State-authoritative: paused state wins over the lingering
                    // raw `evcharger_charging: true` boolean — currentOn is off,
                    // matching the state-derived settle evidence (observedValue:false).
                    currentOn: false,
                    evCharging: true,
                    evChargingState: 'plugged_in_paused',
                    binaryControlObservation: expectedStateEvidence,
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

                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual(expectedStateEvidence);
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')).toEqual(expect.objectContaining({
                    currentOn: false,
                    evCharging: false,
                    binaryControlObservation: expectedStateEvidence,
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('clears cached EV binary evidence when realtime charging state is unknown', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                });
                await evDeviceManager.init();
                const previousEvidence = {
                    valid: true as const,
                    capabilityId: 'evcharger_charging' as const,
                    observedValue: false,
                    observedCapabilityIds: ['evcharger_charging_state'],
                    observedAtMs: new Date('2026-04-01T11:50:00.000Z').getTime(),
                    source: 'realtime_capability' as const,
                };
                evDeviceManager.setSnapshotForTests([{
                    id: 'ev1',
                    name: 'Easee',
                    targets: [],
                    deviceClass: 'evcharger',
                    deviceType: 'onoff',
                    controlCapabilityId: 'evcharger_charging',
                    currentOn: true,
                    evCharging: false,
                    evChargingState: 'plugged_in_paused',
                    binaryControlObservation: previousEvidence,
                }]);

                vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'mystery');

                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toBeUndefined();
                expect(findSnapshotDevice(evDeviceManager.getSnapshot(), 'ev1')?.binaryControlObservation)
                    .toBeUndefined();

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
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getDebugObservedSources('dev1')?.snapshotRefresh).toBeDefined();

            // A single empty read is held under abandon-grace; drive past the
            // consecutive-read threshold so the genuinely-gone device commits.
            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();
            await deviceManager.refreshSnapshot();

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
            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);
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
                currentOn: false,
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
                reasonCode: 'drift_detected',
                hadChanges: true,
                shouldReconcilePlan: true,
                rawChangeCount: 1,
                filteredChangeCount: 1,
                controlCapabilityId: 'onoff',
                rawBinaryObserved: true,
                rawBinaryValue: false,
                binarySettleOutcome: 'none',
                previousCurrentOn: true,
                nextCurrentOn: false,
            }));
        });

        it('suppresses reconcile for the realtime echo of a local onoff write', async () => {
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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                currentOn: true,
            }));
            expect(realtimeListener).not.toHaveBeenCalled();
        });

        it('suppresses reconcile when the realtime echo arrives before the local write resolves', async () => {
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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                currentOn: true,
            }));
            expect(realtimeListener).not.toHaveBeenCalled();

            resolveWrite?.();
            await setCapabilityPromise;
        });

        it('emits drift immediately when device fights back with contradictory device.update during binary settle', async () => {
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

            await deviceManager.refreshSnapshot();
            const liveStateListener = vi.fn();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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

            // Drift is emitted immediately — no waiting for settle timeout
            expect(realtimeListener).toHaveBeenCalledOnce();
            const driftEvent = realtimeListener.mock.calls[0][0];
            expect(driftEvent).toEqual(expect.objectContaining({
                deviceId: 'dev1',
                changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
            }));
            expect(liveStateListener).toHaveBeenCalledOnce();
            expect(liveStateListener.mock.calls[0][0]).toEqual(expect.objectContaining({
                source: 'device_update',
                deviceId: 'dev1',
                observationSeq: driftEvent.observationSeq,
                observedAtMs: driftEvent.observedAtMs,
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
            }));
        });

        it('updates observed state before emitting drift for contradictory realtime onoff during binary settle', async () => {
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

            await deviceManager.refreshSnapshot();
            await deviceManager.setCapability('dev1', 'onoff', false);

            const currentOnAtReconcile: unknown[] = [];
            const liveStateListener = vi.fn();
            const realtimeListener = vi.fn(() => {
                currentOnAtReconcile.push(deviceManager.getSnapshot()[0]?.currentOn);
            });
            deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                name: 'Heater',
                capabilityId: 'onoff',
                changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
            }));
            const driftEvent = realtimeListener.mock.calls[0][0];
            expect(liveStateListener).toHaveBeenCalledOnce();
            expect(liveStateListener.mock.calls[0][0]).toEqual(expect.objectContaining({
                source: 'realtime_capability',
                deviceId: 'dev1',
                observationSeq: driftEvent.observationSeq,
                observedAtMs: driftEvent.observedAtMs,
            }));
            expect(currentOnAtReconcile).toEqual([true]);
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
            }));
        });

        it('settles matching realtime onoff confirmations without reconcile loops', async () => {
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

            await deviceManager.refreshSnapshot();
            await deviceManager.setCapability('dev1', 'onoff', false);

            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));
        });

        it('stops preserving the local off-state after settle timeout; a later non-boolean device.update honestly resolves currentOn:false (no re-synthesized on-state)', async () => {
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

                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: false }));

                await vi.advanceTimersByTimeAsync(5000);
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

                // After the settle window expires the held off-state is released,
                // but a binary-less device.update no longer re-synthesizes the old
                // optimistic on-state — it honestly resolves currentOn:false, which
                // matches the existing off-state, so the only change is the target.
                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: [
                        { capabilityId: 'target_temperature', previousValue: '20°C', nextValue: '21°C' },
                    ],
                }));
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
            expect(realtimeListener).not.toHaveBeenCalled();
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: false }));

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

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: true }));
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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
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

                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.setSnapshotForTests([]);

                await vi.advanceTimersByTimeAsync(5000);

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

                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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

                await vi.advanceTimersByTimeAsync(5000);

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

                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));

                await vi.advanceTimersByTimeAsync(5000);

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
                    currentOn: false,
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
                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: false }));
            });

            it('pending off write + capability event on => drift immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
                }));
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: true }));
            });

            it('pending off write + device.update with off => settles immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectDeviceUpdateForTest(heaterOffDevice());

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: false }));
            });

            it('pending off write + device.update with on => drift immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOnDevice() });
                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.injectDeviceUpdateForTest(heaterOnDevice());

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
                }));
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: true }));
            });

            it('pending on write + capability event on => settles immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOffDevice() });
                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', true);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', true);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: true }));
            });

            it('pending on write + capability event off => drift immediately', async () => {
                mockApiGet.mockResolvedValue({ dev1: heaterOffDevice() });
                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', true);
                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' })],
                }));
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: false }));
            });

            it('does not settle or mutate pending EV resume from raw capability event while state is paused', async () => {
                vi.useFakeTimers();
                try {
                    const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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
                    await evDeviceManager.refreshSnapshot();
                    const realtimeListener = vi.fn();
                    evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                    await evDeviceManager.setCapability('ev1', 'evcharger_charging', true);
                    evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging', true);

                    expect(realtimeListener).not.toHaveBeenCalled();
                    expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                        currentOn: false,
                        evCharging: false,
                        evChargingState: 'plugged_in_paused',
                        binaryControlObservation: expect.objectContaining({
                            observedValue: false,
                            observedCapabilityIds: ['evcharger_charging_state'],
                        }),
                    }));

                    evDeviceManager.destroy();
                } finally {
                    vi.useRealTimers();
                }
            });

            it('shares cursor for EV charging-state drift during binary settle', async () => {
                vi.useFakeTimers();
                try {
                    const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, undefined, undefined, withRealBinarySettle());
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
                    await evDeviceManager.refreshSnapshot();
                    const liveStateListener = vi.fn();
                    const realtimeListener = vi.fn();
                    evDeviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                    await evDeviceManager.setCapability('ev1', 'evcharger_charging', true);
                    vi.setSystemTime(new Date('2026-04-01T12:00:01.000Z'));
                    evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_out');

                    expect(realtimeListener).toHaveBeenCalledOnce();
                    const driftEvent = realtimeListener.mock.calls[0][0];
                    expect(driftEvent).toEqual(expect.objectContaining({
                        deviceId: 'ev1',
                        capabilityId: 'evcharger_charging',
                        observationSeq: 2,
                        changes: [expect.objectContaining({
                            capabilityId: 'evcharger_charging',
                            previousValue: 'on',
                            nextValue: 'off',
                        })],
                    }));
                    expect(liveStateListener).toHaveBeenCalledOnce();
                    expect(liveStateListener.mock.calls[0][0]).toEqual(expect.objectContaining({
                        source: 'realtime_capability',
                        deviceId: 'ev1',
                        capabilityId: 'evcharger_charging_state',
                        observationSeq: driftEvent.observationSeq,
                        observedAtMs: driftEvent.observedAtMs,
                    }));
                    expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                        currentOn: false,
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
                    await deviceManager.refreshSnapshot();
                    const realtimeListener = vi.fn();
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                    // Write off (desired=false), snapshot immediately updated to false
                    await deviceManager.setCapability('dev1', 'onoff', false);
                    // No binary observations arrive
                    await vi.advanceTimersByTimeAsync(5000);

                    // snapshot.currentOn=false matches desired=false => no reconcile at timeout
                    expect(realtimeListener).not.toHaveBeenCalled();
                    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({ currentOn: false }));
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

            await deviceManager.refreshSnapshot();

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));

            await deviceManager.setCapability('dev1', 'onoff', true);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));
            expect(deviceManager.getDebugObservedSources('dev1')?.localWrites.onoff).toEqual(expect.objectContaining({
                path: 'local_write',
                capabilityId: 'onoff',
                value: true,
                preservedLocalState: false,
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    currentOn: false,
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

            await deviceManager.refreshSnapshot();

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

        it('keeps the correct target pending when a device has multiple target capabilities', async () => {
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

            await deviceManager.refreshSnapshot();

            const snap = deviceManager.getSnapshot()[0];
            expect(snap?.targets).toHaveLength(2);
            expect(snap?.targets[0]).toEqual(expect.objectContaining({ id: 'target_temperature', value: 22 }));
            expect(snap?.targets[1]).toEqual(expect.objectContaining({ id: 'target_temperature.zone1', value: 20 }));

            await deviceManager.setCapability('dev1', 'target_temperature.zone1', 18);

            const updated = deviceManager.getSnapshot()[0];
            expect(updated?.targets[0]).toEqual(expect.objectContaining({ id: 'target_temperature', value: 22 }));
            expect(updated?.targets[1]).toEqual(expect.objectContaining({ id: 'target_temperature.zone1', value: 20 }));
            expect(updated?.lastLocalWriteMs).toBeDefined();
        });

        it('preserves local onoff state optimistically after a binary write', async () => {
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

            await deviceManager.refreshSnapshot();

            await deviceManager.setCapability('dev1', 'onoff', true);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));
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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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

            await deviceManager.refreshSnapshot();

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

            await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();
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

                await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();
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

                await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();

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

                await deviceManager.refreshSnapshot();

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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
            await deviceManager.refreshSnapshot();

            // A binary device whose onoff capability carries no value is a
            // should-never-happen anomaly. The parser no longer fabricates an
            // optimistic true — it resolves honestly to currentOn:false (and
            // still emits no timestamped binary evidence).
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
                measuredPowerKw: 1,
                binaryControlObservation: undefined,
                lastFreshDataMs: undefined,
            }));
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
            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                currentOn: true,
                measuredPowerKw: 2.865,
                powerKw: 2.865,
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

                await deviceManager.refreshSnapshot();

                const freshnessSeenAtEmit: Array<number | undefined> = [];
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, () => {
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
                                value: 'plugged_in_complete',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot();

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
                    currentOn: false,
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

            await evDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                currentOn: false,
                evCharging: false,
                evChargingState: 'plugged_in_paused',
            }));

            evDeviceManager.destroy();
        });

        it('recomputes currentOn and reconciles when evcharger_charging_state changes from an on-state to plugged_out', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_out');

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
                currentOn: false,
                evChargingState: 'plugged_out',
            }));

            evDeviceManager.destroy();
        });

        it('does not emit a binary reconcile when evcharger_charging_state stays within the same derived on-state', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_paused');

            expect(realtimeListener).not.toHaveBeenCalled();
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
                evChargingState: 'plugged_in_paused',
            }));

            evDeviceManager.destroy();
        });

        it('keeps EV state of charge valid across in-session charging-state changes', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

                await evDeviceManager.refreshSnapshot();
                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_charging');

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 51,
                    status: 'fresh',
                    sessionStartedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('initializes realtime EV state of charge against the current connected session', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

                await evDeviceManager.refreshSnapshot();
                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                evDeviceManager.injectCapabilityUpdateForTest('ev1', 'measure_battery', 52);

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 52,
                    status: 'fresh',
                    sessionStartedAtMs: new Date('2026-03-20T06:05:00.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('emits observed state for device.update EV state of charge changes without plan reconcile changes', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

                await evDeviceManager.refreshSnapshot();
                vi.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                const liveStateListener = vi.fn();
                const reconcileListener = vi.fn();
                evDeviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

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

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 52,
                    status: 'fresh',
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
                id: 'sensor1',
                name: 'Battery Sensor',
                deviceClass: 'sensor',
                currentOn: true,
                targets: [],
                powerCapable: false,
                capabilities: ['measure_battery'],
            }]);

            deviceManager.injectCapabilityUpdateForTest('sensor1', 'measure_battery', 48);

            expect(deviceManager.getSnapshot()[0].stateOfCharge).toBeUndefined();
        });

        it('treats a fresher charging-state start as on even when the stored EV boolean is stale false', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

            await evDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'evcharger_charging_state', 'plugged_in_charging');

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'ev1',
                changes: [expect.objectContaining({
                    capabilityId: 'evcharger_charging',
                    previousValue: 'off',
                    nextValue: 'on',
                })],
            }));
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
                evCharging: false,
                evChargingState: 'plugged_in_charging',
            }));

            evDeviceManager.destroy();
        });

        it('preserves fresher ev charger state across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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
                                value: 'plugged_in_complete',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T05:59:00.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot();

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
                                value: 'plugged_in_complete',
                                id: 'evcharger_charging_state',
                                lastUpdated: '2026-03-20T05:59:30.000Z',
                            },
                            measure_power: { value: 0, id: 'measure_power' },
                        },
                    },
                });

                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
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

                await evDeviceManager.refreshSnapshot();
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

                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 61,
                    capabilityId: 'measure_battery',
                    status: 'fresh',
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

                await evDeviceManager.refreshSnapshot();
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
                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 61,
                    capabilityId: 'measure_battery',
                    status: 'fresh',
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

                await evDeviceManager.refreshSnapshot();
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
                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 61,
                    capabilityId: 'measure_soc_level',
                    status: 'fresh',
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

                await evDeviceManager.refreshSnapshot();
                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    observedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    status: 'fresh',
                }));

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
                });
                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    observedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    status: 'stale',
                }));

                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
                    percent: 50,
                    observedAtMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    status: 'stale',
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

                await evDeviceManager.refreshSnapshot();
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
                await evDeviceManager.refreshSnapshot();
                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
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
                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
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

                await evDeviceManager.refreshSnapshot();
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
                await evDeviceManager.refreshSnapshot();

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
                await evDeviceManager.refreshSnapshot();

                expect(evDeviceManager.getSnapshot()[0].stateOfCharge).toEqual(expect.objectContaining({
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

                await evDeviceManager.refreshSnapshot();
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

                await evDeviceManager.refreshSnapshot();

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

        it('emits drift when a contradictory device.update arrives during the binary settle window', async () => {
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

            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', false);
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));

            // Device fights back — settle window resolves as drift immediately
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

            expect(realtimeListener).toHaveBeenCalledOnce();
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
            }));
        });

        it('suppresses device.update binary drift while a local off write is still settling', async () => {
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

                await deviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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

                await vi.advanceTimersByTimeAsync(5000);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps Zaptec device.update settle quiet when raw off arrives with a still-charging state', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                    getNativeEvWiringEnabled: () => true,
                }, undefined, withRealBinarySettle());
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

                await evDeviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                    controlCapabilityId: 'evcharger_charging',
                    controlWriteCapabilityId: 'charging_button',
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

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: true,
                    evCharging: false,
                    evChargingState: 'plugged_in_charging',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps state-derived EV device.update evidence when raw charging boolean disagrees', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

                await evDeviceManager.refreshSnapshot();
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
                    currentOn: true,
                    evChargingState: 'plugged_in_charging',
                    binaryControlObservation: {
                        valid: true,
                        capabilityId: 'evcharger_charging',
                        observedValue: true,
                        observedCapabilityIds: ['evcharger_charging_state'],
                        observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                        source: 'device_update',
                    },
                }));
                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toEqual({
                    valid: true,
                    capabilityId: 'evcharger_charging',
                    observedValue: true,
                    observedCapabilityIds: ['evcharger_charging_state'],
                    observedAtMs: new Date('2026-04-01T12:00:00.000Z').getTime(),
                    source: 'device_update',
                });

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not synthesize EV device.update settlement evidence when state lacks a timestamp', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
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

                await evDeviceManager.refreshSnapshot();
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
                    currentOn: false,
                    evChargingState: 'plugged_in_paused',
                }));
                expect(evDeviceManager.getSnapshot()[0].binaryControlObservation).toBeUndefined();
                expect(evDeviceManager.getBinarySettleEvidenceByDeviceId('ev1')).toBeUndefined();

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('settles an idempotent EV pause from unchanged paused state in device.update', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, undefined, undefined, withRealBinarySettle());
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

                await evDeviceManager.refreshSnapshot();
                const realtimeListener = vi.fn();
                evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                vi.setSystemTime(new Date('2026-04-01T11:59:59.000Z'));
                await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);
                expect((evDeviceManager as any).binarySettleState.pendingBinarySettleWindows.size).toBe(1);

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
                expect((evDeviceManager as any).binarySettleState.pendingBinarySettleWindows.size).toBe(0);
                expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                    evCharging: false,
                    evChargingState: 'plugged_in_paused',
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('normalizes Zaptec proprietary capability updates at the observation boundary', async () => {
            const evDeviceManager = new DeviceTransport(homeyMock, loggerMock, {
                getNativeEvWiringEnabled: () => true,
            }, undefined, withRealBinarySettle());
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

            await evDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            evDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            await evDeviceManager.setCapability('ev1', 'evcharger_charging', false);
            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'charging_button', false);

            expect(realtimeListener).not.toHaveBeenCalled();
            expect((evDeviceManager as any).binarySettleState.pendingBinarySettleWindows.size).toBe(1);
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
                evChargingState: 'plugged_in_charging',
            }));

            evDeviceManager.injectCapabilityUpdateForTest('ev1', 'charge_mode', 'Charging finished');

            expect(realtimeListener).not.toHaveBeenCalled();
            expect((evDeviceManager as any).binarySettleState.pendingBinarySettleWindows.size).toBe(0);
            expect(evDeviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                // Paused = off (state-authoritative), even though the proprietary
                // charging signal lingered before the charge_mode update.
                currentOn: false,
                evChargingState: 'plugged_in_paused',
            }));

            evDeviceManager.destroy();
        });

        it('ignores generic device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: () => false },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
            await deviceManager.refreshSnapshot();

            const planListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, planListener);
            expect(deviceManager.listenerCount(PLAN_RECONCILE_REALTIME_UPDATE_EVENT)).toBe(1);

            deviceManager.destroy();

            // EventEmitter listeners are removed
            expect(deviceManager.listenerCount(PLAN_RECONCILE_REALTIME_UPDATE_EVENT)).toBe(0);
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
                await deviceManager.refreshSnapshot();

                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                expect(realtimeListener).toHaveBeenCalledOnce();
                expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                    deviceId: 'dev1',
                    changes: expect.arrayContaining([
                        expect.objectContaining({ capabilityId: 'onoff' }),
                    ]),
                }));
                expect(deviceManager.getSnapshot().find((d) => d.id === 'dev1')?.currentOn).toBe(false);
            });

            it('triggers reconcile when target_temperature is changed externally via capability event', async () => {
                mockApiGet.mockResolvedValue(buildTempDevice());
                await deviceManager.refreshSnapshot();

                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                await deviceManager.refreshSnapshot();

                // Simulate PELS writing target_temperature (records a local write)
                mockApiPut.mockResolvedValue({});
                await deviceManager.setCapability('dev1', 'target_temperature', 16);

                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                // Same value echoed back from the live feed — should be suppressed
                deviceManager.injectCapabilityUpdateForTest('dev1', 'target_temperature', 16);

                expect(realtimeListener).not.toHaveBeenCalled();
            });

            it('ignores normalized target_temperature echoes until device.update confirms the write', async () => {
                mockApiGet.mockResolvedValue(buildTempDevice());
                await deviceManager.refreshSnapshot();

                mockApiPut.mockResolvedValue({});
                await deviceManager.setCapability('dev1', 'target_temperature', 21.5);

                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                await deviceManager.refreshSnapshot();

                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                deviceManager.injectCapabilityUpdateForTest('unknown-device', 'onoff', false);

                expect(realtimeListener).not.toHaveBeenCalled();
            });

            it('ignores capability events when value is unchanged', async () => {
                mockApiGet.mockResolvedValue(buildOnoffDevice());
                await deviceManager.refreshSnapshot();

                const realtimeListener = vi.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
                    await deviceManager.refreshSnapshot();

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
                await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'onoff', false);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.currentOn).toBe(false);
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
                    await deviceManager.refreshSnapshot();
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

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
                    await deviceManager.refreshSnapshot();

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    mockApiPut.mockResolvedValue({});
                    await deviceManager.setCapability('dev1', 'target_temperature', 18);

                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

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
                    await deviceManager.refreshSnapshot();
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_power', 2000);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.measuredPowerKw).toBe(2);
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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const liveStateListener = vi.fn();
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_LIVE_STATE_OBSERVED_EVENT, liveStateListener);
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

                    deviceManager.injectCapabilityUpdateForTest('dev1', 'measure_temperature', 21);

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.currentTemperature).toBe(21);
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

            it('local writes do not advance freshness', async () => {
                vi.useFakeTimers();
                try {
                    await deviceManager.init();
                    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
                    mockApiGet.mockResolvedValue(buildThermostatDevice());
                    await deviceManager.refreshSnapshot();
                    const freshnessAtRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    mockApiPut.mockResolvedValue({});

                    // Local onoff write
                    await deviceManager.setCapability('dev1', 'onoff', false);
                    expect(deviceManager.getSnapshot()[0].currentOn).toBe(false);
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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();
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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();

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
                                value: 'unknown',
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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();
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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();
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
                    await deviceManager.refreshSnapshot();

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
                    await deviceManager.refreshSnapshot();
                    const freshnessAfterFirstRefresh = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(deviceManager.getSnapshot()[0].currentOn).toBe(true);

                    vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
                    mockApiGet.mockResolvedValue({
                        dev1: {
                            id: 'dev1',
                            name: 'Heater',
                            class: 'heater',
                            capabilities: ['onoff', 'measure_power'],
                            capabilitiesObj: {
                                onoff: { id: 'onoff' },
                            },
                        },
                    });
                    await deviceManager.refreshSnapshot({ targetedRefresh: true });

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.currentOn).toBe(true);
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
                    await deviceManager.refreshSnapshot();

                    vi.setSystemTime(new Date('2026-04-01T12:01:00.000Z'));
                    const reconcileListener = vi.fn();
                    deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, reconcileListener);

                    deviceManager.injectDeviceUpdateForTest({
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['onoff', 'measure_power'],
                        capabilitiesObj: {
                            onoff: { value: 'unknown', id: 'onoff' },
                            measure_power: { value: 500, id: 'measure_power' },
                        },
                    });

                    const snapshot = deviceManager.getSnapshot()[0];
                    expect(snapshot.currentOn).toBe(false);
                    expect(snapshot.measuredPowerKw).toBe(0.5);
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
                    await deviceManager.refreshSnapshot();
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(new Date(initialAt).getTime());

                    // measure_power gets a new lastUpdated; onoff stays at the old value.
                    const updatedAt = new Date('2026-04-01T12:05:00.000Z').toISOString();
                    deviceData.dev1.capabilitiesObj.measure_power.lastUpdated = updatedAt;
                    vi.setSystemTime(new Date('2026-04-01T12:06:00.000Z'));
                    await deviceManager.refreshSnapshot();
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(new Date(updatedAt).getTime());
                } finally {
                    vi.useRealTimers();
                }
            });

            it('does not fabricate freshness when a targeted refresh sees unchanged capability timestamps', async () => {
                // Homey serves cached capability values even when the device has been silent
                // for hours. A successful poll is not by itself evidence the device is alive;
                // only Homey's per-capability `lastUpdated` proves new observation. The
                // 40-minute `STALE_DEVICE_OBSERVATION_MS` window is the backstop.
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
                    await deviceManager.refreshSnapshot();
                    const freshnessAfterInit = deviceManager.getSnapshot()[0].lastFreshDataMs;
                    expect(freshnessAfterInit).toBe(new Date('2026-04-01T11:55:00.000Z').getTime());

                    // Advance 6 minutes — device's capability timestamps still report 11:55.
                    vi.setSystemTime(new Date('2026-04-01T12:06:00.000Z'));

                    // Normal refresh with unchanged timestamps: freshness must NOT advance.
                    await deviceManager.refreshSnapshot();
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterInit);

                    // Targeted refresh with unchanged timestamps: also must NOT advance —
                    // the poll itself is not evidence the device communicated.
                    await deviceManager.refreshSnapshot({ targetedRefresh: true });
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
                const previousSnapshot: TargetDeviceSnapshot[] = [{
                    id: 'ev1',
                    name: 'Zaptec',
                    deviceClass: 'evcharger',
                    capabilities: ['evcharger_charging'],
                    currentOn: true,
                    controlCapabilityId: 'evcharger_charging',
                    targets: [],
                    powerCapable: false,
                    lastFreshDataMs: initialFreshAt,
                }];
                const nextSnapshot: TargetDeviceSnapshot[] = [{
                    ...previousSnapshot[0],
                    binaryControlObservation: {
                        valid: true,
                        capabilityId: 'evcharger_charging',
                        observedValue: true,
                        observedCapabilityIds: ['evcharger_charging_state'],
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
        });

        it('ignores device.update events for a device that stops being managed', async () => {
            const managedState: Record<string, boolean> = { dev1: true };
            const managedDeviceManager = new DeviceTransport(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot();

            managedState.dev1 = false;
            await managedDeviceManager.refreshSnapshot();

            const realtimeListener = vi.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
