
import { TargetDeviceSnapshot } from '../utils/types';
import { WeatherForecast } from './weatherService';

export type LogicControllerDeps = {
    getWeatherForecast: () => Promise<WeatherForecast[]>;
    log: (...args: unknown[]) => void;
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
        this.coefficients = this.deps.loadCoefficients() || {};
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

    async updateFeedback(devices: TargetDeviceSnapshot[]): Promise<void> {
        for (const device of devices) {
            const target = device.targets?.find(t => t.id === 'target_temperature')?.value;
            const currentTemp = device.currentTemperature;

            if (typeof target === 'number' && typeof currentTemp === 'number') {
                const failureThreshold = 1.0;
                // If it's significantly below target, we treat it as a potential under-performance
                if (target > currentTemp + failureThreshold) {
                    this.recordDailyFailure(device.id);
                }
            }
        }
    }

    recordDailyFailure(deviceId: string): void {
        const current = this.coefficients[deviceId] ?? 0.02;
        const next = current * 1.05;
        this.coefficients[deviceId] = next;
        this.deps.saveCoefficients(this.coefficients);
        this.deps.log(`LogicController: Increased coefficient for ${deviceId} to ${next.toFixed(4)} (+5%)`);
    }
}
