import { DeviceManager, PLAN_RECONCILE_REALTIME_UPDATE_EVENT } from '../lib/core/deviceManager';
import { mockHomeyInstance } from './mocks/homey';
import Homey from 'homey';
import { EventEmitter } from 'events';

// Mock homey-api
const mockSetCapabilityValue = jest.fn();
const mockGetDevices = jest.fn();
const mockGetLiveReport = jest.fn();
const mockDevicesConnect = jest.fn().mockResolvedValue(undefined);
const mockDevicesDisconnect = jest.fn().mockResolvedValue(undefined);
const mockDevicesEmitter = new EventEmitter();
mockDevicesEmitter.setMaxListeners(0);

jest.mock('homey-api', () => ({
    HomeyAPI: {
        createAppAPI: jest.fn().mockImplementation(() => Promise.resolve({
            devices: {
                getDevices: mockGetDevices,
                setCapabilityValue: mockSetCapabilityValue,
                connect: mockDevicesConnect,
                disconnect: mockDevicesDisconnect,
                on: mockDevicesEmitter.on.bind(mockDevicesEmitter),
                off: mockDevicesEmitter.off.bind(mockDevicesEmitter),
            },
            energy: {
                getLiveReport: mockGetLiveReport,
            },
        })),
    },
}));

const findSnapshotDevice = <T extends { id: string }>(
    snapshot: T[],
    deviceId: string,
): T | undefined => {
    for (const device of snapshot) {
        if (device.id === deviceId) return device;
    }
    return undefined;
};

const getCapabilityCallback = (makeInstanceMock: jest.Mock, capabilityId: string) => {
    const call = makeInstanceMock.mock.calls.find(([nextCapabilityId]) => nextCapabilityId === capabilityId);
    if (!call) {
        throw new Error(`Missing capability listener for ${capabilityId}`);
    }
    return call[1] as (value: unknown) => void;
};

const makeCapabilityInstanceImpl = (destroyInstanceMock: jest.Mock) => (
    _cap: string,
    cb: (value: unknown) => void,
) => Promise.resolve({
    destroy: destroyInstanceMock,
    __trigger: cb,
});

const buildRealtimeDevices = (
    makeInstanceMock: jest.Mock,
    destroyInstanceMock: jest.Mock,
) => ({
    dev1: {
        id: 'dev1',
        name: 'Heater',
        capabilities: ['measure_power', 'onoff'],
        class: 'heater',
        makeCapabilityInstance: makeInstanceMock.mockImplementation(
            makeCapabilityInstanceImpl(destroyInstanceMock),
        ),
        capabilitiesObj: {
            measure_power: { value: 1000, id: 'measure_power' },
        },
    },
});

