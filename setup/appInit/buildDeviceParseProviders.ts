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

export type DeviceParseProviderDeps = {
  isManagedFilterActive: () => boolean;
  resolveNativeWiringEnabled: (deviceId: string) => boolean;
  getDeviceDriverIdOverride: (deviceId: string) => string | undefined;
  getFlowConflict: (
    deviceId: string,
  ) => { conflictingCapabilities: readonly string[]; flowName?: string } | undefined;
};

export const buildDeviceParseProviders = (params: {
  ctx: AppContext;
  deps: DeviceParseProviderDeps;
  /**
   * Lazy: the registry is built AFTER the transport and cleared at uninit, so
   * the meter providers must resolve it per call. Empty/no-op outside that
   * window, which leaves the single-home path untouched.
   */
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined;
  resolveMeterSelection: () => MainMeterSelection;
}): DeviceTransportParseProviders => {
  const { ctx, deps, getHomeRuntimeRegistry, resolveMeterSelection } = params;
  return {
    getHomeyEnergyMeterSelection: resolveMeterSelection,
    ...buildHomeRuntimeMeterProviders(getHomeRuntimeRegistry),
    getPriority: (id) => ctx.getPriorityForDevice(id),
    getControllable: (id) => ctx.isCapacityControlEnabled(id),
    getManaged: (id) => ctx.resolveManagedState(id),
    isManagedFilterActive: () => deps.isManagedFilterActive(),
    getBudgetExempt: (id) => ctx.isBudgetExempt(id),
    getCommunicationModel: (id) => ctx.getCommunicationModel(id),
    getNativeEvWiringEnabled: (id) => deps.resolveNativeWiringEnabled(id),
    getFlowConflict: (id) => deps.getFlowConflict(id),
    getDeviceDriverIdOverride: (id) => deps.getDeviceDriverIdOverride(id),
    getDeviceControlProfile: (id) => ctx.deviceControlProfiles[id],
    getDeviceTargetPowerConfig: (id) => ctx.deviceTargetPowerConfigs[id],
    getFlowReportedCapabilities: (deviceId) => ctx.getFlowReportedCapabilitiesForDevice(deviceId),
  };
};
