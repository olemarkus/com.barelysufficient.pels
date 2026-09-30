import type { AppContext } from '../../lib/app/appContext';
import { TemperaturePriceShiftPolicy } from '../../lib/thermostat/priceShiftPolicy';

export function createTemperaturePriceShiftPolicy(ctx: AppContext): TemperaturePriceShiftPolicy {
  return new TemperaturePriceShiftPolicy(
    ctx.homey.settings,
    () => ctx.getCurrentHourPriceLevel(),
    () => ctx.priceOptimizationEnabled,
    () => ctx.priceOptimizationSettings,
    (deviceId) => ctx.getThermalDirection(deviceId),
    (deviceId, value) => ctx.deviceManager!.resolveTemperatureTarget(deviceId, value),
  );
}
