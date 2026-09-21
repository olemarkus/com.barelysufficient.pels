import type { SettingsUiHubMarketRead } from '../../../contracts/src/settingsUiApi.ts';
import type { SetupRecommendation } from './recommendationsModel.ts';

/**
 * What PELS can do next, once first-run setup is complete.
 *
 * The setup path ends the moment PELS can manage a home's devices, and its lede
 * promises that "Prices, solar and Smart tasks build on" it. Then the card
 * disappears and nothing said where those are. For a Norwegian owner that is
 * fine: capacity control, the thing they came for, is now running. For an owner
 * in the Netherlands or Flanders it is the point where their actual goal starts.
 *
 * These ride the existing recommendation surfaces rather than a list of their
 * own: the Overview banner announces them at exactly the moment the setup card
 * goes, and **Dismiss is the owner saying "not relevant to me"**, remembered.
 *
 * Each one appears only when it is relevant to THIS home (owner ruling
 * 2026-09-20: never tell an owner to configure something that is not relevant
 * to them), judged from state the settings UI already holds:
 *
 * - it applies here (there is a device it could act on, the home has solar
 *   surplus PELS can use);
 * - it is not already in use — recommending prices to an owner who set them up
 *   last year is the same mistake from the other side;
 * - and every fact behind that verdict has been resolved by its boundary.
 *
 * None shows while the setup path is open. One thing at a time: the path is the
 * instruction until it is done.
 */

/** A managed device, reduced to what decides whether a suggestion applies. */
export type AfterSetupDevice = {
  /** Has a temperature target: the only kind Price can act on. */
  temperature: boolean;
  /** Has Limit on, so PELS may command it (solar surplus needs that). */
  limitable: boolean;
  /** Could take a Smart task: a charger, or anything with a temperature target. */
  taskCapable: boolean;
  /** The owner made an explicit per-device Price choice, including Off. */
  priceConfigured: boolean;
  usesSolarSurplus: boolean;
};

export type AfterSetupFacts = {
  setupComplete: boolean;
  /** Managed devices only; their Price and solar flags come from the price settings. */
  devices: readonly AfterSetupDevice[];
  /** Producer-resolved global owner choice; explicit Off suppresses the Price suggestion. */
  priceOptimizationEnabled: boolean;
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
  body: 'In Flanders the capacity tariff bills your highest 15-minute average, and PELS is holding an '
    + 'hourly average. If you live in Flanders, change Capacity period to 15-minute average. '
    + 'Elsewhere in Belgium this does not apply, and you can dismiss it.',
  actionLabel: 'Open Limits & safety',
  target: { kind: 'panel', panelId: 'limits' },
};

const suggestion = (
  id: string,
  copy: Pick<SetupRecommendation, 'title' | 'body' | 'actionLabel'>,
  panelId: string,
): SetupRecommendation => ({
  id: `after-setup:${id}`,
  version: VERSION,
  category: 'optional',
  ...copy,
  target: { kind: 'panel', panelId },
});

const PRICES = suggestion('prices', {
  title: 'Heat more while power is cheap',
  body: 'PELS can raise the temperature a little in cheap hours and lower it in expensive ones, so heating '
    + 'and hot water run when power costs least. Choose where your prices come from, then turn on Price '
    + 'for the devices that should follow them.',
  actionLabel: 'Set up prices',
}, 'electricity-prices');

// True of both kinds of solar home this applies to: one that exports, and a
// zero-export home whose inverter throttles what it cannot use. Neither "exports"
// nor "sends to the grid" may be claimed — the second home does neither.
const SOLAR = suggestion('solar', {
  title: 'Use more of your own solar',
  body: 'PELS can run a device, or heat a little more, while your solar produces more than the home is '
    + 'using, so that power is used at home. Turn on Use solar surplus on the devices that should take it.',
  actionLabel: 'Choose devices',
}, 'devices');

const SMART_TASKS = suggestion('smart-tasks', {
  title: 'Have something ready by a set time',
  body: 'A Smart task charges the car or heats water to the level you choose by the time you need it, in '
    + 'the cheapest hours before then. Add one from a Flow with the Add charging task or Add heating task '
    + 'action, or from the New smart task widget on a dashboard.',
  actionLabel: 'Open Smart tasks',
}, 'deadlines');

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
    ? [PRICES] : [];
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
  if (!facts.setupComplete) return [];
  const { devices } = facts;
  // No cap is in force, so none can be wrong, unless PELS may limit something.
  const flanders = facts.belgianHomeOnHourlyPeriod && devices.some((device) => device.limitable)
    ? [FLANDERS_PERIOD] : [];
  return [...flanders, ...resolvePricesAndSolar(facts, devices), ...resolveSmartTasks(facts, devices)];
};
