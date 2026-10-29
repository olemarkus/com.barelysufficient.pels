import { describe, expect, it } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { inputDevice } from '../utils/planConvergenceFixtures';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { withCapacityPace } from '../helpers/capacityPaceFixture';
import type { PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';

/**
 * The stepped fairness hold, driven through a whole plan build (report
 * 2026-10-28-diag-niro-charge-not-starting). A heater is limited; with it off, the
 * next shed takes the charger straight to its lowest active step. The plan must
 * say the fairness rule holds it there, on the cycle of the cut, whatever reason
 * that cycle wrote.
 */
const CAPACITY = { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, periodMinutes: 60 } as const;

const heater = (on: boolean): PlanInputDevice => inputDevice({
  id: 'heater',
  name: 'Panel heater',
  binaryCapabilityId: 'onoff',
  binaryControl: { on },
  currentState: on ? 'on' : 'off',
  currentDrawKw: on ? 2 : 0,
  expectedPowerKw: 2,
  controllable: true,
  managed: true,
  priority: 3,
});

const STEP_KW: Record<string, number> = { off: 0, '6a': 1.4, '16a': 3.7, '32a': 7.4 };

const charger = (stepId: string): PlanInputDevice => inputDevice({
  id: 'charger',
  name: 'Charger',
  isEvCharger: true,
  binaryCapabilityId: 'evcharger_charging',
  binaryControl: { on: true },
  currentState: 'on',
  currentDrawKw: STEP_KW[stepId],
  expectedPowerKw: 7.4,
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: '6a', planningPowerW: 1400 },
      { id: '16a', planningPowerW: 3700 },
      { id: '32a', planningPowerW: 7400 },
    ],
  },
  selectedStepId: stepId,
  desiredStepId: stepId,
  controllable: true,
  managed: true,
  priority: 1,
});

describe('stepped fairness hold through a plan build', () => {
  it('stamps the hold once the charger is cut to its lowest step while the heater is limited', async () => {
    // Background load keeps the house over the 8 kW pace whatever PELS limits.
    const backgroundKw = 6;
    let heaterOn = true;
    let chargerStepId = '32a';
    const builder = new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => CAPACITY,
      getPowerTracker: () => withCapacityPace({
        lastTimestamp: Date.now(),
        lastPowerW: (backgroundKw + (heaterOn ? 2 : 0) + STEP_KW[chargerStepId]) * 1000,
      }, CAPACITY, 8),
      getShedBehavior: (deviceId: string) => (
        deviceId === 'charger' ? { action: 'set_step' } : { action: 'turn_off' }
      ),
      decorateDeferredObjectives: decorateWithoutDeferredObjectives,
    }, createPlanEngineState());

    // Each cycle observes what the previous plan decided, as the executor would.
    const cycles = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const plan = await builder.buildDevicePlanSnapshot([heater(heaterOn), charger(chargerStepId)]);
      const planned = Object.fromEntries(plan.devices.map((device) => [device.id, device]));
      cycles.push(planned);
      heaterOn = planned.heater?.plannedState !== 'shed';
      chargerStepId = planned.charger?.desiredStepId ?? chargerStepId;
    }

    const cut = cycles.find((planned) => planned.charger?.desiredStepId === '6a');
    expect(cut?.heater?.plannedState).toBe('shed');
    expect(cut?.charger?.steppedFairnessHold).toEqual({ stepId: '6a', limitedDeviceCount: 1 });
    // No cycle before the cut, with the charger above its lowest step, carries it.
    for (const planned of cycles.slice(0, cycles.indexOf(cut!))) {
      expect(planned.charger?.steppedFairnessHold).toBeUndefined();
    }
  });
});
