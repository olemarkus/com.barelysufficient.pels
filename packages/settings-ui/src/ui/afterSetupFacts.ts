import type { PriceOptimizationSetup } from '../../../contracts/src/priceOptimizationSettings.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { supportsSmartTaskKind } from '../../../shared-domain/src/smartTaskDeviceKind.ts';
import type { NorwayPriceSetup, SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import type { AfterSetupDevice, AfterSetupFacts, AfterSetupPriceSource } from './afterSetupRecommendations.ts';
import { hasLoadedDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { supportsPowerDevice, supportsTemperatureControlDevice } from './deviceUtils.ts';
import { logSettingsError } from './logging.ts';
import { loadPriceSetupSuggestion } from './priceSetupOffer.ts';
import { getPricesReadModel } from './prices.ts';
import { readHomeMembership, type HomeMembershipRead } from './homeScope.ts';
import { isBelgianHomeOnHourlyPeriod, readSetupMarket, readSetupPath } from './setupPathFacts.ts';
import { state } from './state.ts';

type PriceSetupState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; setup: PriceOptimizationSetup; priceSource: AfterSetupPriceSource };

// Prices PELS can show are prices it can classify, so a ready level summary is
// the producer's own word that the source in force has delivered some. A source
// PELS fell back to without knowing where the hub is (`default`) is no answer
// to offer: Electricity prices asks that owner to choose, and so does this.
// Nor is the Norway source while a Norway setting is still assumed: keeping
// the source alone would leave the setup path's Prices step open.
const isNorwaySetupChosen = ({ gridCompany, priceArea, pricingModel }: NorwayPriceSetup): boolean => (
  gridCompany.kind === 'chosen' && priceArea.chosen && pricingModel.chosen
);

export const resolvePriceSource = (
  payload: Pick<SettingsUiPricesPayload, 'priceSetup' | 'priceLevelSummary'>,
): AfterSetupPriceSource => {
  const { priceSetup, priceLevelSummary } = payload;
  if (priceSetup.state !== 'resolved' || priceLevelSummary.state !== 'ready') return { kind: 'needs_setup' };
  const { source, norway } = priceSetup.setup;
  if (source.basis.kind === 'default') return { kind: 'needs_setup' };
  if (source.scheme === 'norway' && !isNorwaySetupChosen(norway)) return { kind: 'needs_setup' };
  return { kind: 'priced', scheme: source.scheme, chosen: source.basis.kind === 'chosen' };
};

/**
 * Homey Energy PELS assumed, while Power by the Hour has a price device, is a
 * choice between two sources rather than one to keep. Asked only then: the
 * answer is an app-to-app read, and a failed one is no offer.
 */
export const offerPowerhour = async (source: AfterSetupPriceSource): Promise<AfterSetupPriceSource> => {
  if (source.kind !== 'priced' || source.scheme !== 'homey' || source.chosen) return source;
  const suggestion = await loadPriceSetupSuggestion();
  return suggestion.powerhour.kind === 'has_price_device' ? { kind: 'powerhour_offered' } : source;
};

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
    const payload = await getPricesReadModel();
    const read = payload.priceOptimizationSetup;
    if (generation !== priceSetupLoadGeneration) return;
    if (read.state === 'resolved') {
      const priceSource = await offerPowerhour(resolvePriceSource(payload));
      if (generation !== priceSetupLoadGeneration) return;
      priceSetupState = { state: 'ready', setup: read.setup, priceSource };
    }
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
    .filter((device) => (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID)
    .filter((device) => state.managedMap[device.id] === true)
    .map((device) => {
      const temperature = supportsTemperatureControlDevice(device);
      return {
        temperature,
        limitable: supportsPowerDevice(device) && state.controllableMap[device.id] === true,
        taskCapable: temperature || device.isEvCharger || supportsSmartTaskKind(device, 'energy'),
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
      priceSource: priceSetupState.priceSource,
      solarSurplusAvailable: state.surplusPoolReachable
        && (state.hasManagedSolarDevice || state.hasExhibitedExport),
      market: readSetupMarket(),
      belgianHomeOnHourlyPeriod: isBelgianHomeOnHourlyPeriod(),
      smartTaskConfigured: Object.keys(state.deferredObjectiveSettings.objectivesByDeviceId).length > 0,
    },
  };
};
