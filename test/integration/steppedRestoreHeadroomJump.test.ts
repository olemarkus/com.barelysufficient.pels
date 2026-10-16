import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planRestoreForSteppedDevice } from '../../lib/plan/restore/helpers';
import { buildRestoreBatchState } from '../../lib/plan/restore/batch';
import type { RestoreCycle } from '../../lib/plan/restore/types';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { applyRestorePlanForSpec, restoreCycleFixture, steppedPlanDevice } from '../utils/planTestUtils';
import { buildPlanCycle } from '../utils/planContextPowerFixture';

const PROFILE = {
  steps: [0, 1, 2, 3, 4, 5, 6].map((kw) => ({ id: `${kw}`, planningPowerW: kw * 1000 })),
};
const runningDevice = (overrides: Parameters<typeof steppedPlanDevice>[0] = {}) => steppedPlanDevice({
  id: 'stepper', name: 'Stepper', currentState: 'on', currentOn: true,
  selectedStepId: '1', desiredStepId: '1', currentDrawKw: 1,
  steppedLoadProfile: PROFILE, priority: 10, ...overrides,
});

function cycleFor(dev: ReturnType<typeof runningDevice>, availableKw: number): RestoreCycle {
  const cycle = restoreCycleFixture(new Map([[dev.id, dev]]), createPlanEngineState(), {
    nowTs: Date.now(), measurementTs: Date.now(),
  });
  return { ...cycle, batchState: buildRestoreBatchState({ timing: cycle.timing, availableHeadroom: availableKw }) };
}

function restore(cycle: RestoreCycle, dev: ReturnType<typeof runningDevice>, availableKw: number) {
  return planRestoreForSteppedDevice(cycle, { onDevices: [] }, dev, {
    availableHeadroom: availableKw, restoredOneThisCycle: false,
  });
}

