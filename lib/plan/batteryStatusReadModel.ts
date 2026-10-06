/**
 * The overview card of a home battery: what it is doing now, in owner terms.
 * A battery is not a load the shed/restore lanes limit, so it does not go
 * through `buildDeviceStatus`. Its state word is what the battery itself
 * reports doing, and its reason line is why PELS holds it (the storage relief
 * stage's `storageHold` on the plan device):
 *
 * - **Supplying** / **Charging**: the battery's own reading, PELS holding it.
 *   The word follows the observed sign, never the plan: a battery PELS has
 *   just asked to supply that still charges reads Charging until it turns.
 * - **Own mode**: it runs the mode chosen in its own app.
 *
 * Power is shown without a sign: the state word gives the direction. Below
 * `DIRECTION_MIN_W` either way the battery is doing nothing worth naming, so
 * no power is shown. The wording is canonical in `notes/ui-terminology.md`
 * § "Home battery".
 */
import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { SettingsUiPlanHomeBattery } from '../../packages/contracts/src/settingsUiApi';
import { displayStateLabel, displayStateTone } from '../../packages/shared-domain/src/planCardGrammar';
import type { HomeBatteryCardRead } from '../observer/observedDeviceStateProjection';
import type { DevicePlanDevice } from './planTypes';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

export type HomeBatteryCard = Extract<HomeBatteryCardRead, { kind: 'battery' }>;
type StorageHold = DevicePlanDevice['storageHold'];
type Direction = 'supplying' | 'charging';

const NO_BATTERY_CARD: HomeBatteryCardRead = { kind: 'none' };

/**
 * A home battery's card facts as one home's overview reads them. PELS controls
 * a home battery only in the Main home, so only Main's overview shows one: a
 * battery a meter area owns is telemetry for that area and reads as no
 * battery there (the device list hides it the same way).
 */
export function readHomeBatteryCardForHome(
  homeId: HomeId,
  readCard: (deviceId: string) => HomeBatteryCardRead,
  deviceId: string,
): HomeBatteryCardRead {
  return homeId === MAIN_HOME_ID ? readCard(deviceId) : NO_BATTERY_CARD;
}

/** Below this the battery is neither charging nor supplying in any way worth naming, W. */
const DIRECTION_MIN_W = 50;

export const BATTERY_STATE_LABELS = {
  supplying: 'Supplying',
  charging: 'Charging',
  own_mode: 'Own mode',
} as const;

export const BATTERY_REASON_LINES = {
  relief: 'Holding your limit so your devices keep running',
  surplus: 'Storing the solar power your devices leave',
  cap_for_device: 'Charging less so a device can use the solar',
  none: 'PELS takes over when your limit or solar needs it',
} as const satisfies Record<StorageHold, string>;

/** The direction a held battery is meant to go, named while its own reading shows none. */
const INTENDED_DIRECTION = {
  relief: 'supplying',
  surplus: 'charging',
  cap_for_device: 'charging',
} as const satisfies Record<Exclude<StorageHold, 'none'>, Direction>;

/** What the battery itself reports doing, or `null` when it reports too little to name. */
const resolveObservedDirection = (battery: HomeBatteryCard): Direction | null => {
  if (battery.power.kind !== 'observed') return null;
  const { signedW } = battery.power;
  if (signedW >= DIRECTION_MIN_W) return 'charging';
  return signedW <= -DIRECTION_MIN_W ? 'supplying' : null;
};

/**
 * The battery's activity and power as the card and the hero name them. A held
 * battery's word is its observed direction; one that reports none yet keeps
 * the word for what PELS holds it to do, with no power. Power is present only
 * with an observed direction.
 */
export function buildSettingsUiPlanHomeBattery(
  battery: HomeBatteryCard,
  hold: StorageHold,
): SettingsUiPlanHomeBattery {
  const direction = resolveObservedDirection(battery);
  const power: SettingsUiPlanHomeBattery['power'] = direction !== null && battery.power.kind === 'observed'
    ? { kind: 'observed', kw: Math.abs(battery.power.signedW) / 1000 }
    : { kind: 'absent' };
  // Only a battery PELS holds for relief that is supplying holds the limit: a
  // surplus or capped hold, or a battery in its own mode, discharges for
  // reasons of its own.
  const holdsLimit = hold === 'relief' && direction === 'supplying';
  if (hold === 'none') return { activity: 'own_mode', power, holdsLimit };
  return { activity: direction ?? INTENDED_DIRECTION[hold], power, holdsLimit };
}

const resolveFactText = (battery: HomeBatteryCard, hold: StorageHold): string | null => {
  const parts = [
    battery.level.kind === 'observed' ? `${Math.round(battery.level.percent)} % charged` : null,
    hold === 'none' ? resolveObservedDirection(battery) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
};

const resolveReason = (battery: HomeBatteryCard, hold: StorageHold, dryRun: boolean): DeviceStatus['reason'] => {
  // A battery PELS cannot drive, or one PELS is only simulating, has nothing
  // more to say than its own reading.
  if (hold === 'none' && (!battery.drivable || dryRun)) return null;
  return { text: BATTERY_REASON_LINES[hold] };
};

export function buildHomeBatteryStatus(
  battery: HomeBatteryCard,
  hold: StorageHold,
  available: boolean,
  dryRun: boolean,
): DeviceStatus {
  const common = {
    cardKind: 'binary' as const,
    powerVariant: 'live' as const,
    factText: resolveFactText(battery, hold),
    rail: null,
    limited: false,
    wouldLimit: false,
    canEaseOff: false,
    controlOffDrawing: false,
    holdCause: null,
  };
  if (!available) {
    return {
      ...common,
      kind: 'unavailable',
      tone: displayStateTone('unavailable'),
      label: displayStateLabel('unavailable'),
      powerText: null,
      reason: null,
    };
  }
  const { activity, power } = buildSettingsUiPlanHomeBattery(battery, hold);
  const kind = activity === 'own_mode' ? 'idle' : 'active';
  return {
    ...common,
    kind,
    tone: displayStateTone(kind),
    label: BATTERY_STATE_LABELS[activity],
    powerText: power.kind === 'observed' ? `${power.kw.toFixed(1)} kW` : null,
    reason: resolveReason(battery, hold, dryRun),
  };
}
