import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { resolveLatestPlanDesiredStepId } from '../../lib/plan/plannedSteppedCommand';
import { resolvePlannedDesiredStepToPreserve } from '../../lib/executor/steppedFeedback';
import { PELS_TARGET_STEP_CAPABILITY_ID } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadDesiredRuntimeState } from '../../lib/executor/steppedCommandState';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { steppedInputDevice } from '../utils/planTestUtils';
import { planBuilderWiring } from '../helpers/planBuilderWiring';

// The step the plan admits a stepped restore to is the step the executor's Flow
// feedback lifecycle reads back (`resolveLatestPlanDesiredStepId`). When the plan
// device carried that decision in two fields and restore admission revised only
// one, the reader saw the keep rung instead, and a Flow report still at the old
// rung made the executor "preserve" the old rung over the command in flight.
const CHARGER_PROFILE = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '10a', planningPowerW: 2300 },
    { id: '16a', planningPowerW: 3680 },
  ],
};
const NOW_MS = Date.parse('2026-10-01T19:50:05.000Z');
const SOFT_LIMIT_KW = 8;

const buildPlanner = (availableKw: number): PlanBuilder => new PlanBuilder({
  ...planBuilderWiring(),
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  getCapacitySettings: () => ({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, periodMinutes: 60 }),
  getPowerTracker: () => ({
    buckets: {},
    lastTimestamp: Date.now(),
    lastPowerW: (SOFT_LIMIT_KW - availableKw) * 1000,
  }),
  getDynamicSoftLimitOverride: () => SOFT_LIMIT_KW,
}, createPlanEngineState());

// Running at 6 A, last commanded to 6 A, with room to climb.
const charger = () => steppedInputDevice({
  id: 'charger',
  name: 'Charger',
  steppedLoadProfile: CHARGER_PROFILE,
  selectedStepId: '6a',
  reportedStepId: '6a',
  desiredStepId: '6a',
  binaryControl: { on: true },
  currentDrawKw: 1.38,
  targets: [],
});

const inFlightCommand = (stepId: string): SteppedLoadDesiredRuntimeState => ({
  capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
  stepId,
  previousStepId: '6a',
  changedAtMs: NOW_MS,
  lastIssuedAtMs: NOW_MS,
  retryCount: 0,
  status: 'pending',
});

describe('a stepped restore climb is the step the executor reads back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the admitted rung when a Flow report still names the old one', async () => {
    const plan = await buildPlanner(5).buildDevicePlanSnapshot([charger()]);
    const planned = plan.devices.find((device) => device.id === 'charger');
    // Premise: the planner admitted a climb above the commanded rung.
    expect(planned?.reason.code).toBe(PLAN_REASON_CODES.restoreNeed);
    const admittedStepId = planned?.desiredStepId;
    expect(admittedStepId).toBe('10a');

    const latestPlanDesiredStepId = resolveLatestPlanDesiredStepId(plan, 'charger', CHARGER_PROFILE);
    expect(latestPlanDesiredStepId).toBe(admittedStepId);

    // The executor issued the admitted rung; the charger still reports 6 A.
    const preserved = resolvePlannedDesiredStepToPreserve(
      inFlightCommand('10a'),
      CHARGER_PROFILE,
      latestPlanDesiredStepId,
      { deviceId: 'charger', stepId: '6a', planningPowerW: 1380, observedAtMs: NOW_MS },
    );
    expect(preserved).toBeUndefined();
  });

  it('reads back the rung a climb in flight is held at', async () => {
    // The 10 A command is out and unconfirmed: the restore lane holds the climb
    // pending rather than admitting it again, and that hold names the rung too.
    const plan = await buildPlanner(5).buildDevicePlanSnapshot([steppedInputDevice({
      ...charger(),
      desiredStepId: '10a',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
      lastStepCommandIssuedAt: NOW_MS - 5_000,
    })]);
    const planned = plan.devices.find((device) => device.id === 'charger');
    expect(planned?.reason.code).toBe(PLAN_REASON_CODES.restorePending);
    expect(planned?.desiredStepId).toBe('10a');

    const latestPlanDesiredStepId = resolveLatestPlanDesiredStepId(plan, 'charger', CHARGER_PROFILE);
    expect(latestPlanDesiredStepId).toBe('10a');
    expect(resolvePlannedDesiredStepToPreserve(
      inFlightCommand('10a'),
      CHARGER_PROFILE,
      latestPlanDesiredStepId,
      { deviceId: 'charger', stepId: '6a', planningPowerW: 1380, observedAtMs: NOW_MS },
    )).toBeUndefined();
  });
});
