import { supportsTemperatureAdjustments } from './deviceDetail/temperaturePolicy.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { resolveDefaultSmartTaskKind } from '../../../shared-domain/src/smartTaskDeviceKind.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { namePriceSource } from './afterSetupRecommendations.ts';
import { readAfterSetupFacts } from './afterSetupFacts.ts';
import { isSmartTaskCapable, readMainHomeManagedDevices } from './mainHomeDevices.ts';
import { keepPriceSchemeInForce } from './priceSettingsPersistence.ts';
import { readSetupRespondsToPrices } from './setupPathFacts.ts';
import { resolveSolarSetupAction, type SolarSetupAction } from './setupDevices.ts';
import { resolveSetupBatteryGoal, type SetupBatteryGoal } from './setupBatteryPlan.ts';
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
 * - A Smart task for a device that can carry one: a goal by a ready-by time in
 *   the cheapest hours, which for a car is its price behaviour.
 * - The device's solar action, once surplus can reach it.
 * - A home battery's plan (Plan charging with PELS), with the usable capacity
 *   it needs (`setupBatteryPlan.ts`).
 *
 * It is the one place for these: the after-setup suggestion and Review lead
 * here rather than offering them again.
 *
 * A managed relay without live power can explain what it needs. Nothing here
 * is a completion requirement.
 */
export type SetupGoalChoice = {
  id: string;
  name: string;
  price: { enabled: boolean } | null;
  /** The open task in one line, or none yet (`charger` picks the copy); `null` for a device that takes no task. */
  smartTask: { state: 'open'; summary: string } | { state: 'none'; charger: boolean } | null;
  solar: SolarSetupAction | null;
  /** A home battery's plan; `null` for any other device. */
  battery: SetupBatteryGoal | null;
  /** Explains the power-reading prerequisite for a relay with no setup action. */
  noGoalReason: 'needs_live_power' | null;
};

export type SetupGoalChoices =
  | { state: 'loading' | 'unavailable' }
  /** `priceSource` names where the prices come from, when PELS already has them. */
  | { state: 'ready'; priceSource: string | null; devices: readonly SetupGoalChoice[]; hasActions: boolean };

const resolveSmartTask = (device: SettingsUiDeviceListItem): SetupGoalChoice['smartTask'] => {
  if (!isSmartTaskCapable(device)) return null;
  const entry = state.deferredObjectiveSettings.objectivesByDeviceId[device.id];
  return entry !== undefined && hasOpenSmartTask(device.id)
    ? { state: 'open', summary: formatOpenSmartTaskLine(entry) }
    : { state: 'none', charger: device.isEvCharger };
};

const readPricedSource = () => {
  const read = readAfterSetupFacts();
  return read.state === 'resolved' && read.facts.priceSource.kind === 'priced' ? read.facts.priceSource : null;
};

export const resolveSetupGoalChoices = (): SetupGoalChoices => {
  const managed = readMainHomeManagedDevices();
  if (managed.state !== 'ready') return managed;
  const respondsToPrices = readSetupRespondsToPrices() === true;
  const solarReady = resolveSurplusControlAvailable();
  const priced = readPricedSource();
  const devices = managed.devices.flatMap((device): SetupGoalChoice[] => {
    const price = respondsToPrices && supportsTemperatureAdjustments(device)
      ? { enabled: state.priceOptimizationSettings[device.id]?.enabled === true }
      : null;
    const smartTask = resolveSmartTask(device);
    const solar = solarReady ? resolveSolarSetupAction(device) : null;
    const battery = resolveSetupBatteryGoal(device);
    let noGoalReason: SetupGoalChoice['noGoalReason'] = null;
    if (!price && !smartTask && !solar && !battery) {
      if (resolveDefaultSmartTaskKind(device) !== 'energy') return [];
      noGoalReason = 'needs_live_power';
    }
    return [{
      id: device.id, name: formatDisplayDeviceName(device.name), price, smartTask, solar, battery, noGoalReason,
    }];
  });
  return {
    state: 'ready',
    hasActions: devices.some((device) => device.noGoalReason === null),
    priceSource: priced ? namePriceSource(priced.scheme) : null,
    devices,
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
