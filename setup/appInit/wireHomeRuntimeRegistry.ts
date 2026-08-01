/**
 * Boot-wiring helpers for the per-home capacity-bundle registry (multi-home
 * R7b). `AppServiceWiring` owns the registry FIELD (its lifetime spans
 * init→uninit); the closures here keep every consumer seam lazy over that
 * field, so each seam is inert before `initHomeRuntimeRegistry` runs and again
 * after `runUninit` clears it:
 *
 * - the transport's per-meter provider pair (`buildHomeRuntimeMeterProviders`)
 *   — one `manager/energy/live` poll serves every home;
 * - the settings-handler hooks (`buildHomeRuntimeSettingsHooks`) — suffixed
 *   dirty marks, `homes_config` reconcile, and global source-epoch replacement;
 * - the `AppContext` read port (`buildHomeRuntimeReadPort`) — the settings UI's
 *   already-committed per-home read.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { DeviceTransportParseProviders } from '../../lib/device/transport/managerParseDevice';
import type { HomeRuntimeReadPort } from '../../lib/home/homeRuntimeRead';
import { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';

/** Construct the registry and run its boot-time reconcile (empty = inert). */
export const createHomeRuntimeRegistryForApp = (
  ctx: AppContext,
  isMembershipReady: () => boolean,
  isRuntimeActive: () => boolean,
): HomeRuntimeRegistry => {
  const registry = new HomeRuntimeRegistry({ ctx, isMembershipReady, isRuntimeActive });
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

/**
 * The per-home read port published on `AppContext`. `HomeRuntimeRegistry`
 * already implements the port, so this exists for one reason: `AppContext` must
 * not hold a REFERENCE to the registry. Assigning it directly would put an
 * object carrying `reconcile`, `teardownAll` and `routeMeterReadings` on the
 * shared context, one cast away from any consumer; this closure exposes exactly
 * `readHome` and nothing else.
 *
 * Lazy over the wiring field, like the seams above it: with no registry —
 * before `initHomeRuntimeRegistry`, or after `runUninit` cleared it — there are
 * no committed per-home values, so the port reports `unavailable`. That is the
 * producer classifying its own state, not a defaulted business value; no
 * fabricated plan, tracker or scalar can reach a consumer through this seam.
 */
export const buildHomeRuntimeReadPort = (
  // Typed as the PORT, not the registry: this seam needs nothing else from it,
  // and `HomeRuntimeRegistry implements HomeRuntimeReadPort` proves the source.
  getRegistry: () => HomeRuntimeReadPort | undefined,
): HomeRuntimeReadPort => ({
  readHome: (homeId) => getRegistry()?.readHome(homeId) ?? { state: 'unavailable' },
});

/** The settings-handler hooks (contract: `SettingsHandlerDeps.onHomeScopedSettingChanged`). */
export const buildHomeRuntimeSettingsHooks = (
  getRegistry: () => HomeRuntimeRegistry | undefined,
): {
  onHomeScopedSettingChanged: (baseKey: string, homeId: string) => void;
  reconcileHomeRuntimes: () => void;
  onHomeRuntimePowerSourceObserved: () => void;
  onHomeRuntimePowerSourceChanged: () => void;
  rebuildHomeRuntimePlansForModeChange: () => void;
  rebuildAllHomeRuntimePlansForDeviceControlChange: () => void;
} => ({
  onHomeScopedSettingChanged: (baseKey, homeId) => getRegistry()?.onHomeScopedSettingChanged(baseKey, homeId),
  reconcileHomeRuntimes: () => getRegistry()?.reconcile(),
  onHomeRuntimePowerSourceObserved: () => getRegistry()?.observePowerSourceChange(),
  onHomeRuntimePowerSourceChanged: () => getRegistry()?.onPowerSourceChanged(),
  rebuildHomeRuntimePlansForModeChange: () => getRegistry()?.onModeSettingsChanged(),
  rebuildAllHomeRuntimePlansForDeviceControlChange: () => (
    getRegistry()?.onDeviceControlSettingsChanged()
  ),
});
