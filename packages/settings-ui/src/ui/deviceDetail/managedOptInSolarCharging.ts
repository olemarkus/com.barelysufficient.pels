import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { resolveSolarProductionReadable, state } from '../state.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import { isSurplusTrackingDeviceShape } from './solarSurplusTracking.ts';
import { savePriceOptimizationPatch, SURPLUS_ONLY_PRICE_OPTIMIZATION_CONFIG } from './priceOptimizationPatch.ts';

/**
 * Turning Managed on for an EV charger in a home with solar also turns on
 * "Charge on solar surplus" and "Charge from the grid when the panels stop".
 *
 * Exported solar earns little once net metering ends, so the car should take
 * the sun when there is some and charge as usual when there is none. Both
 * switches together say exactly that, and neither alone does: surplus alone
 * leaves a car plugged in at night waiting for a sun that is not coming, and
 * neither charges a car plugged in at noon from the grid while the panels
 * export.
 *
 * Only where PELS can see the panels' production (a solar device in Homey). A
 * home that shows solar only through its meter's export never tells PELS the
 * panels have stopped, so there the pair would leave the car waiting every
 * night.
 *
 * Only a charger with no saved entry for these switches gets them, and only
 * once the saved map has loaded: an unread map has no entries to protect, and
 * writing into it would replace every other device's. An entry means the owner
 * has made a solar or price choice for this device already, and this is a
 * default, never a correction. The charger must also be one the "Charge on
 * solar surplus" switch is offered for (managed, with a step ladder or an EV
 * preset), or the switch would sit on with nothing to show for it.
 */
export type ManagedOptInSolarCharging = 'enable' | 'leave';

export const resolveManagedOptInSolarCharging = (device: SettingsUiDeviceDetailItem): ManagedOptInSolarCharging => {
  if (!state.priceOptimizationSettingsLoaded || !resolveSolarProductionReadable()) return 'leave';
  if (device.isEvCharger !== true) return 'leave';
  if (Object.hasOwn(state.priceOptimizationSettings, device.id)) return 'leave';
  return isSurplusTrackingDeviceShape(device, resolveDeviceDetailControlState(device, device.id))
    ? 'enable'
    : 'leave';
};

/**
 * Apply `resolveManagedOptInSolarCharging` after the owner turned Managed on,
 * with the same write the charger page's switches make. Called after the
 * control mode and Limit writes, which the charger's eligibility depends on.
 * `isStillWanted` is the caller's Managed-intent check, asked again right
 * before the write.
 */
export async function applyManagedOptInSolarCharging(
  deviceId: string,
  refresh: () => void,
  isStillWanted: () => boolean,
): Promise<void> {
  const device = state.latestDevices.find((entry) => entry.id === deviceId);
  if (!device || !isStillWanted() || resolveManagedOptInSolarCharging(device) === 'leave') return;
  if (await savePriceOptimizationPatch(
    deviceId,
    { surplusWilling: true, gridWhenPanelsStop: true },
    SURPLUS_ONLY_PRICE_OPTIMIZATION_CONFIG,
    'Failed to turn on solar charging',
    refresh,
  )) refresh();
}
