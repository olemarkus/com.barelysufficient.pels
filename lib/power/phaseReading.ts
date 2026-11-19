import type { MainFuse } from '../../packages/contracts/src/capacitySettings';
import type { SettingsUiPhaseLoad } from '../../packages/contracts/src/settingsUi/power';
import type { MeterPhasesRead, PhaseTriple } from '../ports/homeMeterReadings';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { isSamePhaseMeter, type PhaseMeter } from './mainFusePhaseSource';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from './sampleFreshness';

const logger = getLogger('power');

export type PhaseLoad = {
  readonly phase: 'L1' | 'L2' | 'L3';
  /** Phase load in kW, or in kVA for apparent power. Positive means import when direction is known. */
  readonly kw: number;
  /** Measured current, when the meter reports it. */
  readonly currentA?: number;
};

/**
 * What PELS knows about the phases. `none`: the meter reports no phases.
 * `degraded`: it does, but they cannot be trusted, so only the total applies.
 */
export type PhaseReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'degraded' }
  | {
    readonly kind: 'healthy';
    readonly phases: readonly [PhaseLoad, PhaseLoad, PhaseLoad];
    readonly basis: 'active_power' | 'apparent_power' | 'current';
    readonly acceptedAtMs: number;
  };

type PhaseReadingEvent = { kind: 'reading'; reading: PhaseReading } | { kind: 'source_reset' };
type PhaseReadingObserver = (event: PhaseReadingEvent) => void;

const NOMINAL_VOLTAGE_V = 230;
const SUM_TOLERANCE_MIN_W = 500;
const SUM_TOLERANCE_SHARE = 0.15;
const FROZEN_NET_MOVE_W = 200;
const REJECTIONS_BEFORE_DEGRADED = 6;

const sum = (values: PhaseTriple): number => values[0] + values[1] + values[2];
const sumAbs = (values: PhaseTriple): number => values.reduce((total, value) => total + Math.abs(value), 0);
const sameTriple = (a: PhaseTriple, b: PhaseTriple): boolean => a.every((value, index) => value === b[index]);

const toleranceW = (absoluteW: number): number => Math.max(SUM_TOLERANCE_MIN_W, absoluteW * SUM_TOLERANCE_SHARE);

const voltageAt = (voltageV: PhaseTriple | undefined, index: 0 | 1 | 2): number => {
  const measured = voltageV?.[index];
  return measured !== undefined && measured > 0 ? measured : NOMINAL_VOLTAGE_V;
};

// A current-only meter has no sign, so the check is one-sided: the phases must
// at least be able to carry the net power the home reports.
const currentsAgree = (currentA: PhaseTriple, voltageV: PhaseTriple | undefined, netW: number): boolean => {
  const carriedW = currentA[0] * voltageAt(voltageV, 0)
    + currentA[1] * voltageAt(voltageV, 1)
    + currentA[2] * voltageAt(voltageV, 2);
  return carriedW >= Math.abs(netW) - toleranceW(carriedW);
};

type HealthyPhaseBasis = Extract<PhaseReading, { kind: 'healthy' }>['basis'];

const toLoads = (
  read: Extract<MeterPhasesRead, { state: 'read' }>,
  values: PhaseTriple,
  basis: HealthyPhaseBasis,
): PhaseReadingLoads => {
  const { currentA, voltageV } = read;
  const load = (index: 0 | 1 | 2): PhaseLoad => ({
    phase: (['L1', 'L2', 'L3'] as const)[index],
    kw: (basis === 'current' ? values[index] * voltageAt(voltageV, index) : values[index]) / 1000,
    ...(currentA ? { currentA: currentA[index] } : {}),
  });
  return [load(0), load(1), load(2)];
};
type PhaseReadingLoads = readonly [PhaseLoad, PhaseLoad, PhaseLoad];

/**
 * The accepted per-phase picture for Main's meter. Homey re-dates a capability
 * only when its value changes, so a reading's age proves nothing: a phase set
 * is judged by agreeing with the net sample it arrived with, and by moving when
 * net moves. A rejected set leaves the last accepted one in place until enough
 * rejections in a row make the phases untrustworthy.
 */
export class PhaseReadingTracker {
  private reading: PhaseReading = { kind: 'none' };

  private rejections = 0;

  private previous: { netW: number; values: PhaseTriple } | null = null;

  private capabilityIds: readonly string[] = [];

  private meter: PhaseMeter | null = null;

  private lastReadAtMs = -Infinity;

  private readonly observers = new Set<PhaseReadingObserver>();

  current(): PhaseReading {
    return this.reading;
  }

  currentFrom(meter: PhaseMeter | null): PhaseReading {
    return isSamePhaseMeter(meter, this.meter) ? this.reading : { kind: 'none' };
  }

  subscribe(observer: PhaseReadingObserver): void {
    this.observers.add(observer);
  }

  /** The meter's measure capabilities as last read, for diagnostics. */
  meterCapabilityIds(): readonly string[] {
    return this.capabilityIds;
  }

  /** No meter feeds this home's phases any more: nothing is known about them. */
  reset(): void {
    if (this.meter === null) return;
    this.meter = null;
    this.reading = { kind: 'none' };
    this.previous = null;
    this.rejections = 0;
    this.capabilityIds = [];
    this.lastReadAtMs = -Infinity;
    this.notify({ kind: 'source_reset' });
  }

