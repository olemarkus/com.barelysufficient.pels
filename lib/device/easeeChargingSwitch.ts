/**
 * The charging switch of an Easee charger at the SDK seam: how a write to it is
 * carried out and, under built-in device control, how it is read back.
 *
 * Everything above `lib/device` treats `evcharger_charging` as this charger's
 * switch, like any EV charger's. Only here does it become the charger current:
 * PELS pauses the charger with 0 A instead of the app's `stop_charging`, and
 * reads the switch from the plug state and the current instead of from the
 * app's switch. See `notes/native-wiring/README.md`.
 */
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap, DeviceCapabilityValue } from './managerControl';
import { toCapabilityTimestampMs } from './managerControl';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import type { EvChargingState } from '../../packages/contracts/src/types';
import { isEvChargingState } from '../../packages/shared-domain/src/evPlugState';
import {
  EASEE_CHARGER_CURRENT_CAPABILITY_ID,
  EASEE_MIN_CHARGING_CURRENT_A,
  isEaseeChargerCurrentCandidate,
  isNativeSteppedLoadControlEnabled,
  type CapabilityWrite,
} from './nativeSteppedLoadWiring';

/**
 * How PELS's write to an Easee's charging switch reaches the charger: as a
 * charger current, or as the app's own switch.
 *
 * The Easee app turns `evcharger_charging = false` into its `stop_charging`
 * command, which ends the charging session: a charger that authorises by RFID
 * then needs its card again, and every restart begins a new session at the
 * charger's maximum current (32 A) until PELS lowers it. A dynamic charger
 * current below 6 A pauses the charger instead (Easee mode `Awaiting Start`,
 * published as `plugged_in_paused`) and keeps the session, so under built-in
 * control:
 *
 * - **off** writes 0 A.
 * - **on** writes 6 A, the smallest current the charger charges at. PELS sets its
 *   planned level from there with its ordinary step commands.
 * - **on** for a session known to be stopped (`plugged_in`) goes to the switch,
 *   which starts a new one: a charger stopped outside PELS, in the Easee app or
 *   by the car, still gets its session started again.
 *
 * A start is kept for the one state that needs it because a start on an open
 * session opens a new one at 32 A. Easee holds a charger about 5 minutes after a
 * current is raised before it offers the car current (production, 2026-09-25:
 * 08:11:26 to 08:16:27 and 08:50:58 to 08:55:55), longer than PELS waits for the
 * switch to confirm, so a retry sent as a start in that hold reset the charger.
 * A current is harmless on any session: a stopped one just does not start, and
 * the retry comes once the plug state says why.
 *
 * Without built-in control the switch is the app's, with one exception: a
 * session paused below 6 A (PELS's own 0 A pause, say, from before built-in
 * control was turned off) gets 6 A on, since no start command resumes it.
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
const SWITCH: EaseeSwitchWrite = { kind: 'switch' };

/**
 * `trackedDevices` holds each device as Homey last reported it; without built-in
 * control the charger's current is read from there, since the snapshot carries
 * no native step for a charger PELS does not step itself.
 */
export function resolveEaseeSwitchWrite(
  snapshot: TransportDeviceSnapshot,
  trackedDevices: ReadonlyMap<string, HomeyDeviceLike>,
  desired: boolean,
): EaseeSwitchWrite {
  if (isEaseeUnderBuiltInControl(snapshot)) {
    if (!desired) return PAUSE;
    return snapshot.evChargingState === 'plugged_in' ? SWITCH : RESUME;
  }
  const device = trackedDevices.get(snapshot.id);
  if (!desired || device === undefined || snapshot.evChargingState !== 'plugged_in_paused') return SWITCH;
  const capabilityObj = getCapabilityObj(device);
  if (!isEaseeChargerCurrentCandidate(device, capabilityObj)) return SWITCH;
  const currentA = readCurrentA(capabilityObj[EASEE_CHARGER_CURRENT_CAPABILITY_ID]);
  return currentA !== undefined && !holdsChargingCurrent(currentA) ? RESUME : SWITCH;
}

/** A current the charger charges at; below it (0-5 A) the charger pauses. */
function holdsChargingCurrent(currentA: number): boolean {
  return currentA >= EASEE_MIN_CHARGING_CURRENT_A;
}

/**
 * The charging switch as PELS reads it for an Easee under built-in control: on
 * while the charger charges, and while it is paused holding a current it
 * charges at; off otherwise.
 *
 * The app's own `evcharger_charging` is not read. The app derives it from the
 * same charger mode as the plug state (on only in `Charging`) and publishes the
 * two together, so it tells PELS nothing the plug state does not, except for a
 * value PELS wrote itself: Homey keeps a written switch until the app next
 * publishes, which it does only when the charger mode changes (production,
 * 2026-09-25: a charger `Paused` at 0 A still read on).
 *
 * The current is what tells a paused charger PELS switched on from one it
 * switched off. After a resume Easee holds the charger in `Awaiting Start`
 * (`plugged_in_paused`) for about 5 minutes before it offers the car current,
 * so a charger paused at 6 A is on, waiting for Easee, and one paused at 0-5 A
 * is off. A charger still charging is on whatever its current: after PELS's
 * 0 A the switch reads off once Easee reports the pause, when the charger has
 * stopped drawing, not when the current lands.
 */
