import { buildInitialPlanDevices } from '../lib/plan/planDevices';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanContext } from '../lib/plan/planContext';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const buildContext = (devices: PlanInputDevice[]): PlanContext => ({
  devices,
  desiredForMode: {},
  total: 3,
  softLimit: 2,
  capacitySoftLimit: 2,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: -1,
  headroom: -1,
  restoreMarginPlanning: 0.2,
});

describe('buildInitialPlanDevices', () => {
  it('keeps stepped loads on temperature shedding when that is the chosen shed behavior', () => {
    const steppedDevice: PlanInputDevice = {
      id: 'dev-1',
      name: 'Water Heater',
      deviceType: 'temperature',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'max',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
      currentOn: true,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 0.5,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map([['dev-1', { temperature: 55, capabilityId: 'target_temperature' }]]),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_temperature', temperature: 55, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_temperature');
    expect(planDevice.shedTemperature).toBe(55);
    expect(planDevice.shedStepId).toBeNull();
    expect(planDevice.plannedTarget).toBe(55);
    expect(planDevice.desiredStepId).toBe('max');
  });
});
