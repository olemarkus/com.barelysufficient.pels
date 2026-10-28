import { CapacityDrainStart } from '../../lib/plan/capacityDrainStart';
import { computeDynamicSoftLimit, computeShortfallThreshold } from '../../lib/plan/planBudget';
import type { SoftOvershootDecision } from '../../lib/plan/planOvershoot';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { getHourBucketKey } from '../../lib/utils/hourBuckets';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';

const HOUR_MS = 3_600_000;
const SECOND_MS = 1000;
const START_HOUR_MS = Date.UTC(2026, 0, 1);

/** One exact, cumulative-energy meter report from the synthetic plant. */
export type SimulatedPressureReading = {
  atMs: number;
  settings: CapacitySettings;
  managedKw: number;
  usedKWh: number;
  powerKw: number;
  capacityPaceKw: number;
  dailyPaceKw: number | null;
  remainingKWh: number;
  shortfallThresholdKw: number;
  gridTargetKw: number | null;
  periodStartMs: number;
  periodRemainingMs: number;
};

/** A new instance per run: the policy keeps its own episode memory. */
export type SimulatedPressurePolicy = (reading: SimulatedPressureReading) => SoftOvershootDecision;
export type SimulatedPressurePolicyFactory = () => SimulatedPressurePolicy;

/** Frozen reference to 172819bee: later runtime edits must not move the baseline. */
export function referenceGracePolicy(universalGrace: boolean): SimulatedPressurePolicyFactory {
  return () => {
    let pendingSinceMs: number | null = null;
    return (reading) => {
      const bindingPaceKw = reading.dailyPaceKw === null
        ? reading.capacityPaceKw : Math.min(reading.capacityPaceKw, reading.dailyPaceKw);
      const headroomKw = bindingPaceKw - reading.powerKw;
      if (reading.gridTargetKw !== null && reading.powerKw > reading.gridTargetKw) {
        pendingSinceMs = null;
        return { actionable: true, shedActionable: true, pendingSinceMs };
      }
      if (headroomKw >= 0) {
        pendingSinceMs = null;
        return { actionable: false, shedActionable: false, pendingSinceMs };
      }
      pendingSinceMs ??= reading.atMs;
      const elapsedMs = reading.atMs - pendingSinceMs;
      const deficitKw = -headroomKw;
      const actionable = deficitKw >= 0.05 || elapsedMs >= 20_000;
      const graceMs = universalGrace
        ? Math.min(60_000, Math.max(0, reading.remainingKWh) * 0.02 / deficitKw * HOUR_MS)
        : 0;
      return {
        actionable,
        shedActionable: actionable && (deficitKw < 0.05 || elapsedMs >= graceMs),
        pendingSinceMs,
      };
    };
  };
}

/** Candidate, not shipped behavior: urgent projected period breach bypasses grace. */
export const forecastGuardedGracePolicy: SimulatedPressurePolicyFactory = () => {
  const softDecision = referenceGracePolicy(true)();
  return (reading) => {
    const decision = softDecision(reading);
    return reading.powerKw > reading.shortfallThresholdKw
      ? { ...decision, actionable: true, shedActionable: true }
      : decision;
  };
};

/** Conservative final candidate: only daily pressure can receive additional patience. */
export const dailyOnlyGracePolicy: SimulatedPressurePolicyFactory = () => {
  const immediateDecision = referenceGracePolicy(false)();
  return (reading) => {
    const decision = immediateDecision(reading);
    if (decision.pendingSinceMs === null || reading.powerKw > reading.capacityPaceKw || reading.dailyPaceKw === null) {
      return decision;
    }
    // One episode clock, and raw capacity pressure: even a tiny capacity breach
    // withdraws daily grace when the binding daily deficit is meaningful.
    if (reading.powerKw - reading.dailyPaceKw < 0.05) return decision;
    return { ...decision, shedActionable: reading.atMs - decision.pendingSinceMs >= 60_000 };
  };
};