function isChargingSwitchOn(state: EvChargingState, holdsCurrent: boolean): boolean {
  return state === 'plugged_in_charging' || (state === 'plugged_in_paused' && holdsCurrent);
}

/** An Easee charger whose current PELS writes itself (built-in device control on). */
export function isEaseeUnderBuiltInControl(
  snapshot: Pick<TransportDeviceSnapshot, 'controlAdapter' | 'capabilities'>,
): boolean {
  return isNativeSteppedLoadControlEnabled(snapshot)
    && snapshot.capabilities?.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID) === true;
}

/**
 * `capabilityObj` with its charging switch read the way `isChargingSwitchOn`
 * reads it, for a charger `isEaseeUnderBuiltInControl` admits. The switch is
 * dated by the facts it was read from: the plug state, and for a paused charger
 * the current too, whichever Homey updated last. The read contract admits no
 * Easee read without both (`transport/deviceReadContract.ts`), so both are here.
 */
export function withEaseeObservedCharging(capabilityObj: DeviceCapabilityMap): DeviceCapabilityMap {
  const charging = capabilityObj.evcharger_charging;
  const state = capabilityObj.evcharger_charging_state;
  const stateValue = state?.value;
  if (charging === undefined || state === undefined || !isEvChargingState(stateValue)) return capabilityObj;
  const current = capabilityObj[EASEE_CHARGER_CURRENT_CAPABILITY_ID];
  const currentA = readCurrentA(current);
  const on = isChargingSwitchOn(stateValue, currentA !== undefined && holdsChargingCurrent(currentA));
  const datedBy = stateValue === 'plugged_in_paused' && current !== undefined ? latestOf(state, current) : state;
  return {
    ...capabilityObj,
    evcharger_charging: { ...charging, value: on, lastUpdated: datedBy.lastUpdated },
  };
}

/**
 * The realtime events an Easee under built-in control reports, with its
 * charging switch read the way `isChargingSwitchOn` reads it. The app's own
 * switch events are dropped; a plug-state or current report carries the switch
 * it implies. A malformed plug state or current passes through alone, for the
 * handlers that drop it, and implies nothing. For a charger
 * `isEaseeUnderBuiltInControl` admits.
 *
 * A pause report is read against the current the charger holds, which is the
 * level `reportedStepId` reads from it (0-5 A is the off step). Every current
 * report sets that level, PELS's own included: Homey's echo of a current PELS
 * wrote is the current the charger now holds (`transport/nativeSteppedRealtime.ts`).
 * With no level read, a pause report says nothing about the switch.
 */
export function resolveEaseeRealtimeUpdates(
  snapshot: Pick<TransportDeviceSnapshot, 'evChargingState' | 'reportedStepId' | 'steppedLoadProfile'>,
  capabilityId: string,
  value: unknown,
): Array<{ capabilityId: string; value: unknown }> {
  const event = { capabilityId, value };
  switch (capabilityId) {
    case 'evcharger_charging':
      return [];
    case 'evcharger_charging_state': {
      if (!isEvChargingState(value)) return [event];
      if (value !== 'plugged_in_paused') return [event, switchEvent(isChargingSwitchOn(value, false))];
      const { reportedStepId, steppedLoadProfile } = snapshot;
      if (reportedStepId === undefined || steppedLoadProfile === undefined) return [event];
      return [event, switchEvent(!isSteppedLoadOffStep(steppedLoadProfile, reportedStepId))];
    }
    case EASEE_CHARGER_CURRENT_CAPABILITY_ID: {
      const currentA = readCurrentA({ value });
      const state = snapshot.evChargingState;
      if (currentA === undefined || state === undefined) return [event];
      return [event, switchEvent(isChargingSwitchOn(state, holdsChargingCurrent(currentA)))];
    }
    default:
      return [event];
  }
}

function switchEvent(charging: boolean): { capabilityId: string; value: unknown } {
  return { capabilityId: 'evcharger_charging', value: charging };
}

function readCurrentA(current: Pick<DeviceCapabilityValue, 'value'> | undefined): number | undefined {
  const value = current?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function latestOf(first: DeviceCapabilityValue, second: DeviceCapabilityValue): DeviceCapabilityValue {
  const firstMs = toCapabilityTimestampMs(first.lastUpdated) ?? Number.NEGATIVE_INFINITY;
  const secondMs = toCapabilityTimestampMs(second.lastUpdated) ?? Number.NEGATIVE_INFINITY;
  return secondMs > firstMs ? second : first;
}

function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as DeviceCapabilityMap
    : {};
}
