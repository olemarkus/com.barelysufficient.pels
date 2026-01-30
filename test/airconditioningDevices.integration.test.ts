import {
    mockHomeyInstance,
    setMockDrivers,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
jest.useFakeTimers({ doNotFake: ['nextTick', 'Date'] });

const buildAirconApiDevice = (overrides?: Partial<{
    id: string;
    name: string;
    onoff: boolean;
    meterPower: number;
    targetTemperature: number;
    measureTemperature: number;
    class: string;
    capabilities: string[];
}>) => ({
    id: overrides?.id ?? 'aircon-a',
    name: overrides?.name ?? 'Living Room AC',
    class: overrides?.class ?? 'airconditioning',
    virtualClass: null,
    capabilities: overrides?.capabilities ?? [
        'onoff',
        'target_temperature',
        'measure_temperature',
        'meter_power',
    ],
    capabilitiesObj: {
        onoff: { id: 'onoff', value: overrides?.onoff ?? true },
        target_temperature: {
            id: 'target_temperature',
            value: overrides?.targetTemperature ?? 22,
            units: '°C',
            min: 10,
            max: 30,
        },
        measure_temperature: { id: 'measure_temperature', value: overrides?.measureTemperature ?? 21, units: '°C' },
        meter_power: { id: 'meter_power', value: overrides?.meterPower ?? 100 },
    },
    settings: {},
});

describe('Airconditioning device integration', () => {
    beforeEach(() => {
        mockHomeyInstance.settings.removeAllListeners();
        mockHomeyInstance.settings.clear();
        mockHomeyInstance.flow._actionCardListeners = {};
        mockHomeyInstance.flow._conditionCardListeners = {};
        mockHomeyInstance.flow._triggerCardRunListeners = {};
        mockHomeyInstance.flow._triggerCardTriggers = {};
        mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
        jest.clearAllTimers();
    });

    afterEach(async () => {
        await cleanupApps();
        jest.clearAllTimers();
    });

    it('includes airconditioning devices with meter_power', async () => {
        setMockDrivers({});
        const app = createApp();
        await app.onInit();

        (app as any).deviceManager.homeyApi = {
            devices: {
                getDevices: async () => ({
                    'aircon-a': buildAirconApiDevice(),
                }),
            },
        };

        await (app as any).refreshTargetDevicesSnapshot();

        const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
        const entry = snapshot.find((device) => device.id === 'aircon-a');

        expect(entry).toBeDefined();
        expect(entry?.deviceClass).toBe('airconditioning');
        expect(entry?.deviceType).toBe('temperature');
        expect(entry?.targets?.[0]?.id).toBe('target_temperature');
        expect(entry?.powerCapable).toBe(true);
    });
});
