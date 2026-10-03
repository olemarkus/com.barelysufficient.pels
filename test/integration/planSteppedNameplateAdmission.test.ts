import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { computeRestoreBufferKw } from '../../lib/plan/restore/accounting';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PriceLevel } from '../../lib/price/priceLevels';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { steppedInputDevice } from '../utils/planTestUtils';

// Drives the REAL PlanBuilder from the plan INPUT, which is where a learned step
// power arrives (`PlanInputDevice.stepPowerCalibration`).
//
// Production 2026-10-01 19:50:05Z: "Elbillader" (single-phase, 6a..32a) had a
// learned `6a` power of 0.7878 kW, polluted low by trickle samples, against a
// 1.38 kW nameplate. The plan resumed it from off with `restore_stepped_admitted`
// `deltaKw` 0.7877936 while the rung really drew 1.13-1.36 kW: capacity admission
// under-reserved by the gap. Capacity prices a rung at its nameplate.
const CHARGER_PROFILE = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '10a', planningPowerW: 2300 },
    { id: '16a', planningPowerW: 3680 },
    { id: '32a', planningPowerW: 7360 },
  ],
};
const NAMEPLATE_6A_KW = 1.38;
const LEARNED_6A_KW = 0.7878;
const NAMEPLATE_NEED_KW = NAMEPLATE_6A_KW + computeRestoreBufferKw(NAMEPLATE_6A_KW);
const LEARNED_NEED_KW = LEARNED_6A_KW + computeRestoreBufferKw(LEARNED_6A_KW);

const SOFT_LIMIT_KW = 4;

// A builder whose whole-home reading leaves exactly `availableKw` under the pace.
const buildPlanner = (availableKw: number): PlanBuilder => new PlanBuilder({
  leaveOffOnRelease: () => 'released',
  getInferredSurplusKw: () => 0,
  getCapacityDryRun: () => false,
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  setCapacityInShortfall: vi.fn(),
  getCapacitySettings: () => ({ limitKw: 10, marginKw: 0.2, periodMinutes: 60 }),
  resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => false,
    getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
    getPriceOptimizationSettings: () => ({}),
    getShedBehavior: () => ({ action: 'turn_off' }),
  }),
  getPriceOptimizationSettings: () => ({}),
  getPowerTracker: () => ({
    buckets: {},
    lastTimestamp: Date.now(),
    lastPowerW: (SOFT_LIMIT_KW - availableKw) * 1000,
  }),
  getDailyBudgetSnapshot: () => null,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getDynamicSoftLimitOverride: () => SOFT_LIMIT_KW,
  log: vi.fn(),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  decorateDeferredObjectives: decorateWithoutDeferredObjectives,
}, createPlanEngineState());

// Off, drawing nothing, and carrying the learned figure the store had for `6a`.
const elbillader = () => steppedInputDevice({
  id: 'elbillader',
  name: 'Elbillader',
  steppedLoadProfile: CHARGER_PROFILE,
  selectedStepId: 'off',
  binaryControl: { on: false },
  currentDrawKw: 0,
  targets: [],
  stepPowerCalibration: { '6a': LEARNED_6A_KW },
});

describe('stepped restore admission prices the rung at its nameplate', () => {
  let capture: LoggerCapture;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T19:50:05.000Z'));
    capture = captureLogger('debug', ['plan']);
  });
  afterEach(() => {
    capture.restore();
    vi.useRealTimers();
  });

  it('keeps a charger off when the room sits between its learned and nameplate need', async () => {
    // 1.2 kW available: enough for the learned 0.79 kW plus buffer, short of the
    // 1.38 kW nameplate plus buffer. Premise check so the case cannot pass vacuously.
    const availableKw = 1.2;
    expect(LEARNED_NEED_KW).toBeLessThan(availableKw);
    expect(NAMEPLATE_NEED_KW).toBeGreaterThan(availableKw);

    const plan = await buildPlanner(availableKw).buildDevicePlanSnapshot([elbillader()]);
    const charger = plan.devices.find((device) => device.id === 'elbillader');

    expect(charger?.plannedState).toBe('shed');
    expect(charger?.desiredStepId).toBe('off');
    expect(charger?.reason).toMatchObject({
      code: PLAN_REASON_CODES.insufficientHeadroom,
      needKw: expect.closeTo(NAMEPLATE_NEED_KW, 6),
    });
    expect(capture.findEvent('restore_stepped_admitted')).toBeUndefined();
    expect(capture.findEvent('restore_stepped_rejected')).toMatchObject({
      deviceId: 'elbillader',
      requestedStepId: '6a',
      rejectionReason: 'insufficient_headroom',
      neededKw: expect.closeTo(NAMEPLATE_NEED_KW, 6),
    });
  });

  it('admits the same resume once the room covers the nameplate, and books the nameplate', async () => {
    const plan = await buildPlanner(2).buildDevicePlanSnapshot([elbillader()]);
    const charger = plan.devices.find((device) => device.id === 'elbillader');

    expect(charger?.plannedState).toBe('keep');
    expect(charger?.desiredStepId).toBe('6a');
    expect(charger?.reason).toMatchObject({
      code: PLAN_REASON_CODES.restoreNeed,
      needKw: expect.closeTo(NAMEPLATE_NEED_KW, 6),
    });
    // The field the 2026-10-01 log line carried: 1.38, not 0.7877936.
    expect(capture.findEvent('restore_stepped_admitted')).toMatchObject({
      deviceId: 'elbillader',
      toStepId: '6a',
      deltaKw: expect.closeTo(NAMEPLATE_6A_KW, 6),
      neededKw: expect.closeTo(NAMEPLATE_NEED_KW, 6),
    });
  });
});
