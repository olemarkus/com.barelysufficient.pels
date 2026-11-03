import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import type { DeviceTargetPowerConfigsWithReachability } from '../../lib/device/targetPowerReachability';
import type { DeviceStartPolicy } from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import {
  CONTROLLABLE_DEVICES,
  DEVICE_START_POLICIES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_TARGET_POWER_REACHABILITY,
  MANAGED_DEVICES,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';

type DeviceControlSettingsFixture = {
  controllableDevices?: Record<string, boolean>;
  managedDevices?: Record<string, boolean>;
  deviceStartPolicies?: Record<string, DeviceStartPolicy>;
  deviceTargetPowerConfigs?: DeviceTargetPowerConfigsWithReachability;
};

/**
 * A {@link DeviceControlSettings} that has read these maps through its real
 * settings reader, over an in-memory store of its own. The temperature-command
 * policy resolves to "nothing disabled", the state a running app reaches.
 */
export const deviceControlSettingsFixture = (maps: DeviceControlSettingsFixture = {}): DeviceControlSettings => {
  const values = new Map<string, unknown>([[TEMPERATURE_CONTROL_DISABLED_DEVICES, {}]]);
  if (maps.controllableDevices) values.set(CONTROLLABLE_DEVICES, maps.controllableDevices);
  if (maps.managedDevices) values.set(MANAGED_DEVICES, maps.managedDevices);
  if (maps.deviceStartPolicies) values.set(DEVICE_START_POLICIES, maps.deviceStartPolicies);
  if (maps.deviceTargetPowerConfigs) {
    // Stored as the settings UI and the probe store them: the candidate configs
    // and the runtime-owned reachability under their own keys.
    const entries = Object.entries(maps.deviceTargetPowerConfigs);
    values.set(DEVICE_TARGET_POWER_CONFIGS, Object.fromEntries(
      entries.map(([deviceId, { reachability: _reachability, ...config }]) => [deviceId, config]),
    ));
    values.set(DEVICE_TARGET_POWER_REACHABILITY, Object.fromEntries(
      entries.flatMap(([deviceId, { reachability }]) => (reachability ? [[deviceId, reachability]] : [])),
    ));
  }
  const settings = new DeviceControlSettings({
    get: (key) => values.get(key) ?? null,
    getKeys: () => [...values.keys()],
  });
  settings.reload();
  return settings;
};
