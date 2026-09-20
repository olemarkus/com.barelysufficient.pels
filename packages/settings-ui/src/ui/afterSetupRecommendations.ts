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
 * - and every fact behind that verdict is KNOWN. An unread setting looks exactly
 *   like a feature nobody turned on, so an unknown fact yields no suggestion
 *   rather than a wrong one.
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
  priceEnabled: boolean;
  usesSolarSurplus: boolean;
};

/** `unknown` = the setting has not been read (or could not be), so nothing is claimed. */
export type AfterSetupKnown<T> = { state: 'unknown' } | { state: 'known'; value: T };

export type AfterSetupFacts = {
  setupComplete: boolean;
  /** Managed devices only; their Price and solar flags come from the price settings. */
  devices: AfterSetupKnown<readonly AfterSetupDevice[]>;
  /**
   * The home has solar AND the surplus engine can act on it. Both: a home with
   * panels but a pool the runtime declines would be offered a toggle that
   * cannot engage. "Has solar" includes a zero-export home that curtails.
   */
  solarSurplusAvailable: boolean;
  smartTaskConfigured: AfterSetupKnown<boolean>;
};

const VERSION = 1;

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

export const resolveAfterSetupRecommendations = (facts: AfterSetupFacts): SetupRecommendation[] => {
  if (!facts.setupComplete || facts.devices.state === 'unknown') return [];
  const devices = facts.devices.value;

  const pricesApply = devices.some((device) => device.temperature)
    && !devices.some((device) => device.priceEnabled);
  const solarApplies = facts.solarSurplusAvailable
    && devices.some((device) => device.limitable)
    && !devices.some((device) => device.usesSolarSurplus);
  const smartTasksApply = facts.smartTaskConfigured.state === 'known'
    && !facts.smartTaskConfigured.value
    && devices.some((device) => device.taskCapable);

  return [
    ...(pricesApply ? [PRICES] : []),
    ...(solarApplies ? [SOLAR] : []),
    ...(smartTasksApply ? [SMART_TASKS] : []),
  ];
};
