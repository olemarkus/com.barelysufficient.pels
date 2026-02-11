import { DeviceManager } from '../lib/core/deviceManager';
import { mockHomeyInstance } from './mocks/homey';
import Homey from 'homey';

// Mock homey-api
const mockSetCapabilityValue = jest.fn();
const mockGetDevices = jest.fn();

jest.mock('homey-api', () => ({
    HomeyAPI: {
        createAppAPI: jest.fn().mockImplementation(() => Promise.resolve({
            devices: {
                getDevices: mockGetDevices,
                setCapabilityValue: mockSetCapabilityValue,
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

const makeCapabilityInstanceImpl = (destroyInstanceMock: jest.Mock) => (
    _cap: string,
    cb: (value: number | null) => void,
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
            expect(require('homey-api').HomeyAPI.createAppAPI).toHaveBeenCalledWith({ homey: homeyMock });
            expect(loggerMock.log).toHaveBeenCalledWith(expect.stringContaining('initialized'));
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
            expect(snapshot[0].canSetOnOff).toBeUndefined();
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

        it('initializes capability listener for measure_power', async () => {
            await deviceManager.refreshSnapshot();
            expect(makeInstanceMock).toHaveBeenCalledWith('measure_power', expect.any(Function));
        });

        it('updates local state on power change', async () => {
            await deviceManager.refreshSnapshot();
            // Get the registered callback
            const callback = makeInstanceMock.mock.calls[0][1];

            // Verify initial state
            expect(deviceManager.getSnapshot()[0].measuredPowerKw).toBe(1);

            // Trigger update 2000W
            callback(2000);

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot[0].measuredPowerKw).toBe(2);
            expect(snapshot[0].powerKw).toBe(2);
        });

        it('cleans up listeners on destroy', async () => {
            await deviceManager.refreshSnapshot();
            // Instance created
            deviceManager.destroy();
            expect(destroyInstanceMock).toHaveBeenCalled();
        });
    });
});
