import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';
import type { SettingsUiHubMarketRead } from '../../../contracts/src/settingsUiApi.ts';

/** Setup names the essentials: a meter, managed devices and a chosen limit posture.
 * Limits only apply once there are devices PELS may limit. A saved grid limit,
 * a saved capacity limit, or an explicit choice to turn both off completes that step.
 * Simulation remains a separate banner, not a setup requirement.
 */

type SetupStepId = 'power' | 'hardCap' | 'devices';

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
  | { state: 'saved'; limitKw: number; marginKw: number; periodMinutes: CapacityPeriodMinutes }
  | { state: 'grid'; limitKw: number; periodMinutes: CapacityPeriodMinutes | null }
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

/** What the settings UI knows about how far setup has come, for the Main home. */
export type SetupPathFacts = {
  power: SetupPowerReadings;
  hardCap: SetupHardCap;
  managedDeviceCount: number;
  /** Managed devices that also have Limit on: the ones PELS may actually turn down. */
  limitableDeviceCount: number;
  simulating: boolean;
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

const LEDE = 'Check the essentials PELS uses to manage this home. Prices, solar and Smart tasks build on them.';
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
  periodMinutes: CapacityPeriodMinutes | null,
): boolean => market.state === 'resolved' && market.country === 'BE' && periodMinutes === 60;

const FLANDERS_PERIOD_NOTE = ' In Flanders, use the 15-minute average.';

const resolveHardCapDetail = (hardCap: SetupHardCap, market: SettingsUiHubMarketRead): string => {
  if (hardCap.state === 'grid') {
    const gridDetail = `${formatKw(hardCap.limitKw)} grid import limit`;
    return isBelgianHourly(market, hardCap.periodMinutes)
      ? `${gridDetail}. In Flanders, use the 15-minute average for Capacity limit.` : gridDetail;
  }
  if (hardCap.state === 'disabled') return 'Power limits off';
  const base = hardCap.state === 'saved'
    ? `${formatKw(hardCap.limitKw)} ${formatPeriod(hardCap.periodMinutes)}, ${formatKw(hardCap.marginKw)} safety margin`
    : `${formatKw(hardCap.runningLimitKw)} ${formatPeriod(hardCap.periodMinutes)} until you set yours`;
  return isBelgianHourly(market, hardCap.periodMinutes) ? `${base}.${FLANDERS_PERIOD_NOTE}` : base;
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
 * `complete` when setup is complete — there is no "all done" card, because a
 * finished setup has nothing left to say (the Overview says it instead).
 */
export const resolveSetupPath = (facts: SetupPathFacts): SetupPathState => {
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
      detail: resolveHardCapDetail(facts.hardCap, facts.market),
      target: { panel: 'limits' },
    }] : []),
  ];
  if (candidates.every((step) => step.done)) return { state: 'complete' };

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
    state: 'open',
    path: {
      steps,
      doneCount: candidates.filter((step) => step.done).length,
      lede: LEDE,
      simulating: facts.simulating,
    },
  };
};

/** Whether the path is open AND still waiting on this step. */
export const isSetupStepOpen = (read: SetupPathVisibility, id: SetupStepId): boolean => (
  read.state === 'open' && read.path.steps.some((step) => step.id === id && step.status !== 'done')
);

/** Compact progress for a chip: `1 of 2`. */
export const formatSetupProgress = (path: SetupPath): string => (
  `${path.doneCount} of ${path.steps.length}`
);
