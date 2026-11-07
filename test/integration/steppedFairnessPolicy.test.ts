import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildSheddingPlanForSpec } from '../helpers/sheddingPlanForSpec';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPlanCycleObject } from '../utils/planContextPowerFixture';
import { buildInitialPlanDevicesForSpec, steppedInputDevice } from '../utils/planTestUtils';
import { inputDevice } from '../utils/planConvergenceFixtures';
import { capacityGuardSpy } from '../helpers/sheddingWiring';
import { testLogger } from '../utils/testLogger';
import { countFairnessLimitedDevices } from '../../lib/plan/restore/coordination';
import { stampSteppedFairnessHolds } from '../../lib/plan/planSteppedFairnessHold';
import { resolveSteppedShedHypotheticalStepId } from '../../lib/plan/planSteppedShedResolution';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { isSteppedRecoveryLimited } from '../../lib/plan/planShedRecovery';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:30:00Z')); });
afterEach(() => vi.useRealTimers());

const scenarios = [
  { boosted: true, chargerPriority: 1, heaterPriority: 3, witness: 'previous_shed',
    selectedStep: '12a', keepStep: '14a', fairnessCount: 0 },
  { boosted: true, chargerPriority: 1, heaterPriority: 3, witness: 'swap_donor',
    selectedStep: '12a', keepStep: '14a', fairnessCount: 0 },
  { boosted: true, chargerPriority: 1, heaterPriority: 3, witness: 'none',
    selectedStep: '12a', keepStep: '14a', fairnessCount: 0 },
  { boosted: false, chargerPriority: 1, heaterPriority: 3, witness: 'previous_shed',
    selectedStep: '6a', keepStep: '6a', fairnessCount: 1 },
  { boosted: true, chargerPriority: 4, heaterPriority: 2, witness: 'previous_shed',
    selectedStep: '6a', keepStep: '6a', fairnessCount: 1 },
];

it.each([30, 1, 60].flatMap((minutesRemaining) => scenarios.map((scenario) => ({
  ...scenario, minutesRemaining,
}))))('uses the same fairness policy before, during and after wind-down: %j', async (scenario) => {
  const minute = scenario.minutesRemaining === 60 ? 0 : 60 - scenario.minutesRemaining;
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 13, minute)));
  const state = createPlanEngineState();
  if (scenario.witness === 'previous_shed') state.shedDecisions.lastPlannedShedIds = new Set(['heater']);
  if (scenario.witness === 'swap_donor') {
    state.swapLedger.open('charger', { kind: 'stepped', stepId: '14a' },
      new Map([['heater', { kind: 'off' }]]), Date.now() - 1, Date.now() - 1);
  }
  const charger = steppedInputDevice({
    id: 'charger', isEvCharger: true, priority: scenario.chargerPriority,
    binaryControl: { on: true }, controllable: true, managed: true,
    boostSupported: true, forceBoostActive: scenario.boosted,
    selectedStepId: '14a', desiredStepId: '14a', currentDrawKw: 3.22,
    steppedLoadProfile: { steps: [0, 6, 8, 10, 12, 14, 16].map((amps) => ({
      id: amps ? `${amps}a` : 'off', planningPowerW: amps * 230,
    })) },
  });
  const heater = inputDevice({
    id: 'heater', binaryCapabilityId: 'onoff', binaryControl: { on: false },
    currentState: 'off', currentDrawKw: 0, expectedPowerKw: 2,
    controllable: true, managed: true, priority: scenario.heaterPriority,
  });
  const context = buildPlanCycleObject({
    devices: [heater, charger], total: 5.35, softLimit: 5.1, capacitySoftLimit: 5.1,
    softLimitSource: 'capacity', capacityPeriodMinutes: 60,
    capacityPeriodCoverageComplete: true, dailySoftLimit: null,
    budgetPaceKw: null, projectedExemptKw: null,
    budgetKWh: 5, usedKWh: 1, minutesRemaining: scenario.minutesRemaining,
    headroomRaw: -0.25, headroom: -0.25,
  });
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(state.pendingBinaryCommands);
  const getShedBehavior = () => ({ action: 'set_step' as const });
  expect(resolveSteppedShedHypotheticalStepId(charger, context.devices, state,
    getShedBehavior())).toBe(scenario.selectedStep);
  const sheddingPlan = await buildSheddingPlanForSpec(context, context, state, {
    capacityGuard: capacityGuardSpy(), powerTracker: { lastTimestamp: Date.now(), lastPowerW: 5350 },
    structuredLog: testLogger, shortfallThresholdKw: 20, getShedBehavior, pendingBinaryCommandStore,
  });
  expect(sheddingPlan.shedStepTargets.get('charger')).toBe(scenario.selectedStep);
  sheddingPlan.shedSet.add('heater');
  const deps = { getShedBehavior, pendingBinaryCommandStore,
    getInferredSurplusKw: () => 0, getPriceOptimizationSettings: () => ({}) };
  const selected = buildInitialPlanDevicesForSpec({ context, state, sheddingPlan, deps });
  const selectedCharger = selected.find((device) => device.id === 'charger');
  if (!selectedCharger || !isSteppedLoadDevice(selectedCharger)) throw new Error('Missing stepped charger');
  expect(selectedCharger.boostActive).toBe(scenario.boosted);
  expect(selectedCharger.desiredStepId).toBe(scenario.selectedStep);

  // Identical priority, boost and other-device posture with no charger shed:
  // keep materialization must honor the same priority decision as selection.
  const kept = buildInitialPlanDevicesForSpec({ context, state, deps,
    sheddingPlan: { ...sheddingPlan, shedSet: new Set(['heater']),
      shedStepTargets: new Map(), shedReasons: new Map() },
  });
  expect(kept.find((device) => device.id === 'charger')?.desiredStepId).toBe(scenario.keepStep);

  // At the floor, restore admission and the displayed hold must count the
  // same peers that selection and keep yield to.
  const floorDevices = selected.map((device) => device.id === 'charger'
    ? { ...selectedCharger, plannedState: 'keep' as const, selectedStepId: '6a', desiredStepId: '6a',
      reason: { code: 'keep' as const, detail: null } } : device);
  const deviceMap = new Map(floorDevices.map((device) => [device.id, device]));
  const floorCharger = deviceMap.get('charger');
  if (!floorCharger) throw new Error('Missing charger at floor');
  expect(countFairnessLimitedDevices(deviceMap, floorCharger, state.shedDecisions)).toBe(scenario.fairnessCount);
  const hold = stampSteppedFairnessHolds(floorDevices, state.shedDecisions)
    .find((device) => device.id === 'charger')?.steppedFairnessHold;
  expect(hold).toEqual(scenario.fairnessCount === 0
    ? undefined : { stepId: '6a', limitedDeviceCount: scenario.fairnessCount });
});

it('uses the resolved boost release when checking recovery peers', () => {
  const state = createPlanEngineState();
  state.shedDecisions.lastPlannedShedIds = new Set(['heater']);
  const charger = steppedInputDevice({ id: 'charger', priority: 1, boostSupported: true,
    forceBoostActive: true, confirmedNotDrawing: true, currentDrawKw: 0 });
  const heater = inputDevice({ id: 'heater', priority: 3, controllable: true,
    binaryCapabilityId: 'onoff', binaryControl: { on: false } });
  expect(isSteppedRecoveryLimited(charger, [charger, heater], state)).toBe(true);
  expect(isSteppedRecoveryLimited({ ...charger, confirmedNotDrawing: false }, [charger, heater], state)).toBe(false);
});
