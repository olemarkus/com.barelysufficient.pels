import type { LearnedPeaksByDeviceId } from '../../lib/device/devicePowerPeak';
import {
  createTestDeviceTransport,
} from '../helpers/deviceTransportHarness';
import type { Mock, MockInstance } from 'vitest';

import { DeviceTransport } from '../../lib/device/deviceTransport';
import type { Logger } from '../../lib/utils/types';
import { mockHomeyInstance } from '../mocks/homey';
import Homey from 'homey';

// A full read of the heater as Homey reports it: every value dated when read.
const heaterRead = (deviceId: string, measuredPowerW: number) => {
    const lastUpdated = new Date().toISOString();
    return {
        [deviceId]: {
            id: deviceId,
            name: 'Heater',
            class: 'heater',
            capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
            capabilitiesObj: {
                measure_power: { value: measuredPowerW, id: 'measure_power', lastUpdated },
                measure_temperature: { value: 21, id: 'measure_temperature', lastUpdated },
                target_temperature: { value: 20, id: 'target_temperature', lastUpdated },
            },
        },
    };
};

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
    let lastKnownPowerKw: LearnedPeaksByDeviceId;
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

        deviceManager = createTestDeviceTransport(homeyMock, loggerMock, undefined, {
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
        apiGetSpy.mockResolvedValue(heaterRead(deviceId, 1670)); // 1.67 kW

        // Refresh to populate measured power
        await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
        let snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(1.67);
        expect(snapshot[0].expectedPowerKw).toBe(1.67);

        // 2. Flow action: Set expected power to 3.0 kW
        const overrideTs = Date.now() - 10;
        expectedPowerKwOverrides[deviceId] = { kw: 3.0, ts: overrideTs };

        apiGetSpy.mockResolvedValue(heaterRead(deviceId, 1670)); // Still 1.67 kW

        await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
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
        apiGetSpy.mockResolvedValue(heaterRead(deviceId, 3500)); // 3.5 kW

        await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
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
        apiGetSpy.mockResolvedValue(heaterRead(deviceId, 3000));

        await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
        let snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(3.0);

        // User sets expected power to 2.0 kW while measured is still 3.0 kW.
        expectedPowerKwOverrides[deviceId] = { kw: 2.0, ts: Date.now() };
        await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
        snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(2.0);

        // Measured power settles to 2.0 kW.
        apiGetSpy.mockResolvedValue(heaterRead(deviceId, 2000));

        await deviceManager.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
        snapshot = deviceManager.getSnapshot();
        expect(snapshot[0].expectedPowerKw).toBe(2.0);
    });
});
