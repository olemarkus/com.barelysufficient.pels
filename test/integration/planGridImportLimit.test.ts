import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { PriceLevel } from '../../lib/price/priceLevels';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { PlanEngineState } from '../../lib/plan/planState';

const chargerProfile = { steps: [
  { id: 'off', planningPowerW: 0 },
  { id: '6a', planningPowerW: 1380 },
  { id: '10a', planningPowerW: 2300 },
  { id: '16a', planningPowerW: 3680 },
] };

const buildPlanner = (
  totalKw: number,
  state: PlanEngineState = createPlanEngineState(),
  limits: PowerLimitSettings = {
    capacityEnabled: false, gridImportLimitKw: 3.3, limitKw: 10, marginKw: 0.2, periodMinutes: 60,
  },
): PlanBuilder => new PlanBuilder({
  leaveOffOnRelease: () => 'released',
  getInferredSurplusKw: () => 0,
  getCapacityDryRun: () => false,
  capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
  setCapacityInShortfall: vi.fn(),
  getCapacitySettings: () => limits,
  resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => false,
    getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
    getPriceOptimizationSettings: () => ({}),
    getShedBehavior: () => ({ action: 'turn_off' }),
  }),
  getPriceOptimizationSettings: () => ({}),
  getPowerTracker: () => ({ buckets: {}, lastTimestamp: Date.now(), lastPowerW: totalKw * 1000 }),
  getDailyBudgetSnapshot: () => null,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getDynamicSoftLimitOverride: () => null,
  log: vi.fn(),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  decorateDeferredObjectives: decorateWithoutDeferredObjectives,
}, state);

const binaryLoad = (id: string, powerKw: number) => buildPlanInputDevice({
  id, name: id, deviceType: 'onoff', currentDrawKw: powerKw, expectedPowerKw: powerKw,
  targets: [], binaryControl: { on: true },
});

const charger = (stepId: string, powerKw: number) => steppedInputDevice({
  id: 'charger', name: 'EV charger', isEvCharger: true,
  steppedLoadProfile: chargerProfile, selectedStepId: stepId, currentDrawKw: powerKw,
  targets: [], binaryControl: { on: stepId !== 'off' },
});

describe('grid import constraint in the planner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the one-restore-per-cycle policy when all power constraints are disabled', async () => {
    const off = (id: string) => buildPlanInputDevice({
      id, name: id, targets: [], currentDrawKw: 0, expectedPowerKw: 1, binaryControl: { on: false },
    });
    const plan = await buildPlanner(5, createPlanEngineState(), {
      capacityEnabled: false, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, periodMinutes: 60,
    }).buildDevicePlanSnapshot([off('first'), off('second')]);
    expect(plan.devices.filter((device) => device.plannedState === 'keep')).toHaveLength(1);
    expect(plan.devices.find((device) => device.id === 'second')).toMatchObject({
      plannedState: 'shed', reason: { code: 'meter_settling' },
    });
  });

  it('clears grid shedding at a small supported limit without requiring export', async () => {
    const state = createPlanEngineState();
    const limits: PowerLimitSettings = {
      capacityEnabled: false, gridImportLimitKw: 0.3, limitKw: 10, marginKw: 0.2, periodMinutes: 60,
    };
    await buildPlanner(0.32, state, limits).buildDevicePlanSnapshot([binaryLoad('small', 0.05)]);
    expect(state.sheddingActive).toBe(true);
    const off = buildPlanInputDevice({
      id: 'small', targets: [], currentDrawKw: 0, expectedPowerKw: 0.05, binaryControl: { on: false },
    });
    vi.setSystemTime(Date.now() + 120_000);
    await buildPlanner(0.15, state, limits).buildDevicePlanSnapshot([off]);
    expect(state.sheddingActive).toBe(false);
    // The normal recent-shed buffer expires before this small load fits again.
    vi.setSystemTime(Date.now() + 360_000);
    const restored = await buildPlanner(0.01, state, limits).buildDevicePlanSnapshot([off]);
    expect(restored.devices[0].plannedState).toBe('keep');
  });

  it('reacts to a small breach on the first sample despite a recent restore', async () => {
    const state = createPlanEngineState();
    state.actuation.markRestore('heater', Date.now() - 1000);
    const plan = await buildPlanner(3.15, state).buildDevicePlanSnapshot([binaryLoad('heater', 0.8)]);
    expect(plan.devices[0]).toMatchObject({ plannedState: 'shed', reason: { code: 'grid_import' } });
    expect(plan.meta.capacitySoftLimitKw).toBeNull();
  });

  it('prefers an adjustable charger rung over a lower-priority binary cut', async () => {
    const plan = await buildPlanner(4.68).buildDevicePlanSnapshot([
      { ...charger('16a', 3.68), priority: 1 },
      { ...binaryLoad('heater', 0.8), priority: 2 },
    ]);
    expect(plan.devices.find((device) => device.id === 'charger')).toMatchObject({
      plannedState: 'shed', desiredStepId: '6a', reason: { code: 'grid_import' },
    });
    expect(plan.devices.find((device) => device.id === 'heater')?.plannedState).toBe('keep');
  });

  it('pauses at the charger minimum instead of inventing a lower active rung', async () => {
    const plan = await buildPlanner(3.6).buildDevicePlanSnapshot([charger('6a', 1.38)]);
    expect(plan.devices[0]).toMatchObject({ plannedState: 'shed', desiredStepId: 'off' });
  });

  it('limits budget-exempt loads and still reserves grid headroom on admission', async () => {
    const running = { ...binaryLoad('exempt', 1), budgetExempt: true };
    const shed = await buildPlanner(3.5).buildDevicePlanSnapshot([running]);
    expect(shed.devices[0]).toMatchObject({ plannedState: 'shed', reason: { code: 'grid_import' } });
    const off = buildPlanInputDevice({
      id: 'exempt', budgetExempt: true, currentDrawKw: 0, expectedPowerKw: 1,
      targets: [], binaryControl: { on: false },
    });
    const held = await buildPlanner(2.5).buildDevicePlanSnapshot([off]);
    expect(held.devices[0].plannedState).toBe('shed');
  });
});
