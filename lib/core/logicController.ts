import { TargetDeviceSnapshot } from '../utils/types';
import { WeatherForecast } from './weatherService';

export type LogicControllerDeps = {
    getWeatherForecast: () => Promise<WeatherForecast[]>;
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    saveCoefficients: (coefficients: Record<string, number>) => void;
    loadCoefficients: () => Record<string, number>;
};

export type LogicControllerConfig = {
    baseFloorKwh: number;
    uncontrolledLoadKwh: number;
    indoorTargetTemp: number; // Default fallback if device has no target
};

const DEFAULT_HEATING_COEFFICIENT = 0.02;
const MAX_COEFFICIENT = 1.5;
const COEFFICIENT_GROWTH_FACTOR = 1.05;
const FAILURE_THRESHOLD_C = 1.0;

const resolveDayKey = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Weather-aware daily budget calculator with a simple feedback loop.
 *
 * - Calculates heating needs from the next 24h forecast and device targets.
 * - Learns per-device coefficients (kWh per degree-hour) when devices underperform.
 * - Caps coefficient growth and rate-limits updates to avoid runaway budgets.
 */
export class LogicController {
    private coefficients: Record<string, number> = {}; // deviceId -> kWh/degree-delta
    private lastFailureDay: Record<string, string> = {};

    constructor(private deps: LogicControllerDeps, private config: LogicControllerConfig) {
        this.coefficients = this.validateAndLoadCoefficients();
    }

    getCoefficients(): Record<string, number> {
        return { ...this.coefficients };
    }

    updateConfig(config: LogicControllerConfig): void {
        this.config = config;
    }

    /**
     * Returns a dynamic daily budget in kWh or null when forecast is unavailable.
     */
    async calculateDailyBudget(devices: TargetDeviceSnapshot[]): Promise<number | null> {
        const forecast = await this.deps.getWeatherForecast();
        if (!forecast || forecast.length === 0) {
            this.deps.log('LogicController: No weather forecast available, skipping dynamic budget.');
            return null;
        }

        const heatingDevices = devices
            .filter((device) => device.deviceType === 'temperature')
            .map((device) => {
                const targetTemp = device.targets?.find((t) => t.id === 'target_temperature')?.value;
                const target = typeof targetTemp === 'number' ? targetTemp : this.config.indoorTargetTemp;
                const coeff = this.coefficients[device.id] ?? DEFAULT_HEATING_COEFFICIENT;
                return { target, coeff };
            });

        let dailyHeatingNeeds = 0;

        // Heating needs are estimated from the next 24h forecast and per-device targets.
        for (const hourForecast of forecast) {
            const outdoorTemp = hourForecast.air_temperature;
            for (const device of heatingDevices) {
                const delta = Math.max(0, device.target - outdoorTemp);
                dailyHeatingNeeds += delta * device.coeff;
            }
        }

        // Total daily budget (kWh) = BaseFloor (daily kWh) + UncontrolledLoad (daily kWh) + HeatingNeeds (daily kWh).
        const totalBudget = this.config.baseFloorKwh + this.config.uncontrolledLoadKwh + dailyHeatingNeeds;

        this.deps.log(
            `LogicController: Calculated Budget: ${totalBudget.toFixed(2)} kWh `
            + `(Base: ${this.config.baseFloorKwh}, Uncontrolled: ${this.config.uncontrolledLoadKwh}, Heating: ${dailyHeatingNeeds.toFixed(2)})`,
        );

        return totalBudget;
    }

    /**
     * Updates coefficients based on device performance.
     * Only increases once per device per day to avoid runaway growth.
     */
    async updateFeedback(devices: TargetDeviceSnapshot[]): Promise<void> {
        const todayKey = resolveDayKey(new Date());
        for (const device of devices) {
            const target = device.targets?.find((t) => t.id === 'target_temperature')?.value;
            const currentTemp = device.currentTemperature;

            if (typeof target === 'number' && typeof currentTemp === 'number') {
                // If it's significantly below target, we treat it as a potential under-performance
                if (target > currentTemp + FAILURE_THRESHOLD_C) {
                    if (this.lastFailureDay[device.id] === todayKey) continue;
                    this.recordDailyFailure(device.id);
                    this.lastFailureDay[device.id] = todayKey;
                }
            }
        }
    }

    recordDailyFailure(deviceId: string): void {
        const current = this.coefficients[deviceId] ?? DEFAULT_HEATING_COEFFICIENT;
        const next = Math.min(current * COEFFICIENT_GROWTH_FACTOR, MAX_COEFFICIENT);

        if (next !== current) {
            this.coefficients[deviceId] = next;
            this.deps.saveCoefficients(this.coefficients);
            this.deps.log(`LogicController: Increased coefficient for ${deviceId} to ${next.toFixed(4)} (+${(COEFFICIENT_GROWTH_FACTOR - 1) * 100}%)`);
        }
    }

    private static isValidCoefficient(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }

    private validateAndLoadCoefficients(): Record<string, number> {
        const raw = this.deps.loadCoefficients();
        const valid: Record<string, number> = {};
        if (!raw || typeof raw !== 'object') return valid;

        for (const [deviceId, value] of Object.entries(raw)) {
            if (LogicController.isValidCoefficient(value)) {
                valid[deviceId] = value;
            } else {
                this.deps.log(`LogicController: Ignoring invalid coefficient for ${deviceId}: ${String(value)}`);
            }
        }
        return valid;
    }
}
