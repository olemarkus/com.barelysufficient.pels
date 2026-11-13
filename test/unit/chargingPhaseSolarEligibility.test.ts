import { expect, it } from 'vitest';
import { ChargingPhasePlanningCycle, chargingPhasePoint } from '../../lib/plan/chargingPhasePlanning';
import { resolveSurplusEligibility } from '../../lib/plan/planSurplusAbsorb';
import { PHASE_POWER_OFF } from '../../lib/plan/phase/phasePower';
import { EMPTY_CHARGING_PHASE_READ } from '../../lib/ports/chargingPhases';
import { SURPLUS_ABSORB_SETTLE_MS } from '../../lib/plan/admission/surplusAbsorb';
import type { ChargingPhaseEnvelope } from '../../packages/planner-types/src/chargingPhases';
import type { ChargingPhasePlanningRead } from '../../lib/ports/chargingPhases';
import { tryPlanChargingPhaseRestore } from '../../lib/plan/restore/chargingPhaseRestore';
import { buildDisabledRestoreBatchState } from '../../lib/plan/restore/batch';
import type { RestoreCycle } from '../../lib/plan/restore/types';
import { partialDouble } from '../helpers/partialDouble';
import type { MeteredKind, SteppedPlanDevice, MeteredPlanInputDevice } from '../../lib/plan/planTypes';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice, NO_STORAGE_SURPLUS } from '../utils/planTestUtils';

