import { describe, expect, it } from 'vitest';
import {
  buildDeferredObjectiveTaskResults, SERVING_LANE,
  type TaskEvaluationLane, type TaskEvaluationReaders, type TaskEvaluationReport,
  type TaskEvaluationSnapshot,
} from '../../lib/objectives/deferredObjectives/taskEvaluationCoordinator';
import { TaskPlanningTurns } from '../../lib/objectives/deferredObjectives/taskPlanningTurns';
import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { createEmptyActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import type { DeferredObjectiveRoster } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { PriceHorizonEntry } from '../../packages/planner-types/src/priceHorizon';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import {
  noDeviceExclusion, noDeliveredEnergy, noReservationSuppression, noStallEvidence,
} from '../helpers/deferredObjectiveWiringFixtures';

const HOUR_MS = 3_600_000;
const START_MS = Date.UTC(2026, 0, 14, 17, 58);
const DEADLINE_MS = Date.UTC(2026, 0, 15, 2);

const deviceFor = (id: string): ObjectiveDeviceInput => ({
  id, name: id, deviceType: 'onoff', isEvCharger: false,
  objectiveSessionInactive: false, waitingForCarAssociation: false, thermalDirection: 'heating',
  currentDrawKw: 0, expectedPowerKw: 1,
  control: { managed: true, commandAuthority: true },
  steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'run', planningPowerW: 1000 }] },
});

const prices = (): PriceHorizonEntry[] => Array.from({ length: 10 }, (_, index) => ({
  startMs: Date.UTC(2026, 0, 14, 17) + index * HOUR_MS,
  endMs: Date.UTC(2026, 0, 14, 18) + index * HOUR_MS,
  price: index + 1, moneyPrice: index + 1,
}));

/** Real evaluator and recorder, with only its device/price/household reads supplied. */
const createHarness = (count: number) => {
  const devices = Array.from({ length: count }, (_, index) => deviceFor(`load-${index + 1}`));
  const settings: DeferredObjectiveRoster = {
    objectivesByDeviceId: Object.fromEntries(devices.map(({ id }) => [id, {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1, deadlineAtMs: DEADLINE_MS,
    }])),
  };
  const recorder = new DeferredObjectiveActivePlanRecorder({ load: createEmptyActivePlans, save: () => undefined });
  const roster = new TaskAllocationRoster(() => new Date(START_MS));
  const turns = new TaskPlanningTurns();
  const lane: TaskEvaluationLane = { kind: 'scheduled', turns };
  let priceReads = 0;
  let priceOptimizationEnabled = true;
  let readPrices = (_startMs: number, _endMs: number): PriceHorizonEntry[] => prices();
  const readers: TaskEvaluationReaders = {
    prefersContinuousCharging: () => false,
    getPrioritiesForDevices: createFixturePriorityQuery(devices.map(({ id }, index) => ({ id, priority: index + 1 }))),
    resolveDeviceExclusion: noDeviceExclusion, getStallClassification: noStallEvidence,
    hasObservedTask: () => false, getDeliveredEnergyKWh: noDeliveredEnergy,
    isReservationSuppressed: noReservationSuppression,
    buildPriceHorizon: (startMs, endMs) => { priceReads += 1; return readPrices(startMs, endMs); },
  };
  const snapshotAt = (nowMs: number): TaskEvaluationSnapshot => {
    roster.observe(devices, nowMs, () => false);
    return {
      nowMs, timeZone: 'UTC', devices, settings, allocationRoster: roster.read(nowMs),
      powerTracker: {}, dailyBudgetSnapshot: null, activePlans: recorder.getActivePlansSnapshot(),
      priceOptimizationEnabled, powerLimits: capacityOnlyPowerLimits(20), hasSolarProduction: false,
    };
  };
  const evaluate = (nowMs: number, evaluationLane: TaskEvaluationLane = lane): TaskEvaluationReport[] => (
    buildDeferredObjectiveTaskResults(snapshotAt(nowMs), readers, evaluationLane)
  );
  const tick = (nowMs: number): TaskEvaluationReport[] => {
    const reports = evaluate(nowMs);
    recorder.observe(reports.map(({ diagnostic }) => diagnostic), nowMs);
    return reports;
  };
  return {
    devices, settings, recorder, evaluate, tick,
    priceReadCount: () => priceReads,
    setPriceRead: (read: typeof readPrices) => { readPrices = read; },
    setPriceEnabled: (enabled: boolean) => { priceOptimizationEnabled = enabled; },
  };
};

const freshIds = (reports: readonly TaskEvaluationReport[]): string[] => reports.flatMap(({ evaluation }) => (
  evaluation.planning.kind === 'allocated' && evaluation.planning.plan.frozenRead !== true
    ? [evaluation.deviceId] : []
));

