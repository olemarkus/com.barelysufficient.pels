import type { CapabilityWrite } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { toCapabilityTimestampMs } from '../managerControl';

/**
 * Zaptec's answer to a turn-on when the car stopped the session itself. The app
 * publishes the same `plugged_in_paused` for a session PELS paused and for one
 * the car stopped, and resumes only the first. The answer is the only place the
 * difference reaches Homey (observed on a Zaptec Go, 2026-11-14).
 */
const CAR_STOPPED_REFUSAL = 'not Paused nor Scheduled';

/** The switch writes that start a Zaptec session: the standard one and the app's own before 1.11. */
const SWITCH_CAPABILITY_IDS: ReadonlySet<string> = new Set(['evcharger_charging', 'charging_button']);

/**
 * The reports that say what the session is doing. Any one of them supersedes a
 * refusal: the app publishes them together on every change of its operation
 * mode, so the car asking again, a plug-out or a pause all arrive as one.
 */
const SESSION_REPORT_IDS: ReadonlySet<string> = new Set([
  'evcharger_charging_state', 'evcharger_charging', 'charge_mode', 'charging_button',
  'alarm_generic.car_connected',
]);

const isSwitchWrite = (write: CapabilityWrite, value: boolean): boolean => (
  SWITCH_CAPABILITY_IDS.has(write.capabilityId) && write.value === value
);

/**
 * The plug sessions a Zaptec told PELS the car stopped, owned by its transport.
 *
 * A refused turn-on with Zaptec's car-stopped answer turns the app's
 * `plugged_in_paused` into `plugged_in_car_stopped`: PELS sends no turn-on the
 * charger would refuse, and the charger starts charging again by itself when
 * the car asks. Held only while nothing newer is known. Any session report,
 * a full read whose session report is newer than the refusal, PELS's own
 * accepted pause, the device leaving the inventory or an app restart ends it,
 * and the app's own state then stands.
 */
type CarStop = { kind: 'refused'; atMs: number } | { kind: 'released' };

export class ZaptecCarStops {
  private readonly stops = new Map<string, CarStop>();

  /** Whether the device is read through {@link project}: car-stopped, or released and not yet projected back. */
  has(deviceId: string): boolean { return this.stops.has(deviceId); }

  /** Whether the refusal is Zaptec's car-stopped answer to a turn-on, now recorded. */
  noteRefused(deviceId: string, write: CapabilityWrite, message: string, atMs: number): boolean {
    if (!isSwitchWrite(write, true) || !message.includes(CAR_STOPPED_REFUSAL)) return false;
    const known = this.stops.get(deviceId)?.kind === 'refused';
    this.stops.set(deviceId, { kind: 'refused', atMs });
    return !known;
  }

  /** PELS's own pause landed: a resume lands on that session again. */
  noteAccepted(deviceId: string, write: CapabilityWrite): boolean {
    return isSwitchWrite(write, false) && this.release(deviceId);
  }

  noteReport(deviceId: string, capabilityId: string): void {
    if (SESSION_REPORT_IDS.has(capabilityId)) this.release(deviceId);
  }

  /** A full read: a session report dated after the refusal supersedes it. */
  noteRead(device: HomeyDeviceLike): void {
    const stop = this.stops.get(device.id);
    if (stop?.kind !== 'refused') return;
    const newer = [...SESSION_REPORT_IDS].some((capabilityId) => {
      const reportedAtMs = toCapabilityTimestampMs(device.capabilitiesObj[capabilityId]?.lastUpdated);
      return reportedAtMs !== undefined && reportedAtMs > stop.atMs;
    });
    if (newer) this.release(device.id);
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.stops.keys()) if (!ids.has(id)) this.stops.delete(id);
  }

  /**
   * Car-stopped reads the app's paused state as `plugged_in_car_stopped`. Any
   * other state is newer news: it stands and ends the stop, so a later pause by
   * someone else is not read as the car's (a full read reaches
   * {@link noteRead} only while the live feed is trusted, and this does not
   * depend on it). A released stop gives the paused state back once, so a report
   * that superseded it without changing the state (Homey publishes no unchanged
   * value) does not leave the device reading car-stopped.
   */
  project(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const stop = this.stops.get(snapshot.id);
    if (stop === undefined) return snapshot;
    const state = snapshot.evChargingState;
    if (stop.kind === 'released' || (state !== 'plugged_in_paused' && state !== 'plugged_in_car_stopped')) {
      this.stops.delete(snapshot.id);
      return state === 'plugged_in_car_stopped' ? { ...snapshot, evChargingState: 'plugged_in_paused' } : snapshot;
    }
    return state === 'plugged_in_paused' ? { ...snapshot, evChargingState: 'plugged_in_car_stopped' } : snapshot;
  }

  private release(deviceId: string): boolean {
    if (this.stops.get(deviceId)?.kind !== 'refused') return false;
    this.stops.set(deviceId, { kind: 'released' });
    return true;
  }
}