describe('running stepped loads spend a conservative allowance on a direct jump', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T08:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it.each([false, true])('jumps more than three rungs, EV=%s, and books one complete buffered increase', (isEvCharger) => {
    const dev = runningDevice({ isEvCharger });
    const cycle = cycleFor(dev, 12);
    const result = restore(cycle, dev, 12);
    expect(cycle.deviceMap.get(dev.id)).toMatchObject({ desiredStepId: '6', reason: {
      code: PLAN_REASON_CODES.restoreNeed, fromTarget: '1', toTarget: '6', needKw: 5.6,
    } });
    expect(result.availableHeadroom).toBeCloseTo(6.4);
    expect(cycle.batchState.admittedCount).toBe(1);
    expect(cycle.batchState.admittedNeedKw).toBeCloseTo(5.6);
  });

  it.each([
    [4.6, '3'], // 2 kW + 0.3 kW buffer exactly fits half.
    [4.599, '2'],
    [1.3, '2'], // Ordinary one-step admission still uses the full room.
    [1.19, '1'],
  ])('with %s kW available chooses %s', (available, target) => {
    const dev = runningDevice();
    const cycle = cycleFor(dev, available);
    restore(cycle, dev, available);
    expect(cycle.deviceMap.get(dev.id)?.desiredStepId).toBe(target);
  });

  it('prices the target against actual low draw, without crediting nameplate power as already drawn', () => {
    const dev = runningDevice({ currentDrawKw: 0.2 });
    const cycle = cycleFor(dev, 4.6);
    restore(cycle, dev, 4.6);
    expect(cycle.deviceMap.get(dev.id)).toMatchObject({ desiredStepId: '2', reason: { needKw: 2.08 } });
  });

  it('preserves higher-priority startup reservations', () => {
    const dev = runningDevice();
    const cycle = { ...cycleFor(dev, 12), headroomReserves: [{ deviceId: 'first', deviceName: 'First', priority: 1, kw: 9 }] };
    restore(cycle, dev, 12);
    expect(cycle.deviceMap.get(dev.id)?.desiredStepId).toBe('3');
  });

  it('spends only the remaining shared batch allowance', () => {
    const dev = runningDevice();
    const cycle = cycleFor(dev, 12);
    Object.assign(cycle.batchState, { admittedCount: 1, admittedNeedKw: 3.7 });
    cycle.state.shedDecisions.lastPlannedShedIds = new Set([dev.id]);
    planRestoreForSteppedDevice(cycle, { onDevices: [] }, dev, {
      availableHeadroom: 8.3, restoredOneThisCycle: true,
    });
    expect(cycle.deviceMap.get(dev.id)?.desiredStepId).toBe('3');
    expect(cycle.batchState.admittedCount).toBe(2);
    expect(cycle.batchState.admittedNeedKw).toBeCloseTo(6);
  });

  it.each([false, true])('respects the solar ceiling unless boosted: %s', (boostActive) => {
    const dev = runningDevice({ surplusTracking: true, boostActive });
    const cycle = cycleFor(dev, 12);
    cycle.state.surplusTrackingByDevice[dev.id] = { kind: 'rung', stepId: '3', funded: true };
    restore(cycle, dev, 12);
    expect(cycle.deviceMap.get(dev.id)?.desiredStepId).toBe(boostActive ? '6' : '3');
  });

  it('still starts an off device at the lowest active step', () => {
    const dev = runningDevice({ currentState: 'off', currentOn: false, selectedStepId: '0', currentDrawKw: 0 });
    const cycle = cycleFor(dev, 12);
    restore(cycle, dev, 12);
    expect(cycle.deviceMap.get(dev.id)?.desiredStepId).toBe('1');
  });

  it.each([
    { status: 'pending', available: 12 }, { status: 'pending', available: 2 },
    { status: 'stale', available: 12 }, { status: 'stale', available: 2 },
  ] as const)('retains an outstanding target through $status with $available kW available', ({ status, available }) => {
    const dev = runningDevice({
      desiredStepId: '4', lastDesiredStepId: '4', previousStepId: '1',
      stepCommandPending: status === 'pending', stepCommandStatus: status,
      lastStepCommandIssuedAt: Date.now() - 10_000, nextStepCommandRetryAtMs: Date.now() + 60_000,
    });
    const cycle = cycleFor(dev, available);
    restore(cycle, dev, available);
    expect(cycle.deviceMap.get(dev.id)?.desiredStepId).toBe('4');
    expect(cycle.deviceMap.get(dev.id)?.reason.code).toBe(
      status === 'pending' ? PLAN_REASON_CODES.restorePending : PLAN_REASON_CODES.keep,
    );
    expect(cycle.batchState.admittedCount).toBe(0);
  });

  it('retains fairness while another device is limited', () => {
    const dev = runningDevice();
    const cycle = cycleFor(dev, 12);
    const other = runningDevice({ id: 'other', plannedState: 'shed' });
    cycle.deviceMap.set(other.id, other);
    restore(cycle, dev, 12);
    expect(cycle.deviceMap.get(dev.id)).toMatchObject({ desiredStepId: '1', reason: { code: PLAN_REASON_CODES.shedInvariant } });
  });

  it('holds a recently reduced EV charger even with room for a large jump', () => {
    const dev = runningDevice({ isEvCharger: true });
    const cycle = cycleFor(dev, 12);
    cycle.state.actuation.lastDeviceShedMs[dev.id] = Date.now() - 120_000;
    restore(cycle, dev, 12);
    expect(cycle.deviceMap.get(dev.id)).toMatchObject({ desiredStepId: '1', reason: { code: PLAN_REASON_CODES.cooldownRestore } });
  });

  it.each([
    { label: 'ordinary', headroom: 12, grid: false, budget: null, target: '6' },
    { label: 'grid import enabled', headroom: 12, grid: true, budget: null, target: '2' },
    { label: 'budget binds', headroom: 12, grid: false, budget: 4.6, target: '3' },
    { label: 'no limits', headroom: null, grid: false, budget: null, target: '2' },
  ])('uses real restore-pass eligibility and axes: $label', ({ headroom, grid, budget, target }) => {
    const dev = runningDevice();
    const state = createPlanEngineState();
    const result = applyRestorePlanForSpec({
      planDevices: [dev], state, sheddingActive: false,
      ...buildPlanCycle({
        headroomKw: headroom, capacityHeadroomKw: headroom, budgetHeadroomKw: budget,
        capacitySoftLimit: 30, gridImportLimitKw: grid ? 30 : null, gridImportTargetKw: grid ? 30 : null,
      }),
      deps: cycleFor(dev, 12).deps,
    });
    expect(result.planDevices.find((device) => device.id === dev.id)?.desiredStepId).toBe(target);
  });
});
