
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
    baseFloorKw: number;
    uncontrolledLoadKw: number;
    indoorTargetTemp: number; // Default fallback if device has no target
};

export class LogicController {
    private coefficients: Record<string, number> = {}; // deviceId -> kWh/degree-delta

    constructor(private deps: LogicControllerDeps, private config: LogicControllerConfig) {
        const customCoeffs = this.deps.loadCoefficients();
        this.coefficients = (
            typeof customCoeffs === 'object' && customCoeffs !== null
                ? customCoeffs
                : {}
        );
    }

    getCoefficients(): Record<string, number> {
        return { ...this.coefficients };
    }

    async calculateDailyBudget(devices: TargetDeviceSnapshot[]): Promise<number> {
        const forecast = await this.deps.getWeatherForecast();
        if (!forecast || forecast.length === 0) {
            this.deps.log('LogicController: No weather forecast available, using 0 dynamic budget.');
            return 0;
        }

        let dailyHeatingNeeds = 0;

        // We calculate heating needs for the next 24 hours based on forecast
        for (const hourForecast of forecast) {
            const outdoorTemp = hourForecast.air_temperature;

            for (const device of devices) {
                // Only consider heating devices
                if (device.deviceType !== 'temperature') continue;

                const targetTemp = device.targets?.find(t => t.id === 'target_temperature')?.value;
                const target = typeof targetTemp === 'number' ? targetTemp : this.config.indoorTargetTemp;

                const delta = Math.max(0, target - outdoorTemp);

                // Get coefficient or default to something reasonable (e.g. 0.05 kWh per degree delta per hour?)
                // If we have no data, start small.
                const coeff = this.coefficients[device.id] ?? 0.02;

                dailyHeatingNeeds += delta * coeff;
            }
        }

        // Total Budget = BaseFloor + UncontrolledLoad + HeatingNeeds
        // We assume UncontrolledLoad is specified as a daily total in config, or we sum up hourly average.
        // Let's assume config.uncontrolledLoadKw is DAILY total for now, or maybe hourly avg * 24?
        // User requirement: "user-defined 'Base Floor' (kWh)" -> likely total for day?
        // Let's interpret baseFloorKw as daily minimum and uncontrolledLoadKw as daily uncontrolled.

        // Wait, the prompt says "Base Floor (kWh)".
        // And "Assume a baseline of 'uncontrolled' usage exists."

        const totalBudget = this.config.baseFloorKw + this.config.uncontrolledLoadKw + dailyHeatingNeeds;

        this.deps.log(
            `LogicController: Calculated Budget: ${totalBudget.toFixed(2)} kWh `
            + `(Base: ${this.config.baseFloorKw}, Uncontrolled: ${this.config.uncontrolledLoadKw}, Heating: ${dailyHeatingNeeds.toFixed(2)})`,
        );

        return totalBudget;
    }

    private readonly MAX_COEFFICIENT = 1.5;
    private readonly GROWTH_FACTOR = 1.05;
    private readonly FAILURE_THRESHOLD = 1.0;

    async updateFeedback(devices: TargetDeviceSnapshot[]): Promise<void> {
        require('fs').appendFileSync('/tmp/pels_debug.txt', `DEBUG: LogicController updateFeedback received ${devices.length} devices at ${new Date().toISOString()}\n`);
        for (const device of devices) {
            const target = device.targets?.find(t => t.id === 'target_temperature')?.value;
            const currentTemp = device.currentTemperature;

            if (typeof target === 'number' && typeof currentTemp === 'number') {
                // If it's significantly below target, we treat it as a potential under-performance
                if (target > currentTemp + this.FAILURE_THRESHOLD) {
                    this.recordDailyFailure(device.id);
                }
            }
        }
    }

    recordDailyFailure(deviceId: string): void {
        const current = this.coefficients[deviceId] ?? 0.02;
        const next = Math.min(current * this.GROWTH_FACTOR, this.MAX_COEFFICIENT);

        if (next !== current) {
            this.coefficients[deviceId] = next;
            this.deps.saveCoefficients(this.coefficients);
            this.deps.error(`DEBUG: LogicController saved coeffs for ${deviceId}: ${next}`);
            this.deps.log(`LogicController: Increased coefficient for ${deviceId} to ${next.toFixed(4)} (+${(this.GROWTH_FACTOR - 1) * 100}%)`);
        }
    }
}
