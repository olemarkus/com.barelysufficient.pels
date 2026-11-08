import {
  resolveBatteryApiKeyRecommendations,
  resolveSetpointShedLimitRecommendations,
  resolveSmartTaskStartPolicyRecommendations,
  type SetupRecommendation,
} from './recommendationsModel.ts';
import { readSmartTaskUsageDeviceIds } from './smartTaskUsage.ts';
import { resolveManagedState, state } from './state.ts';

/** Suggestions about a device's own settings, from the setting maps the settings UI holds. */
export const resolveDeviceSettingRecommendations = (): SetupRecommendation[] => [
  ...resolveSmartTaskStartPolicyRecommendations(
    state.latestDevices,
    state.managedMap,
    state.controllableMap,
    state.deviceStartPolicyMap,
    readSmartTaskUsageDeviceIds(),
  ),
  // Both maps start empty, which reads as "nothing limited, nothing saved".
  ...(state.deviceSettingMapsLoaded && state.shedBehaviorsLoaded
    ? resolveSetpointShedLimitRecommendations(
      state.latestDevices,
      state.managedMap,
      state.controllableMap,
      state.shedBehaviors,
    )
    : []),
  // A battery's Managed switch is its own setting, so `managedMap` does not hold it.
  ...resolveBatteryApiKeyRecommendations(state.latestDevices.filter(({ id }) => resolveManagedState(id))),
];
