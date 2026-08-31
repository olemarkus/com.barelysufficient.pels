import {
    mockHomeyInstance,
    setMockDrivers,
} from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });

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
        ...(overrides?.capabilities?.includes('measure_power')
            ? { measure_power: { id: 'measure_power', value: 0 } }
            : {}),
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
        vi.clearAllTimers();
    });

    afterEach(async () => {
        await cleanupApps();
        vi.restoreAllMocks();
        vi.clearAllTimers();
    });

    it('keeps binary devices without required power state out of the snapshot', async () => {
        setMockDrivers({});
        mockHomeyInstance.settings.set('managed_devices', { 'vent-1': true });
        mockHomeyInstance.settings.set('controllable_devices', { 'vent-1': true });
        mockHomeyInstance.settings.set('price_optimization_settings', {
            'vent-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
        });

        const app = createApp();
        await app.onInit();

        vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
            'vent-1': buildVentilationApiDevice(),
        });

        await app.refreshTargetDevicesSnapshot();

        const snapshot = getLatestTargetSnapshotForTests();
        const entry = snapshot.find((device) => device.id === 'vent-1');
        expect(entry).toBeUndefined();

        const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
        const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
        const priceSettings = mockHomeyInstance.settings.get('price_optimization_settings') as Record<string, { enabled?: boolean }>;

        expect(managed['vent-1']).toBe(true);
        expect(controllable['vent-1']).toBe(true);
        expect(priceSettings['vent-1']?.enabled).toBe(true);
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

        vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
            'vent-1': buildVentilationApiDevice({
                // A managed device has to report an actual draw. The declared
                // energy approximation supplies the ESTIMATE below; it no longer
                // makes the device manageable on its own.
                capabilities: ['onoff', 'measure_power'],
                energyObj: {
                    approximation: {
                        usageOn: 110,
                        usageOff: 10,
                    },
                },
            }),
        });

        await app.refreshTargetDevicesSnapshot();

        const snapshot = getLatestTargetSnapshotForTests();
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
    it('never demotes persisted managed/controllable settings when a reading goes missing', async () => {
        // A device whose meter is momentarily silent must NOT reach
        // `disableUnsupportedDevices`' persisted `managed: false` / `controllable: false`
        // write: a transient Homey read failure would otherwise permanently un-manage
        // the device and the owner would have to re-enable it by hand
        // (AGENTS.md: "transient external failures get an abandon-grace window, never a
        // destructive reset of persisted state").
        //
        // It does not, because `powerCapable` is STRUCTURAL — it asks whether PELS
        // can support the device at all, not whether it reported a number this
        // cycle. The live question is asked separately, when the plan input is
        // built. This test pins the separation: wire the live gate into
        // `powerCapable` and a home battery is permanently unmanaged on its first
        // discharge (negative watts read as "no reading").
        setMockDrivers({});
        mockHomeyInstance.settings.set('managed_devices', { 'vent-1': true });
        mockHomeyInstance.settings.set('controllable_devices', { 'vent-1': true });

        const app = createApp();
        await app.onInit();

        // `measure_power` is advertised but carries no value this cycle.
        vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
            'vent-1': {
                ...buildVentilationApiDevice({ capabilities: ['onoff', 'measure_power'] }),
                capabilitiesObj: {
                    onoff: { id: 'onoff', value: true },
                    // Advertised, but no value carried this cycle.
                    measure_power: { id: 'measure_power' },
                },
            },
        });

        await app.refreshTargetDevicesSnapshot();

        // Still supported, still in the snapshot, still configurable.
        expect(getLatestTargetSnapshotForTests().find((device) => device.id === 'vent-1')?.powerCapable)
            .toBe(true);

        const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
        const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
        expect(managed['vent-1']).toBe(true);
        expect(controllable['vent-1']).toBe(true);
    });
});
