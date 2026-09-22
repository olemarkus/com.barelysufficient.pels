import type { CapacityScalarSettings } from '../../../contracts/src/capacitySettings.ts';
import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import type { SettingsUiHubMarketRead } from '../../../contracts/src/settingsUiApi.ts';
import {
  isBelgianHourly,
  isSetupStepOpen,
  resolveSetupPath,
  type SetupHardCap,
  type SetupPathState,
  type SetupPowerReadings,
} from './setupPathModel.ts';
import { readHomeMembership, subscribeToHomeScope } from './homeScope.ts';
import { state } from './state.ts';

/**
 * Where the setup path's facts meet.
 *
 * A leaf module on purpose, for the same reason as `planMeasurementSignal.ts`:
 * the readings fact and the hard cap are read in `capacity.ts`, the path is
 * drawn by the Overview (`planRedesign.ts`) and the Setup page
 * (`recommendations.ts`), and `capacity → … → planRedesign` is already an import
 * chain. Publishing here keeps every edge pointing at a module that imports
 * none of them.
 *
 * Device and simulation facts are read from `state` at resolve time rather than
 * published: they already have one owner there, and a second copy would drift.
 */

type SetupFactsRead<T> =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; value: T };

let power: SetupFactsRead<SetupPowerReadings> = { state: 'loading' };
let hardCap: SetupFactsRead<SetupHardCap> = { state: 'loading' };
// Not part of the `loading` gate: `unavailable` is the market-neutral copy, which
// is always correct, so the path never waits for this. A resolved market only
// ever sharpens what is already on screen.
let market: SettingsUiHubMarketRead = { state: 'unavailable' };
const listeners = new Set<() => void>();

// Several callers report "something the path reads may have moved" (a device
// list landing fires on every refresh tick), so listeners run only when the
// resolved path is actually different from the one they last drew.
let lastNotifiedPath = '';

const notify = (): void => {
  // The market is part of it: with setup complete the path is unchanged either way,
  // yet a market landing still changes which recommendations are drawn.
  const resolved = JSON.stringify([readSetupPath(), market]);
  if (resolved === lastNotifiedPath) return;
  lastNotifiedPath = resolved;
  listeners.forEach((listener) => listener());
};

export const onSetupPathChange = (listener: () => void): void => {
  listeners.add(listener);
};

/**
 * A device list landed, or a device or simulation toggle changed `state`:
 * redraw the path's surfaces if that moved the path.
 */
export const notifySetupPathChange = (): void => notify();

subscribeToHomeScope(notifySetupPathChange);

export const publishSetupPower = (next: SetupPowerReadings): void => {
  power = { state: 'ready', value: next };
  notify();
};

/** A bounded first read failed; preserve a previously trusted value. */
export const publishSetupPowerUnavailable = (): void => {
  if (power.state === 'ready') return;
  power = { state: 'unavailable' };
  notify();
};

export const publishSetupMarket = (next: SettingsUiHubMarketRead): void => {
  market = next;
  notify();
};

/**
 * The home is in Belgium and holds an HOURLY average (`isBelgianHourly`). `false`
 * until the hard cap has been read: nothing is asked of the owner on a guess.
 */
export const isBelgianHomeOnHourlyPeriod = (): boolean => (
  hardCap.state === 'ready' && isBelgianHourly(market, hardCap.value.periodMinutes)
);

export const readSetupMarket = (): SettingsUiHubMarketRead => market;

/**
 * `configured` is the capacity owner's verdict from the SDK settings key list,
 * not an inference from a nullable value in the browser. `running` is the
 * independently resolved scalar block the app is actually enforcing.
 */
export const publishSetupHardCapRead = (
  configured: boolean,
  running: CapacityScalarSettings,
): void => {
  const { limitKw, marginKw, periodMinutes } = running;
  hardCap = {
    state: 'ready',
    value: configured
      ? { state: 'saved', limitKw, marginKw, periodMinutes }
      : { state: 'unset', runningLimitKw: limitKw, periodMinutes },
  };
  notify();
};

/** A bounded first read failed; preserve a previously trusted value. */
export const publishSetupHardCapUnavailable = (): void => {
  if (hardCap.state === 'ready') return;
  hardCap = { state: 'unavailable' };
  notify();
};

export type SetupPathRead =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | SetupPathState;

/** `loading` until every fact has arrived once, so no step is judged on a guess. */
export const readSetupPath = (): SetupPathRead => {
  const membership = readHomeMembership();
  if (power.state === 'loading' || hardCap.state === 'loading' || !state.devicesLoaded
    || membership.state === 'loading') return { state: 'loading' };
  if (power.state === 'unavailable' || hardCap.state === 'unavailable'
    || membership.state === 'unavailable') return { state: 'unavailable' };
  const knownIds = new Set(state.latestDevices
    .filter((device) => !membership.runtimeActive
      || (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID)
    .map((device) => device.id));
  const managedIds = [...knownIds].filter((id) => state.managedMap[id] === true);
  const limitableIds = managedIds.filter((id) => state.controllableMap[id] === true);
  return resolveSetupPath({
    power: power.value,
    hardCap: hardCap.value,
    market,
    managedDeviceCount: managedIds.length,
    limitableDeviceCount: limitableIds.length,
    simulating: state.dryRun,
  });
};

// While the setup path is open, the card stands in for two global banners.
// Single-home only (`knownSingleHome`: the roster has been read and holds no
// meter areas): once areas exist the banners also speak for them, the Overview
// can be showing an area with no card on it, and an area's devices are not this
// path's to count. An unread roster is not "no areas".
const SETUP_PATH_PANELS: ReadonlySet<string> = new Set(['overview', 'recommendations']);

const readOpenPath = (knownSingleHome: boolean): SetupPathState => {
  if (!knownSingleHome) return { state: 'complete' };
  const read = readSetupPath();
  return read.state === 'open' ? read : { state: 'complete' };
};

const isCardOnScreen = (): boolean => SETUP_PATH_PANELS.has(state.activePanel);

// The simulation banner stands down in two cases.
//
// Nothing managed, on every panel: there is no device for simulation to hold
// still, so "devices stay as-is" is vacuous — and its one action, "Turn off
// simulation", is the last thing an owner with no configuration should do first.
//
// On a panel that shows the path card: the card carries its own simulation
// note a few pixels below. Same reasoning as the Simulation page, where the
// page's own toggle is the single control.
//
// Once the path closes the banner is the whole surface again — a configured
// home left simulating is exactly what it is for.
export const isSimulationCarriedBySetupPath = (knownSingleHome: boolean): boolean => {
  const path = readOpenPath(knownSingleHome);
  if (path.state === 'complete') return false;
  return isCardOnScreen() || isSetupStepOpen(path, 'devices');
};

// The no-readings banner stands down in ONE case: no reading has ever arrived,
// and the card is on screen with its Power meter step saying the banner's own
// sentence (owner ruling 2026-09-20). Two surfaces a few pixels apart telling a
// new owner the same thing cost the first viewport at 320 px and said nothing
// twice. Everywhere else the banner is still the one staleness surface: on
// panels without the card, and always once readings that HAD arrived stop —
// that is an alert about a working setup, not a setup step.
export const isNoReadingsCarriedBySetupPath = (knownSingleHome: boolean): boolean => (
  isCardOnScreen() && isSetupStepOpen(readOpenPath(knownSingleHome), 'power')
);
