import type { AppContext } from '../../lib/app/appContext';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import type { ResolveOperatingModeForDevice } from '../appDeviceSupport';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';

export function createObservedTemperatureModeUpdates(
  ctx: AppContext,
  resolveOperatingModeForDevice: ResolveOperatingModeForDevice,
  getAreaCatalogs: () => ReturnType<HomeRuntimeRegistry['getLiveBundles']>,
  isDeviceLimited: (deviceId: string) => boolean,
): ObservedTemperatureModeUpdates {
  return new ObservedTemperatureModeUpdates(
    ctx.homey.settings,
    resolveOperatingModeForDevice,
    ctx.resolveManagedState.bind(ctx),
    ctx.loadCapacitySettings.bind(ctx),
    getAreaCatalogs,
    (deviceId, value) => ctx.deviceManager!.resolveTemperatureTarget(deviceId, value),
    isDeviceLimited,
  );
}
