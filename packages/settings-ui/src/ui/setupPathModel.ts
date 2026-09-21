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
 * without the second. The hard cap does not. It is enforced only on devices
 * PELS may limit, so an owner who manages thermostats for their price response
 * alone is never held to it, and is never shown the step. Once something may be
 * limited the cap IS in force, tariff or no tariff, because every home runs one
 * (10 kW until the owner saves their own) — and that is the moment the step
 * appears, naming the number it is running on. Hence Devices before Hard cap:
 * what may be limited, then to what.
 *
 * Priority is the same kind of step, one device later. With two or more
 * devices PELS may limit, an order IS in force whether or not anyone chose it:
 * a device with no stored place sorts last, and ties break by device id, so on a
 * new install the bedroom heater may be limited before the pool pump for no
 * reason anyone gave. What should keep running longest is the one thing only
 * the owner knows, and nothing else in setup asks it. With a single limitable
 * device there is nothing to order, and the step is not shown.
 *
 * The same rule is why the copy picks no market. Norway and Flanders come for
 * the capacity tariff, the Netherlands for solar and dynamic prices; the lede
 * says what builds on the steps rather than selling the hard cap, and the Hard
 * cap step names the period it runs on, because a quarter-hour tariff on the
 * hourly default is the one silent way to get this setup wrong.
 *
 * Simulation is not a step. It is on by default and the path says so while it
 * is open, but a configured home left simulating is a finished setup: the slim
 * simulation banner already speaks for it, and a card that stayed until the
 * owner went live would sit on top of a cautious owner's Overview for weeks.
 *
 * Settings-UI-owned on purpose: the runtime has no use for it, so it lives
 * beside its one consumer rather than in shared-domain.
 */

type SetupStepId = 'power' | 'hardCap' | 'devices' | 'priority';

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
export type SetupHardCap =
  | { state: 'unset'; runningLimitKw: number; periodMinutes: CapacityPeriodMinutes }
  | { state: 'saved'; limitKw: number; marginKw: number; periodMinutes: CapacityPeriodMinutes };

/**
 * Whether a whole-home reading has ever arrived. While none has, `remedy` is the
 * no-readings banner's own sentence for this home's power source: the step
 * stands in for that banner where the card is on screen, so it must say exactly
 * what the banner would have.
 */
export type SetupPowerReadings =
  | { state: 'received' }
  | { state: 'never'; remedy: string };

/** What the settings UI knows about how far setup has come, for the Main home. */
export type SetupPathFacts = {
  power: SetupPowerReadings;
  hardCap: SetupHardCap;
  managedDeviceCount: number;
  /** Managed devices that also have Limit on: the ones PELS may actually turn down. */
  limitableDeviceCount: number;
  simulating: boolean;
  /**
   * How many devices PELS may limit still have no place in the active mode's
   * priority order. `unknown` while the Main home's mode catalog is not the one
   * loaded (it has not arrived, or a meter area's is on screen): the step is
   * then left out rather than asked on a guess.
   */
  priorityOrder: { state: 'unknown' } | { state: 'known'; unplacedCount: number; mode: string };
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
  /** Says simulation is on while the path is open; null when PELS is live. */
  simulationNote: string | null;
};

const LEDE = 'PELS starts managing your devices once these are done. Prices, solar and Smart tasks build on them.';
const SIMULATION_NOTE = 'Simulation is on, so devices stay as-is until you turn it off.';

const formatKw = (value: number): string => `${Number(value.toFixed(1))} kW`;

const countDevices = (count: number): string => (count === 1 ? '1 device' : `${count} devices`);

const resolvePowerDetail = (power: SetupPowerReadings): string => (
  // A reading that has gone quiet is the no-readings banner's job; the meter was
  // connected once, and that is all this step asks.
  power.state === 'received' ? 'Readings are arriving' : power.remedy
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

const FLANDERS_PERIOD_NOTE = ' In Flanders, use the 15-minute average.';

const resolveHardCapDetail = (hardCap: SetupHardCap, market: SettingsUiHubMarketRead): string => {
  const base = hardCap.state === 'saved'
    ? `${formatKw(hardCap.limitKw)} ${formatPeriod(hardCap.periodMinutes)}, ${formatKw(hardCap.marginKw)} safety margin`
    : `${formatKw(hardCap.runningLimitKw)} ${formatPeriod(hardCap.periodMinutes)} until you set yours`;
  return isBelgianHourly(market, hardCap.periodMinutes) ? `${base}.${FLANDERS_PERIOD_NOTE}` : base;
};

const resolvePriorityDetail = (facts: SetupPathFacts, unplacedCount: number, mode: string): string => {
  if (unplacedCount === 0) return `${countDevices(facts.limitableDeviceCount)} in order for ${mode}`;
  // Nothing placed yet is the new install; some unplaced is a device added later,
  // which has silently joined the end of the order and is limited first.
  return unplacedCount === facts.limitableDeviceCount
    ? 'Choose what keeps running longest'
    : `${countDevices(unplacedCount)} not placed yet, so limited first`;
};

// A fact, never an instruction. Devices that cannot be limited (no power
// reading) or that the owner chose not to limit are a finished choice; telling
// that owner to go turn Limit on asks for something they did not come for.
const resolveDevicesDetail = (facts: SetupPathFacts): string => {
  if (facts.managedDeviceCount === 0) return 'Choose the devices PELS manages';
  return facts.limitableDeviceCount > 0
    ? `${countDevices(facts.limitableDeviceCount)} PELS may limit`
    : `${countDevices(facts.managedDeviceCount)} managed`;
};

/**
 * `null` when setup is complete — there is no "all done" card, because a
 * finished setup has nothing left to say (the Overview says it instead).
 */
// In force only with two or more devices to order, and only judged when the
// order is actually known; see the header.
const resolvePriorityStep = (facts: SetupPathFacts): Array<Omit<SetupStep, 'status'> & { done: boolean }> => {
  if (facts.limitableDeviceCount < 2 || facts.priorityOrder.state === 'unknown') return [];
  const { unplacedCount, mode } = facts.priorityOrder;
  return [{
    id: 'priority',
    done: unplacedCount === 0,
    title: 'Priority',
    detail: resolvePriorityDetail(facts, unplacedCount, mode),
    target: { panel: 'modes' },
  }];
};

export const resolveSetupPath = (facts: SetupPathFacts): SetupPath | null => {
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
      done: facts.hardCap.state === 'saved',
      title: 'Hard cap',
      detail: resolveHardCapDetail(facts.hardCap, facts.market),
      target: { panel: 'limits' },
    }] : []),
    ...resolvePriorityStep(facts),
  ];
  if (candidates.every((step) => step.done)) return null;

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
    lede: LEDE,
    simulationNote: facts.simulating ? SIMULATION_NOTE : null,
  };
};

/** Whether the path is open AND still waiting on this step. */
export const isSetupStepOpen = (path: SetupPath | null, id: SetupStepId): boolean => (
  path !== null && path.steps.some((step) => step.id === id && step.status !== 'done')
);

/** Compact progress for a chip: `1 of 2`. */
export const formatSetupProgress = (path: SetupPath): string => (
  `${path.doneCount} of ${path.steps.length}`
);
