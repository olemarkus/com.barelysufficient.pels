import type { AppContext } from '../../lib/app/appContext';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import { TemperaturePriceShiftPolicy } from '../../lib/thermostat/priceShiftPolicy';
import { resolveOperatingModeForDevice } from '../homeRuntime/homeOperatingMode';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';

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

export function createObservedTemperatureModeUpdates(
  ctx: AppContext,
  getAreaCatalogs: () => ReturnType<HomeRuntimeRegistry['getLiveBundles']>,
  isDeviceLimited: (deviceId: string) => boolean,
): ObservedTemperatureModeUpdates {
  const reloadModeCatalogs = () => {
    ctx.loadCapacitySettings();
    getAreaCatalogs().forEach((catalog) => catalog.reloadModeCatalog());
  };
  return new ObservedTemperatureModeUpdates(
    ctx.homey.settings,
    (deviceId) => resolveOperatingModeForDevice(ctx, deviceId),
    ctx.resolveManagedState.bind(ctx),
    reloadModeCatalogs,
    (deviceId, value) => ctx.deviceManager!.resolveTemperatureTarget(deviceId, value),
    isDeviceLimited,
    ctx.priceShiftPolicy,
  );
}