const envelopes: readonly ChargingPhaseEnvelope[] = ([1, 3] as const).map((phases) => ({
  phases, footprint: phases === 1 ? { kind: 'single', phase: 'L1' } : { kind: 'all_three' },
  profile: { steps: [{ id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    { id: '6a', planningCurrentA: 6, planningPowerW: phases * 1380 }] },
}));
const initialRead: ChargingPhasePlanningRead = {
  ...EMPTY_CHARGING_PHASE_READ,
  candidates: [{ deviceId: 'charger', mode: 'automatic', forceSinglePhase: false, minimumCurrentA: 6, envelopes,
    observed: chargingPhasePoint(envelopes[1], 0) }],
};

it('qualifies a phase solar allocation with the normal gate and keeps eligibility after physical confirmation', () => {
  const state = createPlanEngineState(0);
  const off = buildPlanInputDevice({
    id: 'charger', currentDrawKw: 0, currentOn: false, selectedStepId: 'off',
    phaseFootprint: envelopes[1].footprint, steppedLoadProfile: envelopes[1].profile, surplusTracking: true, commandableNow: true,
  });
  const allocate = (read: ChargingPhasePlanningRead, device: MeteredPlanInputDevice, netKw: number, nowMs: number) => {
    state.chargingPhaseCycle = new ChargingPhasePlanningCycle(read);
    resolveSurplusEligibility([device], state, netKw, 0, NO_STORAGE_SURPLUS, nowMs, PHASE_POWER_OFF);
  };
  allocate(initialRead, off, -2.5, 0);
  expect(state.chargingPhaseCycle.hasSolarOffer('charger')).toBe(false);
  expect(state.surplusTrackingByDevice.charger).toEqual({ kind: 'stopped' });
  allocate(initialRead, off, -2.5, SURPLUS_ABSORB_SETTLE_MS);
  expect(state.chargingPhaseCycle.hasSolarOffer('charger')).toBe(true);
  expect(state.surplusEligibilityByDevice.charger?.eligible).toBe(true);

  const target = chargingPhasePoint(envelopes[0], 6);
  const reservation = { deviceId: 'charger', ...chargingPhasePoint(envelopes[1], 6) };
  allocate({ ...EMPTY_CHARGING_PHASE_READ, reservations: [reservation],
    observations: [{ deviceId: 'charger', ...chargingPhasePoint(envelopes[1], 0) }],
    continuations: [{ kind: 'switch', deviceId: 'charger', target, reservation }],
  }, off, -2.5, SURPLUS_ABSORB_SETTLE_MS + 10_000);
  expect(state.surplusEligibilityByDevice.charger?.eligible).toBe(true);
  expect(state.surplusTrackingByDevice.charger?.kind).toBe('rung');

  const confirmed = buildPlanInputDevice({
    id: 'charger', currentDrawKw: 1.38, currentOn: true, selectedStepId: '6a',
    phaseFootprint: envelopes[0].footprint, steppedLoadProfile: envelopes[0].profile, surplusTracking: true, commandableNow: true,
  });
  allocate(EMPTY_CHARGING_PHASE_READ, confirmed, -1.12, SURPLUS_ABSORB_SETTLE_MS + 30_000);
  expect(state.surplusEligibilityByDevice.charger?.eligible).toBe(true);
  expect(state.surplusTrackingByDevice.charger).toMatchObject({ kind: 'rung', stepId: '6a' });
});

it('keeps the ordinary solar rung when restore declines a phase proposal and lowers only after admission', () => {
  const state = createPlanEngineState(0);
  const highEnvelopes = envelopes.map((envelope) => ({
    ...envelope, profile: { steps: [...envelope.profile.steps,
      { id: '16a', planningCurrentA: 16, planningPowerW: envelope.phases * 3680 }] },
  }));
  const input = buildPlanInputDevice({
    id: 'charger', currentDrawKw: 3.68, currentOn: true, selectedStepId: '16a', desiredStepId: '16a',
    steppedLoadProfile: highEnvelopes[0].profile, surplusTracking: true, commandableNow: true,
    phaseFootprint: { kind: 'single', phase: 'L1' },
  });
  state.surplusTrackingByDevice.charger = { kind: 'rung', stepId: '16a', funded: true };
  state.surplusEligibilityByDevice.charger = { eligible: true, sinceMs: 0 };
  state.chargingPhaseCycle = new ChargingPhasePlanningCycle({
    ...EMPTY_CHARGING_PHASE_READ,
    candidates: [{ deviceId: 'charger', mode: 'automatic', forceSinglePhase: true,
      minimumCurrentA: 6, envelopes: highEnvelopes, observed: chargingPhasePoint(highEnvelopes[0], 16) }],
  });
  resolveSurplusEligibility([input], state, -3.32, 0, NO_STORAGE_SURPLUS, 100_000, PHASE_POWER_OFF);
  expect(state.chargingPhaseCycle.hasSolarOffer('charger')).toBe(true);
  expect(state.surplusTrackingByDevice.charger).toMatchObject({ kind: 'rung', stepId: '16a' });
  const device = partialDouble<SteppedPlanDevice & MeteredKind>({ ...input, reservesStartupPower: undefined,
    steppedLoadProfile: highEnvelopes[0].profile, plannedState: 'keep', boostActive: false, desiredStepId: '16a' });
  const cycle = partialDouble<RestoreCycle>({ state, deviceMap: new Map([[device.id, device]]),
    headroomReserves: [], restoredThisCycle: new Set(), batchState: buildDisabledRestoreBatchState() });
  state.chargingPhaseCycle.offerRestoreBudget(device.id, {
    capacity: { kind: 'off' }, grid: { kind: 'off' }, budget: { kind: 'off' }, phase: { kind: 'off' },
  });
  expect(tryPlanChargingPhaseRestore(cycle, device,
    { availableHeadroom: null, restoredOneThisCycle: true })).toBeUndefined();
  expect(state.surplusTrackingByDevice.charger).toMatchObject({ kind: 'rung', stepId: '16a' });
  expect(cycle.deviceMap.get(device.id)?.desiredStepId).toBe('16a');
  expect(state.chargingPhaseCycle.decisions()).toEqual([]);

  expect(tryPlanChargingPhaseRestore(cycle, device,
    { availableHeadroom: null, restoredOneThisCycle: false })?.restoredOneThisCycle).toBe(true);
  expect(state.surplusTrackingByDevice.charger).toMatchObject({ kind: 'rung', stepId: '6a' });
  expect(cycle.deviceMap.get(device.id)?.desiredStepId).toBe('6a');
  expect(state.chargingPhaseCycle.decisions()[0]?.kind).toBe('prepare');
});
