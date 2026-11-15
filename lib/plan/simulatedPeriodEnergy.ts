/**
 * The energy PELS would have kept off the meter in capacity simulation.
 *
 * In simulation (`capacity_dry_run`) nothing is limited, so the meter, and the
 * period energy the power tracker sums from it, runs as if PELS were not there.
 * Pacing from that energy makes a simulated hour run ahead of the hour live
 * control would have had: the capacity pace and the daily budget pace fall
 * faster, and simulation limits devices live control would have left running.
 *
 * This ledger is the planner's own bookkeeping about its own simulated
 * decisions. Each simulated build leaves the relief its plan holds (what the
 * devices it holds would stop drawing); the next build accrues that relief over
 * the interval the tracker has since counted, per hour and per quarter. While
 * simulating, the planner paces from a view of the tracker with that energy
 * taken off (`planningView`). It is never written back: usage history, budgets,
 * learning and the energy shown on the Overview keep the measured figures.
 *
 * In memory only, like the shed-plan latch: after a restart the simulated
 * period paces from measured energy until its next simulated decisions. It is
 * cleared as soon as a build actuates.
 */
import type { PowerTrackerState } from '../power/tracker';
import { getHourBucketKey } from '../utils/hourBuckets';
import { CAPACITY_QUARTER_MS } from '../../packages/shared-domain/src/settings/capacityPeriod';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { DevicePlanDevice } from './planTypes';
import { isMeteredPlanDevice } from './planMeteredDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';

const HOUR_MS = 60 * 60 * 1000;
/** Hours older than this cannot pace anything: the daily budget's day is the longest window. */
const RETAINED_MS = 48 * HOUR_MS;

type HeldRelief = {
  /** The reading the holding plan decided on: relief counts from here. */
  fromMs: number;
  reliefKw: number;
};

export class SimulatedPeriodEnergy {
  private readonly avoidedKWhByHour = new Map<string, number>();
  private avoidedQuarter: { startMs: number; kWh: number } | null = null;
  private held: HeldRelief | null = null;

  /**
   * Count the last simulated plan's relief over the time the tracker has
   * counted since it decided, up to the tracker's latest sample.
   */
  accrue(tracker: PowerTrackerState): void {
    const untilMs = tracker.lastTimestamp;
    if (this.held === null || typeof untilMs !== 'number' || untilMs <= this.held.fromMs) return;
    const { fromMs, reliefKw } = this.held;
    if (reliefKw > 0) {
      for (let startMs = fromMs; startMs < untilMs;) {
        const endMs = Math.min(untilMs, nextBoundaryMs(startMs));
        this.add(startMs, (reliefKw * (endMs - startMs)) / HOUR_MS);
        startMs = endMs;
      }
    }
    this.held = { fromMs: untilMs, reliefKw };
    this.prune(untilMs);
  }

  /** What the plan just built would keep off the meter from the reading it decided on. */
  hold(devices: readonly DevicePlanDevice[], tracker: PowerTrackerState): void {
    const fromMs = tracker.lastTimestamp;
    if (typeof fromMs !== 'number') return;
    const reliefKw = devices.reduce((sum, device) => sum + resolveHeldReliefKw(device), 0);
    this.held = { fromMs, reliefKw };
  }

  /** A build that actuates: live control's own meter is the period's energy again. */
  clear(): void {
    this.avoidedKWhByHour.clear();
    this.avoidedQuarter = null;
    this.held = null;
  }

  /**
   * The tracker as the planner paces from it in simulation: each hour's and the
   * current quarter's energy less what the simulated decisions would have kept
   * off it. An hour that exported (a negative bucket) is left as measured.
   */
  planningView(tracker: PowerTrackerState): PowerTrackerState {
    if (this.avoidedKWhByHour.size === 0 && this.avoidedQuarter === null) return tracker;
    const buckets = { ...tracker.buckets };
    for (const [key, avoidedKWh] of this.avoidedKWhByHour) {
      const measuredKWh = buckets[key];
      if (typeof measuredKWh === 'number' && measuredKWh > 0) buckets[key] = Math.max(0, measuredKWh - avoidedKWh);
    }
    const quarter = tracker.capacityQuarter;
    const avoided = this.avoidedQuarter;
    const capacityQuarter = quarter !== undefined && avoided !== null && quarter.startMs === avoided.startMs
      ? { ...quarter, energyKWh: Math.max(0, quarter.energyKWh - avoided.kWh) }
      : quarter;
    return { ...tracker, buckets, capacityQuarter };
  }

  private add(startMs: number, kWh: number): void {
    const hourKey = getHourBucketKey(startMs);
    this.avoidedKWhByHour.set(hourKey, (this.avoidedKWhByHour.get(hourKey) ?? 0) + kWh);
    const quarterStartMs = Math.floor(startMs / CAPACITY_QUARTER_MS) * CAPACITY_QUARTER_MS;
    this.avoidedQuarter = this.avoidedQuarter?.startMs === quarterStartMs
      ? { startMs: quarterStartMs, kWh: this.avoidedQuarter.kWh + kWh }
      : { startMs: quarterStartMs, kWh };
  }

  private prune(nowMs: number): void {
    for (const key of this.avoidedKWhByHour.keys()) {
      if (new Date(key).getTime() < nowMs - RETAINED_MS) this.avoidedKWhByHour.delete(key);
    }
  }
}

/** The next hour or quarter boundary after `ms`; every hour boundary is a quarter boundary. */
const nextBoundaryMs = (ms: number): number => (Math.floor(ms / CAPACITY_QUARTER_MS) + 1) * CAPACITY_QUARTER_MS;

/**
 * What a device the plan holds would stop drawing, kW: all of it for a turn-off,
 * the draw above the held rung's nameplate for a step-down. A temperature
 * restriction promises no electrical reduction, so it counts nothing, as in
 * shedding's own credit (`shedding/pendingRelief.ts`).
 */
function resolveHeldReliefKw(device: DevicePlanDevice): number {
  if (device.plannedState !== 'shed' || !isMeteredPlanDevice(device)) return 0;
  const drawKw = Math.max(0, device.currentDrawKw);
  if (device.plannedShedTargetKind === 'binary_off') return drawKw;
  if (device.plannedShedTargetKind !== 'step' || !isSteppedLoadDevice(device)) return 0;
  const step = getSteppedLoadStep(device.steppedLoadProfile, device.desiredStepId);
  return step === null ? 0 : Math.max(0, drawKw - step.planningPowerW / 1000);
}
