import { DeviceManager, PLAN_LIVE_STATE_OBSERVED_EVENT, PLAN_RECONCILE_REALTIME_UPDATE_EVENT } from '../lib/core/deviceManager';
import type { LiveFeedHealth } from '../lib/core/deviceLiveFeed';
import {
    mockHomeyInstance,
} from './mocks/homey';
import Homey from 'homey';
import * as homeyApi from '../lib/core/deviceManagerHomeyApi';

// Mock the live feed so tests don't attempt a real socket.io connection.
vi.mock('../lib/core/deviceLiveFeed', () => {
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

describe('DeviceManager', () => {
    let deviceManager: DeviceManager;
    let homeyMock: Homey.App;
    let loggerMock: { log: vi.Mock; debug: vi.Mock; error: vi.Mock };

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
            expect(snapshot[0].currentOn).toBe(true);
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
            const getPriority = vi.fn().mockReturnValue(1);
            const getControllable = vi.fn().mockReturnValue(false);

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
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

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

            vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
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
                    capabilities: ['meter_power.in_tank', 'target_temperature', 'measure_temperature'],
                    capabilitiesObj: {
                        'meter_power.in_tank': { value: 100, id: 'meter_power.in_tank' },
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

            vi.useRealTimers();
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

        it('updates local state on power change via device.update', async () => {
            await deviceManager.refreshSnapshot();

            // Verify initial state
            expect(deviceManager.getSnapshot()[0].measuredPowerKw).toBe(1);

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

        it('prunes stale debug sources and ignores no-op realtime updates for removed devices', async () => {
            await deviceManager.refreshSnapshot();
            expect(deviceManager.getDebugObservedSources('dev1')?.snapshotRefresh).toBeDefined();

            mockApiGet.mockResolvedValue({});
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
            await deviceManager.refreshSnapshot();
            const realtimeListener = vi.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

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
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                changes: [{
                    capabilityId: 'onoff',
                    previousValue: 'on',
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
            const realtimeListener = vi.fn();
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
            expect(realtimeListener).toHaveBeenCalledWith(expect.objectContaining({
                deviceId: 'dev1',
                changes: [expect.objectContaining({ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' })],
            }));
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
            }));
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
                expect(realtimeListener).toHaveBeenCalledWith({
                    deviceId: 'dev1',
                    name: 'Heater',
                    capabilityId: 'onoff',
                    changes: [{
                        capabilityId: 'onoff',
                        previousValue: 'off',
                        nextValue: 'on',
                    }],
                });
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

            it('does not preserve the stale desired binary state after settle timeout expires and a later non-boolean device.update arrives', async () => {
                vi.useFakeTimers();
                try {
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

                    await deviceManager.setCapability('dev1', 'onoff', false);

                    deviceManager.injectDeviceUpdateForTest({
                        id: 'dev1',
                        name: 'Heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        class: 'heater',
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: { value: 19, id: 'target_temperature', units: '°C' },
                        },
                    });

                    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                        currentOn: false,
                        targets: [expect.objectContaining({ id: 'target_temperature', value: 19 })],
                    }));
                    expect(realtimeListener).toHaveBeenCalledWith({
                        deviceId: 'dev1',
                        name: 'Heater',
                        changes: [{
                            capabilityId: 'target_temperature',
                            previousValue: '20°C',
                            nextValue: '19°C',
                        }],
                    });

                    realtimeListener.mockClear();

                    await vi.advanceTimersByTimeAsync(5001);

                    deviceManager.injectDeviceUpdateForTest({
                        id: 'dev1',
                        name: 'Heater',
                        capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                        class: 'heater',
                        capabilitiesObj: {
                            measure_power: { value: 1000, id: 'measure_power' },
                            measure_temperature: { value: 21, id: 'measure_temperature', units: '°C' },
                            target_temperature: { value: 18, id: 'target_temperature', units: '°C' },
                        },
                    });

                    expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                        currentOn: true,
                        targets: [expect.objectContaining({ id: 'target_temperature', value: 18 })],
                    }));
                    expect(realtimeListener).toHaveBeenCalledWith({
                        deviceId: 'dev1',
                        name: 'Heater',
                        changes: [
                            {
                                capabilityId: 'onoff',
                                previousValue: 'off',
                                nextValue: 'on',
                            },
                            {
                                capabilityId: 'target_temperature',
                                previousValue: '19°C',
                                nextValue: '18°C',
                            },
                        ],
                    });
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

        it('preserves a newer local target write across a stale snapshot refresh and keeps freshness timestamps', async () => {
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
                    lastFreshDataMs: new Date('2026-03-20T05:59:30.000Z').getTime(),
                    lastLocalWriteMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 16 })],
                }));
                expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining(
                    'Device snapshot refresh preserved newer local_write target_temperature for Heater (dev1)',
                ));
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
                expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining(
                    'Device snapshot refresh preserved newer device_update measure_power for Heater (dev1)',
                ));
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

        it('assumes on for onoff devices when snapshot data omits the boolean value', async () => {
            await deviceManager.refreshSnapshot();

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
                measuredPowerKw: 1,
            }));
            expect(loggerMock.debug).toHaveBeenCalledWith(
                expect.stringContaining('Snapshot missing boolean onoff value for Heater (dev1); assuming device is on'),
                undefined,
            );
        });

        it('updates local state on generic device.update events', async () => {
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
                const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                    getExperimentalEvSupportEnabled: () => true,
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
                    evChargingState: 'plugged_in_paused',
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
                }));

                evDeviceManager.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('preserves fresher ev charger state across a stale snapshot refresh', async () => {
            vi.useFakeTimers();
            try {
                const evDeviceManager = new DeviceManager(homeyMock, loggerMock, {
                    getExperimentalEvSupportEnabled: () => true,
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
                    evChargingState: 'plugged_in_paused',
                    lastFreshDataMs: new Date('2026-03-20T06:00:01.000Z').getTime(),
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

        it('ignores generic device.update events for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceManager(
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

            it('suppresses normalized capability echoes for own recent writes', async () => {
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
                ).toBe(21.5);
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
                    deviceManager = new DeviceManager(homeyMock, loggerMock, undefined, undefined, { debugStructured });
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
                deviceManager = new DeviceManager(homeyMock, loggerMock, undefined, undefined, { debugStructured });
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

                    // Local target_temperature write
                    await deviceManager.setCapability('dev1', 'target_temperature', 18);
                    expect(deviceManager.getSnapshot()[0].targets.find((t) => t.id === 'target_temperature')?.value).toBe(18);
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

            it('marks device fresh at poll time even when tracked capability timestamps are unchanged', async () => {
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

                    // Advance 6 minutes — device is now stale (threshold is 5 minutes)
                    vi.setSystemTime(new Date('2026-04-01T12:06:00.000Z'));

                    // Normal refresh with unchanged timestamps: freshness must NOT advance
                    await deviceManager.refreshSnapshot();
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(freshnessAfterInit);

                    // Stale-targeted refresh: freshness MUST advance to the poll time
                    await deviceManager.refreshSnapshot({ targetedRefresh: true });
                    expect(deviceManager.getSnapshot()[0].lastFreshDataMs).toBe(
                        new Date('2026-04-01T12:06:00.000Z').getTime(),
                    );
                } finally {
                    vi.useRealTimers();
                }
            });
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
