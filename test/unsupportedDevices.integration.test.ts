import {
    mockHomeyInstance,
    setMockDrivers,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
jest.useFakeTimers({ doNotFake: ['nextTick', 'Date'] });

const buildVentilationApiDevice = (overrides?: Partial<{
    id: string;
    name: string;
    targetTemperature: number;
    measureTemperature: number;
    class: string;
    capabilities: string[];
}>) => ({
    id: overrides?.id ?? 'vent-1',
    name: overrides?.name ?? 'Ventilation',
    class: overrides?.class ?? 'thermostat',
    virtualClass: null,
    capabilities: overrides?.capabilities ?? [
        'target_temperature',
        'measure_temperature',
    ],
    capabilitiesObj: {
        target_temperature: {
            id: 'target_temperature',
            value: overrides?.targetTemperature ?? 20,
            units: '°C',
            min: 12,
            max: 30,
        },
        measure_temperature: { id: 'measure_temperature', value: overrides?.measureTemperature ?? 20.5, units: '°C' },
    },
    settings: {},
});

describe('Unsupported device handling', () => {
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

    it('forces devices without power capability to remain unmanaged', async () => {
        setMockDrivers({});
        mockHomeyInstance.settings.set('managed_devices', { 'vent-1': true });
        mockHomeyInstance.settings.set('controllable_devices', { 'vent-1': true });
        mockHomeyInstance.settings.set('price_optimization_settings', {
            'vent-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
        });

        const app = createApp();
        await app.onInit();

        (app as any).deviceManager.homeyApi = {
            devices: {
                getDevices: async () => ({
                    'vent-1': buildVentilationApiDevice(),
                }),
            },
        };

        await (app as any).refreshTargetDevicesSnapshot();

        const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
        const entry = snapshot.find((device) => device.id === 'vent-1');
        expect(entry).toBeDefined();
        expect(entry?.powerCapable).toBe(false);

        const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
        const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
        const priceSettings = mockHomeyInstance.settings.get('price_optimization_settings') as Record<string, { enabled?: boolean }>;

        expect(managed['vent-1']).toBe(false);
        expect(controllable['vent-1']).toBe(false);
        expect(priceSettings['vent-1']?.enabled).toBe(false);
    });
});
