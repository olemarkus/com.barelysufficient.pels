import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { supportsTemperatureControlDevice, type SettingsUiDeviceListItem } from './deviceUtils.ts';
import { namePriceSource } from './afterSetupRecommendations.ts';
import { readAfterSetupFacts } from './afterSetupFacts.ts';
import { readMainHomeManagedDevices } from './mainHomeDevices.ts';
import { keepPriceSchemeInForce } from './priceSettingsPersistence.ts';
import { isSolarSetupJourney } from './setupJourneyState.ts';
import { readSetupRespondsToPrices } from './setupPathFacts.ts';
import { resolveSolarSetupAction, type SolarSetupAction } from './setupDevices.ts';
import { formatOpenSmartTaskLine } from './smartTaskSummary.ts';
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
  price: { enabled: boolean } | null;
  /** The open task in one line, or none yet; `null` for a device that takes no task here. */
  smartTask: { state: 'open'; summary: string } | { state: 'none' } | null;
  solar: SolarSetupAction | null;
};

export type SetupGoalChoices =
  | { state: 'loading' | 'unavailable' }
  /** `priceSource` names where the prices come from, when PELS already has them. */
  | { state: 'ready'; priceSource: string | null; devices: readonly SetupGoalChoice[] };

const resolveSmartTask = (device: SettingsUiDeviceListItem): SetupGoalChoice['smartTask'] => {
  if (!device.isEvCharger) return null;
  const entry = state.deferredObjectiveSettings.objectivesByDeviceId[device.id];
  return entry !== undefined && hasOpenSmartTask(device.id)
    ? { state: 'open', summary: formatOpenSmartTaskLine(entry) }
    : { state: 'none' };
};

const readPricedSource = () => {
  const read = readAfterSetupFacts();
  return read.state === 'resolved' && read.facts.priceSource.kind === 'priced' ? read.facts.priceSource : null;
};

export const resolveSetupGoalChoices = (): SetupGoalChoices => {
  const managed = readMainHomeManagedDevices();
  if (managed.state !== 'ready') return managed;
  const respondsToPrices = readSetupRespondsToPrices() === true;
  const solarReady = resolveSurplusControlAvailable() && !isSolarSetupJourney();
  const priced = readPricedSource();
  return {
    state: 'ready',
    priceSource: priced ? namePriceSource(priced.scheme) : null,
    devices: managed.devices.flatMap((device) => {
      const price = respondsToPrices && supportsTemperatureControlDevice(device)
        ? { enabled: state.priceOptimizationSettings[device.id]?.enabled === true }
        : null;
      const smartTask = resolveSmartTask(device);
      const solar = solarReady ? resolveSolarSetupAction(device) : null;
      if (price === null && smartTask === null && solar === null) return [];
      return [{ id: device.id, name: formatDisplayDeviceName(device.name), price, smartTask, solar }];
    }),
  };
};

/**
 * Turning on Price-based control or saving a Smart task here also makes the
 * source PELS assumed the owner's, as the price suggestion's `Use these prices`
 * does: the page named it, and leaving it assumed would reopen setup on Prices
 * the moment a device uses them. A source PELS holds no prices from is left for
 * the Prices step.
 */
export const keepAssumedPriceSource = async (): Promise<void> => {
  const priced = readPricedSource();
  if (priced && !priced.chosen) await keepPriceSchemeInForce(priced.scheme);
};

/** Whether any managed device has a job to choose; a read still loading offers nothing yet. */
export const offersSetupGoals = (): boolean => {
  const choices = resolveSetupGoalChoices();
  return choices.state === 'ready' && choices.devices.length > 0;
};
