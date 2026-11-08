import type { MainFuse } from '../../packages/contracts/src/capacitySettings';
import type { SettingsUiPhaseLoad } from '../../packages/contracts/src/settingsUi/power';
import type { MeterPhasesRead, PhaseTriple } from '../ports/homeMeterReadings';

export type PhaseLoad = {
  readonly phase: 'L1' | 'L2' | 'L3';
  /** Load on the phase, kW. Signed (positive import) when `signed`; a magnitude otherwise. */
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
    /** False for a current-only meter, which cannot say which way a phase flows. */
    readonly signed: boolean;
    readonly acceptedAtMs: number;
  };

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

const toLoads = (read: Extract<MeterPhasesRead, { state: 'read' }>): PhaseReadingLoads => {
  const { powerW, currentA, voltageV } = read;
  const load = (index: 0 | 1 | 2): PhaseLoad => ({
    phase: (['L1', 'L2', 'L3'] as const)[index],
    kw: (powerW ? powerW[index] : (currentA as PhaseTriple)[index] * voltageAt(voltageV, index)) / 1000,
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

  current(): PhaseReading {
    return this.reading;
  }

  /** The meter's measure capabilities as last read, for diagnostics. */
  meterCapabilityIds(): readonly string[] {
    return this.capabilityIds;
  }

  /** One meter read, taken with the net sample it is judged against. */
  admit(read: MeterPhasesRead, netW: number, nowMs: number): void {
    // A failed read is no evidence about the meter: the last picture stands.
    if (read.state === 'unavailable') return;
    this.capabilityIds = read.capabilityIds;
    if (read.state === 'none') {
      this.reading = { kind: 'none' };
      this.previous = null;
      this.rejections = 0;
      return;
    }
    const values = read.powerW ?? read.currentA;
    if (values === undefined) return;
    const frozen = this.previous !== null
      && sameTriple(this.previous.values, values)
      && Math.abs(this.previous.netW - netW) > FROZEN_NET_MOVE_W;
    const agrees = read.powerW
      ? Math.abs(sum(read.powerW) - netW) <= toleranceW(sumAbs(read.powerW))
      : currentsAgree(values, read.voltageV, netW);
    this.previous = { netW, values };
    if (agrees && !frozen) {
      this.rejections = 0;
      this.reading = { kind: 'healthy', phases: toLoads(read), signed: read.powerW !== undefined, acceptedAtMs: nowMs };
      return;
    }
    this.rejections += 1;
    if (this.reading.kind !== 'healthy' || this.rejections >= REJECTIONS_BEFORE_DEGRADED) {
      this.reading = { kind: 'degraded' };
    }
  }
}

/** A phase's load in amps: measured when the meter reports it, derived at nominal voltage otherwise. */
const phaseAmps = (load: PhaseLoad): number => load.currentA ?? Math.abs(load.kw) * 1000 / NOMINAL_VOLTAGE_V;

/** The settings UI's view: only a three-phase fuse with trusted phases has anything to show. */
export function projectPhaseLoadForUi(reading: PhaseReading, fuse: MainFuse): SettingsUiPhaseLoad {
  if (reading.kind !== 'healthy' || fuse.kind !== 'on' || fuse.supply !== 'three_phase_neutral') {
    return { state: 'none' };
  }
  return {
    state: 'phases',
    fuseAmps: fuse.amps,
    phases: reading.phases.map((load) => ({ phase: load.phase, amps: phaseAmps(load) })),
  };
}