describe('bounded smart-task planning turns', () => {
  it('reports price-off ahead of a queued cached allocation and retains its planning turn', () => {
    const home = createHarness(2);
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1.2, deadlineAtMs: DEADLINE_MS,
    };
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-1']);
    expect(home.recorder.getActivePlan('load-2')?.diagnosticReasonCode).toBe('objective_waiting_for_plan');
    home.setPriceEnabled(false);
    const paused = home.tick(START_MS + 90_000);
    expect(freshIds(paused)).toEqual([]);
    for (const { diagnostic, evaluation } of paused) {
      expect(diagnostic.reasonCode).toBe('objective_price_feature_disabled');
      expect(diagnostic.horizonPlan).toBeUndefined();
      expect(evaluation.planning.kind).toBe('inactive');
      expect(home.recorder.getActivePlan(diagnostic.deviceId)?.diagnosticReasonCode)
        .toBe('objective_price_feature_disabled');
    }
    home.setPriceEnabled(true);
    expect(freshIds(home.tick(START_MS + 120_000))).toEqual(['load-2']);
  });

  it('accepts the whole roster while one task gets each planning turn', () => {
    const home = createHarness(6);
    const reports = home.tick(START_MS);

    expect(reports).toHaveLength(6);
    expect(freshIds(reports)).toEqual(['load-1']);
    expect(reports.slice(1).map(({ evaluation }) => evaluation.planning.kind))
      .toEqual(Array(5).fill('awaiting_plan'));
    expect(Object.values(home.recorder.getActivePlansSnapshot().plansByDeviceId)
      .filter((plan) => plan.pending)).toHaveLength(5);
  });

  it('drains a priority-ordered queue across the end of the settle window', () => {
    const home = createHarness(6);
    const selected = Array.from({ length: 6 }, (_, index) => {
      const nowMs = START_MS + index * 30_000;
      const fresh = freshIds(home.tick(nowMs));
      expect(fresh).toHaveLength(1);
      return fresh[0];
    });

    expect(selected).toEqual(home.devices.map(({ id }) => id));
    expect(Object.values(home.recorder.getActivePlansSnapshot().plansByDeviceId)
      .every((plan) => !plan.pending && plan.latest !== null)).toBe(true);
    expect(home.recorder.getActivePlan('load-6')?.latest?.revisedAtMs).toBe(START_MS + 150_000);
  });

  it('serves committed plans without price reads or fresh allocations', () => {
    const home = createHarness(2);
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    const readsBefore = home.priceReadCount();

    const reports = home.evaluate(START_MS + 60_000, SERVING_LANE);

    expect(freshIds(reports)).toEqual([]);
    expect(reports.map(({ evaluation }) => evaluation.planning.kind)).toEqual(['allocated', 'allocated']);
    expect(home.priceReadCount()).toBe(readsBefore);
  });

  it('keeps compatible settled plans frozen when the planning queue restarts mid-hour', () => {
    const home = createHarness(2);
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    const saved = home.recorder.getActivePlansSnapshot();
    const restarted: TaskEvaluationLane = { kind: 'scheduled', turns: new TaskPlanningTurns() };

    const reports = home.evaluate(Date.UTC(2026, 0, 14, 18, 20), restarted);

    expect(freshIds(reports)).toEqual([]);
    expect(reports.map(({ evaluation }) => evaluation.planning.kind)).toEqual(['allocated', 'allocated']);
    expect(home.recorder.getActivePlansSnapshot()).toEqual(saved);
  });

  it('opens one due turn when a restarted queue reaches the next settle generation', () => {
    const home = createHarness(2);
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    const restarted: TaskEvaluationLane = { kind: 'scheduled', turns: new TaskPlanningTurns() };

    const reports = home.evaluate(Date.UTC(2026, 0, 14, 18, 58), restarted);

    expect(freshIds(reports)).toEqual(['load-1']);
    expect(reports.find(({ evaluation }) => evaluation.deviceId === 'load-2')?.evaluation.planning.kind)
      .toBe('allocated');
  });

  it('persists queued replan revisions even when their turn comes after :00', () => {
    const home = createHarness(6);
    for (let index = 0; index < 6; index += 1) home.tick(START_MS - 10 * 60_000 + index * 30_000);
    const previousRevision = home.recorder.getActivePlan('load-6')?.latest?.revision;
    expect(previousRevision).toBeDefined();
    home.setPriceRead(() => prices().map((period) => ({
      ...period, price: 100 - period.price, moneyPrice: 100 - period.moneyPrice,
    })));

    for (let index = 0; index < 6; index += 1) {
      expect(freshIds(home.tick(START_MS + index * 30_000))).toHaveLength(1);
    }

    const latest = home.recorder.getActivePlan('load-6')?.latest;
    expect(latest?.revision).toBeGreaterThan(previousRevision ?? 0);
    expect(latest?.revisedAtMs).toBe(START_MS + 150_000);
  });

  it('moves a blocked higher task behind the other waiting tasks', () => {
    const home = createHarness(3);
    const highDeadline = DEADLINE_MS + HOUR_MS;
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1, deadlineAtMs: highDeadline,
    };
    home.setPriceRead((_startMs, endMs) => endMs === highDeadline ? [] : prices());

    expect(freshIds(home.tick(START_MS))).toEqual([]);
    expect(freshIds(home.tick(START_MS + 30_000))).toEqual(['load-2']);
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-3']);
  });

  it('retries a committed task after a transient price gap in its settle turn', () => {
    const home = createHarness(1);
    home.tick(START_MS - 10 * 60_000);
    const committed = home.recorder.getActivePlan('load-1')?.latest;
    expect(committed).toBeDefined();
    home.setPriceRead(() => []);

    const duringGap = home.tick(START_MS);

    expect(freshIds(duringGap)).toEqual([]);
    expect(duringGap[0]?.evaluation.planning).toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    expect(home.recorder.getActivePlan('load-1')?.latest).toEqual(committed);
    home.setPriceRead(() => prices().map((period) => ({
      ...period, price: 100 - period.price, moneyPrice: 100 - period.moneyPrice,
    })));

    expect(freshIds(home.tick(START_MS + 30_000))).toEqual(['load-1']);
    expect(home.recorder.getActivePlan('load-1')?.latest?.revision).toBeGreaterThan(committed?.revision ?? 0);
  });

  it('keeps the awaiting-prices hold on the serving lane before any planning turn', () => {
    const home = createHarness(1);
    home.setPriceRead(() => prices().slice(0, 2));

    const report = home.evaluate(START_MS, SERVING_LANE)[0];

    expect(report?.evaluation.planning).toEqual({ kind: 'awaiting_prices', device: 'held' });
    expect(freshIds(home.tick(START_MS))).toEqual([]);
  });

  it('keeps an uncalibrated thermal task learning while it awaits its turn', () => {
    const home = createHarness(1);
    home.devices[0] = { ...deviceFor('load-1'), deviceType: 'temperature', currentTemperature: 20 };
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 40, deadlineAtMs: DEADLINE_MS,
    };

    const report = home.evaluate(START_MS, SERVING_LANE)[0];

    expect(report?.evaluation.planning.kind).toBe('learning');
    expect(report?.diagnostic.reasonCode).toBe('objective_missing_capacity');
    expect(freshIds(home.tick(START_MS))).toEqual([]);
  });

  it('keeps lower tickets ahead of a repeatedly edited higher task', () => {
    const home = createHarness(3);
    expect(freshIds(home.tick(START_MS))).toEqual(['load-1']);
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1.2, deadlineAtMs: DEADLINE_MS,
    };
    expect(freshIds(home.tick(START_MS + 30_000))).toEqual(['load-2']);
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1.4, deadlineAtMs: DEADLINE_MS,
    };
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-3']);
  });

  it('holds a lower commitment after higher energy changes on the same price grid', () => {
    const home = createHarness(2);
    home.devices[0]!.steppedLoadProfile = {
      steps: [{ id: 'off', planningPowerW: 0 }, { id: 'run', planningPowerW: 2000 }],
    };
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    const highBefore = home.recorder.getActivePlan('load-1')?.latest;
    expect(highBefore).toBeDefined();
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1.2, deadlineAtMs: DEADLINE_MS,
    };
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-1']);
    const highAfter = home.recorder.getActivePlan('load-1')?.latest;
    expect(highAfter?.revision).toBeGreaterThan(highBefore?.revision ?? 0);
    // The current partial interval moves with the clock; future native slots stay the same.
    const futureStarts = (plan: typeof highBefore) => plan?.hours
      .filter(({ startsAtMs }) => startsAtMs >= START_MS + 2 * 60_000)
      .map(({ startsAtMs }) => startsAtMs);
    expect(futureStarts(highAfter)).toEqual(futureStarts(highBefore));

    const lower = home.evaluate(START_MS + 90_000, SERVING_LANE)
      .find(({ evaluation }) => evaluation.deviceId === 'load-2');

    expect(lower?.evaluation.planning.kind).toBe('awaiting_plan');
    expect(lower?.diagnostic.reasonCode).toBe('objective_waiting_for_plan');
    expect(home.recorder.getActivePlan('load-2')?.latest).not.toBeNull();
    expect(freshIds(home.tick(START_MS + 90_000))).toEqual(['load-2']);
    expect(home.evaluate(START_MS + 120_000, SERVING_LANE)
      .find(({ evaluation }) => evaluation.deviceId === 'load-2')?.evaluation.planning.kind).toBe('allocated');
  });

  it('does not let previews spend the pending live planning turn', () => {
    const home = createHarness(3);
    const before = home.recorder.getActivePlansSnapshot();

    const preview = home.evaluate(START_MS, { kind: 'preview', candidateDeviceId: 'load-3' });

    expect(freshIds(preview)).toContain('load-3');
    expect(home.recorder.getActivePlansSnapshot()).toEqual(before);
    expect(freshIds(home.tick(START_MS))).toEqual(['load-1']);
    expect(freshIds(home.tick(START_MS + 30_000))).toEqual(['load-2']);
  });
});
