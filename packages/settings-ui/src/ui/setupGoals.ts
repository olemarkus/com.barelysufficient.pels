import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { supportsTemperatureControlDevice, type SettingsUiDeviceListItem } from './deviceUtils.ts';
import { namePriceSource } from './afterSetupRecommendations.ts';
import { readAfterSetupFacts } from './afterSetupFacts.ts';
import { readHomeMembership } from './homeScope.ts';
import { keepPriceSchemeInForce } from './priceSettingsPersistence.ts';
import { readSetupRespondsToPrices } from './setupPathFacts.ts';
import { resolveSolarSetupAction, type SolarSetupAction } from './setupDevices.ts';
import { hasOpenSmartTask, resolveSurplusControlAvailable, state } from './state.ts';

/**
 * `Choose what PELS does`: the optional setup page between the limits and the
 * review. The required steps give PELS a meter and devices; this one gives it
 * something to do with them in a home that has no limit to hold, which is most
 * homes outside Norway and Belgium. Each managed device is offered the job that
 * fits it, through the control that already does it:
 *
 * - Price-based control for a device with a temperature target, while PELS
 *   responds to prices.
 * - A Smart task for an EV charger: charging by a ready-by time in the cheapest
 *   hours is the car's price behaviour.
 * - The device's solar action, once surplus can reach it, except in the solar
 *   setup, whose own page offered it already.
 *
 * A device with none of these is left out, and a home with none is not offered
 * the page. Nothing here is a completion requirement.
 */
export type SetupGoalChoice = {
  id: string;
  name: string;
  /** `source` names where the prices come from, when PELS already has them. */
  price: { enabled: boolean; source: string | null } | null;
  smartTask: 'open' | 'none' | null;
  solar: SolarSetupAction | null;
};

export type SetupGoalChoices =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; devices: readonly SetupGoalChoice[] };

export type SetupGoalContext = {
  respondsToPrices: boolean;
  priceSourceName: string | null;
  solarReady: boolean;
  solarJourney: boolean;
};

const resolveGoalChoice = (
  device: SettingsUiDeviceListItem,
  context: SetupGoalContext,
): SetupGoalChoice | null => {
  const price = context.respondsToPrices && supportsTemperatureControlDevice(device)
    ? { enabled: state.priceOptimizationSettings[device.id]?.enabled === true, source: context.priceSourceName }
    : null;
  let smartTask: SetupGoalChoice['smartTask'] = null;
  if (device.isEvCharger) smartTask = hasOpenSmartTask(device.id) ? 'open' : 'none';
  const solar = context.solarReady && !context.solarJourney ? resolveSolarSetupAction(device) : null;
  if (price === null && smartTask === null && solar === null) return null;
  return { id: device.id, name: formatDisplayDeviceName(device.name), price, smartTask, solar };
};

export const resolveSetupGoalChoices = (
  devices: readonly SettingsUiDeviceListItem[],
  context: SetupGoalContext,
): SetupGoalChoices => {
  const membership = readHomeMembership();
  if (!state.devicesLoaded || membership.state === 'loading') return { state: 'loading' };
  if (membership.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ready',
    devices: devices
      .filter((device) => state.managedMap[device.id] === true
        && (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID)
      .flatMap((device) => resolveGoalChoice(device, context) ?? []),
  };
};

const readPricedSource = () => {
  const read = readAfterSetupFacts();
  return read.state === 'resolved' && read.facts.priceSource.kind === 'priced' ? read.facts.priceSource : null;
};

/** The page's context as the settings UI holds it now. */
export const readSetupGoalContext = (solarJourney: boolean): SetupGoalContext => {
  const priced = readPricedSource();
  return {
    respondsToPrices: readSetupRespondsToPrices() === true,
    priceSourceName: priced ? namePriceSource(priced.scheme) : null,
    solarReady: resolveSurplusControlAvailable(),
    solarJourney,
  };
};

/**
 * Turning on Price-based control here also makes the source PELS assumed the
 * owner's, as the price suggestion's `Use these prices` does: the card named it,
 * and leaving it assumed would reopen setup on Prices the moment a device
 * follows them. A source PELS holds no prices from is left for the Prices step.
 */
export const keepAssumedPriceSource = async (): Promise<void> => {
  const priced = readPricedSource();
  if (priced && !priced.chosen) await keepPriceSchemeInForce(priced.scheme);
};

/** Whether any managed device has a job to choose; a read still loading offers nothing yet. */
export const offersSetupGoals = (solarJourney: boolean): boolean => {
  const choices = resolveSetupGoalChoices(state.latestDevices, readSetupGoalContext(solarJourney));
  return choices.state === 'ready' && choices.devices.length > 0;
};
