import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import type { MeteredPlanInputDevice } from '../../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { buildExecutableSteppedLoadIntent } from '../../lib/executor/executableSteppedLoadProjection';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';
import { withCapacityPace } from '../helpers/capacityPaceFixture';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 30);
const LIMITED_TARGET = 19;
const REQUESTED_TARGET = 22;
const SETTINGS = {
  capacityEnabled: true, gridImportLimitKw: null, limitKw: 20, marginKw: 0.2, periodMinutes: 60 as const,
};
const LIMIT = { action: 'set_temperature' as const, temperature: LIMITED_TARGET };

const pump = (priority: number, currentTarget = LIMITED_TARGET, on = true) => buildPlanInputDevice({
  id: 'pump', name: 'Pump', deviceType: 'temperature', priority,
  binaryCapabilityId: 'onoff', binaryControl: { on },
  currentTarget, currentTemperature: 21,
  targets: [{ id: 'target_temperature', value: currentTarget, unit: '°C', min: 5, max: 30, step: 0.5 }],
  currentDrawKw: on ? 1 : 0, expectedPowerKw: on ? 1 : 6, shedBehavior: LIMIT,
});
const direct = (priority: number) => buildPlanInputDevice({
  id: `direct-${priority}`, name: `Direct ${priority}`, deviceType: 'onoff', priority,
  binaryCapabilityId: 'onoff', binaryControl: { on: false }, currentDrawKw: 0, expectedPowerKw: 0.5,
});

async function recoveryPlan(devices: MeteredPlanInputDevice[], paceKw = 10, previouslyShed = true) {
  const state = createPlanEngineState();
  state.shedDecisions.lastPlannedDeviceIds = new Set(devices.map(({ id }) => id));
  if (previouslyShed) state.shedDecisions.lastPlannedShedIds = new Set(devices.map(({ id }) => id));
  else state.shedDecisions.lastPlannedKeptIds = new Set(devices.map(({ id }) => id));
  const temperatureIds = new Set(devices.filter(isTemperaturePlanDevice).map(({ id }) => id));
  const getShedBehavior = (id: string) => temperatureIds.has(id) ? LIMIT : { action: 'turn_off' as const };
  const builder = new PlanBuilder({
    ...planBuilderWiring(),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => SETTINGS,
    // The meter sees the pump's 1 kW, or a 1 kW background while a pump is OFF.
    getPowerTracker: () => withCapacityPace({ lastTimestamp: Date.now(), lastPowerW: 1000 }, SETTINGS, paceKw),
    getShedBehavior,
    resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
      getShedBehavior,
      getModeDeviceTargets: () => ({ Home: Object.fromEntries([...temperatureIds].map((id) => [id, REQUESTED_TARGET])) }),
    }),
  }, state);
  return builder.buildDevicePlanSnapshot(devices);
}

describe('setpoint demand closes electrical restore batching through the full plan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it.each([1, 2, 3])('preserves priority around a pump at rank %s, independent of snapshot order', async (pumpRank) => {
    for (const reverse of [false, true]) {
      const directRanks = [1, 2, 3].filter((rank) => rank !== pumpRank);
      const devices = [pump(pumpRank), ...directRanks.map(direct)];
      const plan = await recoveryPlan(reverse ? devices.reverse() : devices);
      expect(plan.devices.filter((device) => device.id.startsWith('direct-') && device.plannedState === 'keep')
        .map(({ id }) => id).sort()).toEqual(directRanks.filter((rank) => rank < pumpRank).map((rank) => `direct-${rank}`));
      const plannedPump = plan.devices.find(({ id }) => id === 'pump');
      expect(plannedPump).toBeDefined();
      if (!plannedPump || !isTemperaturePlanDevice(plannedPump)) throw new Error('missing temperature pump');
      expect(plannedPump.plannedTarget).toBe(pumpRank === 1 ? REQUESTED_TARGET : LIMITED_TARGET);
      expect(plannedPump.plannedState).toBe(pumpRank === 1 ? 'keep' : 'shed');
    }
  });

  it.each([LIMITED_TARGET, REQUESTED_TARGET])('still prices a real OFF start whose current target is %s', async (currentTarget) => {
    // 19 C represents the unchanged setpoint policy; 22 C also covers a pump
    // turned OFF under turn_off before its owner selected a setpoint limit.
    const rejected = await recoveryPlan([pump(1, currentTarget, false)], 2);
    expect(rejected.devices[0]).toMatchObject({
      plannedState: 'shed', reason: { code: 'insufficient_headroom', needKw: 6.6 },
    });
    const admitted = await recoveryPlan([pump(1, currentTarget, false)], 9);
    expect(admitted.devices[0].plannedState).toBe('keep');
  });

  it.each([true, false])('keeps an ON temperature/stepped device on its priced rung path (previously shed: %s)', async (previouslyShed) => {
    const hybrid = buildPlanInputDevice({
      id: 'hybrid', name: 'Hybrid', priority: 1, deviceType: 'temperature',
      binaryCapabilityId: 'onoff', binaryControl: { on: true },
      currentDrawKw: 1, expectedPowerKw: 1, planningPowerKw: 1,
      currentTarget: LIMITED_TARGET, currentTemperature: 21,
      targets: [{ id: 'target_temperature', value: LIMITED_TARGET, unit: '°C', min: 5, max: 30, step: 0.5 }],
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1000 },
          { id: 'mid', planningPowerW: 2000 }, { id: 'max', planningPowerW: 6000 },
        ],
      },
      selectedStepId: 'low', desiredStepId: 'max', shedBehavior: LIMIT,
    });
    // Only 2.5 kW of headroom: its full 5 kW jump cannot pass admission.
    // The producer's current-rung restore quantity is 1 kW; a target-only
    // admission must not leave the input's requested max rung unpriced.
    const plan = await recoveryPlan([hybrid], 3.5, previouslyShed);
    const planned = plan.devices[0];
    expect(planned).toMatchObject({ desiredStepId: 'mid', reason: { code: 'restore_need', needKw: 1.2 } });
    expect(buildExecutableSteppedLoadIntent(planned)?.desired.stepId).toBe('mid');
  });
});
