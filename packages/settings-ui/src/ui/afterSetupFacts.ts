import type { PriceOptimizationSetup } from '../../../contracts/src/priceOptimizationSettings.ts';
import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import type { AfterSetupDevice, AfterSetupFacts } from './afterSetupRecommendations.ts';
import { hasLoadedDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { supportsPowerDevice, supportsTemperatureControlDevice } from './deviceUtils.ts';
import { logSettingsError } from './logging.ts';
import { getPricesReadModel } from './prices.ts';
import { readHomeMembership, type HomeMembershipRead } from './homeScope.ts';
import { isBelgianHomeOnHourlyPeriod, readSetupMarket, readSetupPath } from './setupPathFacts.ts';
import { state } from './state.ts';

type PriceSetupState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; setup: PriceOptimizationSetup };

export type AfterSetupFactsRead =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'resolved'; facts: AfterSetupFacts };

let priceSetupState: PriceSetupState = { state: 'loading' };
let priceSetupLoadGeneration = 0;

/**
 * Load producer-classified price facts. An unavailable response is a no-op:
 * keep the last good value, or keep waiting if none has ever arrived.
 */
export const loadAfterSetupFacts = async (): Promise<void> => {
  priceSetupLoadGeneration += 1;
  const generation = priceSetupLoadGeneration;
  try {
    const read = (await getPricesReadModel()).priceOptimizationSetup;
    if (generation !== priceSetupLoadGeneration) return;
    if (read.state === 'resolved') priceSetupState = { state: 'ready', setup: read.setup };
    else if (priceSetupState.state !== 'ready') priceSetupState = { state: 'unavailable' };
  } catch (error) {
    await logSettingsError('Failed to read price settings for suggestions', error, 'setup recommendations');
    if (generation === priceSetupLoadGeneration && priceSetupState.state !== 'ready') {
      priceSetupState = { state: 'unavailable' };
    }
  }
};

type ResolvedHomeMembership = Extract<HomeMembershipRead, { state: 'resolved' }>;

const resolveDevices = (
  setup: PriceOptimizationSetup,
  membership: ResolvedHomeMembership,
): AfterSetupDevice[] => {
  const configuredDeviceIds = new Set(setup.configuredDeviceIds);
  const solarSurplusDeviceIds = new Set(setup.solarSurplusDeviceIds);
  return state.latestDevices
    .filter((device) => !membership.runtimeActive
      || (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID)
    .filter((device) => state.managedMap[device.id] === true)
    .map((device) => {
      const temperature = supportsTemperatureControlDevice(device);
      return {
        temperature,
        limitable: supportsPowerDevice(device) && state.controllableMap[device.id] === true,
        taskCapable: temperature || device.deviceClass === 'evcharger',
        priceConfigured: configuredDeviceIds.has(device.id),
        usesSolarSurplus: solarSurplusDeviceIds.has(device.id),
      };
    });
};

export const readAfterSetupFacts = (): AfterSetupFactsRead => {
  const setupPath = readSetupPath();
  const membership = readHomeMembership();
  if (setupPath.state === 'loading' || !state.devicesLoaded || priceSetupState.state === 'loading'
    || membership.state === 'loading' || !hasLoadedDeferredObjectiveSettings()) return { state: 'loading' };
  if (setupPath.state === 'unavailable' || priceSetupState.state === 'unavailable'
    || membership.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'resolved',
    facts: {
      setupComplete: setupPath.state === 'complete',
      devices: resolveDevices(priceSetupState.setup, membership),
      priceOptimizationEnabled: priceSetupState.setup.enabled,
      solarSurplusAvailable: state.surplusPoolReachable
        && (state.hasManagedSolarDevice || state.hasExhibitedExport),
      market: readSetupMarket(),
      belgianHomeOnHourlyPeriod: isBelgianHomeOnHourlyPeriod(),
      smartTaskConfigured: Object.keys(state.deferredObjectiveSettings.objectivesByDeviceId).length > 0,
    },
  };
};