describe('DeviceManager', () => {
    let deviceManager: DeviceManager;
    let homeyMock: Homey.App;
    let loggerMock: { log: jest.Mock; debug: jest.Mock; error: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        mockDevicesEmitter.removeAllListeners();
        mockGetLiveReport.mockResolvedValue({ items: [] });
        homeyMock = mockHomeyInstance as unknown as Homey.App;

        // Mock Homey API/Cloud/Platform properties required for init checks
        (homeyMock as any).api = {
            getOwnerApiToken: jest.fn().mockReturnValue('mock-token'),
            getLocalUrl: jest.fn().mockReturnValue('http://localhost'),
        };
        (homeyMock as any).cloud = {
            getHomeyId: jest.fn().mockReturnValue('mock-id'),
        };
        (homeyMock as any).platform = 'local';
        (homeyMock as any).platformVersion = '2.0.0';

        loggerMock = {
            log: jest.fn(),
            debug: jest.fn(),
            error: jest.fn(),
        };
        deviceManager = new DeviceManager(homeyMock, loggerMock);
    });

    describe('init', () => {
        it('initializes HomeyAPI when checks pass', async () => {
            await deviceManager.init();
            expect(require('homey-api').HomeyAPI.createAppAPI).toHaveBeenCalledWith(expect.objectContaining({
                homey: homeyMock,
                debug: expect.any(Function),
            }));
            expect(loggerMock.log).toHaveBeenCalledWith(expect.stringContaining('initialized'));
        });

        it('promotes error-like HomeyAPI debug entries to error logs', async () => {
            await deviceManager.init();
            const createAppApiCall = require('homey-api').HomeyAPI.createAppAPI.mock.calls[0]?.[0];
            const debug = createAppApiCall?.debug as ((...args: unknown[]) => void) | undefined;

            debug?.('[HomeyAPIV3Local]', 'SocketIOClient.Namespace[/manager/devices].onConnectError', 'parseuri is not a function');

            expect(loggerMock.error).toHaveBeenCalledWith(
                'HomeyAPI:',
                '[HomeyAPIV3Local]',
                'SocketIOClient.Namespace[/manager/devices].onConnectError',
                'parseuri is not a function',
            );
        });

        it('does not promote routine HomeyAPI debug entries', async () => {
            await deviceManager.init();
            const createAppApiCall = require('homey-api').HomeyAPI.createAppAPI.mock.calls[0]?.[0];
            const debug = createAppApiCall?.debug as ((...args: unknown[]) => void) | undefined;

            debug?.('[HomeyAPIV3Local]', 'SocketIOClient.onConnect');

            expect(loggerMock.error).not.toHaveBeenCalledWith(
                'HomeyAPI:',
                '[HomeyAPIV3Local]',
                'SocketIOClient.onConnect',
            );
        });

        it('skips initialization if checks fail', async () => {
            (homeyMock as any).api = undefined;
            await deviceManager.init();
            expect(require('homey-api').HomeyAPI.createAppAPI).not.toHaveBeenCalled();
        });
    });

    describe('refreshSnapshot', () => {
        it('populates snapshot with controllable devices', async () => {
            await deviceManager.init();
            mockGetDevices.mockResolvedValue({
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

        it('includes airtreatment temperature devices in snapshot', async () => {
            await deviceManager.init();
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            expect(mockGetLiveReport).toHaveBeenCalledWith({});
        });

        it('keeps off on/off devices power-capable when Homey energy W metadata exists', async () => {
            await deviceManager.init();
            mockGetDevices.mockResolvedValue({
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

            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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
            mockGetDevices.mockResolvedValue({
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

            expect(mockSetCapabilityValue).toHaveBeenCalledWith({
                deviceId: 'dev1',
                capabilityId: 'target_temperature',
                value: 22,
            });
            expect(mockSetCapabilityValue).toHaveBeenCalledWith({
                deviceId: 'dev1',
                capabilityId: 'target_temperature',
                value: 22,
            });
        });
    });

    describe('Real-time updates', () => {
        let makeInstanceMock: jest.Mock;
        let destroyInstanceMock: jest.Mock;

        beforeEach(async () => {
            makeInstanceMock = jest.fn();
            destroyInstanceMock = jest.fn();

            // Setup device with makeCapabilityInstance
            mockGetDevices.mockResolvedValue(buildRealtimeDevices(
                makeInstanceMock,
                destroyInstanceMock,
            ));
            await deviceManager.init();
        });

        it('initializes realtime listeners for power and onoff capabilities', async () => {
            await deviceManager.refreshSnapshot();
            expect(makeInstanceMock).toHaveBeenCalledWith('measure_power', expect.any(Function));
            expect(makeInstanceMock).toHaveBeenCalledWith('onoff', expect.any(Function));
        });

        it('does not attach capability listeners for unmanaged devices', async () => {
            const managedDeviceManager = new DeviceManager(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => deviceId === 'dev1' },
            );
            await managedDeviceManager.init();

            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Managed heater',
                    capabilities: ['measure_power', 'onoff'],
                    class: 'heater',
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
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
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
                    capabilitiesObj: {
                        measure_power: { value: 900, id: 'measure_power' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await managedDeviceManager.refreshSnapshot();

            expect(makeInstanceMock).toHaveBeenCalledTimes(2);
            expect(makeInstanceMock).toHaveBeenNthCalledWith(1, 'measure_power', expect.any(Function));
            expect(makeInstanceMock).toHaveBeenNthCalledWith(2, 'onoff', expect.any(Function));
            expect(mockDevicesConnect).toHaveBeenCalledTimes(1);
            expect(mockDevicesEmitter.listenerCount('device.update')).toBe(1);
        });

        it('attaches realtime capability listeners when a device becomes managed', async () => {
            const managedState: Record<string, boolean> = { dev1: false };
            const managedDeviceManager = new DeviceManager(
                homeyMock,
                loggerMock,
                { getManaged: (deviceId) => managedState[deviceId] === true },
            );
            await managedDeviceManager.init();

            await managedDeviceManager.refreshSnapshot();
            expect(makeInstanceMock).not.toHaveBeenCalled();
            expect(mockDevicesConnect).not.toHaveBeenCalled();
            expect(mockDevicesEmitter.listenerCount('device.update')).toBe(0);

            managedState.dev1 = true;
            await managedDeviceManager.refreshSnapshot();

            expect(makeInstanceMock).toHaveBeenCalledTimes(2);
            expect(makeInstanceMock).toHaveBeenNthCalledWith(1, 'measure_power', expect.any(Function));
            expect(makeInstanceMock).toHaveBeenNthCalledWith(2, 'onoff', expect.any(Function));
            expect(mockDevicesConnect).toHaveBeenCalledTimes(1);
            expect(mockDevicesEmitter.listenerCount('device.update')).toBe(1);
        });

        it('logs device.update listener attachment failures as errors', async () => {
            mockDevicesConnect.mockRejectedValueOnce(new TypeError('parseuri is not a function'));

            await deviceManager.refreshSnapshot();

            expect(loggerMock.error).toHaveBeenCalledWith(
                'Failed to attach device.update listener',
                expect.any(TypeError),
            );
        });

        it('updates local state on power change', async () => {
            await deviceManager.refreshSnapshot();
            const callback = getCapabilityCallback(makeInstanceMock, 'measure_power');

            // Verify initial state
            expect(deviceManager.getSnapshot()[0].measuredPowerKw).toBe(1);

            // Trigger update 2000W
            callback(2000);

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot[0].measuredPowerKw).toBe(2);
            expect(snapshot[0].powerKw).toBe(2);
        });

        it('tracks snapshot refresh, realtime capability, and device.update sources for debug dumps', async () => {
            await deviceManager.refreshSnapshot();

            let observedSources = deviceManager.getDebugObservedSources('dev1');
            expect(observedSources?.snapshotRefresh).toEqual(expect.objectContaining({
                path: 'snapshot_refresh',
                fetchSource: 'homey_api_getDevices',
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    measuredPowerKw: 1,
                }),
            }));

            const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
            onOffCallback(true);

            observedSources = deviceManager.getDebugObservedSources('dev1');
            expect(observedSources?.realtimeCapabilities.onoff).toEqual(expect.objectContaining({
                path: 'realtime_capability',
                capabilityId: 'onoff',
                value: true,
                shouldReconcilePlan: true,
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    currentOn: true,
                }),
            }));

            mockDevicesEmitter.emit('device.update', {
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

            const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');

            mockGetDevices.mockResolvedValue({});
            await deviceManager.refreshSnapshot();

            expect(deviceManager.getDebugObservedSources('dev1')).toBeNull();

            onOffCallback(true);
            expect(deviceManager.getDebugObservedSources('dev1')).toBeNull();

            mockDevicesEmitter.emit('device.update', {
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

        it('emits reconcile event when onoff changes via capability listener', async () => {
            await deviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
            onOffCallback(false);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: false,
            }));
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                capabilityId: 'onoff',
                changes: [{
                    capabilityId: 'onoff',
                    previousValue: 'unknown',
                    nextValue: 'off',
                }],
            });
        });

        it('suppresses reconcile for the realtime echo of a local onoff write', async () => {
            await deviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            await deviceManager.setCapability('dev1', 'onoff', true);

            const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
            onOffCallback(true);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
            }));
            expect(realtimeListener).not.toHaveBeenCalled();
            expect(loggerMock.debug).toHaveBeenCalledWith(
                'Realtime capability update for Heater (dev1) via onoff: true [local echo]',
            );
        });

        it('suppresses reconcile when the realtime echo arrives before the local write resolves', async () => {
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        onoff: { value: false, id: 'onoff' },
                    },
                },
            });

            let resolveWrite: (() => void) | undefined;
            mockSetCapabilityValue.mockImplementationOnce(() => new Promise<void>((resolve) => {
                resolveWrite = resolve;
            }));

            await deviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            const setCapabilityPromise = deviceManager.setCapability('dev1', 'onoff', true);
            const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
            onOffCallback(true);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: true,
            }));
            expect(realtimeListener).not.toHaveBeenCalled();
            expect(loggerMock.debug).toHaveBeenCalledWith(
                'Realtime capability update for Heater (dev1) via onoff: true [local echo]',
            );

            resolveWrite?.();
            await setCapabilityPromise;
        });

        it('waits for the binary settle window before reconciling contradictory onoff callbacks', async () => {
            jest.useFakeTimers();
            try {
                mockGetDevices.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        makeCapabilityInstance: makeInstanceMock.mockImplementation(
                            makeCapabilityInstanceImpl(destroyInstanceMock),
                        ),
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

                const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
                onOffCallback(true);

                expect(realtimeListener).not.toHaveBeenCalled();
                expect(loggerMock.debug).toHaveBeenCalledWith(
                    'Realtime capability update for Heater (dev1) via onoff: true [binary settling]',
                );

                await jest.advanceTimersByTimeAsync(4999);
                expect(realtimeListener).not.toHaveBeenCalled();

                await jest.advanceTimersByTimeAsync(1);
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
            } finally {
                jest.useRealTimers();
            }
        });

        it('uses the latest onoff observation before the settle deadline as the source of truth', async () => {
            jest.useFakeTimers();
            try {
                mockGetDevices.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        makeCapabilityInstance: makeInstanceMock.mockImplementation(
                            makeCapabilityInstanceImpl(destroyInstanceMock),
                        ),
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

                const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
                onOffCallback(false);
                onOffCallback(true);

                await jest.advanceTimersByTimeAsync(5000);

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
                expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                    currentOn: true,
                }));
            } finally {
                jest.useRealTimers();
            }
        });

        it('confirms the local off write when the latest onoff observation before deadline is off', async () => {
            jest.useFakeTimers();
            try {
                mockGetDevices.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        makeCapabilityInstance: makeInstanceMock.mockImplementation(
                            makeCapabilityInstanceImpl(destroyInstanceMock),
                        ),
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

                const onOffCallback = getCapabilityCallback(makeInstanceMock, 'onoff');
                onOffCallback(true);
                onOffCallback(true);
                onOffCallback(false);

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
                mockGetDevices.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        makeCapabilityInstance: makeInstanceMock.mockImplementation(
                            makeCapabilityInstanceImpl(destroyInstanceMock),
                        ),
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

        it('preserves local onoff state after a successful binary write when no realtime capability listener is available', async () => {
            mockGetDevices.mockResolvedValue({
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
                currentOn: true,
            }));
            expect(deviceManager.getDebugObservedSources('dev1')?.localWrites.onoff).toEqual(expect.objectContaining({
                path: 'local_write',
                capabilityId: 'onoff',
                value: true,
                preservedLocalState: true,
                snapshot: expect.objectContaining({
                    id: 'dev1',
                    currentOn: true,
                }),
            }));
        });

        it('keeps binary writes non-optimistic when a realtime capability listener is available', async () => {
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'onoff'],
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
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

        it('emits reconcile event when target temperature changes via capability listener', async () => {
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
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

            const targetCallback = getCapabilityCallback(makeInstanceMock, 'target_temperature');
            targetCallback(18);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 18 })],
            }));
            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                capabilityId: 'target_temperature',
                changes: [{
                    capabilityId: 'target_temperature',
                    previousValue: '20°C',
                    nextValue: '18°C',
                }],
            });
        });

        it('preserves newer realtime target observations when snapshot refresh returns an older target timestamp', async () => {
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
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

            const targetCallback = getCapabilityCallback(makeInstanceMock, 'target_temperature');
            targetCallback(26.5);
            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
            }));

            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
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

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
            }));
            expect(deviceManager.getDebugObservedSources('dev1')?.snapshotRefresh).toEqual(expect.objectContaining({
                path: 'snapshot_refresh',
                snapshot: expect.objectContaining({
                    targets: [expect.objectContaining({ id: 'target_temperature', value: 26.5 })],
                }),
            }));
            expect(loggerMock.debug).toHaveBeenCalledWith(
                expect.stringContaining('Device snapshot refresh preserved newer realtime target_temperature for Heater (dev1)'),
            );
        });

        it('consumes local target writes even when the first realtime echo has no drift', async () => {
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    class: 'heater',
                    capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'onoff'],
                    makeCapabilityInstance: makeInstanceMock.mockImplementation(
                        makeCapabilityInstanceImpl(destroyInstanceMock),
                    ),
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

            await deviceManager.setCapability('dev1', 'target_temperature', 18);

            const targetCallback = getCapabilityCallback(makeInstanceMock, 'target_temperature');
            targetCallback(18);
            expect(realtimeListener).not.toHaveBeenCalled();

            const snapshot = deviceManager.getSnapshot();
            snapshot[0].targets[0].value = 20;

            targetCallback(18);

            expect(realtimeListener).toHaveBeenCalledWith({
                deviceId: 'dev1',
                name: 'Heater',
                capabilityId: 'target_temperature',
                changes: [{
                    capabilityId: 'target_temperature',
                    previousValue: '20°C',
                    nextValue: '18°C',
                }],
            });
        });
        it('updates local state on generic device.update events', async () => {
            await deviceManager.refreshSnapshot();
            const realtimeListener = jest.fn();
            deviceManager.on(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, realtimeListener);

            expect(deviceManager.getSnapshot()[0]).toEqual(expect.objectContaining({
                currentOn: undefined,
                measuredPowerKw: 1,
            }));

            mockDevicesEmitter.emit('device.update', {
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

        it('suppresses stale device.update drift immediately after a local binary write', async () => {
            mockGetDevices.mockResolvedValue({
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

            mockDevicesEmitter.emit('device.update', {
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
                mockGetDevices.mockResolvedValue({
                    dev1: {
                        id: 'dev1',
                        name: 'Heater',
                        class: 'heater',
                        capabilities: ['measure_power', 'onoff'],
                        makeCapabilityInstance: makeInstanceMock.mockImplementation(
                            makeCapabilityInstanceImpl(destroyInstanceMock),
                        ),
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

                mockDevicesEmitter.emit('device.update', {
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

            mockDevicesEmitter.emit('device.update', {
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
            expect(mockDevicesConnect).not.toHaveBeenCalled();
            expect(mockDevicesEmitter.listenerCount('device.update')).toBe(0);
        });

        it('does not emit reconcile event for temperature-only generic device changes', async () => {
            mockGetDevices.mockResolvedValue({
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

            mockDevicesEmitter.emit('device.update', {
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
            // Instance created
            deviceManager.destroy();
            expect(destroyInstanceMock).toHaveBeenCalled();
        });

        it('destroys realtime capability listeners when a device stops being managed', async () => {
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

            expect(destroyInstanceMock).toHaveBeenCalledTimes(2);
            expect(mockDevicesDisconnect).toHaveBeenCalledTimes(1);
            expect(mockDevicesEmitter.listenerCount('device.update')).toBe(0);
        });
    });
});
