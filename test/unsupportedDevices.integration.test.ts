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
    onoff: boolean;
    class: string;
    capabilities: string[];
    energyObj: Record<string, unknown> | null;
}>) => ({
    id: overrides?.id ?? 'vent-1',
    name: overrides?.name ?? 'Ventilation Relay',
    class: overrides?.class ?? 'socket',
    virtualClass: null,
    capabilities: overrides?.capabilities ?? [
        'onoff',
    ],
    capabilitiesObj: {
        onoff: { id: 'onoff', value: overrides?.onoff ?? true },
    },
    settings: {},
    energyObj: overrides?.energyObj,
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

    it('keeps devices manageable when Homey energy estimate exists', async () => {
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
                    'vent-1': buildVentilationApiDevice({
                        energyObj: {
                            approximation: {
                                usageOn: 110,
                                usageOff: 10,
                            },
                        },
                    }),
                }),
            },
        };

        await (app as any).refreshTargetDevicesSnapshot();

        const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
        const entry = snapshot.find((device) => device.id === 'vent-1');
        expect(entry).toBeDefined();
        expect(entry?.powerCapable).toBe(true);
        expect(entry?.expectedPowerSource).toBe('homey-energy');
        expect(entry?.expectedPowerKw).toBeCloseTo(0.1, 6);

        const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
        const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
        const priceSettings = mockHomeyInstance.settings.get('price_optimization_settings') as Record<string, { enabled?: boolean }>;

        expect(managed['vent-1']).toBe(true);
        expect(controllable['vent-1']).toBe(true);
        expect(priceSettings['vent-1']?.enabled).toBe(true);
    });
});
