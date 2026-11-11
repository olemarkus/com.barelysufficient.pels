import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { inputDevice } from '../utils/planConvergenceFixtures';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { withCapacityPace } from '../helpers/capacityPaceFixture';
import type { PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';
import { buildExecutionPlan } from '../../lib/plan/planExecutionProjection';

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

const SOLAR_LADDER = { steps: [0, 6, 8, 10, 12, 14, 16].map((amps) => ({
  id: amps ? `${amps}a` : 'off', planningPowerW: amps * 230,
})) };

const chargerAt14A = (): PlanInputDevice => inputDevice({
  id: 'charger',
  name: 'Charger',
  isEvCharger: true,
  evChargingState: 'plugged_in_charging',
  hasStandingDemand: false,
  binaryCapabilityId: 'evcharger_charging',
  binaryControl: { on: true },
  currentState: 'on',
  currentDrawKw: 3.22,
  expectedPowerKw: 7.4,
  steppedLoadProfile: SOLAR_LADDER,
  selectedStepId: '14a',
  desiredStepId: '14a',
  controllable: true,
  managed: true,
  priority: 1,
});

describe('stepped fairness hold through a plan build', () => {
  // The capacity pace is computed from the current hour. Pin the clock mid-hour:
  // near an hour's end the drain changes the pace and the fixture cannot land on 8 kW.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T10:20:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  const shedOnceOver = async (pump: PlanInputDevice, lastPlannedShed: readonly string[] = []) => {
    let houseKw = 4;
    const state = createPlanEngineState();
    const builder = new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => CAPACITY,
      getPowerTracker: () => withCapacityPace({ lastTimestamp: Date.now(), lastPowerW: houseKw * 1000 }, CAPACITY, 8),
      getShedBehavior: (deviceId: string) => (
        deviceId === 'charger' ? { action: 'set_step' } : { action: 'turn_off' }
      ),
      decorateDeferredObjectives: decorateWithoutDeferredObjectives,
    }, state);
    await builder.buildDevicePlanSnapshot([pump, chargerAt14A()]);
    const settled = new Set(state.shedDecisions.lastPlannedNonCapacityHoldIds);
    // A device limited for power stays shed from the cycles before this one.
    state.shedDecisions.lastPlannedShedIds = new Set([...state.shedDecisions.lastPlannedShedIds, ...lastPlannedShed]);
    houseKw = 8.25;
    const plan = await builder.buildDevicePlanSnapshot([pump, chargerAt14A()]);
    return { charger: plan.devices.find((device) => device.id === 'charger'), settled };
  };

  const pump = (surplusOnly: boolean): PlanInputDevice => inputDevice({
    id: 'pump',
    name: 'Pump',
    binaryCapabilityId: 'onoff',
    binaryControl: { on: false },
    currentState: 'off',
    currentDrawKw: 0,
    expectedPowerKw: 2,
    controllable: true,
    managed: true,
    priority: 3,
    ...(surplusOnly ? { surplusOnly: true as const } : {}),
  });

  it('leaves a charger on its next step while a solar-only pump waits for export', async () => {
    const { charger: planned, settled } = await shedOnceOver(pump(true));
    expect(settled.has('pump')).toBe(true);
    expect(planned?.desiredStepId).toBe('12a');
  });

  it('takes the charger to its lowest step while a device limited for power waits', async () => {
    const { charger: planned, settled } = await shedOnceOver(pump(false), ['pump']);
    expect(settled.has('pump')).toBe(false);
    expect(planned?.desiredStepId).toBe('6a');
  });

  const buildWithPreviouslyHeldPeer = async (charging: PlanInputDevice, peer: PlanInputDevice) => {
    const capacity = { ...CAPACITY, limitKw: 5, marginKw: 0 };
    const state = createPlanEngineState();
    state.shedDecisions.lastPlannedShedIds = new Set([peer.id]);
    state.shedDecisions.lastPlannedKeptIds = new Set([charging.id]);
    state.shedDecisions.lastPlannedDeviceIds = new Set([charging.id, peer.id]);
    state.boostActiveByDevice[charging.id] = true;
    const builder = new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => capacity,
      getPowerTracker: () => withCapacityPace({ lastTimestamp: Date.now(), lastPowerW: 4900 }, capacity, 5),
      getShedBehavior: (deviceId) => (
        deviceId === charging.id ? { action: 'set_step' } : { action: 'turn_off' }
      ),
      decorateDeferredObjectives: decorateWithoutDeferredObjectives,
    }, state);
    return builder.buildDevicePlanSnapshot([peer, charging]);
  };

  it('lowers a retained charger rung when restore keeps a previously limited peer off', async () => {
    const plan = await buildWithPreviouslyHeldPeer(chargerAt14A(), heater(false));
    const charging = plan.devices.find((device) => device.id === 'charger');
    expect(plan.devices.find((device) => device.id === 'heater')?.plannedState).toBe('shed');
    expect(charging).toMatchObject({ plannedState: 'keep', commandableNow: true });
    expect(charging?.boostActive).toBe(false);
    expect(charging?.desiredStepId).toBe('6a');
    expect(charging?.steppedFairnessHold).toEqual({ stepId: '6a', limitedDeviceCount: 1 });
    expect(buildExecutionPlan(plan).devices.find((device) => device.commands.id === 'charger')?.commands)
      .toMatchObject({ steppedLoad: { desired: { stepId: '6a', plannedStepId: '6a' },
        transition: { effectiveTransition: 'step_down_while_on' } } });
  });

  it.each([
    { priority: 1, step: '14a' },
    { priority: 5, step: '6a' },
  ])('keeps boost priority over a previously limited peer (charger priority $priority)', async ({ priority, step }) => {
    const plan = await buildWithPreviouslyHeldPeer({
      ...chargerAt14A(), priority, boostSupported: true, boostRequested: true,
    }, heater(false));
    const charging = plan.devices.find((device) => device.id === 'charger');
    expect(plan.devices.find((device) => device.id === 'heater')?.plannedState).toBe('shed');
    expect(charging).toMatchObject({ plannedState: 'keep', commandableNow: true });
    expect(charging?.boostActive).toBe(true);
    expect(charging?.desiredStepId).toBe(step);
  });

  it('does not lower a retained rung for a peer held only by its solar posture', async () => {
    const plan = await buildWithPreviouslyHeldPeer(chargerAt14A(), { ...heater(false), surplusOnly: true });
    expect(plan.devices.find((device) => device.id === 'heater')).toMatchObject({
      plannedState: 'shed', nonCapacityHoldShed: true,
    });
    expect(plan.devices.find((device) => device.id === 'charger')).toMatchObject({ desiredStepId: '14a' });
  });
});
