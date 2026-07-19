/**
 * Boot-wiring helpers for the per-home capacity-bundle registry (multi-home
 * R7b). `AppServiceWiring` owns the registry FIELD (its lifetime spans
 * init→uninit); the closures here keep every consumer seam lazy over that
 * field, so each seam is inert before `initHomeRuntimeRegistry` runs and again
 * after `runUninit` clears it:
 *
 * - the transport's per-meter provider pair (`buildHomeRuntimeMeterProviders`)
 *   — one `manager/energy/live` poll serves every home;
 * - the settings-handler hooks (`buildHomeRuntimeSettingsHooks`) — the
 *   suffixed-key dirty-mark hook plus the `homes_config` reconcile trigger.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { DeviceTransportParseProviders } from '../../lib/device/transport/managerParseDevice';
import { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';

/** Construct the registry and run its boot-time reconcile (empty = inert). */
export const createHomeRuntimeRegistryForApp = (
  ctx: AppContext,
  isMembershipReady: () => boolean,
): HomeRuntimeRegistry => {
  const registry = new HomeRuntimeRegistry({ ctx, isMembershipReady });
  registry.reconcile();
  return registry;
};

/** The transport's sub-home meter provider pair (request ids + readings fan-out). */
export const buildHomeRuntimeMeterProviders = (
  getRegistry: () => HomeRuntimeRegistry | undefined,
): Pick<DeviceTransportParseProviders, 'getAdditionalMeterDeviceIds' | 'onAdditionalMeterReadings'> => ({
  getAdditionalMeterDeviceIds: () => getRegistry()?.getMeterDeviceIds() ?? [],
  // Poll-discard parity is enforced inside `routeMeterReadings` (it already reads
  // the power source), so this dispatch stays a thin lazy forward.
  onAdditionalMeterReadings: (readings, nowMs) => getRegistry()?.routeMeterReadings(readings, nowMs),
});

/** The settings-handler hooks (contract: `SettingsHandlerDeps.onHomeScopedSettingChanged`). */
export const buildHomeRuntimeSettingsHooks = (
  getRegistry: () => HomeRuntimeRegistry | undefined,
): {
  onHomeScopedSettingChanged: (baseKey: string, homeId: string) => void;
  reconcileHomeRuntimes: () => void;
} => ({
  onHomeScopedSettingChanged: (baseKey, homeId) => getRegistry()?.onHomeScopedSettingChanged(baseKey, homeId),
  reconcileHomeRuntimes: () => getRegistry()?.reconcile(),
});
