
import { mockHomeyInstance, mockHomeyApiInstance, setMockDrivers, MockDriver, MockDevice } from './mocks/homey';
const PelsApp = require('../app');

const createApp = () => {
    const app = new PelsApp();
    (app as any).homey = mockHomeyInstance;
    (app as any).homeyApi = mockHomeyApiInstance;
    return app;
};

// Mock Date.now to control time
const originalDateNow = Date.now;
let currentTime = 1000000000000;

beforeAll(() => {
    global.Date.now = jest.fn(() => currentTime);
});

afterAll(() => {
    global.Date.now = originalDateNow;
});

describe('Mixed Type Restoration Throttling', () => {
    let app: any;

    beforeEach(async () => {
        currentTime = 1000000000000;
        jest.clearAllMocks();
        mockHomeyInstance.settings.clear();
        mockHomeyInstance.settings.set('operating_mode', 'Home');
        mockHomeyInstance.settings.set('capacity_limit', 10);
        mockHomeyInstance.settings.set('capacity_margin', 0);
        mockHomeyInstance.settings.set('capacity_dry_run', false); // Disable dry-run to allow actual shedding

        // Define mixed devices
        // Dev 1: Heater (turn_off)
        // Dev 2: Thermostat (set_temperature)

        const dev1 = new MockDevice('dev-1', 'Heater Off', ['onoff', 'measure_power', 'target_temperature']);
        dev1.setCapabilityValue('measure_power', 1); // 1 kW
        dev1.setCapabilityValue('onoff', true);
        dev1.setCapabilityValue('target_temperature', 20);
        dev1.setSettings({
            pels_priority: 10,
            pels_shed_enabled: true,
            pels_shed_action: 'turn_off',
        });

        const dev2 = new MockDevice('dev-2', 'Thermostat Temp', ['target_temperature', 'measure_power']);
        dev2.setCapabilityValue('measure_power', 1); // 1 kW
        dev2.setCapabilityValue('target_temperature', 20);
        dev2.setSettings({
            // Priority 1 = most important.
            // Let's make them equal or distinct.
            // App sorts OFF devices by P ascending (restore most important first).
            pels_priority: 20,
            pels_shed_enabled: true,
            pels_shed_action: 'set_temperature',
            pels_shed_temperature: 10,
        });

        const driver = new MockDriver('driver-1', [dev1, dev2]);
        setMockDrivers({ 'driver-1': driver });

        // Setup mode targets
        mockHomeyInstance.settings.set('mode_device_targets', {
            'Home': {
                'dev-1': { id: 'target_temperature', value: 20 },
                'dev-2': { id: 'target_temperature', value: 20 },
            },
        });

        // Setup overshoot behaviors (THIS is what getShedBehavior reads)
        mockHomeyInstance.settings.set('overshoot_behaviors', {
            'dev-1': { action: 'turn_off' },
            'dev-2': { action: 'set_temperature', temperature: 10 },
        });

        app = createApp();
        await app.onInit();

        // Reset timers
        (app as any).lastSheddingMs = 0;
        (app as any).lastOvershootMs = 0;
        (app as any).lastRestoreMs = 0;
        (app as any).lastDeviceShedMs = {};
    });

    test('should throttle restoration and enforce cooldown between mixed device types', async () => {
        // 1. Trigger Overshoot to shed BOTH devices
        // Limit 10. Usage 15.
        // Need to shed 1+1=2kW.

        (app as any).computeDynamicSoftLimit = () => 0.5; // Very low limit
        await (app as any).recordPowerSample(5000);

        let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
        const d1 = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2 = plan.devices.find((d: any) => d.id === 'dev-2');

        // Verify both are shed
        expect(d1.plannedState).toBe('shed'); // Heater Off
        expect(d2.plannedState).toBe('shed'); // Thermostat Temp

        // Update mock states to reflect shedding
        const mockD1 = mockHomeyInstance.drivers.getDrivers()['driver-1'].getDevices()[0];
        const mockD2 = mockHomeyInstance.drivers.getDrivers()['driver-1'].getDevices()[1];
        await mockD1.setCapabilityValue('onoff', false);
        await mockD2.setCapabilityValue('target_temperature', 10);
        (app as any).lastSnapshotRefreshMs = 0; // Force refresh

        // Advance time past Shed Cooldown (60s)
        currentTime += 61000;

        // 2. Headroom returns - enough for BOTH
        (app as any).computeDynamicSoftLimit = () => 10.0;
        // Headroom = 10 - 5 = 5kW. Needs 2kW.

        // Record sample to trigger restore plan
        await (app as any).recordPowerSample(5000);
        plan = mockHomeyInstance.settings.get('device_plan_snapshot');

        const d1Codes = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Codes = plan.devices.find((d: any) => d.id === 'dev-2');

        // Expect ONLY ONE to be restored in this cycle
        const d1Restored = d1Codes.plannedState !== 'shed';
        const d2Restored = d2Codes.plannedState !== 'shed';

        // Throttling check
        expect(d1Restored && d2Restored).toBe(false);
        expect(d1Restored || d2Restored).toBe(true);

        // Assume D2 (Temp) restored (based on user logs/priority).
        // Or whoever restored, verify the OTHER restores later.

        // 3. Immediate next cycle (within 30s)
        // Should NOT restore the other one due to Cooldown
        currentTime += 5000; // +5s
        await (app as any).recordPowerSample(5000);
        plan = mockHomeyInstance.settings.get('device_plan_snapshot');

        const d1Cycles2 = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Cycles2 = plan.devices.find((d: any) => d.id === 'dev-2');

        const d1RestoredC2 = d1Cycles2.plannedState !== 'shed';
        const d2RestoredC2 = d2Cycles2.plannedState !== 'shed';

        // The one that WAS shed should STAY shed (Cooldown)
        if (d1Restored) {
            expect(d2RestoredC2).toBe(false);
            // Ensure it's blocked by COOLDOWN, not throttling
            // (Though throttling resets every cycle, cooldown is persistent)
        } else {
            expect(d1RestoredC2).toBe(false);
        }

        // 4. After Cooldown (30s)
        currentTime += 35000; // +35s (Total 40s from first restore)
        await (app as any).recordPowerSample(5000);
        plan = mockHomeyInstance.settings.get('device_plan_snapshot');

        // Now both should be restored
        const d1Cycles3 = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Cycles3 = plan.devices.find((d: any) => d.id === 'dev-2');

        expect(d1Cycles3.plannedState).not.toBe('shed');
        expect(d2Cycles3.plannedState).not.toBe('shed');
    });
});