  private notify(event: PhaseReadingEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (error) {
        logger.error({ event: 'phase_reading_observer_failed', err: normalizeError(error) });
      }
    }
  }

  private publish(reading: PhaseReading): void {
    if (reading.kind !== 'healthy' && this.reading.kind === reading.kind) return;
    this.reading = reading;
    this.notify({ kind: 'reading', reading });
  }

  private noteUnconfirmedRead(): void {
    this.rejections += 1;
    if (this.reading.kind === 'healthy' && this.rejections >= REJECTIONS_BEFORE_DEGRADED) {
      this.publish({ kind: 'degraded' });
    }
  }

  /** A read opened under a different meter or mapping has no current authority. */
  admitCurrent(
    meter: PhaseMeter,
    currentMeter: PhaseMeter | null,
    read: MeterPhasesRead,
    netW: number,
    sampledAtMs: number,
    nowMs: number,
  ): void {
    if (currentMeter !== null && !isSamePhaseMeter(currentMeter, this.meter)) this.reset();
    if (nowMs - sampledAtMs > POWER_SAMPLE_STALE_THRESHOLD_MS) return;
    if (isSamePhaseMeter(meter, currentMeter)) this.admit(meter, read, netW, sampledAtMs);
  }

  /** One meter read, taken with the net sample it is judged against. */
  admit(meter: PhaseMeter, read: MeterPhasesRead, netW: number, sampledAtMs: number): void {
    if (!isSamePhaseMeter(meter, this.meter)) {
      this.reset();
      this.meter = meter;
    }
    if (sampledAtMs < this.lastReadAtMs) return;
    this.lastReadAtMs = sampledAtMs;
    // One failed read leaves the last picture standing, but a meter that keeps
    // failing has stopped confirming it.
    if (read.state === 'unavailable') {
      this.noteUnconfirmedRead();
      return;
    }
    this.capabilityIds = read.capabilityIds;
    if (read.state === 'none') {
      this.publish({ kind: 'none' });
      this.previous = null;
      this.rejections = 0;
      return;
    }
    const values = read.powerW ?? read.apparentPowerVA ?? read.currentA;
    if (values === undefined) return;
    const basis = phaseBasis(read);
    const frozen = this.previous !== null
      && sameTriple(this.previous.values, values)
      && Math.abs(this.previous.netW - netW) > FROZEN_NET_MOVE_W;
    const agrees = basis === 'current'
      ? currentsAgree(values, read.voltageV, netW)
      : Math.abs(sum(values) - netW) <= toleranceW(sumAbs(values));
    this.previous = { netW, values };
    if (agrees && !frozen) {
      this.rejections = 0;
      this.publish({
        kind: 'healthy', phases: toLoads(read, values, basis), basis, acceptedAtMs: sampledAtMs,
      });
      return;
    }
    this.rejections += 1;
    if (this.reading.kind !== 'healthy' || this.rejections >= REJECTIONS_BEFORE_DEGRADED) {
      this.publish({ kind: 'degraded' });
    }
  }
}

function phaseBasis(read: Extract<MeterPhasesRead, { state: 'read' }>): HealthyPhaseBasis {
  if (read.powerW !== undefined) return 'active_power';
  return read.apparentPowerVA === undefined ? 'current' : 'apparent_power';
}

/** A phase's load in amps: measured when the meter reports it, derived at nominal voltage otherwise. */
const phaseAmps = (load: PhaseLoad): number => load.currentA ?? Math.abs(load.kw) * 1000 / NOMINAL_VOLTAGE_V;

export type PhaseDirection = 'import' | 'export';

/** Current magnitude in one direction. Use only for a signed phase set. */
export const directionalPhaseAmps = (load: PhaseLoad, direction: PhaseDirection): number => (
  (direction === 'import' ? load.kw > 0 : load.kw < 0) ? Math.abs(phaseAmps(load)) : 0
);

/** The settings UI's view: only a three-phase fuse with trusted phases has anything to show. */
export function projectPhaseLoadForUi(
  reading: PhaseReading,
  fuse: MainFuse,
  meterCapabilityIds: readonly string[],
): SettingsUiPhaseLoad {
  if (fuse.kind !== 'on' || fuse.supply !== 'three_phase_neutral') {
    // Carried with the fuse off, so the picker can appear the moment it is turned on.
    if (meterCapabilityIds.length === 0) return { state: 'none' };
    if (reading.kind !== 'healthy') return { state: 'none', meterCapabilityIds };
    return {
      state: 'none',
      meterCapabilityIds,
      phasesRecognised: true,
      ...(reading.phases.some((load) => load.currentA === undefined) ? { powerOnly: true } : {}),
    };
  }
  if (reading.kind !== 'healthy') return { state: 'none', meterCapabilityIds };
  return {
    state: 'phases',
    ...(meterCapabilityIds.length > 0 ? { meterCapabilityIds } : {}),
    fuseAmps: fuse.amps,
    ...(reading.phases.some((load) => load.currentA === undefined) ? { powerOnly: true } : {}),
    phases: reading.phases.map((load) => ({
      phase: load.phase,
      amps: phaseAmps(load),
      ...(reading.basis === 'active_power' && load.kw < 0 ? { exporting: true } : {}),
    })),
  };
}
