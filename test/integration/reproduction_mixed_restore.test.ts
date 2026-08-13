
import { getLatestPlanSnapshotForTests, mockHomeyInstance, setMockDrivers, MockDriver, MockDevice } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { reasonText } from '../utils/deviceReasonTestUtils';

let currentTime = 1000000000000;

beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterAll(() => {
    vi.useRealTimers();
});

describe('Mixed Type Restoration Throttling', () => {
    let app: any;

    beforeEach(async () => {
        currentTime = 1000000000000;
        vi.setSystemTime(currentTime);
        vi.clearAllMocks();
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
        mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });
        mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true, 'dev-2': true });

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
        (app as any).planEngine.state.lastInstabilityMs = 0;
        (app as any).planEngine.state.lastRestoreMs = 0;
        (app as any).planEngine.state.lastDeviceShedMs = {};
    });

    afterEach(async () => {
        await cleanupApps();
        app = undefined;
    });

    test('should throttle restoration and enforce cooldown between mixed device types', async () => {
        // 1. Trigger Overshoot to shed BOTH devices
        // Limit 10. Usage 15.
        // Need to shed 1+1=2kW.

        (app as any).computeDynamicSoftLimit = () => 0.5; // Very low limit
        await (app as any).powerSamplePipeline.recordPowerSample(5000);

        let plan = getLatestPlanSnapshotForTests();
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
        await (app as any).refreshTargetDevicesSnapshot();

        // Advance time past Shed Cooldown (60s)
        currentTime += 61000;
        vi.setSystemTime(currentTime);

        // 2. Headroom returns - enough for BOTH
        (app as any).computeDynamicSoftLimit = () => 10.0;
        // Deactivate the guard after restoring headroom so shedding hysteresis allows it.
        await (app as any).capacityGuard?.setSheddingActive(false);
        (app as any).planEngine.state.lastRecoveryMs = currentTime - 61000;
        // Headroom = 10 - 5 = 5kW. Needs 2kW.

        // Record sample to trigger restore plan
        await (app as any).powerSamplePipeline.recordPowerSample(5000);
        plan = getLatestPlanSnapshotForTests();

        const d1Codes = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Codes = plan.devices.find((d: any) => d.id === 'dev-2');

        // Expect ONLY ONE to be restored in this cycle
        const d1Restored = d1Codes.plannedState !== 'shed';
        const d2Restored = d2Codes.plannedState !== 'shed';

        // Throttling check
        expect(d1Restored && d2Restored).toBe(false);
        expect(d1Restored || d2Restored).toBe(true);

        if (d1Restored) {
            await mockD1.setCapabilityValue('onoff', true);
        } else if (d2Restored) {
            await mockD2.setCapabilityValue('target_temperature', 20);
        }
        await (app as any).refreshTargetDevicesSnapshot();

        // Assume D2 (Temp) restored (based on user logs/priority).
        // Or whoever restored, verify the OTHER restores later.

        // 3. Immediate next cycle (within 30s)
        // Should NOT restore the other one due to Cooldown
        currentTime += 5000; // +5s
        vi.setSystemTime(currentTime);
        await (app as any).powerSamplePipeline.recordPowerSample(5000);
        plan = getLatestPlanSnapshotForTests();

        const d1Cycles2 = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Cycles2 = plan.devices.find((d: any) => d.id === 'dev-2');

        const d1RestoredC2 = d1Cycles2.plannedState !== 'shed';
        const d2RestoredC2 = d2Cycles2.plannedState !== 'shed';

        // The one that WAS shed stays shed, and says WHY: the restore cooldown.
        // The house has 5 kW spare against a ~1 kW need here, so "shed due to
        // capacity" would be plainly false — and, because that reason renders as
        // a kW gap the owner is invited to close, the admission arithmetic finds
        // no gap and the card collapses to a bare "Waiting to resume".
        //
        // This assertion required the cooldown label until 0c4cb8661, which
        // flipped it to capacity on a deliberate position: the restore cooldown
        // is plan-global (`state.lastRestoreMs`, bumped by ANY device), so it
        // read as the other device's label. That position is reversed here, for
        // two reasons — root `AGENTS.md` § "Device card reason lines" admits the
        // countdowns as holds power cannot lift, and the binary peer in this very
        // cycle already shows the same countdown via `markOffDevicesStayOff`.
        // A global timer still holds THIS device; naming it is not borrowing.
        if (d1Restored) {
            expect(d2RestoredC2).toBe(false);
            expect(reasonText(d2Cycles2.reason)).toMatch(/^cooldown \(restore/);
        } else {
            expect(d1RestoredC2).toBe(false);
            expect(reasonText(d1Cycles2.reason)).toMatch(/^cooldown \(restore/);
        }

        // 4. After Cooldown (60s)
        currentTime += 35000; // +35s (Total 40s from first restore)
        vi.setSystemTime(currentTime);
        await (app as any).powerSamplePipeline.recordPowerSample(5000);
        plan = getLatestPlanSnapshotForTests();

        // Still in restore cooldown, and the still-shed peer still says so.
        const d1Cycles3 = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Cycles3 = plan.devices.find((d: any) => d.id === 'dev-2');

        if (d1Restored) {
            expect(d2Cycles3.plannedState).toBe('shed');
            expect(reasonText(d2Cycles3.reason)).toMatch(/^cooldown \(restore/);
        } else {
            expect(d1Cycles3.plannedState).toBe('shed');
            expect(reasonText(d1Cycles3.reason)).toMatch(/^cooldown \(restore/);
        }

        // 5. After restore cooldown window
        currentTime += 90000; // +90s (Total 130s from first restore)
        vi.setSystemTime(currentTime);
        await (app as any).powerSamplePipeline.recordPowerSample(5000);
        plan = getLatestPlanSnapshotForTests();

        const d1Cycles4 = plan.devices.find((d: any) => d.id === 'dev-1');
        const d2Cycles4 = plan.devices.find((d: any) => d.id === 'dev-2');

        expect(d1Cycles4.plannedState).not.toBe('shed');
        expect(d2Cycles4.plannedState).not.toBe('shed');
    });
});
