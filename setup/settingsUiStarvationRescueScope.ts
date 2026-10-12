import type { StarvationRescueHostApi } from '../packages/contracts/src/widgetHostApi';
import { resolveRescuableDeviceFromList } from '../packages/shared-domain/src/starvationRescueShared';

// Resolve the requested device against the live starved list, after the
// device's home scope: a rescue is a Main-home smart task.
export const resolveRescuableSettingsDevice = (
  host: StarvationRescueHostApi,
  deviceId: string,
) => {
  const scope = host.resolveSmartTaskHomeScope(deviceId);
  if (scope === 'sub_home') {
    return { ok: false as const, reason: 'device_in_sub_home' as const };
  }
  if (scope === 'source_device') {
    return { ok: false as const, reason: 'device_not_planned' as const };
  }
  if (scope === 'unavailable') {
    return { ok: false as const, reason: 'unavailable' as const };
  }
  return resolveRescuableDeviceFromList(host.getStarvedRescueDevices(), deviceId);
};
