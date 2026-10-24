import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';
import type { SettingsUiHubMarketRead } from '../../../contracts/src/settingsUiApi.ts';

/**
 * The first-run setup path: what must be true before PELS manages a home's
 * devices, in the order a new owner meets it.
 *
 * It is state, not a tour. Each step is judged from what the app already holds,
 * so the path never claims progress the owner did not make and never asks for a
 * step that is already done. A returning owner who unmanages their last device
 * gets the Devices step back; nothing is remembered about having "finished".
 *
 * **A step appears only when what it configures is in force for this home.**
 * Asking an owner to configure something that does not apply to them tells them
 * the app was built for somebody else. A power meter and managed devices apply
 * to everyone: there is no plan without the first and nothing to plan for
 * without the second. The limits do not. They are enforced only on devices
 * PELS may limit, so an owner who manages thermostats for their price response
 * alone is never held to them, and is never shown the step. Once something may
 * be limited the step appears, because a home that has never chosen still runs
 * the capacity limit on a built-in 10 kW, and the step names the number it is
 * running on. A saved grid import limit, a saved hard cap, or an explicit choice
 * to turn both limits off completes it. Hence Devices before Limits: what may be
 * limited, then to what.
 *
 * Prices follow the same rule. They apply once something in the home uses
 * them (see `SetupPrices`), and then the step stays open while PELS prices with
 * a source or a Norway setting the owner never chose, naming what it uses in
 * the meantime, the way Limits names the 10 kW it runs on.
 *
 * Priority is automatic, so confirming or customising the order is not a setup
 * requirement. Owners can change it in Modes whenever they want.
 *
 * Simulation is not a completion requirement. The explicit review surface
 * offers activation; a configured home may remain simulating indefinitely.
 *
 * Settings-UI-owned on purpose: the runtime has no use for it, so it lives
 * beside its one consumer rather than in shared-domain.
 */

export type SetupStepId = 'power' | 'hardCap' | 'devices' | 'prices';

/** `next` is the first step still open; every later open step is `later`. */
type SetupStepStatus = 'done' | 'next' | 'later';

export type SetupStep = {
  id: SetupStepId;
  status: SetupStepStatus;
  /** A noun that stays put across states, so the list reads the same every visit. */
  title: string;
  /** The step's current fact, or what doing it achieves while it is open. */
  detail: string;
  /** Settings panel the row opens, with the field it promises where one exists. */
  target: { panel: string; anchor?: string };
};

/**
 * The persisted hard cap, or the fact that none has been saved. The app runs on
 * a built-in 10 kW until the owner saves their own, and never writes that value
 * back, so an absent key is a true "not chosen yet".
 */
export type SetupCapacityLimit =
  | { state: 'unset'; runningLimitKw: number; periodMinutes: CapacityPeriodMinutes }
  | { state: 'saved'; limitKw: number; marginKw: number; periodMinutes: CapacityPeriodMinutes };

/**
 * The limits step's fact. With a grid import limit on, the capacity limit is
 * either running alongside it or switched `off`; with both off the owner has
 * explicitly chosen no limit (`disabled`).
 */
export type SetupHardCap =
  | SetupCapacityLimit
  | { state: 'grid'; limitKw: number; capacity: SetupCapacityLimit | { state: 'off' } }
  | { state: 'disabled' };

/**
 * Whether a whole-home reading has ever arrived. While none has, `remedy` is the
 * no-readings banner's own sentence for this home's power source: the step
 * stands in for that banner where the card is on screen, so it must say exactly
 * what the banner would have.
 */
export type SetupPowerReadings =
  | { state: 'received' }
  | { state: 'never'; remedy: string };

/**
 * Whether anything in the home uses prices and, when something does, how far
 * the owner has set them up (`priceSetupStatus.ts`).
 */
export type SetupPrices =
  | { state: 'unused' }
  | { state: 'used'; complete: boolean; summary: string };

/** What the settings UI knows about how far setup has come, for the Main home. */
export type SetupPathFacts = {
  power: SetupPowerReadings;
  hardCap: SetupHardCap;
  managedDeviceCount: number;
  /** Managed devices that also have Limit on: the ones PELS may actually turn down. */
  limitableDeviceCount: number;
  simulating: boolean;
  prices: SetupPrices;
  /**
   * Where the hub is, from geography alone (never its language). `unavailable`
   * draws the market-neutral copy, which is always correct; a resolved market
   * only ever sharpens it.
   */
  market: SettingsUiHubMarketRead;
};

export type SetupPath = {
  steps: readonly SetupStep[];
  doneCount: number;
  lede: string;
  /** Whether the path should name the simulation posture below its steps. */
  simulating: boolean;
};

export type SetupPathState =
  | { state: 'complete' }
  | { state: 'open'; path: SetupPath };

type SetupPathVisibility = SetupPathState | { state: 'loading' };

const formatKw = (value: number): string => `${Number(value.toFixed(1))} kW`;

const countDevices = (count: number): string => (count === 1 ? '1 device' : `${count} devices`);

const resolvePowerDetail = (power: SetupPowerReadings): string => (
  // A reading that has gone quiet is the no-readings banner's job; the meter was
  // connected once, and that is all this step asks.
  power.state === 'received' ? 'Meter connected' : power.remedy
);

// The same words as the Capacity period options on Limits & safety, so the
// owner can find the setting the row is describing.
const formatPeriod = (periodMinutes: CapacityPeriodMinutes): string => (
  periodMinutes === 15 ? '15-minute average' : 'hourly average'
);

