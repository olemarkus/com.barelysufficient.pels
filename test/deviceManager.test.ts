import { DeviceManager, PLAN_RECONCILE_REALTIME_UPDATE_EVENT } from '../lib/core/deviceManager';
import {
    mockHomeyInstance,
    clearMockSdkDeviceListeners,
    emitMockSdkDeviceUpdate,
} from './mocks/homey';
import Homey from 'homey';
import * as homeyApi from '../lib/core/deviceManagerHomeyApi';

const mockApiGet = jest.fn();
const mockApiPut = jest.fn().mockResolvedValue(undefined);
const mockGetLiveReport = jest.fn();
const mockSdkDevicesEmitter = mockHomeyInstance.api.getApi('homey:manager:devices');

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

describe('DeviceManager', () => {
    let deviceManager: DeviceManager;
    let homeyMock: Homey.App;
    let loggerMock: { log: jest.Mock; debug: jest.Mock; error: jest.Mock };

    afterEach(() => {
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        clearMockSdkDeviceListeners();
        mockGetLiveReport.mockResolvedValue({ items: [] });
        homeyMock = mockHomeyInstance as unknown as Homey.App;

        // Wire mock API functions via spyOn so restoreAllMocks cleans up.
        const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
        mockApiGet.mockImplementation(async (path: string) => originalGet(path));
        jest.spyOn(mockHomeyInstance.api, 'get').mockImplementation(mockApiGet);
        jest.spyOn(mockHomeyInstance.api, 'put').mockImplementation(mockApiPut);
        jest.spyOn(homeyApi, 'getEnergyLiveReport').mockImplementation(() => mockGetLiveReport());

        loggerMock = {
            log: jest.fn(),
            debug: jest.fn(),
            error: jest.fn(),
        };
        deviceManager = new DeviceManager(homeyMock, loggerMock);
    });

    describe('init', () => {
        it('marks SDK ready and logs initialization when checks pass', async () => {
            await deviceManager.init();
            expect(loggerMock.log).toHaveBeenCalledWith(expect.stringContaining('initialized'));
        });

        it('skips initialization if api is missing', async () => {
            const savedApi = (homeyMock as any).api;
            (homeyMock as any).api = undefined;
            deviceManager = new DeviceManager(homeyMock, loggerMock);
            await deviceManager.init();
            expect(loggerMock.log).not.toHaveBeenCalledWith(expect.stringContaining('initialized'));
            expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining('skipping init'));
            (homeyMock as any).api = savedApi;
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

        it('stores cumulative home power from live report in getHomePowerW', async () => {
            await deviceManager.init();
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

            await deviceManager.refreshSnapshot();

            expect(deviceManager.getHomePowerW()).toBe(4500);
        });

        it('returns null from getHomePowerW when no cumulative item exists', async () => {
            await deviceManager.init();
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

            await deviceManager.refreshSnapshot();

            expect(deviceManager.getHomePowerW()).toBeNull();
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
            expect(snapshot[0].currentOn).toBeUndefined();
            expect(snapshot[0].canSetControl).toBeUndefined();
        });

        it('skips EV chargers when experimental support is disabled', async () => {
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

            expect(deviceManager.getSnapshot()).toHaveLength(0);
        });

        it('includes official EV chargers when experimental support is enabled', async () => {
            const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                getExperimentalEvSupportEnabled: () => true,
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
            const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                getExperimentalEvSupportEnabled: () => true,
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

        it('excludes EV chargers without the official charging capability', async () => {
            const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                getExperimentalEvSupportEnabled: () => true,
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
            const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                getExperimentalEvSupportEnabled: () => true,
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
            expect(mockGetLiveReport).toHaveBeenCalled();
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
            const getPriority = jest.fn().mockReturnValue(1);
            const getControllable = jest.fn().mockReturnValue(false);

            deviceManager = new DeviceManager(homeyMock, loggerMock, { getPriority, getControllable });
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

        it('uses meter_power delta when measure_power is missing', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power.in_tank', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        'meter_power.in_tank': { value: 100, id: 'meter_power.in_tank' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot();

            jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power.in_tank', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        'meter_power.in_tank': { value: 101, id: 'meter_power.in_tank' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot();
            const snapshot = deviceManager.getSnapshot();

            expect(snapshot[0].measuredPowerKw).toBeCloseTo(1, 3);
            expect(snapshot[0].powerCapable).toBe(true);

            jest.useRealTimers();
        });

        it('handles meter_power resets by ignoring negative deltas', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

            await deviceManager.init();
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power.in_tank', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        'meter_power.in_tank': { value: 100, id: 'meter_power.in_tank' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot();

            jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
            mockApiGet.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'AC',
                    class: 'airconditioning',
                    capabilities: ['meter_power.in_tank', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        'meter_power.in_tank': { value: 99, id: 'meter_power.in_tank' },
                        target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                        measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    },
                },
            });

            await deviceManager.refreshSnapshot();
            const snapshot = deviceManager.getSnapshot();

            expect(snapshot[0].measuredPowerKw).toBeUndefined();
            expect(snapshot[0].expectedPowerSource).toBe('default');

            jest.useRealTimers();
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

        it('attaches SDK realtime listener after init', async () => {
            await deviceManager.refreshSnapshot();
            // Verify the SDK realtime listener is attached by checking that
            // device.update events are handled (the listener count on the emitter)
            expect(mockSdkDevicesEmitter.listenerCount('realtime')).toBeGreaterThanOrEqual(1);
        });

        it('ignores device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceManager(
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
            const realtimeListener = jest.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            // device.update for unmanaged dev2 should be ignored
            emitMockSdkDeviceUpdate({
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
            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev2')).toEqual(expect.objectContaining({
                managed: false,
                measuredPowerKw: 0.9,
            }));

            managedDeviceManager.destroy();
        });

        it('handles device.update events when a device becomes managed', async () => {
            const managedState: Record<string, boolean> = { dev1: false };
            const managedDeviceManager = new DeviceManager(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true },
            );
            await managedDeviceManager.init();

            await managedDeviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            // device.update should be ignored while unmanaged
            emitMockSdkDeviceUpdate({
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
            emitMockSdkDeviceUpdate({
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

        it('updates local state on power change via device.update', async () => {
            await deviceManager.refreshSnapshot();

            // Verify initial state
            expect(deviceManager.getSnapshot()[0].measuredPowerKw).toBe(1);

            // Trigger update 2000W via device.update
            emitMockSdkDeviceUpdate({
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
        });

        it('tracks snapshot refresh and device.update sources for debug dumps', async () => {
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

            emitMockSdkDeviceUpdate({
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
                    previousValue: 'unknown',
                    nextValue: 'off',
                }],
            }));
        });

        it('prunes stale debug sources and ignores no-op realtime updates for removed devices', async () => {
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getDebugObservedSources('dev1')?.snapshotRefresh).toBeDefined();

            mockApiGet.mockResolvedValue({});
            await deviceManager.refreshSnapshot();

            expect(deviceManager.getDebugObservedSources('dev1')).toBeNull();

            emitMockSdkDeviceUpdate({
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
            await deviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            emitMockSdkDeviceUpdate({
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
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                changes: [{
                    capabilityId: 'onoff',
                    previousValue: 'unknown',
                    nextValue: 'off',
                }],
            });
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
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', true);

            emitMockSdkDeviceUpdate({
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
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            const setCapabilityPromise = deviceManager.setCapability('dev1', 'onoff', true);

            emitMockSdkDeviceUpdate({
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

        it('suppresses contradictory device.update during binary settle window via local state preservation', async () => {
            jest.useFakeTimers();
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
                const realtimeListener = jest.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);

                // Contradictory device.update (fight-back from device)
                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });

                // Local binary state is preserved, so no reconcile during settle
                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));

                await jest.advanceTimersByTimeAsync(5000);

                // After settle window expires, local state was preserved so no reconcile
                expect(realtimeListener).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });

        it('preserves local binary state across multiple contradictory device.update events', async () => {
            jest.useFakeTimers();
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
                const realtimeListener = jest.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);

                // First echo confirms the local write
                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                });
                // Second update fights back
                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });

                // Local binary state is preserved throughout
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));

                await jest.advanceTimersByTimeAsync(5000);

                // No reconcile because local state was preserved
                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));
            } finally {
                jest.useRealTimers();
            }
        });

        it('confirms the local off write when the latest onoff observation before deadline is off', async () => {
            jest.useFakeTimers();
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
                const realtimeListener = jest.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);

                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });
                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                });
                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                });

                await jest.advanceTimersByTimeAsync(5000);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));
            } finally {
                jest.useRealTimers();
            }
        });

        it('drops a pending binary settle window when the device disappears before expiry', async () => {
            jest.useFakeTimers();
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
                const realtimeListener = jest.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);
                deviceManager.setSnapshotForTests([]);

                await jest.advanceTimersByTimeAsync(5000);

                expect(realtimeListener).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
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

        it('updates local target snapshot after a successful temperature write', async () => {
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
                value: 18,
            }));
        });

        it('updates the correct target when a device has multiple target capabilities', async () => {
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
            expect(updated?.targets[1]).toEqual(expect.objectContaining({ id: 'target_temperature.zone1', value: 18 }));
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
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            emitMockSdkDeviceUpdate({
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
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                changes: [{
                    capabilityId: 'target_temperature',
                    previousValue: '20°C',
                    nextValue: '18°C',
                }],
            });
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
            emitMockSdkDeviceUpdate({
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
            jest.useFakeTimers();
            try {
                jest.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
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

                emitMockSdkDeviceUpdate({
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

                jest.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
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
                jest.useRealTimers();
            }
        });

        it('preserves a newer local target write across a stale snapshot refresh and keeps freshness timestamps', async () => {
            jest.useFakeTimers();
            try {
                jest.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
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
                    lastFreshDataMs: new Date('2026-03-20T06:00:00.000Z').getTime(),
                    lastLocalWriteMs: undefined,
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 23 })],
                }));

                jest.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                await deviceManager.setCapability('dev1', 'target_temperature', 16);
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    lastLocalWriteMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 16 })],
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
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    lastLocalWriteMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 16 })],
                }));
                expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining(
                    'Device snapshot refresh preserved newer local_write target_temperature for Heater (dev1)',
                ));
            } finally {
                jest.useRealTimers();
            }
        });

        it('uses snapshot refresh time as the freshness baseline for stable devices', async () => {
            jest.useFakeTimers();
            try {
                await deviceManager.init();
                jest.setSystemTime(new Date('2026-03-20T06:10:00.000Z'));
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
                    lastFreshDataMs: new Date('2026-03-20T06:10:00.000Z').getTime(),
                    lastUpdated: new Date('2026-03-20T06:10:00.000Z').getTime(),
                }));
            } finally {
                jest.useRealTimers();
            }
        });

        it('preserves fresher power observed from device.update across a stale snapshot refresh', async () => {
            jest.useFakeTimers();
            try {
                await deviceManager.init();
                jest.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
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

                jest.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                emitMockSdkDeviceUpdate({
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
                expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining(
                    'Device snapshot refresh preserved newer device_update measure_power for Heater (dev1)',
                ));
            } finally {
                jest.useRealTimers();
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
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            // device.update with target changed from 20 to 18
            emitMockSdkDeviceUpdate({
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
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                changes: [{
                    capabilityId: 'target_temperature',
                    previousValue: '20°C',
                    nextValue: '18°C',
                }],
            });

            // Subsequent device.update with same value does not trigger reconcile
            realtimeListener.mockClear();
            emitMockSdkDeviceUpdate({
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

        it('updates local state on generic device.update events', async () => {
            await deviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: undefined,
                measuredPowerKw: 1,
            }));

            emitMockSdkDeviceUpdate({
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
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                changes: [{
                    capabilityId: 'onoff',
                    previousValue: 'unknown',
                    nextValue: 'on',
                }],
            });
        });

        it('records device.update freshness before emitting reconcile', async () => {
            jest.useFakeTimers();
            try {
                await deviceManager.init();
                jest.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
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

                jest.setSystemTime(new Date('2026-03-20T06:05:00.000Z'));
                emitMockSdkDeviceUpdate({
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
                jest.useRealTimers();
            }
        });

        it('treats ev state-only device.update events as fresh observations', async () => {
            jest.useFakeTimers();
            try {
                const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                    getExperimentalEvSupportEnabled: () => true,
                });
                await evDeviceManager.init();

                jest.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
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

                jest.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                emitMockSdkDeviceUpdate({
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
                    evChargingState: 'plugged_in_paused',
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                jest.useRealTimers();
            }
        });

        it('preserves fresher ev charger state across a stale snapshot refresh', async () => {
            jest.useFakeTimers();
            try {
                const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                    getExperimentalEvSupportEnabled: () => true,
                });
                await evDeviceManager.init();

                jest.setSystemTime(new Date('2026-03-20T06:00:00.000Z'));
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

                jest.setSystemTime(new Date('2026-03-20T06:00:01.000Z'));
                emitMockSdkDeviceUpdate({
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
                    evChargingState: 'plugged_in_paused',
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                jest.useRealTimers();
            }
        });

        it('suppresses stale device.update drift immediately after a local binary write', async () => {
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
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', false);
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));

            emitMockSdkDeviceUpdate({
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
                currentOn: false,
            }));
            expect(realtimeListener).not.toHaveBeenCalled();
        });

        it('suppresses device.update binary drift while a local off write is still settling', async () => {
            jest.useFakeTimers();
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
                const realtimeListener = jest.fn();
                deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

                await deviceManager.setCapability('dev1', 'onoff', false);

                emitMockSdkDeviceUpdate({
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                });

                await jest.advanceTimersByTimeAsync(5000);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: false,
                }));
            } finally {
                jest.useRealTimers();
            }
        });

        it('ignores generic device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceManager(
                homeyMock,
                loggerMock,
                { getManaged: () => false },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            emitMockSdkDeviceUpdate({
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
            expect(findSnapshotDevice(managedDeviceManager.getSnapshot(), 'dev1')).toEqual(expect.objectContaining({
                managed: false,
                measuredPowerKw: 1,
            }));

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
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            emitMockSdkDeviceUpdate({
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

        it('cleans up listeners on destroy', async () => {
            await deviceManager.refreshSnapshot();
            const listenersBefore = mockSdkDevicesEmitter.listenerCount('realtime');
            expect(listenersBefore).toBeGreaterThanOrEqual(1);

            deviceManager.destroy();

            // After destroy, device.update events should not trigger handler
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            emitMockSdkDeviceUpdate({
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
        });

        it('ignores device.update events for a device that stops being managed', async () => {
            const managedState: Record<string, boolean> = { dev1: true };
            const managedDeviceManager = new DeviceManager(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true },
            );
            await managedDeviceManager.init();
            await managedDeviceManager.refreshSnapshot();

            managedState.dev1 = false;
            await managedDeviceManager.refreshSnapshot();

            const realtimeListener = jest.fn();
            managedDeviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            emitMockSdkDeviceUpdate({
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
