import type { SmartTaskHomeScope } from '../packages/contracts/src/smartTaskHomeScope';
import type { StarvationRescueDevice } from '../packages/contracts/src/starvationRescue';
import { resolveRescuableDeviceFromList } from '../packages/shared-domain/src/starvationRescueShared';

export type SettingsUiStarvationRescueScope = {
  getStarvedRescueDevices?: () => StarvationRescueDevice[];
  resolveSmartTaskHomeScope?: (deviceId: string) => SmartTaskHomeScope;
};

// Resolve the requested device against the live starved list. The app surface
// is optional during restart; absence maps to the shared unavailable state.
export const resolveRescuableSettingsDevice = (
  app: SettingsUiStarvationRescueScope | null,
  deviceId: string,
) => {
  if (typeof app?.resolveSmartTaskHomeScope !== 'function') {
    return { ok: false as const, reason: 'unavailable' as const };
  }
  const scope = app.resolveSmartTaskHomeScope(deviceId);
  if (scope === 'sub_home') {
    return { ok: false as const, reason: 'device_in_sub_home' as const };
  }
  if (scope === 'unavailable') {
    return { ok: false as const, reason: 'unavailable' as const };
  }
  const devices = typeof app.getStarvedRescueDevices === 'function' ? app.getStarvedRescueDevices() : null;
  return resolveRescuableDeviceFromList(devices, deviceId);
};
