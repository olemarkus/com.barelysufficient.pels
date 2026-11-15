import { getDebugEmitter } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
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
  /** The read under way, so a slow meter device never has two. */
  private inFlight: Promise<void> | null = null;
  /** Main's meter as the poll last requested it; null while Main has none selected. */
  private mainMeterDeviceId: string | null = null;

  /**
   * Start reading the meters' peaks without waiting for them: the poll records
   * its samples at once, so a slow or stalled meter device never holds one, and
   * a sample uses the last accepted peak until the read lands.
   */
  refreshInBackground(
    meterDeviceIds: readonly string[],
    mainMeterDeviceId: string | null,
    read: (meterDeviceId: string) => Promise<MeterMonthlyPeakRead>,
    nowMs: number,
  ): void {
    this.refresh(meterDeviceIds, mainMeterDeviceId, read, nowMs).catch((error: unknown) => {
      emitDebug({ event: 'meter_monthly_peak_refresh_failed', error: normalizeError(error).message });
    });
  }

  /**
   * Read the meters' peaks, at most once per `METER_MONTHLY_PEAK_READ_INTERVAL_MS`
   * and one read at a time: a call while a read is under way gets that read.
   * `mainMeterDeviceId` is Main's meter among them, as the poll resolved it.
   */
  refresh(
    meterDeviceIds: readonly string[],
    mainMeterDeviceId: string | null,
    read: (meterDeviceId: string) => Promise<MeterMonthlyPeakRead>,
    nowMs: number,
  ): Promise<void> {
    this.mainMeterDeviceId = mainMeterDeviceId;
    if (this.inFlight !== null) return this.inFlight;
    if (this.lastReadAtMs !== null && nowMs - this.lastReadAtMs < METER_MONTHLY_PEAK_READ_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastReadAtMs = nowMs;
    const reading = this.readAll(meterDeviceIds, read).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = reading;
    return reading;
  }

  private async readAll(
    meterDeviceIds: readonly string[],
    read: (meterDeviceId: string) => Promise<MeterMonthlyPeakRead>,
  ): Promise<void> {
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
