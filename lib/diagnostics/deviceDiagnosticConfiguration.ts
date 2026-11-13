import type { HomeModeCatalog } from '../home/homeModeCatalog';
import type { DeviceModeConfigurationRead } from '../home/homeModeDeviceRead';
import type { DeviceControlSettings } from '../device/deviceControlSettings';
import type { ExternalOffDeviceOptInRead, ExternalOffHoldPolicy } from '../observer/externalOffHold';
import { resolveDeviceStartPolicy } from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import type { DeviceStartPolicy } from '../../packages/contracts/src/types';
import type { ConfiguredShedBehavior } from '../../packages/shared-domain/src/settings/shedBehaviors';

/** Owner-resolved configuration at capture, separate from the last committed plan's decisions. */
export type DeviceDiagnosticConfiguration = {
  modes: DeviceModeConfigurationRead;
  powerLimitControl: boolean;
  budgetExempt: boolean;
  startPolicy: DeviceStartPolicy;
  configuredShedBehavior: ConfiguredShedBehavior;
  externalOffOptIn: ExternalOffDeviceOptInRead;
};

export type DeviceDiagnosticConfigurationRead =
  | { state: 'available'; configuration: DeviceDiagnosticConfiguration }
  | { state: 'unavailable' };

/** Reads existing owners only: no device refresh, plan evaluation or hold migration. */
export function readDeviceDiagnosticConfiguration(
  catalog: Pick<HomeModeCatalog, 'readDeviceModeConfiguration'>,
  controls: Pick<DeviceControlSettings,
    'isControllable' | 'isBudgetExempt' | 'deviceStartPolicies' | 'getConfiguredShedBehavior'>,
  externalOff: Pick<ExternalOffHoldPolicy, 'readOptInForDevice'> | undefined,
  deviceId: string,
): DeviceDiagnosticConfiguration {
  return {
    modes: catalog.readDeviceModeConfiguration(deviceId),
    powerLimitControl: controls.isControllable(deviceId),
    budgetExempt: controls.isBudgetExempt(deviceId),
    startPolicy: resolveDeviceStartPolicy(controls.deviceStartPolicies, deviceId),
    configuredShedBehavior: controls.getConfiguredShedBehavior(deviceId),
    externalOffOptIn: externalOff?.readOptInForDevice(deviceId) ?? { status: 'unavailable' },
  };
}

/** A diagnostic read failure must not erase the rest of a dump or report. */
export function captureDeviceDiagnosticConfiguration(
  read: (deviceId: string) => DeviceDiagnosticConfiguration,
  deviceId: string,
): DeviceDiagnosticConfigurationRead {
  try {
    return { state: 'available', configuration: read(deviceId) };
  } catch {
    return { state: 'unavailable' };
  }
}
