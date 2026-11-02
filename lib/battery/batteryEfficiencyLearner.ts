/**
 * Measures each Main-home battery's round-trip efficiency from what it does,
 * whoever drives it (PELS or the battery's own mode), so the device page can
 * offer it beside the configured value. The plan never reads it.
 *
 * A measured cycle is a closed span between two moments when the reported
 * charge level enters the same percent from the same direction. Stored energy
 * is then the same at both ends, so the AC energy the battery returned divided
 * by the AC energy it took in is the round trip, whatever the usable capacity
 * is (the configured capacity is not used). Entering the same percent from the
 * same side puts both ends on the same rounding boundary of the battery's own
 * level, so the integer level adds no bias.
 *
 * Energy is integrated from the battery's own signed power reading on each
 * Main meter sample, holding the previous reading over the interval. Anything
 * that makes that integral untrustworthy abandons the span rather than
 * guessing: a missing or unavailable reading, a sample gap, or a nonzero power
 * reading that has not been refreshed for a long time. Accepted results are
 * kept, so a missed sample only costs the cycle in progress.
 */
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { BatteryEfficiencyMeasurement } from '../../packages/contracts/src/continuousBatteryPlan';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { BatteryEfficiencyCycles, BatteryEfficiencyStore } from '../ports/batteryEfficiencyStore';

const logger = getLogger('battery');

/**
 * Plausible round trip for a home battery with its inverter. Above 1 the
 * battery returned more than it took in, which only a drifting level estimate
 * or a power-sensor offset produces; below 0.6 standby drain or a bad sensor
 * dominates. Both bounds sit inside the configurable 50-100 %.
 */
export const BATTERY_EFFICIENCY_MIN = 0.6;
export const BATTERY_EFFICIENCY_MAX = 1;
/** Results kept per battery; the suggestion is their median, so one odd cycle cannot move it. */
export const BATTERY_EFFICIENCY_RETAINED_CYCLES = 5;
/** A persisted row is taken only as the learner would have written it; anything else is the store's own damage. */
export const acceptBatteryEfficiencyCyclesRow = (value: unknown): readonly number[] | undefined => (
  Array.isArray(value) && value.length > 0 && value.length <= BATTERY_EFFICIENCY_RETAINED_CYCLES
  && value.every(entry => typeof entry === 'number' && Number.isFinite(entry)
    && entry >= BATTERY_EFFICIENCY_MIN && entry <= BATTERY_EFFICIENCY_MAX)
    ? value as number[] : undefined
);
/** Cycles needed before PELS suggests a value. */
export const BATTERY_EFFICIENCY_MIN_CYCLES = 3;
/**
 * The level must travel at least this far between the span's ends. A battery's
 * level is its own estimate, typically good to a percent or two; across 20
 * percentage points that error stays a few percent of the measured energy.
 */
const MIN_EXCURSION_PERCENT = 20;
/** Longer spans mostly measure self-discharge and standby, not the round trip. */
const MAX_SPAN_MS = 72 * 60 * 60 * 1000;
/** A longer gap between meter samples leaves the integral unknown. */
const MAX_SAMPLE_GAP_MS = 5 * 60 * 1000;
/** A nonzero power reading older than this is no longer evidence of what flows now. */
const MAX_POWER_READING_AGE_MS = 15 * 60 * 1000;
const IDLE_POWER_W = 50;
const MS_PER_HOUR = 3_600_000;

type Span = {
  anchorPercent: number;
  direction: 'up' | 'down';
  startedAtMs: number;
  inKWh: number;
  outKWh: number;
  minPercent: number;
  maxPercent: number;
};

type Tracking = { atMs: number; percent: number; signedW: number; span: Span | null };

type Reading = { percent: number; signedW: number };

/** Median of a non-empty list: the upper middle value for an even count, so a suggestion is always a measured cycle. */
const median = (values: readonly [number, ...number[]]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? values[0];
};

const readingOf = (device: DeviceSurfaces, nowMs: number): Reading | null => {
  const power = device.batteryPower;
  const level = device.batteryLevel;
  if (!device.available || power === undefined || level === undefined) return null;
  if (Math.abs(power.signedW) > IDLE_POWER_W && nowMs - power.observedAtMs > MAX_POWER_READING_AGE_MS) return null;
  return { percent: Math.round(level.percent), signedW: power.signedW };
};

const startSpan = (percent: number, direction: Span['direction'], atMs: number): Span => ({
  anchorPercent: percent, direction, startedAtMs: atMs, inKWh: 0, outKWh: 0, minPercent: percent, maxPercent: percent,
});

export class BatteryEfficiencyLearner {
  private readonly tracking = new Map<string, Tracking>();
  /** Persisted results once the store has been read; read lazily, and again after a failed read. */
  private cycles: BatteryEfficiencyCycles | null = null;

