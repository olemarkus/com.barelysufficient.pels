/**
 * The charging switch of an Easee charger under built-in device control, at the
 * SDK seam: how a write to it is carried out and how it is read back.
 *
 * Everything above `lib/device` treats `evcharger_charging` as this charger's
 * switch, like any EV charger's. Only here does it become the charger current:
 * PELS pauses the charger with 0 A instead of the app's `stop_charging`, and
 * reads the switch back without trusting a `true` the charger contradicts. See
 * `notes/native-wiring/README.md`.
 */
import type { DeviceCapabilityMap } from './managerControl';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import {
  EASEE_CHARGER_CURRENT_CAPABILITY_ID,
  EASEE_MIN_CHARGING_CURRENT_A,
  isNativeSteppedLoadControlEnabled,
  type CapabilityWrite,
} from './nativeSteppedLoadWiring';

/**
 * How PELS's write to the charging switch of an Easee under built-in control
 * reaches the charger: as a charger current, or as the app's own switch.
 *
 * The Easee app turns `evcharger_charging = false` into its `stop_charging`
 * command, which ends the charging session: a charger that authorises by RFID
 * then needs its card again, and every restart begins a new session at the
 * charger's maximum current (32 A) until PELS lowers it. A dynamic charger
 * current below 6 A pauses the charger instead (Easee mode `Paused`, published
 * as `plugged_in_paused`) and keeps the session, so:
 *
 * - **off** writes 0 A. The app reports the paused charger with
 *   `evcharger_charging = false`, so the observation PELS waits for is the one
 *   it asked for.
 * - **on**, for a charger whose session is still open, writes 6 A, the
 *   smallest current it charges at. PELS sets its planned level from there with
 *   its ordinary step commands.
 * - **on** for a stopped session goes to the switch, which starts a new one: a
 *   charger stopped outside PELS, in the Easee app or by the car, still gets
 *   its session started again.
 */
type EaseeSwitchWrite =
  | { kind: 'current'; write: CapabilityWrite }
  | { kind: 'switch' };

const PAUSE: EaseeSwitchWrite = {
  kind: 'current',
  write: { capabilityId: EASEE_CHARGER_CURRENT_CAPABILITY_ID, value: 0 },
};
const RESUME: EaseeSwitchWrite = {
  kind: 'current',
  write: { capabilityId: EASEE_CHARGER_CURRENT_CAPABILITY_ID, value: EASEE_MIN_CHARGING_CURRENT_A },
};
const START_SESSION: EaseeSwitchWrite = { kind: 'switch' };

/** For a charger `isEaseeUnderBuiltInControl` admits. */
export function resolveEaseeSwitchWrite(snapshot: TransportDeviceSnapshot, desired: boolean): EaseeSwitchWrite {
  if (!desired) return PAUSE;
  return isSessionOpen(snapshot) ? RESUME : START_SESSION;
}

/**
 * The charging session is still open: paused, or charging. A current resumes a
 * paused one and a start command would open a new session instead, even while
 * the charger holds off after a current was raised. Easee waits about 5 minutes
 * before it offers the car current again (production, 2026-09-25: 08:11:26 to
 * 08:16:27 and 08:50:58 to 08:55:55), longer than PELS waits for a switch to
 * confirm, so a retry must not become a start.
 */
function isSessionOpen(snapshot: TransportDeviceSnapshot): boolean {
  return snapshot.evChargingState === 'plugged_in_paused'
    || snapshot.evChargingState === 'plugged_in_charging';
}

/** An Easee charger whose current PELS writes itself (built-in device control on). */
export function isEaseeUnderBuiltInControl(
  snapshot: Pick<TransportDeviceSnapshot, 'controlAdapter' | 'capabilities'>,
): boolean {
  return isNativeSteppedLoadControlEnabled(snapshot)
    && snapshot.capabilities?.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID) === true;
}

/**
 * The charging switch PELS reads for an Easee under built-in control: the app's
 * own `evcharger_charging`, but never on while the charger reports itself
 * paused.
 *
 * The app publishes its switch only when the charger mode changes, and Homey
 * keeps PELS's last write to it until then: in production (2026-09-25) a
 * charger went to `Paused` while PELS's start was in flight, never charged, and
 * held PELS's `true`, so PELS read a charger allocating 0 A as running at 6 A.
 * The plug state comes from the same mode and is never written. A current set
 * below 6 A anywhere (the owner in the Easee app, say) pauses the charger, and
 * the switch reads off once the app reports it paused, seconds later.
 *
 * A switch forced off is dated by the plug state that forced it.
 */
export function withEaseeObservedCharging(capabilityObj: DeviceCapabilityMap): DeviceCapabilityMap {
  const charging = capabilityObj.evcharger_charging;
  const state = capabilityObj.evcharger_charging_state;
  if (charging?.value !== true || state?.value !== 'plugged_in_paused') return capabilityObj;
  return {
    ...capabilityObj,
    evcharger_charging: { ...charging, value: false, lastUpdated: state.lastUpdated },
  };
}

/**
 * The realtime events an Easee under built-in control reports, with its
 * charging switch read the way `withEaseeObservedCharging` reads it: the app's
 * switch reporting on reads as off while the last plug state is paused, and a
 * plug-state change also reports the switch, since the app derives both from
 * the same charger mode and may send its switch before the plug state. For a
 * charger `isEaseeUnderBuiltInControl` admits.
 */
export function resolveEaseeRealtimeUpdates(
  snapshot: Pick<TransportDeviceSnapshot, 'evChargingState'>,
  capabilityId: string,
  value: unknown,
): Array<{ capabilityId: string; value: unknown }> {
  const event = { capabilityId, value };
  switch (capabilityId) {
    case 'evcharger_charging':
      return [switchEvent(value === true && snapshot.evChargingState !== 'plugged_in_paused')];
    case 'evcharger_charging_state':
      return [event, switchEvent(value === 'plugged_in_charging')];
    default:
      return [event];
  }
}

function switchEvent(charging: boolean): { capabilityId: string; value: unknown } {
  return { capabilityId: 'evcharger_charging', value: charging };
}
