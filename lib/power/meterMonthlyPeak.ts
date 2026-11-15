import { getDebugEmitter } from '../logging/logger';
import type { MeterMonthlyPeakRead } from '../ports/homeMeterReadings';

const emitDebug = getDebugEmitter('power', 'plan');

/**
 * The month peak a home's meter reports itself, as last accepted: the peak in
 * kW and when the meter last changed it. Which month it counts for is
 * `resolveCurrentMonthCapacityPeak`'s answer (`capacityPeak.ts`).
 */
export type MeterMonthlyPeak = { readonly peakKw: number; readonly observedAtMs: number };

/**
 * A meter changes its month peak at most once a quarter, so a minute between
 * reads is soon enough and keeps the poll from reading every meter device on
 * every sample.
 */
export const METER_MONTHLY_PEAK_READ_INTERVAL_MS = 60 * 1000;

/**
 * Every home's meter-reported month peak, by meter device id, for the
 * Homey Energy poll's meters. One app-wide store: a meter id names one meter
 * whichever home reads it, and a home that changes meter reads the new one's.
 *
 * A read that fails or carries a malformed value leaves the last accepted peak
 * in place; a meter that reports none, or is no longer read, has none.
 */
export class MeterMonthlyPeaks {
  private readonly accepted = new Map<string, MeterMonthlyPeak>();
  private lastReadAtMs: number | null = null;
  /** Main's meter as the poll last requested it; null while Main has none selected. */
  private mainMeterDeviceId: string | null = null;

  /**
   * Read the meters' peaks, at most once per `METER_MONTHLY_PEAK_READ_INTERVAL_MS`.
   * `mainMeterDeviceId` is Main's meter among them, as the poll resolved it.
   */
  async refresh(
    meterDeviceIds: readonly string[],
    mainMeterDeviceId: string | null,
    read: (meterDeviceId: string) => Promise<MeterMonthlyPeakRead>,
    nowMs: number,
  ): Promise<void> {
    this.mainMeterDeviceId = mainMeterDeviceId;
    if (this.lastReadAtMs !== null && nowMs - this.lastReadAtMs < METER_MONTHLY_PEAK_READ_INTERVAL_MS) return;
    this.lastReadAtMs = nowMs;
    const forgotten = Array.from(this.accepted.keys()).filter((id) => !meterDeviceIds.includes(id));
    for (const meterDeviceId of forgotten) this.accepted.delete(meterDeviceId);
    for (const meterDeviceId of meterDeviceIds) {
      this.admit(meterDeviceId, await read(meterDeviceId));
    }
  }

  admit(meterDeviceId: string, read: MeterMonthlyPeakRead): void {
    if (read.state === 'unavailable') return;
    if (read.state === 'none') {
      this.accepted.delete(meterDeviceId);
      return;
    }
    const previous = this.accepted.get(meterDeviceId);
    this.accepted.set(meterDeviceId, { peakKw: read.peakKw, observedAtMs: read.observedAtMs });
    if (previous?.peakKw !== read.peakKw || previous.observedAtMs !== read.observedAtMs) {
      emitDebug({
        event: 'meter_monthly_peak_accepted',
        meterDeviceId,
        peakKw: read.peakKw,
        observedAtMs: read.observedAtMs,
      });
    }
  }

  /** Main's meter's last accepted peak (`current` for the meter the poll last named Main's). */
  currentMain(): MeterMonthlyPeak | null {
    return this.current(this.mainMeterDeviceId);
  }

  /** The meter's last accepted peak; null for no meter or a meter that reports none. */
  current(meterDeviceId: string | null): MeterMonthlyPeak | null {
    return meterDeviceId === null ? null : this.accepted.get(meterDeviceId) ?? null;
  }
}