  constructor(
    private readonly store: BatteryEfficiencyStore,
    private readonly getBatteries: () => readonly DeviceSurfaces[],
  ) {}

  /** Main meter tap: one integration step for every managed Main-home battery. */
  recordSample(nowMs: number): void {
    const seen = new Set<string>();
    for (const device of this.getBatteries()) {
      if (device.deviceClass !== 'battery' || !device.managed) continue;
      seen.add(device.id);
      this.step(device.id, readingOf(device, nowMs), nowMs);
    }
    for (const deviceId of this.tracking.keys()) {
      if (!seen.has(deviceId)) this.tracking.delete(deviceId);
    }
  }

  read(deviceId: string): BatteryEfficiencyMeasurement {
    this.cycles ??= this.readStore();
    if (this.cycles === null) return { status: 'unavailable' };
    const results = this.cycles.get(deviceId) ?? [];
    const [first, ...rest] = results;
    if (first === undefined || results.length < BATTERY_EFFICIENCY_MIN_CYCLES) {
      return { status: 'measuring', cycles: results.length, cyclesNeeded: BATTERY_EFFICIENCY_MIN_CYCLES };
    }
    return {
      status: 'measured',
      roundTripEfficiency: Math.round(median([first, ...rest]) * 100) / 100,
      cycles: results.length,
    };
  }

  private step(deviceId: string, reading: Reading | null, nowMs: number): void {
    const previous = this.tracking.get(deviceId);
    if (reading === null) {
      this.tracking.delete(deviceId);
      return;
    }
    if (previous === undefined || nowMs - previous.atMs > MAX_SAMPLE_GAP_MS) {
      this.tracking.set(deviceId, { atMs: nowMs, percent: reading.percent, signedW: reading.signedW, span: null });
      return;
    }
    if (nowMs <= previous.atMs) return;
    let span = previous.span;
    if (span !== null) {
      const energyKWh = previous.signedW * (nowMs - previous.atMs) / MS_PER_HOUR / 1000;
      span = energyKWh >= 0
        ? { ...span, inKWh: span.inKWh + energyKWh }
        : { ...span, outKWh: span.outKWh - energyKWh };
      if (nowMs - span.startedAtMs > MAX_SPAN_MS) span = null;
    }
    span = this.onLevel(deviceId, span, previous.percent, reading.percent, nowMs);
    this.tracking.set(deviceId, { atMs: nowMs, percent: reading.percent, signedW: reading.signedW, span });
  }

  /** Anchors, extends or closes the span on a level change; only a one-percent step marks a boundary. */
  private onLevel(deviceId: string, span: Span | null, from: number, to: number, nowMs: number): Span | null {
    if (to === from) return span;
    const widened = span === null ? null : {
      ...span, minPercent: Math.min(span.minPercent, to), maxPercent: Math.max(span.maxPercent, to),
    };
    if (Math.abs(to - from) !== 1) return widened;
    const direction = to > from ? 'up' : 'down';
    if (widened === null) return startSpan(to, direction, nowMs);
    if (widened.anchorPercent !== to || widened.direction !== direction
      || widened.maxPercent - widened.minPercent < MIN_EXCURSION_PERCENT) return widened;
    this.close(deviceId, widened, nowMs);
    return startSpan(to, direction, nowMs);
  }

  private close(deviceId: string, span: Span, nowMs: number): void {
    const efficiency = span.inKWh > 0 ? span.outKWh / span.inKWh : Number.NaN;
    const details = {
      deviceId,
      inKWh: Math.round(span.inKWh * 1000) / 1000,
      outKWh: Math.round(span.outKWh * 1000) / 1000,
      excursionPercent: span.maxPercent - span.minPercent,
      durationMs: nowMs - span.startedAtMs,
    };
    if (!(efficiency >= BATTERY_EFFICIENCY_MIN && efficiency <= BATTERY_EFFICIENCY_MAX)) {
      logger.info({ event: 'battery_efficiency_cycle_rejected', ...details });
      return;
    }
    logger.info({ event: 'battery_efficiency_cycle_measured', ...details, roundTripEfficiency: efficiency });
    this.cycles ??= this.readStore();
    if (this.cycles === null) return;
    const results = [...(this.cycles.get(deviceId) ?? []), efficiency].slice(-BATTERY_EFFICIENCY_RETAINED_CYCLES);
    const next = new Map(this.cycles);
    next.set(deviceId, results);
    try {
      this.store.write(next);
      this.cycles = next;
    } catch (error) {
      logger.warn({ event: 'battery_efficiency_store_write_failed', deviceId, err: normalizeError(error) });
    }
  }

  /** The persisted results, or null while the store cannot be read: a write then could drop other batteries. */
  private readStore(): BatteryEfficiencyCycles | null {
    try {
      return this.store.read();
    } catch (error) {
      logger.warn({ event: 'battery_efficiency_store_read_failed', err: normalizeError(error) });
      return null;
    }
  }
}
