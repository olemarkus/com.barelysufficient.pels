import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { inputDevice } from '../utils/planConvergenceFixtures';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { withCapacityPace } from '../helpers/capacityPaceFixture';
import type { PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';

/**
 * The wait to step up, driven through whole plan builds. A water heater is cut
 * from Max to Low and the house then sits at its pace with no room for the next
 * step. Once the cut and its cooldown are over the plan keeps the heater at Low,
 * and must say it waits there for room for as long as no step-up is admitted.
 */
const CAPACITY = { capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, periodMinutes: 60 } as const;

const STEP_KW: Record<string, number> = { off: 0, low: 1.3, medium: 2, max: 3 };

const waterHeater = (stepId: string, commandedStepId: string | undefined): PlanInputDevice => inputDevice({
  id: 'heater',
  name: 'Water heater',
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
  currentState: 'on',
  currentDrawKw: STEP_KW[stepId],
  expectedPowerKw: 3,
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1300 },
      { id: 'medium', planningPowerW: 2000 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
  selectedStepId: stepId,
  reportedStepId: stepId,
  desiredStepId: commandedStepId,
  hasStandingDemand: true,
  controllable: true,
  managed: true,
  priority: 1,
});

describe('the wait to step up through a plan build', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T10:05:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps the heater kept at Low once the cut is over, and not before', async () => {
    // Background load: the heater at Max puts the house over the 8 kW pace, at Low
    // it fits, and Medium would not.
    const backgroundKw = 6.5;
    let stepId = 'max';
    let commandedStepId: string | undefined;
    const builder = new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => CAPACITY,
      getPowerTracker: () => withCapacityPace({
        lastTimestamp: Date.now(),
        lastPowerW: (backgroundKw + STEP_KW[stepId]!) * 1000,
      }, CAPACITY, 8),
      getShedBehavior: () => ({ action: 'set_step' }),
      decorateDeferredObjectives: decorateWithoutDeferredObjectives,
    }, createPlanEngineState());

    // Each cycle observes what the previous plan decided, as the executor would.
    const cycles: DevicePlanDevice[] = [];
    for (let cycle = 0; cycle < 30; cycle += 1) {
      const plan = await builder.buildDevicePlanSnapshot([waterHeater(stepId, commandedStepId)]);
      const heater = plan.devices.find((device) => device.id === 'heater')!;
      cycles.push(heater);
      commandedStepId = heater.desiredStepId ?? commandedStepId;
      stepId = commandedStepId ?? stepId;
      vi.setSystemTime(Date.now() + 30_000);
    }

    const cutIndex = cycles.findIndex((heater) => heater.desiredStepId === 'low');
    expect(cutIndex).toBeGreaterThanOrEqual(0);
    for (const heater of cycles.slice(0, cutIndex + 1)) expect(heater.steppedStepUpHold).toBeUndefined();
    const kept = cycles.slice(cutIndex + 1);
    // The heater is never stepped back up: there is no room for Medium.
    for (const heater of kept) expect(heater.desiredStepId).toBe('low');
    // Every cycle that keeps it at Low with the plain `keep` or a refused step-up
    // carries the stamp; the transitional countdowns keep their own reason.
    const waiting = kept.filter((heater) => heater.plannedState === 'keep'
      && (heater.reason.code === 'keep' || heater.reason.code === 'insufficient_headroom'));
    expect(waiting.length).toBeGreaterThan(0);
    for (const heater of waiting) expect(heater.steppedStepUpHold).toBe(true);
    for (const heater of kept.filter((candidate) => !waiting.includes(candidate))) {
      expect(heater.steppedStepUpHold).toBeUndefined();
    }
    // The last cycles, long after the cut, still say it waits.
    expect(cycles.at(-1)?.steppedStepUpHold).toBe(true);
  });
});
