import type { BatteryDemandForecaster } from './batteryDemandForecast';
import type { BatteryEfficiencyLearner } from './batteryEfficiencyLearner';

/**
 * What the battery owner learns from the Main meter: the battery-neutral
 * household demand the plan forecasts from, and each battery's measured
 * round-trip efficiency the device page offers. One meter tap feeds both.
 */
export class BatteryMeterLearning {
  constructor(
    readonly demand: BatteryDemandForecaster,
    readonly efficiency: BatteryEfficiencyLearner,
  ) {}

  /** Main meter tap. */
  recordNetSample(netPowerW: number, generationW: number | undefined, atMs: number): void {
    this.demand.recordNetSample(netPowerW, generationW, atMs);
    this.efficiency.recordSample(atMs);
  }
}
