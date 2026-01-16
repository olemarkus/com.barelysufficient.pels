
import { LogicController, LogicControllerConfig } from '../lib/core/logicController';
import { TargetDeviceSnapshot } from '../lib/utils/types';

describe('LogicController', () => {
    let controller: LogicController;
    let mockDeps: any;
    let mockConfig: LogicControllerConfig;

    beforeEach(() => {
        mockDeps = {
            getWeatherForecast: jest.fn(),
            log: jest.fn(),
            error: jest.fn(),
            saveCoefficients: jest.fn(),
            loadCoefficients: jest.fn().mockReturnValue({}),
        };
        mockConfig = {
            baseFloorKwh: 10,
            uncontrolledLoadKwh: 5,
            indoorTargetTemp: 21,
        };
        controller = new LogicController(mockDeps, mockConfig);
    });

    test('calculateDailyBudget returns null when no forecast', async () => {
        mockDeps.getWeatherForecast.mockResolvedValue([]);
        const budget = await controller.calculateDailyBudget([]);
        expect(budget).toBeNull();
        expect(mockDeps.log).toHaveBeenCalledWith(expect.stringContaining('skipping dynamic budget'));
    });

    test('calculateDailyBudget computes correctly based on forecast', async () => {
        // Mock forecast: 24 hours of 10 degrees
        const forecast = Array.from({ length: 24 }, (_, i) => ({
            time: `2023-01-01T${String(i).padStart(2, '0')}:00:00Z`,
            air_temperature: 10,
        }));
        mockDeps.getWeatherForecast.mockResolvedValue(forecast);

        // One device, default coeff 0.02
        // Delta = 21 - 10 = 11
        // Hourly Need = 11 * 0.02 = 0.22 kWh
        // Daily Need = 0.22 * 24 = 5.28 kWh
        // Total = 10 (base) + 5 (uncontrolled) + 5.28 = 20.28

        const devices: TargetDeviceSnapshot[] = [{
            id: 'dev1',
            name: 'Heater',
            deviceType: 'temperature',
            targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
            // other required fields mocked lightly
            capabilities: [],
            deviceClass: 'heater',
        } as any];

        const budget = await controller.calculateDailyBudget(devices);

        expect(budget).toBeCloseTo(20.28, 2);
    });

    test('recordDailyFailure increases coefficient by 5%', () => {
        controller.recordDailyFailure('dev1');

        // Default was 0.02. 0.02 * 1.05 = 0.021
        expect(mockDeps.saveCoefficients).toHaveBeenCalledWith(expect.objectContaining({
            dev1: 0.021,
        }));

        // Check if next calculation uses new coeff
        const coeffs = controller.getCoefficients();
        expect(coeffs['dev1']).toBe(0.021);
    });

    test('coefficients do not grow unbounded', () => {
        // Simulate many failures
        for (let i = 0; i < 100; i++) {
            controller.recordDailyFailure('dev1');
        }

        const coeffs = controller.getCoefficients();
        // With simple exponential growth, 0.02 * 1.05^100 is approx 2.6
        // If we want to cap it at e.g. 0.5 or 1.0, this should fail if not implemented.
        // Let's expect it to stay within a reasonable realistic range (e.g. max 1.5 kWh/deg)
        // A well insulated house is ~0.2 kw/deg maybe? A drafty one ~1-2?
        expect(coeffs['dev1']).toBeLessThan(2.0);
    });

    test('updateFeedback does not increase coefficient when target is met', async () => {
        const devices: TargetDeviceSnapshot[] = [{
            id: 'dev1',
            name: 'Heater',
            deviceType: 'temperature',
            targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
            currentTemperature: 21,
            capabilities: [],
            deviceClass: 'heater',
        } as any];

        await controller.updateFeedback(devices);

        expect(mockDeps.saveCoefficients).not.toHaveBeenCalled();
    });

    test('updateFeedback increases coefficient once per day when target is missed', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
        const devices: TargetDeviceSnapshot[] = [{
            id: 'dev1',
            name: 'Heater',
            deviceType: 'temperature',
            targets: [{ id: 'target_temperature', value: 22, unit: 'C' }],
            currentTemperature: 18,
            capabilities: [],
            deviceClass: 'heater',
        } as any];

        await controller.updateFeedback(devices);
        await controller.updateFeedback(devices);

        expect(mockDeps.saveCoefficients).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test('constructor ignores invalid coefficients from settings', () => {
        mockDeps.loadCoefficients.mockReturnValue({
            valid: 0.03,
            invalidText: 'nope',
            invalidNegative: -1,
            invalidNaN: NaN,
        });
        const next = new LogicController(mockDeps, mockConfig);
        expect(next.getCoefficients()).toEqual({ valid: 0.03 });
    });
});