export type SimulatedLoadLevel = { atSecond: number; kw: number };

/** Delayed electrical response is independent of command acceptance. */
export type SimulatedShedResponse =
  | { kind: 'delayed'; seconds: number; remainingFraction: number }
  | { kind: 'no_relief' };

export type SlowResponseScenario = {
  id: string;
  settings: CapacitySettings;
  startSecond: number;
  durationSeconds: number;
  usedBeforeKWh: number;
  managedKw: number;
  background: readonly SimulatedLoadLevel[];
  meterCadenceSeconds: number;
  response: SimulatedShedResponse;
  gridTargetKw: number | null;
  dailyPaceKw: number | null;
  /** Warm controller by default; false reproduces a restart in the current period. */
  controllerWarmStart?: boolean;
};

export type SimulatedPeriodResult = {
  startMs: number;
  usedKWh: number;
  aboveAllowanceWh: number;
  aboveHardCapWh: number;
};

export type SlowResponseResult = {
  scenario: string;
  firstShedSecond: number | null;
  firstReliefSecond: number | null;
  commandCount: number;
  peakPowerKw: number;
  importedWh: number;
  managedWh: number;
  periods: SimulatedPeriodResult[];
};

type SimulationPlant = {
  managedKw: number;
  commandedShedAtSecond: number | null;
  firstReliefSecond: number | null;
  importedWh: number;
  managedWh: number;
  peakPowerKw: number;
  periodEnergyKWh: Map<number, number>;
};

/**
 * Closed loop for ONE shed decision: the policy sees discrete meter reports;
 * its command changes a separate physical plant after the specified delay.
 *
 * This is a pressure-policy experiment, not a complete planner/executor model:
 * no restore, priorities, retries, startup gates, or device attribution. Once
 * shed, the load remains restricted. Energy reports are exact cumulative
 * energy at each sample (optimistic: no missed-pulse integration error). Actual
 * energy is integrated independently every second and split at period rollover.
 */
export function runSlowResponseSimulation(
  scenario: SlowResponseScenario,
  createPolicy: SimulatedPressurePolicyFactory,
): SlowResponseResult {
  const policy = createPolicy();
  const drain = new CapacityDrainStart();
  const startMs = START_HOUR_MS + scenario.startSecond * SECOND_MS;
  const periodMs = scenario.settings.periodMinutes * 60_000;
  const firstPeriodMs = Math.floor(startMs / periodMs) * periodMs;
  let plant: SimulationPlant = {
    managedKw: scenario.managedKw,
    commandedShedAtSecond: null,
    firstReliefSecond: null,
    importedWh: 0,
    managedWh: 0,
    peakPowerKw: 0,
    periodEnergyKWh: new Map([[firstPeriodMs, scenario.usedBeforeKWh]]),
  };
  // The household has already been observed before these pressure scenarios.
  // Prime every policy equally; the restart cases deliberately omit this phase.
  if (scenario.controllerWarmStart !== false) {
    for (const atMs of [firstPeriodMs - 20_000, firstPeriodMs - 10_000, startMs - 10_000]) {
      const frameMs = Math.floor(atMs / periodMs) * periodMs;
      policy({ ...readPlant(scenario, plant, drain, atMs, 0, frameMs), managedKw: 0 });
    }
  }
  for (let second = 0; second < scenario.durationSeconds; second += 1) {
    plant = deliverShed(scenario, plant, second);
    const atMs = startMs + second * SECOND_MS;
    const powerKw = backgroundAt(scenario.background, second) + plant.managedKw;
    const periodStartMs = Math.floor(atMs / periodMs) * periodMs;
    if (second % scenario.meterCadenceSeconds === 0) {
      const reading = readPlant(scenario, plant, drain, atMs, powerKw, periodStartMs);
      const decision = policy(reading);
      // Exhausted allowance is a separate production shedding-entry bypass.
      if (plant.commandedShedAtSecond === null && (decision.shedActionable || reading.remainingKWh <= 0)) {
        plant.commandedShedAtSecond = second;
        plant = deliverShed(scenario, plant, second);
      }
    }
    // A zero-delay command already changes this second's physical draw.
    const actualKw = backgroundAt(scenario.background, second) + plant.managedKw;
    plant.peakPowerKw = Math.max(plant.peakPowerKw, powerKw, actualKw);
    plant.importedWh += actualKw / 3.6;
    plant.managedWh += plant.managedKw / 3.6;
    plant.periodEnergyKWh.set(periodStartMs, (plant.periodEnergyKWh.get(periodStartMs) ?? 0) + actualKw / 3600);
  }
  return simulationResult(scenario, plant);
}

