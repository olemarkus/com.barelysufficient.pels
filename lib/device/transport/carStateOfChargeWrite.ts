import type { DeviceStateOfChargeSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

/**
 * The two rules that govern a CAR-sourced battery level once it is on a charger:
 * when a write is worth telling consumers about, and when it goes away.
 *
 * Kept apart from `stateOfCharge.ts`, which resolves what the CHARGER itself
 * reports, so "a charger reading never displaces a car reading" stays a rule you
 * can read rather than infer. Design of record: `notes/ev-car-link/README.md`.
 */

/**
 * Whether a car-sourced write is worth telling consumers about.
 *
 * Provenance counts: swapping which car supplies the level, or taking over from
 * a charger-owned reading, must still reach consumers even when the percentage
 * happens to match — the dispatch is gated on this answer.
 */
export function hasCarStateOfChargeChanged(
  previous: DeviceStateOfChargeSnapshot | undefined,
  next: DeviceStateOfChargeSnapshot,
  carId: string,
): boolean {
  if (!previous) return true;
  if (previous.source !== 'car' || previous.sourceDeviceId !== carId) return true;
  return previous.percent !== next.percent
    || previous.observedAtMs !== next.observedAtMs
    || previous.status !== next.status;
}

/**
 * Drops a car-sourced level when the association ends.
 *
 * Removed rather than aged out: with no car there is no battery to report, and
 * leaving the last percentage behind would show a departed car's charge as this
 * charger's. Only ever clears a reading the car produced — a charger's own
 * native or flow-reported level is untouched.
 */
export function clearCarStateOfCharge(params: { snapshot: TransportDeviceSnapshot }): boolean {
  const { snapshot } = params;
  if (snapshot.stateOfCharge?.source !== 'car') return false;
  snapshot.stateOfCharge = undefined;
  return true;
}
