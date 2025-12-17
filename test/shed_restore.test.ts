
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Mock types for internal App state
interface InternalApp {
    latestTargetSnapshot: Array<{
        id: string;
        measuredPowerKw?: number;
        expectedPowerKw?: number;
        powerKw?: number;
        controllable?: boolean;
        currentOn?: boolean;
        priority?: number;
    }>;
    capacitySettings: { marginKw?: number };
    capacityDryRun: boolean;
    priceOptimizationSettings: Record<string, any>;
    buildDevicePlanSnapshot(): any;
    handleCapacityCheck(): Promise<void>;
    capacityGuard: {
        getHeadroom: () => number | null;
        isSheddingActive: () => boolean;
        setSheddingActive: (active: boolean) => void;
        checkShortfall: () => void;
        getSoftLimit: () => number;
        getLastTotalPower: () => number;
        isInShortfall: () => boolean;
        getRestoreMargin: () => number;
    } | undefined;
}

describe('Shed vs Restore Logic', () => {
    beforeEach(() => {
        mockHomeyInstance.settings.removeAllListeners();
        mockHomeyInstance.settings.clear();
        jest.clearAllTimers();
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
        // Force soft limit to 10 for controllable shedding test
        (app as any).computeDynamicSoftLimit = () => 10;

        // Mock Snapshots directly to control measured/expected separation
        // Scenario:
        // Device A: Expected 3kW, Measured 0.5kW (Priority 50)
        // Device B: Expected 3kW, Measured 2.5kW (Priority 50)
        // Headroom needed: 2.0kW

        // Overwrite snapshot manually for the test logic within App
        (app as any).targetDevices = [
            { id: 'dev-A', name: 'Heater A', controllable: true, currentOn: true, priority: 50, expectedPowerKw: 3.0, measuredPowerKw: 0.5, powerKw: 3.0 },
            { id: 'dev-B', name: 'Heater B', controllable: true, currentOn: true, priority: 50, expectedPowerKw: 3.0, measuredPowerKw: 2.5, powerKw: 3.0 },
        ];

        // Force negative headroom to trigger shedding
        // Mock CapacityGuard to return negative headroom
        const mockGuard = {
            getHeadroom: () => -2.0, // Need 2kW
            getSoftLimit: () => 10,
            getLastTotalPower: () => 12,
            isSheddingActive: () => false,
            setSheddingActive: jest.fn(),
            checkShortfall: jest.fn(),
            isInShortfall: () => false,
            getRestoreMargin: () => 0.2,
        };
        (app as any).capacityGuard = mockGuard;
        (app as any).capacitySettings = { limitKw: 10, marginKw: 0.2 };

        // Run calculation
        const devices = (app as any).targetDevices;
        const plan = (app as any).buildDevicePlanSnapshot(devices);

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
        (app as any).computeDynamicSoftLimit = () => 10;

        // Device C: Expected 5kW, Measured 0kW (Maybe checking in but idle?)
        (app as any).targetDevices = [
            { id: 'dev-C', name: 'Heater C', controllable: true, currentOn: true, priority: 50, expectedPowerKw: 5.0, measuredPowerKw: 0.0, powerKw: 5.0 },
            { id: 'dev-D', name: 'Heater D', controllable: true, currentOn: true, priority: 50, expectedPowerKw: 1.0, measuredPowerKw: 0.5, powerKw: 1.0 },
        ];

        const mockGuard = {
            getHeadroom: () => -0.4, // Need 0.4kW
            getSoftLimit: () => 10,
            getLastTotalPower: () => 10.4,
            isSheddingActive: () => false,
            setSheddingActive: jest.fn(),
            checkShortfall: jest.fn(),
            isInShortfall: () => false,
            getRestoreMargin: () => 0.2,
        };
        (app as any).capacityGuard = mockGuard;

        const devices = (app as any).targetDevices;
        const plan = (app as any).buildDevicePlanSnapshot(devices);

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
        (app as any).computeDynamicSoftLimit = () => 10;

        // Device E: Expected 3.0kW, Measured 0.0kW (Currently OFF)
        (app as any).targetDevices = [
            { id: 'dev-E', name: 'Heater E', controllable: true, currentOn: false, priority: 50, expectedPowerKw: 3.0, measuredPowerKw: 0.0, powerKw: 3.0 },
        ];
        // Headroom 2.0kW. Restore Margin 0.2, Hysteresis = Max(0.2, 0.2*2) = 0.4.
        // Need: expected(3.0) + hysteresis(0.4) = 3.4kW.
        // Available: 2.0kW.
        // Result: 2.0 < 3.4 => Deny.

        const mockGuard = {
            getHeadroom: () => 2.0,
            getSoftLimit: () => 10,
            getLastTotalPower: () => 8,
            isSheddingActive: () => false,
            setSheddingActive: jest.fn(),
            checkShortfall: jest.fn(),
            isInShortfall: () => false,
            getRestoreMargin: () => 0.2,
        };
        (app as any).capacityGuard = mockGuard;
        // Mock timing so cooldowns don't block
        (app as any).lastSheddingMs = 0;
        (app as any).lastOvershootMs = 0;
        (app as any).lastRestoreMs = 0;

        const devices = (app as any).targetDevices;
        // Mock desired state (e.g. thermostat set to 22) to imply it "wants" to be ON
        (app as any).modeDeviceTargets = { 'Home': { 'dev-E': 22 } };
        (app as any).operatingMode = 'Home';

        const plan = (app as any).buildDevicePlanSnapshot(devices);
        const devE = plan.devices.find((d: any) => d.id === 'dev-E');

        // Should NOT be 'keep' (which means turn on if desired).
        // Wait, logical output for 'off' device that stays 'off' depends on logic.
        // If it wants to be on (default desired is on in tests usually unless mode set?),
        // Code says: `let plannedState = ... 'keep'`.
        // But `offDevices` loop might change it?
        // In `app.ts`:
        // `const offDevices = planDevices.filter ...`
        // If it restores, `dev.plannedState` doesn't change from 'keep'?
        // Wait, let's check `app.ts` logic again.
        // If restored: `restoredThisCycle.add(dev.id)`.
        // And `plannedState` logic earlier: `let plannedState = ...`.
        // The `offDevices` loop does NOT explicitly set `plannedState = 'on'`.
        // It assumes `plannedState` defaults to 'keep' (which implies "revert to schedule/thermostat" -> ON?).
        // Ah, if `currentState === 'off'`, `plannedState` being 'keep' usually means "Stay Off" UNLESS the Homey flow turns it on?
        // Actually, `pels_devices_on` capability logic?
        // Let's verify what "Restoring" means in `app.ts`.
        // `restoredThisCycle` is tracked but does it affect `plannedState`?
        // NO!
        // `app.ts` logic:
        // If NOT restored (e.g. not enough headroom), does it set `plannedState = 'shed'`?
        // No... `offDevices` loop:
        // If `availableHeadroom >= needed`: restores.
        // Else: `dev.plannedState = 'shed'` ONLY if swapped?
        // Wait, if it's off and we DON'T restore it, it stays 'off' because `currentState` is 'off'.
        // `plannedState` 'keep' means "Do what you want", but PELS only *forces* 'shed'.
        // However, if PELS wants to *prevent* it from turning on, it must be 'shed'.
        // Let's check `app.ts` L1043 (in original file, roughly):
        // "Not enough headroom ... plannedState = 'shed'"?
        // Actually `app.ts`:1029: `dev.plannedState = 'shed'` if swap pending.
        // But if just "not enough headroom" and NO swap?
        // It falls through?
        // If it falls through, `plannedState` remains 'keep'.
        // Does 'keep' mean "Allowed to turn on"?
        // If `currentState` is 'off', and `plannedState` is 'keep', PELS action `turn_on` might fire?
        // No, PELS mainly acts when state changes or shedding is needed.
        // If `plannedState` is 'keep', PELS logic usually assumes "No Restriction".
        // But for "Off" devices, we want them to STAY "Off".
        // "Secondary guard: if a device is currently off and headroom is still below what it needs ... keep it shed"
        // Found it! `app.ts` ~900 (logic block before the loop).
        // Wait, that comment says "Secondary guard". But where is the code?
        // The code IS the `offDevices` loop.
        // If `restoredThisCycle.has(dev.id)` is FALSE, then... ?
        // The code doesn't explicitly set 'shed' if headroom is missing???
        // Let's re-read `app.ts` carefully.

        // Line 928: `if (headroomRaw ...)` block.
        // Loop `offDevices`.
        // ...
        // If `availableHeadroom >= needed` -> `restoredThisCycle.add`.
        // Else -> fall through.
        //
        // After loop?
        // There is no "After loop set everything else to shed"???
        // This implies that if it's OFF, and we don't have headroom, we leave it as 'keep'?
        // That seems WRONG. If `plannedState` is 'keep', does PELS turn it on?
        // `deviceManager.ts` or `app.ts` enacts the plan.
        // If `plannedState` is 'keep', and device is 'off', PELS usually checks `desired` state.
        // If `desired` (schedule/thermostat) says ON, and PELS says 'keep', it TURNS ON?
        // If so, we MUST set 'shed' to prevent it.

        // Ah, looking at `app.ts`:
        // Only if `plannedState === 'shed'` do we enforce OFF.
        // If we simply run out of headroom in the `restore` loop, we MUST ensure the remaining devices get `plannedState = 'shed'`.
        // I don't see that logic in the view I had.
        // I only see `plannedState = 'shed'` inside "Swap" or "Cooldown" blocks.

        // Let's write the test to expect 'shed' (blocked restore) and see if it fails.
        // If it fails (returns 'keep'), then I found another bug or my understanding is incomplete.
        // IF it returns 'keep', PELS would let it turn on -> OVERSHOOT.
        // So distinct restore logic implies "Blocking Restore" must be active.

        // Actually, looking at `plan.ts` (not visible here, logic in `app.ts`):
        // Line 900 comment: "Secondary guard... keep it shed".
        // Logic starts at ~928.
        // Inside `offDevices` loop:
        // If restored -> Good.
        // If NOT restored -> ?
        // I suspect the *default* `plannedState` for off devices might be computed earlier?
        // No, L861: `let plannedState = ... ? 'shed' : 'keep'`.
        // So default is 'keep'.
        // If the loop doesn't change it to 'shed', it remains 'keep'.
        // This looks like a HUGE BUG in existing code if true.
        // Unless `app.ts` has a final pass not seen?

        expect(devE.plannedState).toBe('shed'); // Expectation: Blocked because 3.4kW > 2.0kW
    });
});
