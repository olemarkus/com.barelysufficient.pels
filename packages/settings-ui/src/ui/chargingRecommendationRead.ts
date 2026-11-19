import { chargingRecommendations } from './chargingRecommendations.ts';
import { loadChargingSetup } from './chargingSetupFacts.ts';
import type { SettingsUiDeviceDetailItem } from './deviceUtils.ts';
import { resolveAutomaticChargingControlRecommendations, type SetupRecommendation } from './recommendationsModel.ts';
import { state } from './state.ts';

let currentChargingRecommendations: SetupRecommendation[] = [];
let chargingReadGeneration = 0;
let chargingReadAt = 0;
let chargingStatus: 'loading' | 'resolved' | 'unavailable' = 'loading';
const needsChargingRead = (): boolean => state.latestDevices.some((device) => (
  device.isEvCharger && state.managedMap[device.id] === true
));
export async function loadChargingRecommendations(onChange: () => void, force = false): Promise<void> {
  if (!needsChargingRead()) return;
  if (!force && Date.now() - chargingReadAt < 30_000) return;
  chargingReadAt = Date.now();
  const generation = ++chargingReadGeneration;
  try {
    const { devices, access } = await loadChargingSetup();
    if (generation !== chargingReadGeneration) return;
    chargingStatus = 'resolved';
    currentChargingRecommendations = chargingRecommendations(devices, access);
    onChange();
  } catch {
    // Keep the failed check visible and retryable. Its old actions may now be obsolete.
    if (generation !== chargingReadGeneration) return;
    chargingReadAt = 0;
    chargingStatus = 'unavailable';
    onChange();
  }
}

export const chargingRecommendationStatus = () => needsChargingRead() ? chargingStatus : 'resolved';

export const currentChargingAdvice = (managed: readonly SettingsUiDeviceDetailItem[]): SetupRecommendation[] => {
  const verified = chargingStatus === 'resolved' ? currentChargingRecommendations : [];
  const automaticRecommendations = state.devicePowerControlModesLoaded
    ? resolveAutomaticChargingControlRecommendations(managed, state.devicePowerControlModes)
    : [];
  const automaticReviewDeviceIds = new Set(automaticRecommendations.flatMap(({ target }) => (
    target.kind === 'device-control-model' ? [target.deviceId] : []
  )));
  return [
    ...verified.filter(({ id, target }) => target.kind === 'device'
      && managed.some((device) => device.id === target.deviceId
        && device.automaticPowerControl?.mode !== 'automatic')
      // Manual still owns real Flow conflicts; only onboarding competes with
      // the recommendation to review the replacement Automatic route.
      && !(id.startsWith('charging-setup:') && automaticReviewDeviceIds.has(target.deviceId))),
    ...automaticRecommendations,
  ];
};
