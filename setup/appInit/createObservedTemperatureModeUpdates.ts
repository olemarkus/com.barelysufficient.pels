import type { AppContext } from '../../lib/app/appContext';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import { resolveOperatingModeForDevice } from '../homeRuntime/homeOperatingMode';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';

export function createObservedTemperatureModeUpdates(
  ctx: AppContext,
  getAreaCatalogs: () => ReturnType<HomeRuntimeRegistry['getLiveBundles']>,
): ObservedTemperatureModeUpdates {
  return new ObservedTemperatureModeUpdates(
    ctx.homey.settings,
    (deviceId) => resolveOperatingModeForDevice(ctx, deviceId),
    ctx.resolveManagedState.bind(ctx),
    ctx.loadCapacitySettings.bind(ctx),
    getAreaCatalogs,
    (deviceId, value) => ctx.deviceManager!.resolveTemperatureTarget(deviceId, value),
  );
}