// Flanders bills the 15-minute peak; Wallonia and Brussels have no such tariff,
// and a country code cannot tell them apart. So this names Flanders and leaves
// the rest of Belgium alone, rather than telling a Walloon to change a setting
// that does not apply to them.
export const isBelgianHourly = (
  market: SettingsUiHubMarketRead,
  periodMinutes: CapacityPeriodMinutes,
): boolean => market.state === 'resolved' && market.country === 'BE' && periodMinutes === 60;

/** The capacity limit in force, whether alone or beside a grid import limit. */
const resolveSetupCapacityLimit = (hardCap: SetupHardCap): SetupCapacityLimit | null => {
  if (hardCap.state === 'disabled') return null;
  if (hardCap.state !== 'grid') return hardCap;
  return hardCap.capacity.state === 'off' ? null : hardCap.capacity;
};

const formatCapacityDetail = (capacity: SetupCapacityLimit): string => {
  const period = formatPeriod(capacity.periodMinutes);
  return capacity.state === 'saved'
    ? `${formatKw(capacity.limitKw)} hard cap (${period}), ${formatKw(capacity.marginKw)} safety margin`
    : `${formatKw(capacity.runningLimitKw)} hard cap (${period}) until you set yours`;
};

const formatLimitsSummary = (hardCap: SetupHardCap): string => {
  if (hardCap.state === 'disabled') return 'Power limits off';
  if (hardCap.state !== 'grid') return formatCapacityDetail(hardCap);
  const grid = `${formatKw(hardCap.limitKw)} grid import limit`;
  return hardCap.capacity.state === 'off' ? grid : `${grid}, ${formatCapacityDetail(hardCap.capacity)}`;
};

/** A Belgian home whose capacity limit, in force, runs on the hourly average. */
export const isBelgianHourlySetup = (market: SettingsUiHubMarketRead, hardCap: SetupHardCap): boolean => {
  const capacity = resolveSetupCapacityLimit(hardCap);
  return capacity !== null && isBelgianHourly(market, capacity.periodMinutes);
};

// Ask about measured peaks: connection-capacity charges use similar names.
const MEASURED_PEAK_QUESTION = 'Charged for your highest hourly or 15-minute average grid import? '
  + 'Set your hard cap, or turn off Capacity limit.';

const resolveHardCapDetail = (facts: SetupPathFacts): string => {
  const { hardCap, market } = facts;
  // Only while the step is open: beside a grid import limit the step is done.
  if (hardCap.state === 'unset') {
    const guidance = market.state === 'resolved' && market.country === 'NL'
      ? 'Dutch household grid charges depend on connection size, not measured peaks. '
        + 'You can turn off Capacity limit and still use prices and solar.'
      : MEASURED_PEAK_QUESTION;
    return `${formatCapacityDetail(hardCap)}. ${guidance}`;
  }
  return formatLimitsSummary(hardCap);
};

// A fact, never an instruction. Devices that cannot be limited (no power
// reading) or that the owner chose not to limit are a finished choice; telling
// that owner to go turn Limit on asks for something they did not come for.
const resolveDevicesDetail = (facts: SetupPathFacts): string => {
  if (facts.managedDeviceCount === 0) return 'Choose one device to start';
  return facts.limitableDeviceCount > 0
    ? `${countDevices(facts.limitableDeviceCount)} PELS may limit`
    : `${countDevices(facts.managedDeviceCount)} managed`;
};

/** Keep the resolved steps available for the explicit review, even after setup closes. */
export const resolveSetupSteps = (facts: SetupPathFacts): SetupPath => {
  // In force only once some managed device may be limited; see the header.
  const hardCapApplies = facts.limitableDeviceCount > 0;
  const candidates: Array<Omit<SetupStep, 'status'> & { done: boolean }> = [
    {
      id: 'power',
      done: facts.power.state === 'received',
      title: 'Power meter',
      detail: resolvePowerDetail(facts.power),
      target: { panel: 'limits', anchor: '#settings-power-source' },
    },
    {
      id: 'devices',
      done: facts.managedDeviceCount > 0,
      title: 'Devices',
      detail: resolveDevicesDetail(facts),
      target: { panel: 'devices' },
    },
    ...(hardCapApplies ? [{
      id: 'hardCap' as const,
      done: facts.hardCap.state !== 'unset',
      title: 'Limits',
      detail: resolveHardCapDetail(facts),
      target: { panel: 'limits' },
    }] : []),
    ...(facts.prices.state === 'used' ? [{
      id: 'prices' as const,
      done: facts.prices.complete,
      title: 'Prices',
      detail: facts.prices.summary,
      target: { panel: 'electricity-prices', anchor: '#price-source-select' },
    }] : []),
  ];

  const nextIndex = candidates.findIndex((step) => !step.done);
  const statusAt = (done: boolean, index: number): SetupStepStatus => {
    if (done) return 'done';
    return index === nextIndex ? 'next' : 'later';
  };
  const steps: SetupStep[] = candidates.map(({ done, ...step }, index) => ({
    ...step,
    status: statusAt(done, index),
  }));

  return {
    steps,
    doneCount: candidates.filter((step) => step.done).length,
    lede: 'Connect your meter, choose a device, then review your settings.',
    simulating: facts.simulating,
  };
};

export const resolveSetupPath = (facts: SetupPathFacts): SetupPathState => {
  const path = resolveSetupSteps(facts);
  return path.doneCount === path.steps.length ? { state: 'complete' } : { state: 'open', path };
};

/** Whether the path is open AND still waiting on this step. */
export const isSetupStepOpen = (read: SetupPathVisibility, id: SetupStepId): boolean => (
  read.state === 'open' && read.path.steps.some((step) => step.id === id && step.status !== 'done')
);

/** Compact progress for a chip: `1 of 2`. */
export const formatSetupProgress = (path: SetupPath): string => (
  `${path.doneCount} of ${path.steps.length}`
);
