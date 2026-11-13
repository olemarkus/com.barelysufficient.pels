import { describe, expect, it } from 'vitest';
import {
  ChargingPhasePlanningCycle, chargingPhasePoint,
} from '../../lib/plan/chargingPhasePlanning';
import { applyRestoreCandidates } from '../../lib/plan/restore/candidateLoop';
import {
  tryPlanChargingPhaseRestore, withChargingPhaseOffCandidates,
} from '../../lib/plan/restore/chargingPhaseRestore';
import { buildDisabledRestoreBatchState } from '../../lib/plan/restore/batch';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import type { RestoreCycle } from '../../lib/plan/restore/types';
import type { RestoreTiming } from '../../lib/plan/restore/timing';
import type { BinaryControlKind, MeteredKind, SteppedPlanDevice } from '../../lib/plan/planTypes';
import type { ChargingPhaseEnvelope } from '../../packages/planner-types/src/chargingPhases';
import { EMPTY_CHARGING_PHASE_READ } from '../../lib/ports/chargingPhases';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { partialDouble } from '../helpers/partialDouble';

const NOW = 10_000;
const envelopes: readonly ChargingPhaseEnvelope[] = ([1, 3] as const).map((phases) => ({
  phases, footprint: phases === 1 ? { kind: 'single', phase: 'L1' } : { kind: 'all_three' },
  profile: { steps: [{ id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    { id: '6a', planningCurrentA: 6, planningPowerW: phases * 1380 },
    { id: '16a', planningCurrentA: 16, planningPowerW: phases * 3680 }] },
}));
const axes = { capacity: { kind: 'off' as const }, grid: { kind: 'off' as const },
  budget: { kind: 'off' as const }, phase: { kind: 'off' as const } };

function fixture(mode: 'single' | 'automatic' = 'single', currentA = 0) {
  const state = createPlanEngineState(NOW);
  state.chargingPhaseCycle = new ChargingPhasePlanningCycle({
    ...EMPTY_CHARGING_PHASE_READ,
    candidates: [{ deviceId: 'charger', mode, minimumCurrentA: 6, envelopes, forceSinglePhase: true,
      observed: chargingPhasePoint(envelopes[0], currentA) }],
  });
  const device = partialDouble<SteppedPlanDevice & MeteredKind & BinaryControlKind>({
    id: 'charger', name: 'Charger', priority: 1, plannedState: 'keep',
    control: { managed: true, commandAuthority: true }, available: true,
    currentDrawKw: currentA * 0.23, currentOn: currentA > 0, budgetExempt: false, boostActive: false,
    steppedLoadProfile: envelopes[0].profile, selectedStepId: currentA > 0 ? `${currentA}a` : 'off',
    desiredStepId: '6a', reason: { code: 'keep', detail: null },
  });
  state.shedDecisions.hasRecordedPlan = true;
  state.shedDecisions.lastPlannedDeviceIds = new Set([device.id]);
  state.shedDecisions.lastPlannedKeptIds = new Set([device.id]);
  const cycle = partialDouble<RestoreCycle>({
    state, deviceMap: new Map([[device.id, device]]), swapLedger: state.swapLedger,
    restoredThisCycle: new Set(), headroomReserves: [], storageHandBackWaitingAt: Infinity,
    batchState: buildDisabledRestoreBatchState(),
    timing: partialDouble<RestoreTiming>({ nowTs: NOW, measurementTs: NOW }),
    phase: 'runtime',
  });
  return { cycle, device };
}

describe('phase-only restore turns', () => {
  it('leaves a kept idle device alone when its phase mode already matches', () => {
    const { cycle, device } = fixture();
    const ledger = buildRestoreHeadroomLedger(axes);
    const candidates = withChargingPhaseOffCandidates([device], [], cycle.state.chargingPhaseCycle);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['charging_phase']);
    const result = applyRestoreCandidates(cycle, { onDevices: [] }, candidates, ledger, false);
    expect(cycle.deviceMap.get(device.id)).toMatchObject({
      plannedState: 'keep', desiredStepId: '6a', reason: { code: 'keep', detail: null },
    });
    expect(result.restoredOneThisCycle).toBe(false);
    expect(cycle.restoredThisCycle.size).toBe(0);
    expect(cycle.state.chargingPhaseCycle.decisions()).toEqual([]);
    expect(ledger.axes()).toEqual(axes);
  });

  it('preserves the kept posture while another restore waits for a fresh meter reading', () => {
    const { cycle, device } = fixture('automatic');
    const ledger = buildRestoreHeadroomLedger(axes);
    const candidates = withChargingPhaseOffCandidates([device], [], cycle.state.chargingPhaseCycle);
    applyRestoreCandidates(cycle, { onDevices: [] }, candidates, ledger, true);
    expect(cycle.deviceMap.get(device.id)).toMatchObject({
      plannedState: 'keep', desiredStepId: '6a', reason: { code: 'keep', detail: null },
    });
    expect(cycle.restoredThisCycle.size).toBe(0);
    expect(cycle.state.chargingPhaseCycle.decisions()).toEqual([]);
    expect(ledger.axes()).toEqual(axes);
  });
});

describe('solar phase admission', () => {
  it('does not spend grid room when the solar turn could not fund the alternative floor', () => {
    const { cycle, device } = fixture('automatic', 16);
    const solarDevice = { ...device, surplusTracking: true as const };
    const phases = cycle.state.chargingPhaseCycle;
    expect(phases.chooseSurplus(device.id, 3.5, axes.phase)).toBeUndefined();
    phases.offerRestoreBudget(device.id, axes);
    expect(tryPlanChargingPhaseRestore(cycle, solarDevice,
      { availableHeadroom: null, restoredOneThisCycle: false })).toBeUndefined();
    expect(phases.decisions()).toEqual([]);
  });

  it('lets an actual boost use capacity independently of the missing solar offer', () => {
    const { cycle, device } = fixture('automatic', 16);
    cycle.state.chargingPhaseCycle.offerRestoreBudget(device.id, axes);
    const result = tryPlanChargingPhaseRestore(cycle, { ...device, surplusTracking: true, boostActive: true },
      { availableHeadroom: null, restoredOneThisCycle: false });
    expect(result?.restoredOneThisCycle).toBe(true);
    expect(cycle.state.chargingPhaseCycle.decisions()[0]).toMatchObject({ kind: 'prepare', target: { phases: 3 } });
  });
});
