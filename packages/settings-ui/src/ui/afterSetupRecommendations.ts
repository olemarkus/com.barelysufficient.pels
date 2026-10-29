import type { PriceSchemeSetting, SettingsUiHubMarketRead } from '../../../contracts/src/settingsUiApi.ts';
import type { SetupRecommendation } from './recommendationsModel.ts';

/**
 * Optional features appear after first-run setup, using accepted facts from
 * this home. Flemish period advice also appears during setup and shares the
 * same dismissible recommendation on both surfaces.
 */

/** A managed device, reduced to what decides whether a suggestion applies. */
export type AfterSetupDevice = {
  /** Has a temperature target: the only kind Price can act on. */
  temperature: boolean;
  /** Has Limit on, so PELS may command it (solar surplus needs that). */
  limitable: boolean;
  /** Could take a temperature, charging or supported relay energy task. */
  taskCapable: boolean;
  /** The owner made an explicit per-device Price choice, including Off. */
  priceConfigured: boolean;
  usesSolarSurplus: boolean;
};

/**
 * Where the home's prices come from, as far as the price suggestions need it:
 * `priced` when PELS holds prices from the source in force and nothing but
 * choosing that source is left to set up, and whether the owner chose it;
 * `powerhour_offered` when that source is Homey Energy, assumed, while Power by
 * the Hour has a price device that could price the home instead; `needs_setup`
 * when it holds none yet, or the source still needs settings only the prices
 * page asks for.
 */
export type AfterSetupPriceSource =
  | { kind: 'priced'; scheme: PriceSchemeSetting; chosen: boolean }
  | { kind: 'powerhour_offered' }
  | { kind: 'needs_setup' };

export type AfterSetupFacts = {
  setupComplete: boolean;
  /** Managed devices only; their Price and solar flags come from the price settings. */
  devices: readonly AfterSetupDevice[];
  /** Producer-resolved global owner choice; explicit Off suppresses the Price suggestion. */
  priceOptimizationEnabled: boolean;
  priceSource: AfterSetupPriceSource;
  /**
   * The home has solar AND the surplus engine can act on it. Both: a home with
   * panels but a pool the runtime declines would be offered a toggle that
   * cannot engage. "Has solar" includes a zero-export home that curtails.
   */
  solarSurplusAvailable: boolean;
  smartTaskConfigured: boolean;
  /** Where the hub is, from geography alone. `unavailable` = the neutral order. */
  market: SettingsUiHubMarketRead;
  /**
   * A Belgian home holding an HOURLY average. Flanders bills the 15-minute
   * peak; the rest of Belgium has no such tariff, and a country code cannot
   * tell them apart.
   */
  belgianHomeOnHourlyPeriod: boolean;
};

const VERSION = 1;

/**
 * The one silent way to get capacity control wrong: a Flemish home left on the
 * hourly default protects an average its tariff does not bill. It cannot sit on
 * the setup path, because that step closes the moment a cap is saved, which is
 * exactly when the mistake becomes invisible.
 *
 * A real recommendation, not an optional feature, and deliberately a QUESTION:
 * the country says Belgium, only the owner knows whether that means Flanders.
 * Dismiss is a Walloon or Brussels owner saying it does not apply.
 */
const FLANDERS_PERIOD: SetupRecommendation = {
  id: 'market:flanders-capacity-period',
  version: VERSION,
  category: 'recommendation',
  title: 'Check your capacity period',
  body: 'In Flanders? Use the 15-minute average for measured peaks.',
  actionLabel: 'Use 15-minute average',
  target: { kind: 'quarter-hour' },
};

const suggestion = (
  id: string,
  copy: Pick<SetupRecommendation, 'title' | 'body' | 'actionLabel' | 'guideLink'>,
  target: SetupRecommendation['target'],
): SetupRecommendation => ({
  id: `after-setup:${id}`,
  version: VERSION,
  category: 'optional',
  ...copy,
  target,
});

const panel = (panelId: string): SetupRecommendation['target'] => ({ kind: 'panel', panelId });

const PRICES_TITLE = 'Heat in cheap hours';

const PRICE_SOURCE_NAMES: Record<PriceSchemeSetting, string> = {
  norway: 'the Norway source',
  homey: 'Homey Energy',
  powerhour: 'Power by the Hour',
  flow: 'your Flow',
};

/** How a price source is named in a sentence, as the price suggestion names it. */
export const namePriceSource = (scheme: PriceSchemeSetting): string => PRICE_SOURCE_NAMES[scheme];

