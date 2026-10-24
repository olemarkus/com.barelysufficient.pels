import {
  resolveSetpointShedLimitRecommendations,
  resolveSmartTaskStartPolicyRecommendations,
  type SetupRecommendation,
} from './recommendationsModel.ts';
import { readSmartTaskUsageDeviceIds } from './smartTaskUsage.ts';
import { state } from './state.ts';

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
      state.modeTargets[state.activeMode] ?? {},
    )
    : []),
];
