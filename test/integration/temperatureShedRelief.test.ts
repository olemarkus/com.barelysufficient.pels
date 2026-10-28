import { describe, expect, it, vi } from 'vitest';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { PlanInputDevice, ShedBehavior } from '../../lib/plan/planTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildSheddingPlanForSpec } from '../helpers/sheddingPlanForSpec';
import { capacityGuardSpy, sheddingWiring } from '../helpers/sheddingWiring';
import { partialDouble } from '../helpers/partialDouble';
import { buildPlanCycle, type PlanCycleSpec } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';

const NOW = 1_000_000;
const shedBehavior = (id: string): ShedBehavior => id === 'heat'
  ? { action: 'set_temperature', temperature: 19 } : { action: 'turn_off' };

const heat = (target = 22, powerKw = 6) => buildPlanInputDevice({
  id: 'heat', name: 'Heat', priority: 3, currentDrawKw: powerKw, expectedPowerKw: powerKw,
  currentTarget: target, currentTemperature: 21,
  targets: [{ id: 'target_temperature', value: target, unit: '°C' }],
  binaryControl: { on: true },
});
const direct = () => buildPlanInputDevice({
  id: 'direct', name: 'Direct', priority: 1, currentDrawKw: 6, expectedPowerKw: 6,
  binaryControl: { on: true }, targets: [],
});

async function decide(
  state: PlanEngineState, devices: PlanInputDevice[], thresholdKw: number | null, grid = false, atMs = NOW,
  cycle: PlanCycleSpec = {},
) {
  const { context, power } = buildPlanCycle({
    devices, nowTs: atMs, total: 18, softLimit: 12, headroom: -6,
    capacitySoftLimit: grid ? null : 12, softLimitSource: grid ? 'grid' : 'capacity',
    capacityHeadroomKw: grid ? null : -6,
    gridImportTargetKw: grid ? 12 : null,
    budgetKWh: 10, minutesRemaining: 30,
    intent: { getShedBehavior: shedBehavior },
    ...cycle,
  });
  const guard = capacityGuardSpy();
  const result = await buildSheddingPlanForSpec(context, power, state, {
    ...sheddingWiring(state), getShedBehavior: shedBehavior, capacityGuard: guard,
    shortfallThresholdKw: thresholdKw,
    powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: atMs, lastPowerW: power.drawKw * 1000 }),
  });
  return { result, guard };
}

