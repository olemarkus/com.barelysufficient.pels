import type { Mock, MockInstance } from 'vitest';

import { DeviceTransport } from '../../lib/device/deviceTransport';
import type { Logger } from '../../lib/utils/types';
import { mockHomeyInstance } from '../mocks/homey';
import Homey from 'homey';

describe('Issue #18 Reproduction: Expected Power Overlap', () => {
    let deviceManager: DeviceTransport;
    let homeyMock: Homey.App;
    let loggerMock: Logger & {
        log: Mock;
        debug: Mock;
        error: Mock;
        structuredLog: Logger['structuredLog'] & { info: Mock; error: Mock; debug: Mock };
    };
    // Shared state objects
    let expectedPowerKwOverrides: Record<string, { kw: number; ts: number }>;
    let lastKnownPowerKw: Record<string, number>;
    let lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
    let apiGetSpy: MockInstance;

    beforeEach(() => {
        vi.clearAllMocks();
        homeyMock = mockHomeyInstance as unknown as Homey.App;

        loggerMock = {
            log: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            structuredLog: {
                info: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            } as unknown as Logger['structuredLog'] & { info: Mock; error: Mock; debug: Mock },
        };

        // Initialize state objects
        expectedPowerKwOverrides = {};
        lastKnownPowerKw = {};
        lastPositiveMeasuredPowerKw = {};

        deviceManager = new DeviceTransport(homeyMock, loggerMock, undefined, {
            expectedPowerKwOverrides,
            lastKnownPowerKw,
            lastPositiveMeasuredPowerKw,
        });

        apiGetSpy = vi.spyOn(mockHomeyInstance.api, 'get');
    });

    afterEach(() => {
        apiGetSpy.mockRestore();
        deviceManager.destroy();
    });

    it('should reproduce issue where measured power overwrites expected power', async () => {
        await deviceManager.init();

        const deviceId = 'dev1';

        // 1. Initial state: Device is drawing 1.67 kW
        apiGetSpy.mockResolvedValue({
            [deviceId]: {
                id: deviceId,
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    measure_power: { value: 1670, id: 'measure_power' }, // 1.67 kW
                    measure_temperature: { value: 21, id: 'measure_temperature' },
                    target_temperature: { value: 20, id: 'target_temperature' },
                },
            },
        });

        // Refresh to populate measured power
        await deviceManager.refreshSnapshot();
        let snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(1.67);
        expect(snapshot[0].expectedPowerKw).toBe(1.67);

        // 2. Flow action: Set expected power to 3.0 kW
        const overrideTs = Date.now() - 10;
        expectedPowerKwOverrides[deviceId] = { kw: 3.0, ts: overrideTs };

        apiGetSpy.mockResolvedValue({
            [deviceId]: {
                id: deviceId,
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    measure_power: { value: 1670, id: 'measure_power' }, // Still 1.67 kW
                    measure_temperature: { value: 21, id: 'measure_temperature' },
                    target_temperature: { value: 20, id: 'target_temperature' },
                },
            },
        });

        await deviceManager.refreshSnapshot();
        snapshot = deviceManager.getSnapshot();

        expect(snapshot[0].expectedPowerKw).toBe(3.0);
    });

    // A manual value is an INSTRUCTION, so a higher measurement no longer
    // supersedes it. Safety is unaffected: restore sizing takes
    // max(currentDraw, expected, planning), so the live 3.5 kW still drives the
    // reservation through `currentDrawKw` — it just stops silently rewriting what
    // the owner typed.
    it('keeps the manual override when a higher measurement arrives', async () => {
        await deviceManager.init();
        const deviceId = 'dev1';

        // Set expected power to 3.0 kW
        const overrideTs = Date.now();
        expectedPowerKwOverrides[deviceId] = { kw: 3.0, ts: overrideTs };

        // Measured power jumps to 3.5 kW
        apiGetSpy.mockResolvedValue({
            [deviceId]: {
                id: deviceId,
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    measure_power: { value: 3500, id: 'measure_power' }, // 3.5 kW
                    measure_temperature: { value: 21, id: 'measure_temperature' },
                    target_temperature: { value: 20, id: 'target_temperature' },
                },
            },
        });

        await deviceManager.refreshSnapshot();
        const snapshot = deviceManager.getSnapshot();

        expect(snapshot[0].expectedPowerKw).toBe(3.0);
    });

    // The lowered override applies at once. It used to wait for measurement to
    // settle down to it, which meant a user correcting an over-estimate saw
    // nothing change until the device happened to agree.
    it('applies a lowered manual override immediately', async () => {
        await deviceManager.init();
        const deviceId = 'dev1';

        // Initial measured power is 3.0 kW.
        apiGetSpy.mockResolvedValue({
            [deviceId]: {
                id: deviceId,
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    measure_power: { value: 3000, id: 'measure_power' },
                    measure_temperature: { value: 21, id: 'measure_temperature' },
                    target_temperature: { value: 20, id: 'target_temperature' },
                },
            },
        });

        await deviceManager.refreshSnapshot();
        let snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(3.0);

        // User sets expected power to 2.0 kW while measured is still 3.0 kW.
        expectedPowerKwOverrides[deviceId] = { kw: 2.0, ts: Date.now() };
        await deviceManager.refreshSnapshot();
        snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(2.0);

        // Measured power settles to 2.0 kW.
        apiGetSpy.mockResolvedValue({
            [deviceId]: {
                id: deviceId,
                name: 'Heater',
                class: 'heater',
                capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
                capabilitiesObj: {
                    measure_power: { value: 2000, id: 'measure_power' },
                    measure_temperature: { value: 21, id: 'measure_temperature' },
                    target_temperature: { value: 20, id: 'target_temperature' },
                },
            },
        });

        await deviceManager.refreshSnapshot();
        snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(2.0);
    });
});
