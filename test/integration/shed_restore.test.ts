
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { withFixtureResidualKw } from '../utils/planTestUtils';

// Mock types for internal App state
type InternalApp = {
    latestTargetSnapshot: Array<{
        id: string;
        measuredPowerKw?: number;
        expectedPowerKw?: number;
        controllable?: boolean;
        currentOn: boolean;
        priority?: number;
    }>;
    capacitySettings: { marginKw?: number };
    capacityDryRun: boolean;
    priceOptimizationSettings: Record<string, any>;
    planService: {
        buildDevicePlanSnapshot: (devices: any[]) => Promise<any>;
    };
    handleCapacityCheck(): Promise<void>;
    capacityGuard: {
        getHeadroom: () => number | null;
        checkShortfall: () => void;
        getSoftLimit: () => number;
        getShortfallThreshold: () => number;
        isInShortfall: () => boolean;
        getRestoreMargin: () => number;
    } | undefined;
};

describe('Shed vs Restore Logic', () => {
    beforeEach(() => {
        mockHomeyInstance.settings.removeAllListeners();
        mockHomeyInstance.settings.clear();
        vi.clearAllTimers();
    });

    afterEach(async () => {
        await cleanupApps();
    });

    test('Shedding uses measured power (gain), ignoring expected power', async () => {
        const deviceA = new MockDevice('dev-A', 'Heater A', ['measure_power', 'onoff']);
        const deviceB = new MockDevice('dev-B', 'Heater B', ['measure_power', 'onoff']);

        // Both ON
        await deviceA.setCapabilityValue('onoff', true);
        await deviceB.setCapabilityValue('onoff', true);

        setMockDrivers({ driverA: new MockDriver('driverA', [deviceA, deviceB]) });

        const app = createApp() as unknown as InternalApp;
        await (app as any).onInit();
        (app as any).powerTracker.lastTimestamp = Date.now();
        (app as any).powerTracker.lastPowerW = 12000;
        // Force soft limit to 10 for controllable shedding test
        (app as any).computeDynamicSoftLimit = () => 10;

        // Mock Snapshots directly to control measured/expected separation
        // Scenario:
        // Device A: Expected 3kW, Measured 0.5kW (Priority 50)
        // Device B: Expected 3kW, Measured 2.5kW (Priority 50)
        // Headroom needed: 2.0kW

        // Overwrite snapshot manually for the test logic within App
        (app as any).targetDevices = [
            withFixtureResidualKw({ id: 'dev-A', name: 'Heater A', controllable: true, binaryCapabilityId: 'onoff', binaryControl: { on: true }, currentOn: true, priority: 50, expectedPowerKw: 3.0, currentDrawKw: 0.5 }),
            withFixtureResidualKw({ id: 'dev-B', name: 'Heater B', controllable: true, binaryCapabilityId: 'onoff', binaryControl: { on: true }, currentOn: true, priority: 50, expectedPowerKw: 3.0, currentDrawKw: 2.5 }),
        ];

        // Force negative headroom to trigger shedding
        // Mock CapacityGuard to return negative headroom
        const mockGuard = {
            getHeadroom: () => -2.0, // Need 2kW
            checkShortfall: vi.fn(),
            isInShortfall: () => false,
            getRestoreMargin: () => 0.2,
        };
        (app as any).capacityGuard = mockGuard;
        (app as any).capacitySettings = { limitKw: 10, marginKw: 0.2 };

        // Run calculation
        const devices = (app as any).targetDevices;
        const plan = await (app as any).planService.buildDevicePlanSnapshot(devices);

        // Analysis:
        // Needed 2.0kW.
        // Device A offers 0.5kW (measured).
        // Device B offers 2.5kW (measured).
        // Logic sorts candidates by priority (equal) then by effectivePower (measured).
        // B (2.5) > A (0.5).
        // So B should be shed first.

        const shedB = plan.devices.find((d: any) => d.id === 'dev-B');
        const shedA = plan.devices.find((d: any) => d.id === 'dev-A');

        expect(shedB.plannedState).toBe('shed');
        // B provides 2.5kW, which is > 2.0kW needed. So A should be kept.
        expect(shedA.plannedState).toBe('keep');
    });

    test('Shedding ignores devices with 0 measured power even if high expected power', async () => {
        const app = createApp() as unknown as InternalApp;
        await (app as any).onInit();
        (app as any).powerTracker.lastTimestamp = Date.now();
        (app as any).powerTracker.lastPowerW = 10400;
        (app as any).computeDynamicSoftLimit = () => 10;

        // Device C: Expected 5kW, Measured 0kW (Maybe checking in but idle?)
        (app as any).targetDevices = [
            withFixtureResidualKw({ id: 'dev-C', name: 'Heater C', controllable: true, binaryCapabilityId: 'onoff', binaryControl: { on: true }, currentOn: true, priority: 50, expectedPowerKw: 5.0, currentDrawKw: 0.0 }),
            withFixtureResidualKw({ id: 'dev-D', name: 'Heater D', controllable: true, binaryCapabilityId: 'onoff', binaryControl: { on: true }, currentOn: true, priority: 50, expectedPowerKw: 1.0, currentDrawKw: 0.5 }),
        ];

        const mockGuard = {
            getHeadroom: () => -0.4, // Need 0.4kW
            checkShortfall: vi.fn(),
            isInShortfall: () => false,
            getRestoreMargin: () => 0.2,
        };
        (app as any).capacityGuard = mockGuard;

        const devices = (app as any).targetDevices;
        const plan = await (app as any).planService.buildDevicePlanSnapshot(devices);

        // D offers 0.5kW. C offers 0.0kW.
        // D should be shed because C helps nothing.

        const shedC = plan.devices.find((d: any) => d.id === 'dev-C');
        const shedD = plan.devices.find((d: any) => d.id === 'dev-D');

        expect(shedD.plannedState).toBe('shed');
        expect(shedC.plannedState).toBe('keep');
    });

    test('Restore uses expected power (cost), denying restore if headroom insufficient', async () => {
        const app = createApp() as unknown as InternalApp;
        await (app as any).onInit();
        (app as any).powerTracker.lastTimestamp = Date.now();
        (app as any).powerTracker.lastPowerW = 8000;
        (app as any).computeDynamicSoftLimit = () => 10;

        // Device E: Expected 3.0kW, Measured 0.0kW (Currently OFF)
        (app as any).targetDevices = [
            withFixtureResidualKw({ id: 'dev-E', name: 'Heater E', controllable: true, binaryCapabilityId: 'onoff', binaryControl: { on: false }, currentOn: false, priority: 50, expectedPowerKw: 3.0, currentDrawKw: 0.0 }),
        ];
        // Headroom 2.0kW. Restore Margin 0.2, Hysteresis = Max(0.2, 0.2*2) = 0.4.
        // Need: expected(3.0) + hysteresis(0.4) = 3.4kW.
        // Available: 2.0kW.
        // Result: 2.0 < 3.4 => Deny.

        const mockGuard = {
            getHeadroom: () => 2.0,
            checkShortfall: vi.fn(),
            isInShortfall: () => false,
            getRestoreMargin: () => 0.2,
        };
        (app as any).capacityGuard = mockGuard;
        // Mock timing so cooldowns don't block
        (app as any).planEngine.state.lastInstabilityMs = 0;
        (app as any).planEngine.state.lastRestoreMs = 0;

        const devices = (app as any).targetDevices;
        // Mock desired state (e.g. thermostat set to 22) to imply it "wants" to be ON
        (app as any).modeDeviceTargets = { 'Home': { 'dev-E': 22 } };
        (app as any).operatingMode = 'Home';

        const plan = await (app as any).planService.buildDevicePlanSnapshot(devices);
        const devE = plan.devices.find((d: any) => d.id === 'dev-E');

        // A device that is OFF and cannot be afforded must be planned `shed`, not `keep`.
        // `keep` means "no restriction", so the executor would let the mode target set above
        // put dev-E back on and overshoot. Restore admission owns this (`lib/plan/restore/`):
        // a candidate it does not admit is marked shed, it does not fall through.

        expect(devE.plannedState).toBe('shed'); // Expectation: Blocked because 3.4kW > 2.0kW
    });
});