function readPlant(
  scenario: SlowResponseScenario,
  plant: SimulationPlant,
  drain: CapacityDrainStart,
  atMs: number,
  powerKw: number,
  periodStartMs: number,
): SimulatedPressureReading {
  const energyKWh = plant.periodEnergyKWh.get(periodStartMs) ?? 0;
  const tracker: PowerTrackerState = {
    buckets: { [getHourBucketKey(atMs)]: energyKWh },
    lastTimestamp: atMs,
    lastPowerW: powerKw * 1000,
    capacityQuarter: { startMs: periodStartMs, energyKWh, trackedMs: atMs - periodStartMs },
  };
  drain.record(scenario.settings, tracker, atMs, powerKw);
  const pace = computeDynamicSoftLimit(scenario.settings, tracker, atMs, drain.startFor(scenario.settings, tracker, atMs));
  return {
    atMs,
    settings: scenario.settings,
    managedKw: plant.managedKw,
    usedKWh: energyKWh,
    powerKw,
    capacityPaceKw: pace.allowedKw,
    dailyPaceKw: scenario.dailyPaceKw,
    remainingKWh: pace.remainingKWh,
    shortfallThresholdKw: computeShortfallThreshold(scenario.settings, tracker, atMs),
    gridTargetKw: scenario.gridTargetKw,
    periodStartMs,
    periodRemainingMs: periodStartMs + scenario.settings.periodMinutes * 60_000 - atMs,
  };
}

function deliverShed(scenario: SlowResponseScenario, plant: SimulationPlant, second: number): SimulationPlant {
  if (plant.commandedShedAtSecond === null || scenario.response.kind === 'no_relief') return plant;
  if (second < plant.commandedShedAtSecond + scenario.response.seconds) return plant;
  const afterKw = scenario.managedKw * scenario.response.remainingFraction;
  return {
    ...plant,
    firstReliefSecond: plant.managedKw > afterKw ? plant.firstReliefSecond ?? second : plant.firstReliefSecond,
    managedKw: afterKw,
  };
}

function backgroundAt(levels: readonly SimulatedLoadLevel[], second: number): number {
  let kw = 0;
  for (const level of levels) {
    if (level.atSecond > second) break;
    kw = level.kw;
  }
  return kw;
}

function simulationResult(scenario: SlowResponseScenario, plant: SimulationPlant): SlowResponseResult {
  const periodHours = scenario.settings.periodMinutes / 60;
  const allowanceKWh = (scenario.settings.limitKw - scenario.settings.marginKw) * periodHours;
  const hardCapKWh = scenario.settings.limitKw * periodHours;
  return {
    scenario: scenario.id,
    firstShedSecond: plant.commandedShedAtSecond,
    firstReliefSecond: plant.firstReliefSecond,
    commandCount: plant.commandedShedAtSecond === null ? 0 : 1,
    peakPowerKw: plant.peakPowerKw,
    importedWh: plant.importedWh,
    managedWh: plant.managedWh,
    periods: [...plant.periodEnergyKWh].map(([startMs, usedKWh]) => ({
      startMs,
      usedKWh,
      aboveAllowanceWh: Math.max(0, usedKWh - allowanceKWh) * 1000,
      aboveHardCapWh: Math.max(0, usedKWh - hardCapKWh) * 1000,
    })),
  };
}
