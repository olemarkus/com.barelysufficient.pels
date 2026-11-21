import type { HomeyDeviceLike } from '../../utils/types';

/**
 * How long a poll's read of a meter can stand in for a fresh one. The poll runs
 * every 10 s and its phase and month-peak reads follow within milliseconds, so
 * this only has to cover that sample; anything older is read again.
 */
const POLLED_METER_READ_REUSE_MS = 5_000;

/** A reader that follows the poll's sample and reads the same meter. */
export type PolledMeterReader = 'phases' | 'monthly_peak';

/**
 * The meter payloads the Homey Energy poll just read, kept so the readers that
 * follow the same sample (the main-fuse phases, the meters' month peaks) need
 * not fetch the meter again. Each reader takes a read once: its next read
 * follows the next sample, which brings its own.
 */
export class PolledMeterReads {
  private readonly byId = new Map<string, {
    device: HomeyDeviceLike; readAtMs: number; takenBy: Set<PolledMeterReader>;
  }>();

  remember(devices: readonly HomeyDeviceLike[], readAtMs: number): void {
    for (const device of devices) this.byId.set(device.id, { device, readAtMs, takenBy: new Set() });
  }

  /** The poll's read of this meter, if it is recent enough; it is not handed to `reader` again. */
  take(reader: PolledMeterReader, meterDeviceId: string, nowMs: number): HomeyDeviceLike | undefined {
    const entry = this.byId.get(meterDeviceId);
    if (entry === undefined || entry.takenBy.has(reader)) return undefined;
    if (nowMs - entry.readAtMs > POLLED_METER_READ_REUSE_MS) {
      this.byId.delete(meterDeviceId);
      return undefined;
    }
    entry.takenBy.add(reader);
    return entry.device;
  }
}
