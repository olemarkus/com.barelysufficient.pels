import {
    mockHomeyInstance,
    setMockDrivers,
    MockDevice,
    MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });

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
        vi.clearAllTimers();
    });

    afterEach(async () => {
        await cleanupApps();
        vi.clearAllTimers();
    });

    it('builds a snapshot entry for a heatpump device', async () => {
        const device = await buildHeatpumpDevice({ on: true, powerW: 2000, targetTemperature: 22 });
        setMockDrivers({
            driverA: new MockDriver('driverA', [device]),
        });

        const app = createApp();
        await app.onInit();

        const snapshot = getLatestTargetSnapshotForTests();
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

        const snapshot = getLatestTargetSnapshotForTests();
        const entry = snapshot.find((snap) => snap.id === device.idValue);

        expect(entry?.targets).toBeDefined();
        expect(entry?.targets?.length).toBeGreaterThan(0);
        const tempTarget = entry?.targets?.find((t) => t.id === 'target_temperature');
        expect(tempTarget).toBeDefined();
        expect(tempTarget?.value).toBe(26.5);
    });

    // Capacity shedding (lower target_temperature, never onoff) and mode-setpoint
    // application are covered black-box, through the SDK boundary, in
    // test/e2e/heatpumpShedControl.e2e.test.ts. This spec keeps the classification cases.

    it('includes heatpump devices without power capability but marks them unsupported', async () => {
        setMockDrivers({});
        const app = createApp();
        await app.onInit();

        vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
            'heatpump-a': buildHeatpumpApiDevice({
                capabilities: ['onoff', 'target_temperature', 'measure_temperature'],
            }),
        });

        await (app as any).refreshTargetDevicesSnapshot();

        const snapshot = getLatestTargetSnapshotForTests() as Array<{ id: string; powerCapable?: boolean }>;
        const entry = snapshot.find((device) => device.id === 'heatpump-a');
        expect(entry).toBeDefined();
        expect(entry?.powerCapable).toBe(false);
    });
});
