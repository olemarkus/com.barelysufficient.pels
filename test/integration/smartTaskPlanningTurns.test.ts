import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeferredObjectiveTaskResults, LIVE_LANE, SERVING_LANE,
  type TaskEvaluationLane, type TaskEvaluationReaders, type TaskEvaluationReport,
  type TaskEvaluationSnapshot,
} from '../../lib/objectives/deferredObjectives/taskEvaluationCoordinator';
import { TaskPlanningTurns } from '../../lib/objectives/deferredObjectives/taskPlanningTurns';
import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { createEmptyActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import * as policyHorizon from '../../lib/objectives/deferredObjectives/policyHorizon';
import { applyDeferredAdmissionToInput, applyDeferredObjectiveAdmission, buildDeferredReleaseIntents } from '../../lib/objectives/deferredObjectives/admission';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildInitialPlanDevicesForSpec, buildPlanInputDevice, sheddingPlanFixture } from '../utils/planTestUtils';
import { resolveStartPolicyHold } from '../../lib/plan/shedding/startPolicyHold';
import { isRestoreLiveEligibleDevice, isSwapRestoreCandidate } from '../../lib/plan/restore/devices';
import { buildExecutableDeviceIntent } from '../../lib/plan/planExecutionProjection';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { fixedConfirmationWindows } from '../helpers/confirmationWindows';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import type { DeferredObjectiveActivePlansV2 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
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
  id, name: id, deviceType: 'onoff', isEvCharger: false, energyIdleCapable: false,
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
const createHarness = (count: number, load: () => DeferredObjectiveActivePlansV2 = createEmptyActivePlans) => {
  const devices = Array.from({ length: count }, (_, index) => deviceFor(`load-${index + 1}`));
  const settings: DeferredObjectiveRoster = {
    objectivesByDeviceId: Object.fromEntries(devices.map(({ id }) => [id, {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1, deadlineAtMs: DEADLINE_MS,
    }])),
  };
  const recorder = new DeferredObjectiveActivePlanRecorder({ load, save: () => undefined });
  const roster = new TaskAllocationRoster(() => new Date(START_MS));
  const turns = new TaskPlanningTurns();
  const lane: TaskEvaluationLane = { kind: 'scheduled', turns };
  const powerTracker: PowerTrackerState = {};
  let priceReads = 0;
  let priceOptimizationEnabled = true;
  let readPrices = (_startMs: number, _endMs: number): PriceHorizonEntry[] => prices();
  let readEnergyIdle: TaskEvaluationReaders['getEnergyIdleState'];
  const readers: TaskEvaluationReaders = {
    prefersContinuousCharging: () => false,
    getPrioritiesForDevices: createFixturePriorityQuery(devices.map(({ id }, index) => ({ id, priority: index + 1 }))),
    resolveDeviceExclusion: noDeviceExclusion, getStallClassification: noStallEvidence,
    hasObservedTask: () => false, getDeliveredEnergyKWh: noDeliveredEnergy,
    isReservationSuppressed: noReservationSuppression,
    getEnergyIdleState: (deviceId, deadlineAtMs) => readEnergyIdle?.(deviceId, deadlineAtMs),
    buildPriceHorizon: (startMs, endMs) => { priceReads += 1; return readPrices(startMs, endMs); },
  };
  const snapshotAt = (nowMs: number): TaskEvaluationSnapshot => {
    roster.observe(devices, nowMs, () => false);
    return {
      nowMs, timeZone: 'UTC', devices, settings, allocationRoster: roster.read(nowMs),
      powerTracker, dailyBudgetSnapshot: null, activePlans: recorder.getActivePlansSnapshot(),
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
    devices, settings, recorder, evaluate, tick, powerTracker,
    priceReadCount: () => priceReads,
    setPriceRead: (read: typeof readPrices) => { readPrices = read; },
    setPriceEnabled: (enabled: boolean) => { priceOptimizationEnabled = enabled; },
    setEnergyIdleRead: (read: typeof readEnergyIdle) => { readEnergyIdle = read; },
  };
};

const freshIds = (reports: readonly TaskEvaluationReport[]): string[] => reports.flatMap(({ evaluation }) => (
  evaluation.planning.kind === 'allocated' && evaluation.planning.plan.frozenRead !== true
    ? [evaluation.deviceId] : []
));

describe('bounded smart-task planning turns', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries a failed idle reopening on the next planning turn', () => {
    const home = createHarness(1);
    home.devices[0] = {
      ...home.devices[0], steppedLoadProfile: undefined, energyIdleCapable: true,
    };
    expect(freshIds(home.tick(START_MS))).toEqual(['load-1']);
    const reopening = START_MS + HOUR_MS;
    home.setEnergyIdleRead(() => ({ kind: 'reopened', sinceMs: reopening }));
    home.setPriceRead(() => []);

    const [failed] = home.tick(reopening);
    expect(failed?.evaluation).toMatchObject({
      usesAvailablePower: true, planning: { kind: 'allocated', plan: { frozenRead: true, plannedUsefulEnergyKWh: 0 } },
    });
    home.setPriceRead(prices);
    const [retried] = home.tick(reopening + 30_000);
    expect(retried?.diagnostic).toMatchObject({ scheduledReplan: true, restoresIdleBookings: true });
  });

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

  it('keeps the booked allocation rank during a roster review and updates it on fresh allocation', () => {
    const home = createHarness(2);
    // A higher-ranked managed load competes for headroom even without a task.
    delete home.settings.objectivesByDeviceId['load-1'];
    const laterIsCheaper = () => prices().map((period) => ({
      ...period, price: 100 - period.price, moneyPrice: 100 - period.moneyPrice,
    }));
    home.setPriceRead(laterIsCheaper);
    expect(freshIds(home.tick(START_MS))).toEqual(['load-2']);
    const before = home.recorder.getActivePlan('load-2')?.latest;
    expect(before?.allocationRank).toBe(2);

    home.devices.shift();
    home.setPriceRead(() => []);
    const [reviewed] = home.tick(START_MS + 30_000);
    expect(reviewed?.diagnostic.contextReviewed).toBe(true);
    expect(reviewed?.evaluation.planning).toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    expect(home.recorder.getActivePlan('load-2')?.latest).toMatchObject({
      revision: before?.revision, allocationRank: 2,
    });

    home.setPriceRead(laterIsCheaper);
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-2']);
    const after = home.recorder.getActivePlan('load-2');
    expect(after?.original?.allocationRank).toBe(2);
    expect(after?.latest?.allocationRank).toBe(1);
    expect(after?.latest?.hours.filter((hour) => hour.plannedKWh > 0))
      .toEqual(before?.hours.filter((hour) => hour.plannedKWh > 0));
  });

  it.each([
    { scenario: 'backfills a missing rank', savedRank: undefined },
    { scenario: 'retains an existing rank until a real revision', savedRank: 4 },
  ])('$scenario without holding a lower task', ({ savedRank }) => {
    const laterIsCheaper = () => prices().map((period) => ({
      ...period, price: 100 - period.price, moneyPrice: 100 - period.moneyPrice,
    }));
    const before = createHarness(2);
    before.setPriceRead(laterIsCheaper);
    before.tick(START_MS);
    before.tick(START_MS + 30_000);
    const saved = structuredClone(before.recorder.getActivePlansSnapshot());
    for (const { latest, original } of Object.values(saved.plansByDeviceId)) {
      if (latest === null) throw new Error('Expected a committed plan');
      delete latest.allocationRank;
      if (original) delete original.allocationRank;
    }
    const high = saved.plansByDeviceId['load-1'].latest;
    if (high === null) throw new Error('Expected a committed higher plan');
    if (savedRank !== undefined) high.allocationRank = savedRank;
    const home = createHarness(2, () => saved);
    home.setPriceRead(laterIsCheaper);
    const settleAt = START_MS + HOUR_MS;
    const reports = home.tick(settleAt);
    expect(freshIds(reports)).toEqual(['load-1']);
    expect(reports[0].diagnostic.allocationRank).toBe(1);
    expect(home.recorder.getActivePlan('load-1')?.latest).toEqual({
      ...high, allocationRank: savedRank ?? 1,
    });
    expect(home.recorder.getActivePlan('load-1')?.original).toEqual(saved.plansByDeviceId['load-1'].original);

    const lower = home.evaluate(settleAt + 1_000, SERVING_LANE)
      .find(({ evaluation }) => evaluation.deviceId === 'load-2');
    expect(lower?.evaluation.planning).toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    expect(lower?.diagnostic.reasonCode).not.toBe('objective_waiting_for_plan');

    if (savedRank === undefined) expect(home.recorder.flushIfDirty()).toBe(true);
    const persisted = structuredClone(home.recorder.getActivePlansSnapshot());
    const restarted = createHarness(2, () => persisted);
    restarted.setPriceRead(laterIsCheaper);
    restarted.tick(settleAt + HOUR_MS);
    expect(restarted.recorder.getActivePlan('load-1')?.latest)
      .toEqual(persisted.plansByDeviceId['load-1'].latest);
  });

  it('serves committed plans without price reads or building policy horizons', () => {
    const home = createHarness(2);
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    const readsBefore = home.priceReadCount();
    const buildPolicyHorizon = vi.spyOn(policyHorizon, 'buildDeferredObjectivePolicyHorizon');

    const reports = home.evaluate(START_MS + 60_000, SERVING_LANE);

    expect(freshIds(reports)).toEqual([]);
    expect(reports.map(({ evaluation }) => evaluation.planning.kind)).toEqual(['allocated', 'allocated']);
    expect(home.priceReadCount()).toBe(readsBefore);
    expect(buildPolicyHorizon).not.toHaveBeenCalled();
  });

  describe.each(['frozen', 'replanning'] as const)('%s horizon availability', (path) => {
    it.each(['disabled', 'missing', 'available'] as const)('preserves the %s outcome', (availability) => {
      const home = createHarness(1);
      home.tick(START_MS - 10 * 60_000);
      const committed = home.recorder.getActivePlan('load-1')?.latest;
      expect(committed).toBeDefined();
      home.setPriceEnabled(availability !== 'disabled');
      if (availability === 'missing') home.setPriceRead(() => []);
      const buildPolicyHorizon = vi.spyOn(policyHorizon, 'buildDeferredObjectivePolicyHorizon');

      const reports = path === 'frozen'
        ? home.evaluate(START_MS - 5 * 60_000, LIVE_LANE)
        : home.evaluate(START_MS);
      const report = reports[0];

      if (availability === 'disabled') {
        expect(report?.diagnostic.reasonCode).toBe('objective_price_feature_disabled');
        expect(report?.diagnostic.horizonPlan).toBeUndefined();
        expect(report?.evaluation.planning.kind).toBe('inactive');
      } else if (path === 'replanning' && availability === 'available') {
        expect(freshIds(reports)).toEqual(['load-1']);
        expect(buildPolicyHorizon).toHaveBeenCalled();
        return;
      } else {
        expect(report?.evaluation.planning).toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
        expect(report?.diagnostic.horizonBucketCount).toBe(committed?.hours.length);
        expect(freshIds(reports)).toEqual([]);
      }
      expect(buildPolicyHorizon).not.toHaveBeenCalled();
      expect(home.recorder.getActivePlan('load-1')?.latest).toEqual(committed);
    });
  });

  it('does not build a policy horizon when a selected turn serves a live step gap frozen', () => {
    const home = createHarness(1);
    home.tick(START_MS - 10 * 60_000);
    delete home.devices[0]!.steppedLoadProfile;
    home.devices[0]!.steppedLadderMissing = true;
    const buildPolicyHorizon = vi.spyOn(policyHorizon, 'buildDeferredObjectivePolicyHorizon');

    const [report] = home.evaluate(START_MS);

    expect(report?.evaluation.planning).toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    expect(report?.diagnostic.liveStepsUnavailable).toBe(true);
    expect(buildPolicyHorizon).not.toHaveBeenCalled();
  });

  it.each(['serving', 'scheduled'] as const)('reports a missing bootstrap horizon on the %s lane', (lane) => {
    const home = createHarness(1);
    home.setPriceRead(() => []);
    const buildPolicyHorizon = vi.spyOn(policyHorizon, 'buildDeferredObjectivePolicyHorizon');

    const report = (lane === 'serving' ? home.evaluate(START_MS, SERVING_LANE) : home.evaluate(START_MS))[0];

    expect(report?.diagnostic.trajectory).toEqual({
      kind: 'unavailable', reasonCode: 'objective_missing_price_horizon',
    });
    expect(report?.diagnostic.reasonCode).toBe('objective_missing_price_horizon');
    expect(report?.evaluation.planning.kind).toBe('inactive');
    expect(buildPolicyHorizon).not.toHaveBeenCalled();
    expect(home.recorder.getActivePlan('load-1')?.latest).toBeUndefined();
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
    const buildPolicyHorizon = vi.spyOn(policyHorizon, 'buildDeferredObjectivePolicyHorizon');

    const duringGap = home.tick(START_MS);

    expect(freshIds(duringGap)).toEqual([]);
    expect(duringGap[0]?.evaluation.planning).toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    expect(home.recorder.getActivePlan('load-1')?.latest).toEqual(committed);
    expect(buildPolicyHorizon).not.toHaveBeenCalled();
    home.setPriceRead(() => prices().map((period) => ({
      ...period, price: 100 - period.price, moneyPrice: 100 - period.moneyPrice,
    })));

    expect(freshIds(home.tick(START_MS + 30_000))).toEqual(['load-1']);
    expect(buildPolicyHorizon).toHaveBeenCalled();
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

  it('serves a lower commitment saved before planning turns until its queued turn replans it', () => {
    const before = createHarness(2);
    before.tick(START_MS);
    before.tick(START_MS + 30_000);
    const saved = structuredClone(before.recorder.getActivePlansSnapshot());
    const lowerLatest = saved.plansByDeviceId['load-2']?.latest;
    const planned = lowerLatest?.allocationContextSignature;
    if (!lowerLatest || planned === undefined) throw new Error('the lower task did not commit a plan');
    // The earlier format: the roster, then each higher claim as a device and topology pair.
    const [rosterSignature] = JSON.parse(planned) as [string, unknown];
    lowerLatest.allocationContextSignature = JSON.stringify([rosterSignature, [['load-1', 'main']]]);
    delete lowerLatest.allocationRank;
    const restarted = createHarness(2, () => saved);
    const lowerOf = (reports: readonly TaskEvaluationReport[]) => (
      reports.find(({ evaluation }) => evaluation.deviceId === 'load-2')
    );

    const frozen = restarted.evaluate(START_MS + 60_000, SERVING_LANE);
    expect(lowerOf(frozen)?.evaluation.planning)
      .toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    restarted.recorder.observe(frozen.map(({ diagnostic }) => diagnostic), START_MS + 60_000);
    expect(restarted.recorder.getActivePlan('load-2')?.latest).not.toHaveProperty('allocationRank');
    expect(freshIds(restarted.tick(START_MS + 60_000))).toEqual(['load-2']);
    expect(restarted.recorder.getActivePlan('load-2')?.latest?.allocationContextSignature).toBe(planned);
    expect(restarted.recorder.getActivePlan('load-2')?.latest?.allocationRank).toBe(2);
    expect(lowerOf(restarted.evaluate(START_MS + 90_000, SERVING_LANE))?.evaluation.planning.kind).toBe('allocated');
  });

  it('serves a lower commitment whose turn cannot replan after a higher change, and replans it later', () => {
    const home = createHarness(2);
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1.2, deadlineAtMs: DEADLINE_MS,
    };
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-1']);
    const lowerBefore = home.recorder.getActivePlan('load-2')?.latest;
    const lowerOf = (reports: readonly TaskEvaluationReport[]) => (
      reports.find(({ evaluation }) => evaluation.deviceId === 'load-2')
    );
    expect(lowerOf(home.evaluate(START_MS + 75_000, SERVING_LANE))?.evaluation.planning.kind).toBe('awaiting_plan');
    home.setPriceRead(() => []);

    expect(freshIds(home.tick(START_MS + 90_000))).toEqual([]);

    expect(lowerOf(home.evaluate(START_MS + 105_000, SERVING_LANE))?.evaluation.planning)
      .toMatchObject({ kind: 'allocated', plan: { frozenRead: true } });
    expect(home.recorder.getActivePlan('load-2')?.latest?.revision).toBe(lowerBefore?.revision);
    home.setPriceRead(() => prices());
    expect(freshIds(home.tick(START_MS + 120_000))).toEqual(['load-2']);
    expect(home.recorder.getActivePlan('load-2')?.latest?.revision).toBeGreaterThan(lowerBefore?.revision ?? 0);
    expect(lowerOf(home.evaluate(START_MS + 150_000, SERVING_LANE))?.evaluation.planning)
      .toMatchObject({ kind: 'allocated' });
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

describe('device control during a queued replan', () => {
  it.each([
    ['EV charge level', { kind: 'ev_soc', targetPercent: 55 }, {
      isEvCharger: true, stateOfCharge: { level: { kind: 'known', percent: 50, carId: null } },
    }, 50],
    ['temperature', { kind: 'temperature', targetTemperatureC: 23 }, {
      deviceType: 'temperature', currentTemperature: 20,
    }, 20],
    ['delivered energy', { kind: 'energy', targetEnergyKWh: 1 }, {}, 0],
  ] as const)('applies the same queued replan decision to a %s task', (_label, objective, observation, progress) => {
    const home = createHarness(2);
    const lower = home.devices[1]!;
    home.devices[1] = { ...lower, ...observation, currentDrawKw: 1 };
    home.settings.objectivesByDeviceId[lower.id] = {
      ...objective, enabled: true, enforcement: 'soft', deadlineAtMs: DEADLINE_MS,
    };
    home.powerTracker.objectiveProfiles = {
      [lower.id]: {
        updatedAtMs: START_MS,
        lastSample: { observedAtMs: START_MS, value: progress },
        kwhPerUnit: { sampleCount: 50, mean: 0.5, m2: 0, min: 0.5, max: 0.5, confidence: 'high', lastUpdatedMs: START_MS },
        acceptedSamples: 50,
        rejectedSamples: 0,
      },
    };
    home.tick(START_MS);
    home.tick(START_MS + 30_000);
    expect(home.recorder.getActivePlan(lower.id)?.latest).toBeTruthy();

    home.settings.objectivesByDeviceId['load-1'] = {
      enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 1.2, deadlineAtMs: DEADLINE_MS,
    };
    expect(freshIds(home.tick(START_MS + 60_000))).toEqual(['load-1']);

    const queued = home.evaluate(START_MS + 90_000, SERVING_LANE);
    const evaluations = queued.map(({ evaluation }) => evaluation);
    const decisions = applyDeferredObjectiveAdmission(evaluations);
    expect(decisions.get(lower.id)).toEqual({ kind: 'waiting', budgetExempt: false });
    expect(buildDeferredReleaseIntents(decisions)[lower.id]).toBeUndefined();
  });

  it('keeps an already-running heater on without task authority or a new command while it awaits its turn', () => {
    const home = createHarness(2);
    const heaters = home.devices.map(({ id }, index) => buildPlanInputDevice({
      id,
      deviceType: 'temperature',
      controlModel: 'binary_power',
      currentTemperature: 20,
      currentTarget: 23,
      currentDrawKw: 1,
      expectedPowerKw: 1,
      controllable: true,
      currentOn: true,
      binaryControl: { on: true },
      priority: index + 1,
    }));
    home.devices.forEach((device, index) => {
      home.devices[index] = { ...device, deviceType: 'temperature', currentTemperature: 20, currentDrawKw: 1 };
      home.settings.objectivesByDeviceId[device.id] = {
        enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 23,
        deadlineAtMs: DEADLINE_MS,
      };
    });
    home.powerTracker.objectiveProfiles = Object.fromEntries(home.devices.map(({ id }) => [id, {
      updatedAtMs: START_MS,
      lastSample: { observedAtMs: START_MS, value: 20 },
      kwhPerUnit: { sampleCount: 50, mean: 1.5, m2: 0, min: 1.5, max: 1.5, confidence: 'high', lastUpdatedMs: START_MS },
      acceptedSamples: 50,
      rejectedSamples: 0,
    }]));
    const state = createPlanEngineState();
    const pending = createPendingBinaryCommandStore(state.pendingBinaryCommands, fixedConfirmationWindows);
    const admissionAt = (time: number, devices = heaters, capacityShed = false) => {
      const reports = home.evaluate(time, SERVING_LANE);
      const decisions = applyDeferredObjectiveAdmission(reports.map(({ evaluation }) => evaluation), devices);
      const input = applyDeferredAdmissionToInput(devices, decisions);
      const { context } = buildPlanCycle({ devices: input.devices, total: 2, softLimit: 20 });
      const plan = buildInitialPlanDevicesForSpec({
        context,
        state,
        sheddingPlan: sheddingPlanFixture({
          shedSet: new Set([...input.forceShedSet, ...(capacityShed ? ['load-2'] : [])]),
          shedReasons: new Map(capacityShed ? [['load-2', { code: PLAN_REASON_CODES.capacity }]] : []),
        }),
        deps: {
          getInferredSurplusKw: () => 0,
          getShedBehavior: () => ({ action: 'turn_off' }),
          getPriceOptimizationSettings: () => ({}),
          pendingBinaryCommandStore: pending,
        },
      });
      return {
        decisions, input, lowerPlan: plan.find(({ id }) => id === 'load-2')!,
        lowerReport: reports.find(({ evaluation }) => evaluation.deviceId === 'load-2'),
      };
    };
    expect(freshIds(home.tick(START_MS))).toEqual(['load-1']);
    expect(freshIds(home.tick(START_MS + 30_000))).toEqual(['load-2']);
    const settleAt = START_MS + HOUR_MS;
    const before = admissionAt(settleAt - 1_000);
    expect(before.decisions.get('load-2')).toMatchObject({ kind: 'planned' });
    expect(before.input.forceShedSet.has('load-2')).toBe(false);
    expect(before.lowerPlan?.plannedState).toBe('keep');

    home.devices[0]!.currentTemperature = 19;
    expect(freshIds(home.tick(settleAt))).toEqual(['load-1']);

    const revision = home.recorder.getActivePlan('load-2')?.latest?.revision;
    const priceReadsBeforeWait = home.priceReadCount();
    const waiting = admissionAt(settleAt + 1_000);
    expect(waiting.lowerReport?.diagnostic.reasonCode).toBe('objective_waiting_for_plan');
    expect(waiting.decisions.get('load-2')).toMatchObject({ kind: 'waiting', budgetExempt: false });
    expect(buildDeferredReleaseIntents(waiting.decisions)['load-2']).toBeUndefined();
    expect(waiting.input.forceShedSet.has('load-2')).toBe(false);
    expect(waiting.lowerPlan.plannedState).toBe('keep');
    const commands = buildExecutableDeviceIntent(waiting.lowerPlan);
    expect(commands).not.toHaveProperty('binary');
    expect(commands).not.toHaveProperty('target');
    expect(home.priceReadCount()).toBe(priceReadsBeforeWait);
    expect(home.recorder.getActivePlan('load-2')?.latest?.revision).toBe(revision);

    pending.record('load-2', { desired: false, startedMs: Date.now() });
    const pendingOff = admissionAt(settleAt + 1_000);
    expect(buildExecutableDeviceIntent(pendingOff.lowerPlan)).not.toHaveProperty('binary');
    pending.clear('load-2');

    const [first, second] = heaters;
    const stopped = buildPlanInputDevice({
      id: 'load-2', deviceType: 'temperature', controlModel: 'binary_power',
      currentTemperature: 20, currentTarget: 23, currentDrawKw: 0, expectedPowerKw: 1,
      controllable: true, binaryControl: { on: false }, priority: 2,
    });
    const offWhileWaiting = admissionAt(settleAt + 1_000, [first!, stopped]).lowerPlan;
    expect(isRestoreLiveEligibleDevice(offWhileWaiting)).toBe(false);
    expect(buildExecutableDeviceIntent(offWhileWaiting)).not.toHaveProperty('binary');
    expect(buildExecutableDeviceIntent(admissionAt(settleAt + 1_000, [
      { ...first!, reservesStartupPower: true, currentDrawKw: 0 }, second!,
    ]).lowerPlan)).not.toHaveProperty('binary');
    expect(buildExecutableDeviceIntent(admissionAt(settleAt + 4 * 60_000).lowerPlan)).not.toHaveProperty('binary');

    const charger = buildPlanInputDevice({
      id: 'load-2', isEvCharger: true, controlModel: 'stepped_load',
      binaryControl: { on: true }, currentDrawKw: 1.3, expectedPowerKw: 1.38, priority: 2,
      startPolicyInForce: 'pels_only', selectedStepId: '6a',
      steppedLoadProfile: { steps: [
        { id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 1380 }, { id: '8a', planningPowerW: 1840 },
      ] },
    });
    const waitingCharger = admissionAt(settleAt + 1_000, [first!, charger]);
    expect(resolveStartPolicyHold(waitingCharger.input.devices).holdIds.has(charger.id)).toBe(false);
    expect(waitingCharger.lowerPlan.plannedState).toBe('keep');
    expect(isRestoreLiveEligibleDevice(waitingCharger.lowerPlan)).toBe(false);
    expect(isSwapRestoreCandidate(waitingCharger.lowerPlan)).toBe(true);
    expect(buildExecutableDeviceIntent(waitingCharger.lowerPlan)).not.toHaveProperty('steppedLoad');
    const limited = admissionAt(settleAt + 1_000, heaters, true);
    expect(limited.lowerPlan.plannedState).toBe('shed');
    expect(buildExecutableDeviceIntent(limited.lowerPlan)).toMatchObject({ binary: { desiredOn: false } });

    expect(freshIds(home.tick(settleAt + 30_000))).toEqual(['load-2']);
    const replanned = admissionAt(settleAt + 31_000);
    expect(replanned.decisions.get('load-2')).toMatchObject({ kind: 'planned' });
    expect(replanned.input.forceShedSet.has('load-2')).toBe(false);
    expect(replanned.lowerPlan?.plannedState).toBe('keep');
  });
});
