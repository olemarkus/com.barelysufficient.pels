import type { PriceSchemeSetting } from '../../../contracts/src/settingsUi/prices.ts';
import type { SettingsUiHubMarketRead } from '../../../contracts/src/settingsUi/webApp.ts';
import type { RecommendationDismissals, SetupRecommendation } from './recommendationsModel.ts';

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
 * Where the home's prices come from, as far as `Choose what PELS does` needs it
 * to name the source and keep an assumed one: `priced` when PELS holds prices
 * from the source in force and nothing but
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
  /** Producer-resolved global owner choice; explicit Off leaves Price out of the suggestion. */
  priceOptimizationEnabled: boolean;
  priceSource: AfterSetupPriceSource;
  /**
   * The surplus engine can act on this home's solar (`resolveSurplusControlAvailable`),
   * the same fact that puts solar actions on `Choose what PELS does`: a home with
   * panels but a pool the runtime declines would be offered a toggle that cannot
   * engage. It includes a zero-export home that curtails.
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

const PRICE_SOURCE_NAMES: Record<PriceSchemeSetting, string> = {
  norway: 'the Norway source',
  homey: 'Homey Energy',
  powerhour: 'Power by the Hour',
  flow: 'your Flow',
};

/** How a price source is named in a sentence. */
export const namePriceSource = (scheme: PriceSchemeSetting): string => PRICE_SOURCE_NAMES[scheme];

const usesAny = (devices: readonly AfterSetupDevice[], flag: 'priceConfigured' | 'usesSolarSurplus'): boolean => (
  devices.some((device) => device[flag])
);

// Outcomes, not features. The solar one never says "export": it must be true of
// a zero-export home that curtails as well as one that exports.
const OUTCOMES = {
  prices: 'heat in cheap hours',
  solar: 'use more of your own solar',
  smartTasks: 'have something ready by a set time',
} as const;

type Offer = keyof typeof OUTCOMES;

const joinOutcomes = (outcomes: readonly string[]): string => (
  outcomes.length < 2 ? outcomes.join('') : `${outcomes.slice(0, -1).join(', ')} or ${outcomes[outcomes.length - 1]}`
);

// The card each offer had before they became one. An owner who dismissed one
// said that offer is not for them, so the one card leaves it out.
const RETIRED_CARD_IDS: Record<Offer, string> = {
  prices: 'after-setup:prices',
  solar: 'after-setup:solar',
  smartTasks: 'after-setup:smart-tasks',
};

const dismissedBefore = (dismissals: RecommendationDismissals, offer: Offer): boolean => (
  dismissals[RETIRED_CARD_IDS[offer]] === VERSION
);

// Whether each offer applies to this home and is not in use yet.
const OFFER_APPLIES: Record<Offer, (facts: AfterSetupFacts) => boolean> = {
  prices: (facts) => facts.priceOptimizationEnabled
    && facts.devices.some((device) => device.temperature)
    && !usesAny(facts.devices, 'priceConfigured'),
  solar: (facts) => facts.solarSurplusAvailable
    && facts.devices.some((device) => device.limitable)
    && !usesAny(facts.devices, 'usesSolarSurplus'),
  smartTasks: (facts) => !facts.smartTaskConfigured && facts.devices.some((device) => device.taskCapable),
};

// What the page offers that is not in use yet, in the order the card names it.
const resolveGoalOffers = (facts: AfterSetupFacts, dismissals: RecommendationDismissals): Offer[] => {
  const solarFirst = facts.market.state === 'resolved' && facts.market.country === 'NL';
  const order: Offer[] = solarFirst ? ['solar', 'prices', 'smartTasks'] : ['prices', 'solar', 'smartTasks'];
  return order.filter((offer) => OFFER_APPLIES[offer](facts) && !dismissedBefore(dismissals, offer));
};

/**
 * One card for everything `Choose what PELS does` offers. Price-based control,
 * solar surplus and Smart tasks were a card each, offering again what the setup
 * page offers, so an owner who skipped the page met the same offer twice more.
 * The body names only what applies and is not in use yet; in the Netherlands,
 * where net metering is ending, solar leads. Dismissed, it stays away: the
 * owner has seen the offer.
 */
const resolveGoalsSuggestion = (
  facts: AfterSetupFacts,
  dismissals: RecommendationDismissals,
): SetupRecommendation[] => {
  const offers = resolveGoalOffers(facts, dismissals);
  if (offers.length === 0) return [];
  return [{
    id: 'after-setup:goals',
    version: VERSION,
    category: 'optional',
    title: 'Choose what PELS does',
    body: `PELS can ${joinOutcomes(offers.map((offer) => OUTCOMES[offer]))}. Choose for each device.`,
    actionLabel: 'Choose',
    target: { kind: 'setup-goals' },
    ...(offers.includes('smartTasks') ? {
      guideLink: {
        label: 'Heat a water heater overnight',
        href: 'https://pels.barelysufficient.org/smart-tasks#heat-a-water-heater-on-a-relay-overnight',
      },
    } : {}),
  }];
};

/** `dismissals` are the owner's, read for the cards the one suggestion replaced. */
export const resolveAfterSetupRecommendations = (
  facts: AfterSetupFacts,
  dismissals: RecommendationDismissals,
): SetupRecommendation[] => {
  // No cap is in force, so none can be wrong, unless PELS may limit something.
  const flanders = facts.belgianHomeOnHourlyPeriod && facts.devices.some((device) => device.limitable)
    ? [FLANDERS_PERIOD] : [];
  if (!facts.setupComplete) return flanders;
  return [...flanders, ...resolveGoalsSuggestion(facts, dismissals)];
};
