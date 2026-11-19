import { supportsTemperatureAdjustments } from './deviceDetail/temperaturePolicy.ts';
import { supportsSmartTaskKind } from '../../../shared-domain/src/smartTaskDeviceKind.ts';
import { readDailyDiagnosticsReportEnabled } from '../../../shared-domain/src/settings/dailyDiagnosticsReport.ts';
import { DAILY_DIAGNOSTICS_REPORT } from '../../../shared-domain/src/settings/settingsKeys.ts';
import type { PriceOptimizationSetup } from '../../../contracts/src/priceOptimizationSettings.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import type { NorwayPriceSetup, SettingsUiPricesPayload } from '../../../contracts/src/settingsUi/prices.ts';
import type { AfterSetupDevice, AfterSetupFacts, AfterSetupPriceSource } from './afterSetupRecommendations.ts';
import { hasLoadedDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { supportsPowerDevice } from './deviceUtils.ts';
import { getSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { isSmartTaskCapable, readMainHomeManagedDevices } from './mainHomeDevices.ts';
import { loadPriceSetupSuggestion } from './priceSetupOffer.ts';
import { readExportPriced } from './priceTimelineRead.ts';
import { getPricesReadModel } from './prices.ts';
import {
  isBelgianHomeOnHourlyPeriod, isSetupDeviceLimitable, readSetupMarket, readSetupPath, readSetupRespondsToPrices,
} from './setupPathFacts.ts';
import { resolveHomeExhibitsSolar, resolveSurplusControlAvailable, state } from './state.ts';

type PriceSetupState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | {
    state: 'ready'; setup: PriceOptimizationSetup;
    /** Whether the published prices hold an export price; `null` while they are not ready. */
    exportPriced: boolean | null;
  };

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
  | { state: 'resolved'; facts: AfterSetupFacts; checksIncomplete?: boolean; checksPending?: boolean };

let priceSetupState: PriceSetupState = { state: 'loading' };
// The goals page names the last accepted source. Its Keep action checks that
// this source is still in force before saving it, even after a failed refresh.
let acceptedPriceSource: AfterSetupPriceSource = { kind: 'needs_setup' };
let priceSetupLoadGeneration = 0;
let dailyReportReadGeneration = 0;
/** Only a successful read may invite the owner to turn on reporting. */
let dailyDiagnosticsReportEnabled: boolean | 'loading' | 'unavailable' = 'loading';

export const loadDailyDiagnosticsReport = async (): Promise<void> => {
  const generation = ++dailyReportReadGeneration;
  try {
    const enabled = readDailyDiagnosticsReportEnabled(await getSetting(DAILY_DIAGNOSTICS_REPORT));
    if (generation === dailyReportReadGeneration) dailyDiagnosticsReportEnabled = enabled;
  } catch (error) {
    if (generation !== dailyReportReadGeneration) return;
    dailyDiagnosticsReportEnabled = 'unavailable';
    await logSettingsError('Failed to read the daily report setting for suggestions', error, 'setup recommendations');
  }
};

export const loadAfterSetupFacts = async (): Promise<void> => {
  await Promise.all([loadPriceSetupFacts(), loadDailyDiagnosticsReport()]);
};

const loadPriceSetupFacts = async (): Promise<void> => {
  priceSetupLoadGeneration += 1;
  const generation = priceSetupLoadGeneration;
  try {
    const payload = await getPricesReadModel();
    const read = payload.priceOptimizationSetup;
    if (generation !== priceSetupLoadGeneration) return;
    if (payload.priceSetup.state === 'resolved') {
      const source = await offerPowerhour(resolvePriceSource(payload));
      if (generation !== priceSetupLoadGeneration) return;
      acceptedPriceSource = source;
    }
    priceSetupState = read.state === 'resolved'
      ? { state: 'ready', setup: read.setup, exportPriced: readExportPriced(payload) }
      : { state: 'unavailable' };
  } catch (error) {
    if (generation !== priceSetupLoadGeneration) return;
    priceSetupState = { state: 'unavailable' };
    await logSettingsError('Failed to read price settings for suggestions', error, 'setup recommendations');
  }
};

const resolveDevices = (
  setup: PriceOptimizationSetup | undefined,
  managed: readonly SettingsUiDeviceListItem[],
): AfterSetupDevice[] => {
  const configuredDeviceIds = new Set(setup?.configuredDeviceIds);
  const solarSurplusDeviceIds = new Set(setup?.solarSurplusDeviceIds);
  return managed.map((device) => ({
    temperature: supportsTemperatureAdjustments(device),
    limitable: supportsPowerDevice(device) && isSetupDeviceLimitable(device.id),
    taskCapable: isSmartTaskCapable(device),
    heatsWaterOnTask: device.deviceClass === 'waterheater' || supportsSmartTaskKind(device, 'energy'),
    priceConfigured: configuredDeviceIds.has(device.id),
    usesSolarSurplus: solarSurplusDeviceIds.has(device.id),
  }));
};

const hasIncompleteChecks = (setupComplete: boolean, tasksKnown: boolean): boolean => (
  priceSetupState.state !== 'ready' || readSetupRespondsToPrices() === null
  || (setupComplete && (!tasksKnown || dailyDiagnosticsReportEnabled === 'unavailable'))
);

export const readAfterSetupFacts = (): AfterSetupFactsRead => {
  const setupPath = readSetupPath();
  const managed = readMainHomeManagedDevices();
  if (setupPath.state === 'loading' || managed.state === 'loading' || priceSetupState.state === 'loading') {
    return { state: 'loading' };
  }
  if (setupPath.state === 'unavailable' || managed.state !== 'ready') return { state: 'unavailable' };
  const price = priceSetupState.state === 'ready' ? priceSetupState : undefined;
  const setupComplete = setupPath.state === 'complete';
  const tasksKnown = hasLoadedDeferredObjectiveSettings();
  return {
    state: 'resolved',
    checksIncomplete: hasIncompleteChecks(setupComplete, tasksKnown),
    checksPending: setupComplete && dailyDiagnosticsReportEnabled === 'loading',
    facts: {
      setupComplete,
      devices: resolveDevices(price?.setup, managed.devices),
      priceOptimizationEnabled: price?.setup.enabled === true,
      priceSource: acceptedPriceSource,
      solarSurplusAvailable: price !== undefined && resolveSurplusControlAvailable(),
      market: readSetupMarket(),
      belgianHomeOnHourlyPeriod: isBelgianHomeOnHourlyPeriod(),
      solarExportUnpriced: resolveHomeExhibitsSolar() && price?.exportPriced === false,
      smartTaskConfigured: tasksKnown
        ? Object.keys(state.deferredObjectiveSettings.objectivesByDeviceId).length > 0 : null,
      dailyDiagnosticsReportOff: dailyDiagnosticsReportEnabled === false,
    },
  };
};