/**
 * Prices are rarely what is missing: outside Norway PELS assumes a source that
 * already has them. So the suggestion says they are there and goes straight to
 * the devices. While the owner has not chosen that source, its button makes it
 * theirs first, or the setup path would reopen on Prices the moment a device
 * follows them. A home PELS holds no prices for, whose source needs more than
 * that choice, or that has two sources to choose between, is sent to set them up.
 * The car is the Smart task suggestion's: Price acts on temperature targets.
 */
const resolvePricesSuggestion = (source: AfterSetupPriceSource): SetupRecommendation => {
  if (source.kind !== 'priced') return suggestion('prices', {
    title: PRICES_TITLE,
    body: 'PELS can raise the temperature a little in cheap hours and lower it in expensive ones, so heating '
      + 'and hot water run when power costs least. Choose where your prices come from, then turn on Price '
      + 'for the devices that should follow them.',
    actionLabel: 'Set up prices',
  }, panel('electricity-prices'));
  const body = `PELS already has your prices from ${PRICE_SOURCE_NAMES[source.scheme]}. Turn on Price for your `
    + 'heating and hot water so they heat more in cheap hours.';
  return source.chosen
    ? suggestion('prices', { title: PRICES_TITLE, body, actionLabel: 'Choose devices' }, panel('devices'))
    : suggestion(
      'prices',
      { title: PRICES_TITLE, body, actionLabel: 'Use these prices' },
      { kind: 'keep-price-source', scheme: source.scheme },
    );
};

// True of both kinds of solar home this applies to: one that exports, and a
// zero-export home whose inverter throttles what it cannot use. Neither "exports"
// nor "sends to the grid" may be claimed — the second home does neither.
const SOLAR = suggestion('solar', {
  title: 'Use more of your own solar',
  body: 'PELS can run a device, or heat a little more, while your solar produces more than the home is '
    + 'using, so that power is used at home. Turn on Use solar surplus on the devices that should take it.',
  actionLabel: 'Choose devices',
}, panel('devices'));

const SMART_TASKS = suggestion('smart-tasks', {
  title: 'Have something ready by a set time',
  body: 'Set a temperature, battery level or energy goal and a ready-by time. PELS chooses the cheapest '
    + 'available hours before then. For a water heater on a relay, use an energy goal in kWh. '
    + 'Start with New smart task on the Smart tasks page. For a nightly relay routine, '
    + 'use the Add energy task Flow action.',
  actionLabel: 'Open Smart tasks',
  guideLink: {
    label: 'Heat a water heater overnight',
    href: 'https://pels.barelysufficient.org/smart-tasks#heat-a-water-heater-on-a-relay-overnight',
  },
}, panel('deadlines'));

const usesAny = (devices: readonly AfterSetupDevice[], flag: 'priceConfigured' | 'usesSolarSurplus'): boolean => (
  devices.some((device) => device[flag])
);

/** Prices and solar: the same two everywhere, only their order follows the market. */
const resolvePricesAndSolar = (
  facts: AfterSetupFacts,
  devices: readonly AfterSetupDevice[],
): SetupRecommendation[] => {
  const prices = facts.priceOptimizationEnabled
    && devices.some((device) => device.temperature)
    && !usesAny(devices, 'priceConfigured')
    ? [resolvePricesSuggestion(facts.priceSource)] : [];
  const solar = facts.solarSurplusAvailable
    && devices.some((device) => device.limitable)
    && !usesAny(devices, 'usesSolarSurplus')
    ? [SOLAR] : [];
  // In the Netherlands net metering is ending, so an owner's own solar comes first.
  const solarFirst = facts.market.state === 'resolved' && facts.market.country === 'NL';
  return solarFirst ? [...solar, ...prices] : [...prices, ...solar];
};

const resolveSmartTasks = (
  facts: AfterSetupFacts,
  devices: readonly AfterSetupDevice[],
): SetupRecommendation[] => (
  !facts.smartTaskConfigured
    && devices.some((device) => device.taskCapable)
    ? [SMART_TASKS] : []
);

export const resolveAfterSetupRecommendations = (facts: AfterSetupFacts): SetupRecommendation[] => {
  const { devices } = facts;
  // No cap is in force, so none can be wrong, unless PELS may limit something.
  const flanders = facts.belgianHomeOnHourlyPeriod && devices.some((device) => device.limitable)
    ? [FLANDERS_PERIOD] : [];
  if (!facts.setupComplete) return flanders;
  return [...flanders, ...resolvePricesAndSolar(facts, devices), ...resolveSmartTasks(facts, devices)];
};
