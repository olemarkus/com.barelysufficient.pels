import type { AppContext } from '../../lib/app/appContext';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import { resolveOperatingModeForDevice } from '../homeRuntime/homeOperatingMode';
import { requirePlanService } from './contextGuards';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';

/** The two registry seams this factory needs, so a test can hand it a stub. */
export type OwningHomeRegistryRead = Pick<HomeRuntimeRegistry, 'getLiveBundles' | 'getOwningHomeRouteForDevice'>;

export function createObservedTemperatureModeUpdates(
  ctx: AppContext,
  getRegistry: () => OwningHomeRegistryRead | undefined,
): ObservedTemperatureModeUpdates {
  return new ObservedTemperatureModeUpdates(
    ctx.homey.settings,
    (deviceId) => resolveOperatingModeForDevice(ctx, deviceId),
    ctx.resolveManagedState.bind(ctx),
    ctx.loadCapacitySettings.bind(ctx),
    () => getRegistry()?.getLiveBundles() ?? [],
    (deviceId, value) => ctx.deviceManager!.resolveTemperatureTarget(deviceId, value),
    // Asked of the device's OWNING home: main's plan filters meter-area members
    // out, so for one of those main would always answer "not limited" and the
    // rule would be silently off. No route means a main-home device.
    (deviceId) => (
      getRegistry()?.getOwningHomeRouteForDevice(deviceId)?.hooks.isDeviceLimited(deviceId)
      ?? requirePlanService(ctx).isDeviceLimitedInLatestPlan(deviceId)
    ),
  );
}
