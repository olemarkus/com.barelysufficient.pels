import {
    mockHomeyInstance,
    setMockDrivers,
    MockDevice,
    MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import {
    CAPACITY_DRY_RUN,
    CAPACITY_LIMIT_KW,
    CAPACITY_MARGIN_KW,
} from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
jest.useFakeTimers({ doNotFake: ['nextTick', 'Date'] });

const buildHeatpumpDevice = async (options?: {
    id?: string;
    name?: string;
    on?: boolean;
    powerW?: number;
    targetTemperature?: number;
    measureTemperature?: number;
}) => {
    const deviceId = options?.id ?? 'heatpump-a';
    const deviceName = options?.name ?? 'Hallway Heatpump';
    const device = new MockDevice(
        deviceId,
        deviceName,
        ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
        'heatpump',
    );
    await device.setCapabilityValue('onoff', options?.on ?? true);
    await device.setCapabilityValue('measure_power', options?.powerW ?? 2000);
    await device.setCapabilityValue('target_temperature', options?.targetTemperature ?? 22);
    await device.setCapabilityValue('measure_temperature', options?.measureTemperature ?? 21);
    return device;
};

const buildHeatpumpApiDevice = (overrides?: Partial<{
    id: string;
    name: string;
    onoff: boolean;
    measurePower: number;
    targetTemperature: number;
    measureTemperature: number;
    class: string;
    virtualClass: string;
    capabilities: string[];
}>) => ({
    id: overrides?.id ?? 'heatpump-a',
    name: overrides?.name ?? 'Hallway Heatpump',
    class: overrides?.class ?? 'heatpump',
    virtualClass: overrides?.virtualClass ?? null,
    capabilities: overrides?.capabilities ?? [
        'onoff',
        'target_temperature',
        'measure_temperature',
        'measure_power',
        'meter_power',
        'thermostat_mode',
        'fan_speed',
    ],
    capabilitiesObj: {
        onoff: { id: 'onoff', value: overrides?.onoff ?? true },
        measure_power: { id: 'measure_power', value: overrides?.measurePower ?? 2000 },
        target_temperature: {
            id: 'target_temperature',
            value: overrides?.targetTemperature ?? 22,
            units: '°C',
            min: 10,
            max: 31,
        },
        measure_temperature: { id: 'measure_temperature', value: overrides?.measureTemperature ?? 21, units: '°C' },
        thermostat_mode: { id: 'thermostat_mode', value: 'heat' },
        fan_speed: { id: 'fan_speed', value: 5 },
    },
    settings: {},
});

describe('Heatpump device integration', () => {
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

    it('builds a snapshot entry for a heatpump device', async () => {
        const device = await buildHeatpumpDevice({ on: true, powerW: 2000, targetTemperature: 22 });
        setMockDrivers({
            driverA: new MockDriver('driverA', [device]),
        });

        const app = createApp();
        await app.onInit();

        const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
        const entry = snapshot.find((snap) => snap.id === device.idValue);

        expect(entry).toBeDefined();
        expect(entry?.deviceType).toBe('temperature');
        expect(entry?.deviceClass).toBe('heatpump');
        expect(entry?.currentOn).toBe(true);
        expect(entry?.powerKw).toBeCloseTo(2.0, 2);
    });

    it('heatpump device has target_temperature in targets', async () => {
        const device = await buildHeatpumpDevice({ targetTemperature: 26.5 });
        setMockDrivers({
            driverA: new MockDriver('driverA', [device]),
        });

        const app = createApp();
        await app.onInit();

        const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[];
        const entry = snapshot.find((snap) => snap.id === device.idValue);

        expect(entry?.targets).toBeDefined();
        expect(entry?.targets?.length).toBeGreaterThan(0);
        const tempTarget = entry?.targets?.find((t) => t.id === 'target_temperature');
        expect(tempTarget).toBeDefined();
        expect(tempTarget?.value).toBe(26.5);
    });

    it('applies mode targets for heatpump devices with target_temperature', async () => {
        const device = await buildHeatpumpDevice({ on: true, powerW: 0, targetTemperature: 22 });
        setMockDrivers({
            driverA: new MockDriver('driverA', [device]),
        });

        mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 20 } });
        mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
        mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true });

        const app = createApp();
        await app.onInit();

        const setCapSpy = jest.fn().mockResolvedValue(undefined);
        const homeyApiStub = {
            devices: {
                getDevices: async () => ({
                    'heatpump-a': buildHeatpumpApiDevice({ onoff: true, measurePower: 0, targetTemperature: 22 }),
                }),
                setCapabilityValue: setCapSpy,
            },
        };
        (app as any).homeyApi = homeyApiStub;
        (app as any).deviceManager.homeyApi = homeyApiStub;

        const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
        await setModeListener({ mode: 'Home' });
        await flushPromises();

        expect(setCapSpy).toHaveBeenCalledWith({
            deviceId: 'heatpump-a',
            capabilityId: 'target_temperature',
            value: 20,
        });
    });

    it('sheds a heatpump device by adjusting target_temperature when headroom is insufficient', async () => {
        const device = await buildHeatpumpDevice({ on: true, powerW: 2000, targetTemperature: 22 });
        setMockDrivers({
            driverA: new MockDriver('driverA', [device]),
        });

        mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
        mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
        mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
        mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true });
        mockHomeyInstance.settings.set('overshoot_behaviors', {
            'heatpump-a': { action: 'set_temperature', temperature: 15 },
        });

        const app = createApp();
        await app.onInit();

        const setCapSpy = jest.fn().mockResolvedValue(undefined);
        (app as any).deviceManager.homeyApi = {
            devices: {
                setCapabilityValue: setCapSpy,
            },
        };

        (app as any).computeDynamicSoftLimit = () => 1;
        if ((app as any).capacityGuard?.setSoftLimitProvider) {
            (app as any).capacityGuard.setSoftLimitProvider(() => 1);
        }

        await (app as any).recordPowerSample(5000);
        jest.advanceTimersByTime(100);
        await flushPromises();

        expect(setCapSpy).toHaveBeenCalledWith({
            deviceId: 'heatpump-a',
            capabilityId: 'target_temperature',
            value: 15,
        });
    });

    it('uses set_temperature shed action for heatpump with target_temperature', async () => {
        const device = await buildHeatpumpDevice({ on: true, powerW: 2000, targetTemperature: 22 });
        setMockDrivers({
            driverA: new MockDriver('driverA', [device]),
        });

        mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
        mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
        mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
        mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true });
        mockHomeyInstance.settings.set('overshoot_behaviors', {
            'heatpump-a': { action: 'set_temperature', temperature: 15 },
        });

        const app = createApp();
        await app.onInit();

        const snapshot = (app as any).deviceManager.getSnapshot();
        const snapDevice = snapshot.find((entry: any) => entry.id === 'heatpump-a');
        expect(snapDevice?.deviceType).toBe('temperature');
        expect(snapDevice?.targets?.length).toBeGreaterThan(0);

        (app as any).computeDynamicSoftLimit = () => 1;
        if ((app as any).capacityGuard?.setSoftLimitProvider) {
            (app as any).capacityGuard.setSoftLimitProvider(() => 1);
        }

        await (app as any).recordPowerSample(5000);
        jest.advanceTimersByTime(100);
        await flushPromises();

        const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
        const planDevice = plan.devices.find((entry: any) => entry.id === 'heatpump-a');
        expect(planDevice?.shedAction).toBe('set_temperature');
        expect(planDevice?.shedTemperature).toBe(15);
    });

    it('excludes heatpump devices without measure_power', async () => {
        setMockDrivers({});
        const app = createApp();
        await app.onInit();

        (app as any).deviceManager.homeyApi = {
            devices: {
                getDevices: async () => ({
                    'heatpump-a': buildHeatpumpApiDevice({
                        capabilities: ['onoff', 'target_temperature', 'measure_temperature'],
                    }),
                }),
            },
        };

        await (app as any).refreshTargetDevicesSnapshot();

        const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot') as Array<{ id: string }>;
        expect(snapshot.find((entry) => entry.id === 'heatpump-a')).toBeUndefined();
    });
});
