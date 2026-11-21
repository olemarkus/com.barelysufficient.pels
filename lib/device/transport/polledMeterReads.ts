import type { HomeyDeviceLike } from '../../utils/types';

/**
 * How long a poll's read of a meter can stand in for a fresh one. The poll runs
 * every 10 s and its phase read follows within milliseconds, so this only has
 * to cover that sample; anything older is read again.
 */
const POLLED_METER_READ_REUSE_MS = 5_000;

/**
 * The meter payloads the Homey Energy poll just read, kept so the readers that
 * follow the same sample (the main-fuse phases) need not fetch the meter again.
 * Each is taken once: the next sample brings its own read.
 */
export class PolledMeterReads {
  private readonly byId = new Map<string, { device: HomeyDeviceLike; readAtMs: number }>();

  remember(devices: readonly HomeyDeviceLike[], readAtMs: number): void {
    for (const device of devices) this.byId.set(device.id, { device, readAtMs });
  }

  /** The poll's read of this meter, if it is recent enough; it is not handed out again. */
  take(meterDeviceId: string, nowMs: number): HomeyDeviceLike | undefined {
    const entry = this.byId.get(meterDeviceId);
    this.byId.delete(meterDeviceId);
    if (entry === undefined || nowMs - entry.readAtMs > POLLED_METER_READ_REUSE_MS) return undefined;
    return entry.device;
  }
}
