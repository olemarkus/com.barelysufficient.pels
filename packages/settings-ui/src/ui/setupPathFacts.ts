import type { CapacityScalarSettings } from '../../../contracts/src/capacitySettings.ts';
import {
  isSetupStepOpen,
  resolveSetupPath,
  type SetupHardCap,
  type SetupPath,
  type SetupPowerReadings,
} from './setupPathModel.ts';
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

let power: SetupPowerReadings | null = null;
let hardCap: SetupHardCap | null = null;
const listeners = new Set<() => void>();

// Several callers report "something the path reads may have moved" (a device
// list landing fires on every refresh tick), so listeners run only when the
// resolved path is actually different from the one they last drew.
let lastNotifiedPath = '';

const notify = (): void => {
  const resolved = JSON.stringify(readSetupPath());
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

export const publishSetupPower = (next: SetupPowerReadings): void => {
  power = next;
  notify();
};

/**
 * `persistedLimitKw` is the persisted cap as its reader resolved it: a number
 * when the owner has saved one, anything else once absence is CONFIRMED
 * (`setupHardCapRead.ts` owns that; a single nullish read is not absence). A
 * saved cap never becomes unsaved again, so once one has been seen a later
 * read without it is the SDK's transient unreadable-store answer: the step
 * stays done rather than sending the owner back, and `running` (the scalars
 * the app is actually using) still refreshes.
 */
export const publishSetupHardCapRead = (
  persistedLimitKw: unknown,
  running: CapacityScalarSettings,
): void => {
  const saved = (typeof persistedLimitKw === 'number' && Number.isFinite(persistedLimitKw))
    || hardCap?.state === 'saved';
  const { limitKw, marginKw, periodMinutes } = running;
  hardCap = saved
    ? { state: 'saved', limitKw, marginKw, periodMinutes }
    : { state: 'unset', runningLimitKw: limitKw, periodMinutes };
  notify();
};

type SetupPathRead =
  | { state: 'loading' }
  | { state: 'resolved'; path: SetupPath | null };

/** `loading` until every fact has arrived once, so no step is judged on a guess. */
export const readSetupPath = (): SetupPathRead => {
  if (power === null || hardCap === null || !state.devicesLoaded) return { state: 'loading' };
  const knownIds = new Set(state.latestDevices.map((device) => device.id));
  const managedIds = [...knownIds].filter((id) => state.managedMap[id] === true);
  return {
    state: 'resolved',
    path: resolveSetupPath({
      power,
      hardCap,
      managedDeviceCount: managedIds.length,
      limitableDeviceCount: managedIds.filter((id) => state.controllableMap[id] === true).length,
      simulating: state.dryRun,
    }),
  };
};

// While the setup path is open, the card stands in for two global banners.
// Single-home only (`knownSingleHome`: the roster has been read and holds no
// meter areas): once areas exist the banners also speak for them, the Overview
// can be showing an area with no card on it, and an area's devices are not this
// path's to count. An unread roster is not "no areas".
const SETUP_PATH_PANELS: ReadonlySet<string> = new Set(['overview', 'recommendations']);

const readOpenPath = (knownSingleHome: boolean): SetupPath | null => {
  if (!knownSingleHome) return null;
  const read = readSetupPath();
  return read.state === 'resolved' ? read.path : null;
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
  if (path === null) return false;
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