describe('temperature restrictions under electrical pressure', () => {
  it.each([
    { name: 'grid pressure', grid: true, threshold: null },
    { name: 'actual capacity projection', grid: false, threshold: 12 },
  ])('requests direct relief in the same cycle as a 6 kW setback under $name', async ({ grid, threshold }) => {
    const { result } = await decide(createPlanEngineState(NOW), [heat(), direct()], threshold, grid);
    expect([...result.shedSet]).toEqual(['heat', 'direct']);
    if (result.outcome.kind !== 'shed') throw new Error('expected a shed');
    expect(result.outcome.latch.decisions.get('heat')).toEqual([
      { kind: 'demand', decidedAtMs: NOW, creditedKw: 0 },
    ]);
    expect(result.outcome.latch.decisions.get('direct')).toEqual([
      { kind: 'electrical', decidedAtMs: NOW, creditedKw: 6 },
    ]);
  });

  it('gives an ordinary capacity restriction its bounded opportunity before a higher-priority cut', async () => {
    const { result } = await decide(createPlanEngineState(NOW), [heat(), direct()], 20);
    expect([...result.shedSet]).toEqual(['heat']);
    if (result.outcome.kind !== 'shed') throw new Error('expected a shed');
    expect(result.outcome.latch.decisions.get('heat')).toEqual([
      { kind: 'demand', decidedAtMs: NOW, creditedKw: 6 },
    ]);
  });

  it.each([true, false])('answers a 2 kW physical deficit without spending a 9 kW daily deficit on direct cuts, grid=%s', async (grid) => {
    const small = buildPlanInputDevice({ id: 'small', priority: 2, currentDrawKw: 2, binaryControl: { on: true } });
    const protectedLoad = buildPlanInputDevice({ id: 'protected', priority: 1, currentDrawKw: 7, binaryControl: { on: true } });
    const { result } = await decide(createPlanEngineState(NOW), [heat(22, 7), small, protectedLoad], grid ? null : 18, grid, NOW, {
      total: 20, softLimit: 11, headroom: -9, softLimitSource: 'daily',
      dailySoftLimit: 11, budgetPaceKw: 11,
      capacitySoftLimit: grid ? null : 18, capacityHeadroomKw: grid ? null : -2,
      gridImportTargetKw: grid ? 18 : null,
    });
    expect([...result.shedSet]).toEqual(['heat', 'small']);
    expect(result.shedSet.has('protected')).toBe(false);
  });

  it('subtracts pending direct relief from the physical deficit before considering residual daily pressure', async () => {
    const state = createPlanEngineState(NOW);
    state.lastShedPlanMeasurementTs = NOW - 1000;
    state.shedPlanLatch = {
      powerW: 20_000, stepTargets: new Map(),
      decisions: new Map([['pending', [{ kind: 'electrical', decidedAtMs: NOW - 1000, creditedKw: 2 }]]]),
    };
    const pending = buildPlanInputDevice({ id: 'pending', priority: 4, currentDrawKw: 2, binaryControl: { on: true } });
    const small = buildPlanInputDevice({ id: 'small', priority: 2, currentDrawKw: 2, binaryControl: { on: true } });
    const { result } = await decide(state, [pending, heat(22, 7), small], null, true, NOW, {
      total: 20, softLimit: 11, headroom: -9, softLimitSource: 'daily',
      dailySoftLimit: 11, budgetPaceKw: 11, gridImportTargetKw: 18,
    });
    expect([...result.shedSet]).toEqual(['pending']);
    expect(result.outcome.kind).toBe('held');
  });

  it('preserves capacity response margin when the actual-cap projection is above the capacity pace', async () => {
    const stepped = steppedInputDevice({
      id: 'stepped', currentDrawKw: 6, selectedStepId: 'high', binaryControl: { on: true },
      steppedLoadProfile: { steps: [
        { id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1500 },
        { id: 'mid', planningPowerW: 4500 }, { id: 'high', planningPowerW: 6000 },
      ] },
    });
    const { result } = await decide(createPlanEngineState(NOW), [stepped], 10.5, false, NOW, {
      total: 12, softLimit: 7.5, headroom: -4.5,
      capacitySoftLimit: 7.5, capacityHeadroomKw: -4.5,
    });
    // The actual cap alone needs 1.5 kW; capacity pacing needs 4.5 kW to
    // preserve the response margin. Select the larger reduction immediately.
    expect(result.shedStepTargets.get('stepped')).toBe('low');
  });

  it.each([true, false])('withdraws a previous soft credit on grid onset, target echoed=%s', async (echoed) => {
    const state = createPlanEngineState(NOW);
    const first = await decide(state, [heat(), direct()], 20);
    state.applySheddingOutcome(first.result.outcome, null);
    const urgent = await decide(state, [heat(echoed ? 19 : 22), direct()], null, true, NOW + 1000);
    expect(urgent.result.shedSet.has('direct')).toBe(true);
    if (urgent.result.outcome.kind !== 'shed') throw new Error('expected a shed');
    expect(urgent.result.outcome.latch.decisions.get('heat')).toEqual([
      { kind: 'withdrawn_demand', decidedAtMs: NOW, creditedKw: 6 },
    ]);
  });

  it.each([true, false])('does not conceal capacity shortfall behind a temperature command, target echoed=%s', async (echoed) => {
    const state = createPlanEngineState(NOW);
    state.pendingTargetCommands.heat = {
      desired: 19, startedMs: NOW - 1000, lastAttemptMs: NOW - 1000,
      nextRetryAtMs: NOW + 30_000, retryCount: 0, status: 'waiting_confirmation',
    };
    const { guard } = await decide(state, [heat(echoed ? 19 : 22)], 12);
    const summary = vi.mocked(guard.recordPlanVerdict).mock.calls.at(-1)?.[2];
    expect(summary).toMatchObject({
      remainingActionableControlledLoad: false,
      shedReliefInFlight: false,
    });
  });
});
