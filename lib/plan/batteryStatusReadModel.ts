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
 * - **Limited · Charging**: PELS caps its charge at its place in the priority
 *   order, with the load's `Limited` word; the reason line says how much more
 *   charge its own mode would take.
 * - **Own mode**: it runs the mode chosen in its own app. With its Power-limit
 *   control off, the reason line says so: PELS never takes it over, and its
 *   own app is in charge. One PELS cannot drive says PELS can only watch it,
 *   and why: its app refused PELS's claim, or gives Homey no power setting.
 *
 * Power is shown without a sign: the state word gives the direction. Below
 * `DIRECTION_MIN_W` either way the battery is doing nothing worth naming, so
 * no power is shown. The wording is canonical in `notes/ui-terminology.md`
 * § "Home battery".
 */
import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { SettingsUiPlanHomeBattery } from '../../packages/contracts/src/settingsUiApi';
import { displayStateLabel, displayStateTone } from '../../packages/shared-domain/src/planCardGrammar';
import { resolveBatteryUndrivableLine } from '../../packages/shared-domain/src/batteryControlCopy';
import type { HomeBatteryCardRead } from '../observer/observedDeviceStateProjection';
import type { StorageHold } from './planTypes';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

export type HomeBatteryCard = Extract<HomeBatteryCardRead, { kind: 'battery' }>;
type StorageHoldKind = StorageHold['kind'];
type Direction = 'supplying' | 'charging';
/** The holds of a battery PELS does not hold: it runs its own mode. */
type OwnModeHoldKind = 'none' | 'power_limit_off';
const isOwnModeHold = (hold: StorageHold): hold is Extract<StorageHold, { kind: OwnModeHoldKind }> => (
  hold.kind === 'none' || hold.kind === 'power_limit_off'
);

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

/** The state word while PELS caps the battery's charge: the load's `Limited`, and what it limits. */
export const BATTERY_CHARGE_LIMITED_LABEL = `${displayStateLabel('held')} · ${BATTERY_STATE_LABELS.charging}`;

export const BATTERY_REASON_LINES = {
  relief: 'Holding your limit so your devices keep running',
  charge_limit: 'Waiting to charge faster',
  surplus: 'Storing the solar power your devices leave',
  cap_for_device: 'Charging less so a device can use the solar',
  none: 'PELS takes over when your limit or solar needs it',
  power_limit_off: 'Power-limit control is off: its own app is in charge',
} as const satisfies Record<StorageHoldKind, string>;

/** Below this, the charge a cap holds back is not worth naming, kW. */
const HELD_BACK_MIN_KW = 0.05;

/** The direction a held battery is meant to go, named while its own reading shows none. */
const INTENDED_DIRECTION = {
  relief: 'supplying',
  charge_limit: 'charging',
  surplus: 'charging',
  cap_for_device: 'charging',
} as const satisfies Record<Exclude<StorageHoldKind, OwnModeHoldKind>, Direction>;

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
  // A capped charge holds nothing: only a discharge for the limit does.
  const holdsLimit = hold.kind === 'relief' && direction === 'supplying';
  if (isOwnModeHold(hold)) return { activity: 'own_mode', power, holdsLimit };
  return { activity: direction ?? INTENDED_DIRECTION[hold.kind], power, holdsLimit };
}

const resolveFactText = (battery: HomeBatteryCard, hold: StorageHold): string | null => {
  const parts = [
    battery.level.kind === 'observed' ? `${Math.round(battery.level.percent)} % charged` : null,
    isOwnModeHold(hold) ? resolveObservedDirection(battery) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
};

const resolveReason = (battery: HomeBatteryCard, hold: StorageHold, dryRun: boolean): DeviceStatus['reason'] => {
  if (isOwnModeHold(hold)) {
    // A battery PELS cannot drive says why: its app refused control, or gives
    // Homey no power setting. The same line its device page and device-list
    // row show in place of a Power-limit control.
    const undrivableLine = resolveBatteryUndrivableLine(battery.control);
    if (undrivableLine !== null) return { text: undrivableLine };
    // One PELS is only simulating has nothing more to say than its own reading.
    if (dryRun) return null;
  }
  if (hold.kind === 'charge_limit' && hold.heldBackKw >= HELD_BACK_MIN_KW) {
    return { text: `${BATTERY_REASON_LINES.charge_limit} · ${hold.heldBackKw.toFixed(1)} kW more needed` };
  }
  return { text: BATTERY_REASON_LINES[hold.kind] };
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
  if (hold.kind === 'charge_limit') {
    return {
      ...common,
      kind: 'held',
      tone: displayStateTone('held'),
      label: BATTERY_CHARGE_LIMITED_LABEL,
      limited: true,
      powerText: power.kind === 'observed' && activity === 'charging' ? `${power.kw.toFixed(1)} kW` : null,
      reason: resolveReason(battery, hold, dryRun),
    };
  }
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
