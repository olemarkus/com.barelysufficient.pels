
import {
    mockHomeyInstance,
    setMockDrivers,
    MockDevice,
    MockDriver,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import { WeatherService } from '../lib/core/weatherService';
import { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import {
    DAILY_BUDGET_KWH,
    DAILY_BUDGET_ENABLED,
    LOGIC_CONTROL_ENABLED,
} from '../lib/utils/settingsKeys';

// Use fake timers to control the periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate'] });

describe('PELS Logic Controller Integration', () => {
    let weatherSpy: jest.SpyInstance;

    beforeEach(() => {
        mockHomeyInstance.settings.removeAllListeners();
        mockHomeyInstance.settings.clear();
        mockHomeyInstance.flow._actionCardListeners = {};
        mockHomeyInstance.flow._conditionCardListeners = {};

        // Clear timers
        jest.clearAllTimers();

        // Mock WeatherService.getForecast to return a "cold day" by default
        // -5 degrees C for all hours
        const baseTimestamp = new Date('2024-01-01T00:00:00.000Z').getTime();
        const coldForecast = Array.from({ length: 24 }).map((_, i) => ({
            time: new Date(baseTimestamp + i * 3600 * 1000).toISOString(),
            air_temperature: -5,
        }));

        weatherSpy = jest
            .spyOn(WeatherService.prototype, 'getForecast')
            .mockResolvedValue(coldForecast);
    });

    afterEach(async () => {
        await cleanupApps();
        await jest.runOnlyPendingTimersAsync();
        jest.restoreAllMocks();
    });

    it('calculates dynamic budget based on cold weather and updates daily budget service', async () => {
        // 1. Setup - Mock devices
        const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_temperature', 'onoff']);
        // Heater is ON, Target 22, Current 18 (Struggling/Needs heat)
        await heater.setCapabilityValue('target_temperature', 22);
        await heater.setCapabilityValue('measure_temperature', 18);
        await heater.setCapabilityValue('onoff', true);

        setMockDrivers({
            driverA: new MockDriver('driverA', [heater]),
        });

        // 2. Setup - Initial Settings
        // Base static budget (should be overridden)
        mockHomeyInstance.settings.set(DAILY_BUDGET_KWH, 30);
        mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, true);
        mockHomeyInstance.settings.set(LOGIC_CONTROL_ENABLED, true);

        // Ensure LogicController coefficients are fresh strings/files if needed,
        // but Homey settings mock handles memory persistence.

        const budgetSpy = jest.spyOn(DailyBudgetService.prototype, 'setDynamicBudget');
        const app = createApp();
        await app.onInit();

        // 3. Trigger Refresh
        // The snapshot refresh interval is 5 * 60 * 1000 (5 mins)
        // Advance time to trigger the interval
        jest.advanceTimersByTime(5 * 60 * 1000 + 100);
        await jest.runOnlyPendingTimersAsync();

        // 4. Verify Weather Fetch
        expect(weatherSpy).toHaveBeenCalled();

        // 5. Verify Dynamic Budget Calculation
        // Logic: Base(10) + Uncontrolled(5) + HeatingNeeds
        // HeatingNeeds: -5 outside, 22 inside = 27 delta.
        // The exact per-hour coefficient is defined in LogicController (default 0.02).
        // Since that implementation detail can change, we only assert it's different from 30.
        // LogicController Default: 10 + 5 + sum(24 hours * (27 * 0.02 per device))
        // Let's just check that it's DIFFERENT from static 30.

        // We can spy on DailyBudgetService.setDynamicBudget if we want exactness,
        // OR we can check if the internal state of dailyBudgetService changed.
        // We can check logs for "Setting dynamic daily budget to..."

        expect(budgetSpy).toHaveBeenCalled();
        const lastCall = budgetSpy.mock.calls[budgetSpy.mock.calls.length - 1] || [];
        const dynamicBudget = lastCall[0] as number;
        expect(dynamicBudget).toBeGreaterThan(0);
        expect(dynamicBudget).not.toBe(30); // Should be different from static config
        budgetSpy.mockRestore();
    });

    it('adjusts coefficients when devices fail to meet target', async () => {
        // 1. Setup - Heater failing to reach target
        const heater = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_temperature', 'onoff']);
        // Target 25 (high), Current 20 (failing)
        await heater.setCapabilityValue('target_temperature', 25);
        await heater.setCapabilityValue('measure_temperature', 20);
        await heater.setCapabilityValue('onoff', true);

        setMockDrivers({
            driverA: new MockDriver('driverA', [heater]),
        });

        mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, true);
        mockHomeyInstance.settings.set(LOGIC_CONTROL_ENABLED, true);
        const app = createApp();
        await app.onInit();

        // Check initial coefficients
        let coeffs = mockHomeyInstance.settings.get('logic_coefficients') || {};
        expect(coeffs['dev-1']).toBeUndefined(); // Should be undefined or default

        // 2. Trigger Refresh twice (to simulate time passing and check for updates)
        // LogicController updates feedback during refresh.

        require('./setup').setAllowConsoleError(true);

        // Advance time and wait for async operations
        jest.advanceTimersByTime(5 * 60 * 1000 + 100);
        await jest.runOnlyPendingTimersAsync();

        // 3. Verify Coefficients Updated
        coeffs = mockHomeyInstance.settings.get('logic_coefficients');
        expect(coeffs).toBeDefined();
        // It should have learned a coefficient for 'dev-1' or increased it.
        // Initial accumulation might take time or be instant depending on logic.
        // In LogicController logic:
        // If (target > measure + 1) -> Failure.
        // recordDailyFailure -> increases coefficient.

        expect(coeffs['dev-1']).toBeDefined();
        expect(coeffs['dev-1']).toBeGreaterThan(0);
    });
});
