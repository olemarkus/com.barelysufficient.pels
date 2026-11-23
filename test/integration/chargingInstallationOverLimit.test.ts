/**
 * A charging installation PELS controls as one load, over the limit.
 *
 * Planner input (`foldChargingInstallations`) reads the installation as its
 * main, at the level the device layer reads from the main: here the
 * installation's 23 A, with two cars sharing it. Read at the main's own watt
 * target instead (0 W after the takeover stopped the main's car) it would be an
 * off device the planner cannot limit. Step-down-first: over the limit the
 * installation steps down to the step that fits, and is switched off only when
 * its lowest step still does not.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildSheddingPlanForSpec } from '../helpers/sheddingPlanForSpec';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPlanCycleObject } from '../utils/planContextPowerFixture';
import { steppedInputDevice, sheddingPlanFixture, buildInitialPlanDevicesForSpec } from '../utils/planTestUtils';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { capacityGuardSpy } from '../helpers/sheddingWiring';
import { testLogger } from '../utils/testLogger';
import { fixedConfirmationWindows } from '../helpers/confirmationWindows';
import { resolveSteppedLoadTransition } from '../../lib/plan/planSteppedLoad';
import { foldChargingInstallations } from '../../lib/planInput/chargingInstallationFold';
import type { PlanInputSnapshotDevice } from '../../lib/planInput/runtimeDeviceRead';

// A three-phase installation's watt ladder, 690 W per amp from 6 A to 32 A.
const WATTS_PER_AMP = 690;
const installationLadder = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    ...Array.from({ length: 27 }, (_, index) => (index + 6) * WATTS_PER_AMP)
      .map((watts) => ({ id: `${watts}w`, planningPowerW: watts })),
  ],
};
const INSTALLATION_KW = (23 * WATTS_PER_AMP) / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const fact = (role: 'main' | 'secondary') => ({
  kind: 'capability_adapter' as const, activationRequired: false, activationEnabled: false,
  chargingInstallation: { id: 'inst', role, mainId: 'main', memberIds: ['main', 'secondary'] },
});
// Two cars sharing 23 A; the main's own watt target reads 0 W, its off step.
const members = (): PlanInputSnapshotDevice[] => [
  { id: 'main', controlModel: 'stepped_load', steppedLoadProfile: installationLadder, selectedStepId: 'off',
    measuredPowerKw: INSTALLATION_KW / 2, binaryControl: { on: true }, controlAdapter: fact('main') },
  { id: 'secondary', controlModel: 'binary_power', measuredPowerKw: INSTALLATION_KW / 2, binaryControl: { on: true },
    controlAdapter: fact('secondary') },
] as unknown as PlanInputSnapshotDevice[];
const levelSource = { readChargingInstallationLevelW: () => 23 * WATTS_PER_AMP };

async function decide(selectedStepId: string, softLimitKw: number, drawKw = INSTALLATION_KW) {
  const state = createPlanEngineState();
  const installation = steppedInputDevice({
    id: 'main', name: 'Go A', isEvCharger: true, steppedLoadProfile: installationLadder,
    selectedStepId, currentDrawKw: drawKw, binaryControl: { on: true }, controllable: true,
  });
  const totalKw = drawKw + 0.6;
  const headroom = softLimitKw - totalKw;
  const context = buildPlanCycleObject({
    devices: [installation],
    total: totalKw, softLimit: softLimitKw, capacitySoftLimit: softLimitKw, dailySoftLimit: null,
    budgetPaceKw: null, projectedExemptKw: null, softLimitSource: 'capacity', capacityHeadroomKw: 1,
    budgetHeadroomKw: null, hourBucketKey: '2026-11-23T12', budgetKWh: 0, usedKWh: 0, minutesRemaining: 60,
    headroomRaw: headroom, headroom,
  });
  const getShedBehavior = () => ({ action: 'turn_off' as const });
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(state.pendingBinaryCommands, fixedConfirmationWindows);
  const sheddingPlan = await buildSheddingPlanForSpec(context, context, state, {
    structuredLog: testLogger, capacityGuard: capacityGuardSpy(), shortfallThresholdKw: 100,
    powerTracker: { lastTimestamp: 900, lastPowerW: totalKw * 1000 } as PowerTrackerState,
    pendingBinaryCommandStore, getShedBehavior,
  });
  const [planDevice] = buildInitialPlanDevicesForSpec({
    context, state,
    sheddingPlan: sheddingPlanFixture({
      shedSet: sheddingPlan.shedSet, shedReasons: sheddingPlan.shedReasons, shedStepTargets: sheddingPlan.shedStepTargets,
    }),
    deps: {
      getInferredSurplusKw: () => 0, getShedBehavior,
      getPriceOptimizationSettings: () => ({}), pendingBinaryCommandStore,
    },
  });
  if (!planDevice) throw new Error('Expected the installation in the plan');
  return { sheddingPlan, planDevice };
}

it('reads the installation at its 23 A level and summed draw, not the main\'s own off step', () => {
  const [main, secondary] = foldChargingInstallations(members(), levelSource);
  expect(main?.chargingInstallationLoad).toEqual({
    currentDrawKw: INSTALLATION_KW, running: true, level: { stepId: `${23 * WATTS_PER_AMP}w`, watts: 23 * WATTS_PER_AMP },
  });
  expect(secondary?.measuredPowerKw).toBe(INSTALLATION_KW / 2);
});

it('steps an over-limit installation down to the step that fits, without switching it off', async () => {
  const [main] = foldChargingInstallations(members(), levelSource);
  // 16.5 kW against 11 kW: the installation has to give up 5.5 kW of its 15.9 kW.
  const { sheddingPlan, planDevice } = await decide(main?.chargingInstallationLoad?.level?.stepId ?? 'off', 11);
  const target = sheddingPlan.shedStepTargets.get('main');
  const targetW = installationLadder.steps.find((step) => step.id === target)?.planningPowerW ?? 0;
  expect(targetW).toBeGreaterThan(0);
  expect(targetW).toBeLessThanOrEqual(11_000 - 600);
  expect(targetW).toBeGreaterThanOrEqual(12 * WATTS_PER_AMP);
  expect(planDevice.plannedState).toBe('shed');
  expect(resolveSteppedLoadTransition(planDevice)?.effectiveTransition).toBe('step_down_while_on');
});

it('takes the installation to its off step only when its lowest step does not fit', async () => {
  const [main] = foldChargingInstallations(members(), levelSource);
  // 16.5 kW against 3 kW: even 6 A (4.1 kW) leaves the house over, so the
  // installation's Off follows, which reaches every member's switch.
  const { sheddingPlan, planDevice } = await decide(main?.chargingInstallationLoad?.level?.stepId ?? 'off', 3);
  expect(sheddingPlan.shedStepTargets.get('main')).toBe('off');
  expect(planDevice.plannedState).toBe('shed');
  // At 6 A with room for it, the same installation is left on its lowest step.
  const atLowest = await decide(`${6 * WATTS_PER_AMP}w`, 5, (6 * WATTS_PER_AMP) / 1000);
  expect(atLowest.sheddingPlan.shedSet.has('main')).toBe(false);
});

it('cannot limit an installation read at the main\'s own off step, however much it draws', async () => {
  const { sheddingPlan } = await decide('off', 11);
  expect(sheddingPlan.shedSet.size).toBe(0);
});
