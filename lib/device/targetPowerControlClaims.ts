import type { HomeyDeviceLike } from '../utils/types';
import { isHomeBatteryDevice, isSolarPanelDevice } from './managerEnergy';

/**
 * Whether Homey holds a device's watt target (`target_power_mode`), for the
 * devices PELS steps through `target_power`.
 *
 * The mode is Homey's, not PELS's: `homey` means the device carries out the
 * watt target Homey sets, and any other value means the device controls its own
 * power and ignores it. A device PELS manages is therefore claimed for Homey
 * whenever its mode reads anything else, an unknown value included, and is then
 * left there. PELS never writes another mode.
 *
 * - `held`: the mode reads `homey`, or a claim Homey accepted is still landing.
 * - `needed`: the mode reads anything else. The plan decides the claim and the
 *   executor writes it (`requestTargetPowerControlClaim`).
 * - `refused`: the device's app rejected the claim, or put the mode back
 *   within `CLAIM_LANDING_MS`. The device is parsed without its watt control
 *   (`withheldCapabilities`), so it is planned through its switch alone, and
 *   the claim is tried again after 15, 30, then 60 minutes.
 *
 * A battery or solar inverter is claimed by its own owner and is never read here.
 */
export type TargetPowerControlClaim = 'held' | 'needed' | 'refused';

const WITHHELD: readonly string[] = ['target_power', 'target_power_mode'];
const NOTHING: readonly string[] = [];
const CLAIM_LANDING_MS = 60_000;
const RETRY_DELAYS_MS = [15, 30, 60].map((minutes) => minutes * 60_000);

type ClaimRecord = {
  /** When Homey accepted a claim whose `homey` reading has not arrived yet. */
  acceptedAtMs?: number;
  failures: number;
  retryAtMs?: number;
};

export class TargetPowerControlClaims {
  private readonly records = new Map<string, ClaimRecord>();

  /** The claim state of `device` as last read, or `undefined` for a device with no watt mode to claim. */
  resolve(device: HomeyDeviceLike, nowMs: number): TargetPowerControlClaim | undefined {
    if (!hasClaimableWattMode(device)) return undefined;
    const record = this.records.get(device.id);
    if (device.capabilitiesObj.target_power_mode?.value === 'homey') {
      // Kept through the landing window, so an app that reports `homey` and then
      // puts its own mode back within it reads as a refusal below.
      if (record && !isLanding(record, nowMs)) this.records.delete(device.id);
      return 'held';
    }
    if (record?.retryAtMs !== undefined) {
      if (nowMs < record.retryAtMs) return 'refused';
      this.records.set(device.id, { failures: record.failures });
      return 'needed';
    }
    if (record?.acceptedAtMs === undefined) return 'needed';
    if (isLanding(record, nowMs)) return 'held';
    // Homey accepted the claim and the device still reads another mode: its app put it back.
    this.noteRefused(device.id, nowMs);
    return 'refused';
  }

  noteAccepted(deviceId: string, nowMs: number): void {
    this.records.set(deviceId, { failures: this.records.get(deviceId)?.failures ?? 0, acceptedAtMs: nowMs });
  }

  noteRefused(deviceId: string, nowMs: number): void {
    const failures = (this.records.get(deviceId)?.failures ?? 0) + 1;
    const delayMs = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] ?? 0;
    this.records.set(deviceId, { failures, retryAtMs: nowMs + delayMs });
  }

  /** The capabilities a refused device is parsed without: it has no watt control to plan on. */
  withheldCapabilities(device: HomeyDeviceLike, nowMs: number): readonly string[] {
    return this.resolve(device, nowMs) === 'refused' ? WITHHELD : NOTHING;
  }

  retainDevices(deviceIds: ReadonlySet<string>): void {
    for (const id of this.records.keys()) if (!deviceIds.has(id)) this.records.delete(id);
  }
}

function isLanding(record: ClaimRecord, nowMs: number): boolean {
  return record.acceptedAtMs !== undefined && nowMs - record.acceptedAtMs < CLAIM_LANDING_MS;
}

function hasClaimableWattMode(device: HomeyDeviceLike): boolean {
  if (!device.capabilities.includes('target_power') || !device.capabilities.includes('target_power_mode')) return false;
  if (device.capabilitiesObj.target_power?.setable !== true) return false;
  if (device.capabilitiesObj.target_power_mode?.setable !== true) return false;
  return !isHomeBatteryDevice(device) && !isSolarPanelDevice(device);
}
