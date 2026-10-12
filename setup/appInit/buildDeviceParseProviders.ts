/**
 * Per-device resolution the transport's parse pipeline needs: priority,
 * managed/controllable state, budget exemption, control profile, and the
 * multi-home meter fan-out.
 *
 * Extracted from `appServiceWiring.initDeviceManager`, which had grown a
 * ~20-line provider literal inline. Grouping it here keeps that method about
 * *constructing* the transport rather than about the settings lookups each
 * provider happens to perform.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { DeviceTransportParseProviders } from '../../lib/device/transport/managerParseDevice';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import { buildHomeRuntimeMeterProviders } from './wireHomeRuntimeRegistry';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { AppNativeWiring } from '../appNativeWiring';
import { isManagedFilterActive } from '../appDeviceSupport';

/**
 * `getHomeRuntimeRegistry` is lazy: the registry is built AFTER the transport
 * and cleared at uninit, so the meter providers must resolve it per call.
 * Empty/no-op outside that window, which leaves the single-home path untouched.
 */
export const buildDeviceParseProviders = (
  ctx: AppContext,
  nativeWiring: AppNativeWiring,
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined,
  resolveMeterSelection: () => MainMeterSelection,
): DeviceTransportParseProviders => {
  const settings = ctx.deviceControlSettings;
  return {
    getHomeyEnergyMeterSelection: resolveMeterSelection,
    // (The whole-home meter IDENTITY is not a parse provider: it rides the
    // sample into the admitted ingest — `PowerSamplePipeline`.)
    ...buildHomeRuntimeMeterProviders(getHomeRuntimeRegistry),
    getControllable: (id) => ctx.isCapacityControlEnabled(id),
    getManaged: (id) => ctx.resolveManagedState(id),
    isManagedFilterActive: () => isManagedFilterActive(settings.managedDevices),
    getBudgetExempt: (id) => settings.isBudgetExempt(id),
    getNativeEvWiringEnabled: (id) => nativeWiring.resolveNativeWiringEnabled(id),
    getFlowConflict: (id) => nativeWiring.getFlowConflict(id),
    getDeviceDriverIdOverride: (id) => settings.getDeviceDriverIdOverride(id),
    getDeviceControlProfile: (id) => settings.getDeviceControlProfile(id),
    getDeviceTargetPowerConfig: (id) => settings.getDeviceTargetPowerConfig(id),
    getFlowReportedCapabilities: (deviceId) => ctx.flowBacked.getFlowReportedCapabilitiesForDevice(deviceId),
    getEvCarAssociationCarIds: (id) => settings.getEvCarAssociationCarIds(id),
  };
};
