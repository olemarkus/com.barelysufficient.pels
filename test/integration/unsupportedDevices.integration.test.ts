import {
    mockHomeyInstance,
    setMockDrivers,
} from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'] });

const buildVentilationApiDevice = (overrides?: Partial<{
    id: string;
    name: string;
    onoff: boolean;
    class: string;
    capabilities: string[];
    energyObj: Record<string, unknown> | null;
}>) => {
    // Homey dates every capability value it reports.
    const lastUpdated = new Date().toISOString();
    return {
        id: overrides?.id ?? 'vent-1',
        name: overrides?.name ?? 'Ventilation Relay',
        class: overrides?.class ?? 'socket',
        virtualClass: null,
        capabilities: overrides?.capabilities ?? [
            'onoff',
        ],
        capabilitiesObj: {
            onoff: { id: 'onoff', value: overrides?.onoff ?? true, lastUpdated },
            ...(overrides?.capabilities?.includes('measure_power')
                ? { measure_power: { id: 'measure_power', value: 0, lastUpdated } }
                : {}),
        },
        settings: {},
        energyObj: overrides?.energyObj,
    };
};

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
        // the device and the owner would have to re-enable it by hand.
        //
        // A read that advertises `measure_power` without a value breaks the
        // device-read contract, so it is ignored outright: the entry the last
        // conforming read produced stands, support included, and nothing about
        // the device is re-decided from the partial payload.
        setMockDrivers({});
        mockHomeyInstance.settings.set('managed_devices', { 'vent-1': true });
        mockHomeyInstance.settings.set('controllable_devices', { 'vent-1': true });

        const app = createApp();
        await app.onInit();

        const getSpy = vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
            'vent-1': buildVentilationApiDevice({ capabilities: ['onoff', 'measure_power'] }),
        });
        await app.refreshTargetDevicesSnapshot();
        expect(getLatestTargetSnapshotForTests().find((device) => device.id === 'vent-1')?.powerCapable)
            .toBe(true);

        getSpy.mockResolvedValue({
            'vent-1': {
                ...buildVentilationApiDevice({ capabilities: ['onoff', 'measure_power'] }),
                capabilitiesObj: {
                    onoff: { id: 'onoff', value: true, lastUpdated: new Date().toISOString() },
                    // Advertised, but no value carried this cycle.
                    measure_power: { id: 'measure_power' },
                },
            },
        });
        await app.refreshTargetDevicesSnapshot();

        // Still supported, still in the snapshot, still configurable.
        expect(getLatestTargetSnapshotForTests().find((device) => device.id === 'vent-1')?.powerCapable)
            .toBe(true);

        // A conforming read with no usable reading (negative watts: what a home
        // battery reports while discharging) is parsed, and support is
        // structural: it does not follow the live reading.
        const conformingAt = new Date().toISOString();
        getSpy.mockResolvedValue({
            'vent-1': {
                ...buildVentilationApiDevice({ capabilities: ['onoff', 'measure_power'] }),
                capabilitiesObj: {
                    onoff: { id: 'onoff', value: true, lastUpdated: conformingAt },
                    measure_power: { id: 'measure_power', value: -2000, lastUpdated: conformingAt },
                },
            },
        });
        await app.refreshTargetDevicesSnapshot();
        expect(getLatestTargetSnapshotForTests().find((device) => device.id === 'vent-1')?.powerCapable)
            .toBe(true);

        const managed = mockHomeyInstance.settings.get('managed_devices') as Record<string, boolean>;
        const controllable = mockHomeyInstance.settings.get('controllable_devices') as Record<string, boolean>;
        expect(managed['vent-1']).toBe(true);
        expect(controllable['vent-1']).toBe(true);
    });
});
