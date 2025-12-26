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
                    capabilities: ['measure_power', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 1000, id: 'measure_power' },
                        target_temperature: { value: 20, id: 'target_temperature', units: '°C' },
                        onoff: { value: true, id: 'onoff' },
                    },
                },
                dev2: {
                    id: 'dev2',
                    name: 'Light',
                    capabilities: ['onoff'],
                    capabilitiesObj: {
                        onoff: { value: true, id: 'onoff' },
                    },
                },
            });

            await deviceManager.refreshSnapshot();

            const snapshot = deviceManager.getSnapshot();
            expect(snapshot).toHaveLength(1); // Only Heater has target_temperature
            expect(snapshot[0].id).toBe('dev1');
            expect(snapshot[0].powerKw).toBe(1);
            expect(snapshot[0].currentOn).toBe(true);
        });

        it('includes measured power zero when load setting is present', async () => {
            await deviceManager.init();
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['measure_power', 'target_temperature'],
                    capabilitiesObj: {
                        measure_power: { value: 0, id: 'measure_power' },
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

        it('uses providers to populate priority and controllable fields', async () => {
            const getPriority = jest.fn().mockReturnValue(1);
            const getControllable = jest.fn().mockReturnValue(false);

            deviceManager = new DeviceManager(homeyMock, loggerMock, { getPriority, getControllable });
            await deviceManager.init();

            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['target_temperature'],
                    capabilitiesObj: {
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
    });

    describe('applyDeviceTargets', () => {
        it('sets capabilities for mapped devices', async () => {
            await deviceManager.init();
            // Seed the snapshot
            mockGetDevices.mockResolvedValue({
                dev1: {
                    id: 'dev1',
                    name: 'Heater',
                    capabilities: ['target_temperature'],
                    capabilitiesObj: {
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
        });
    });
});
