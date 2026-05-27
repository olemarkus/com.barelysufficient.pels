import { buildInitialPlanDevices, type PlanDevicesDeps } from '../lib/plan/planDevices';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanContext } from '../lib/plan/planContext';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import { resolveShedIntent } from '../lib/device/deviceActionProjection';
import { getPrimaryTargetCapability } from '../lib/utils/targetCapabilities';

const buildContext = (devices: PlanContext['devices']): PlanContext => ({
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

type DualReadCase = {
  name: string;
  buildDevice: () => PlanInputDevice;
  shedBehavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  shed: boolean;
};

const cases: DualReadCase[] = [
  {
    name: 'simple binary device with turn_off',
    buildDevice: () => ({
      id: 'dev-binary',
      name: 'Binary Heater',
      targets: [],
      currentOn: true,
      controllable: true,
      hasBinaryControl: true,
      expectedPowerKw: 2,
    }),
    shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
    shed: true,
  },
  {
    name: 'thermostat with set_temperature and primary target (cap-on)',
    buildDevice: () => ({
      id: 'dev-thermostat',
      name: 'Thermostat',
      targets: [{ id: 'target_temperature', value: 22, min: 5, max: 30, step: 0.5, unit: '°C' }],
      currentOn: true,
      controllable: true,
      hasBinaryControl: true,
      expectedPowerKw: 1.5,
    }),
    shedBehavior: { action: 'set_temperature', temperature: 17, stepId: null },
    shed: true,
  },
  {
    name: 'thermostat with set_temperature but cap-off (intent says set_temperature, consumer applies cap gate)',
    buildDevice: () => ({
      id: 'dev-thermostat-off',
      name: 'Thermostat Cap-Off',
      targets: [{ id: 'target_temperature', value: 22, min: 5, max: 30, step: 0.5, unit: '°C' }],
      currentOn: true,
      controllable: false,
      hasBinaryControl: true,
      expectedPowerKw: 1.5,
    }),
    shedBehavior: { action: 'set_temperature', temperature: 17, stepId: null },
    shed: false,
  },
  {
    name: 'stepped device with set_step + binary control',
    buildDevice: () => ({
      id: 'dev-stepped',
      name: 'Stepped Water Heater',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
      currentOn: true,
      controllable: true,
      hasBinaryControl: true,
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
      expectedPowerKw: 3,
    }),
    shedBehavior: { action: 'set_step', temperature: null, stepId: null },
    shed: true,
  },
  {
    name: 'stepped device without binary control (set_step forced)',
    buildDevice: () => ({
      id: 'dev-stepped-nobinary',
      name: 'Stepped No Binary',
      targets: [],
      currentOn: true,
      controllable: true,
      hasBinaryControl: false,
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 800 },
          { id: 'high', planningPowerW: 2000 },
        ],
      },
      selectedStepId: 'high',
      expectedPowerKw: 2,
    }),
    shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
    shed: true,
  },
];

describe('planDevices.resolveShedAction — chunk 5 dual-read parity', () => {
  const runWithIntent = (input: PlanInputDevice, sb: DualReadCase['shedBehavior'], shed: boolean) => {
    const intent = resolveShedIntent({
      shedBehavior: sb,
      hasBinaryControl: input.hasBinaryControl,
      controlModel: input.controlModel,
      steppedLoadProfile: input.steppedLoadProfile,
      primaryTarget: getPrimaryTargetCapability(input.targets),
    });
    const deps: PlanDevicesDeps = {
      getPriorityForDevice: () => 100,
      getShedBehavior: () => sb,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
    };
    return buildInitialPlanDevices({
      context: buildContext([{ ...input, shedIntent: intent }]),
      state: createPlanEngineState(),
      shedSet: shed ? new Set([input.id]) : new Set(),
      shedReasons: shed ? new Map([[input.id, 'shed due to capacity']]) : new Map(),
      guardInShortfall: false,
      deps,
    })[0];
  };

  const runWithoutIntent = (input: PlanInputDevice, sb: DualReadCase['shedBehavior'], shed: boolean) => {
    const deps: PlanDevicesDeps = {
      getPriorityForDevice: () => 100,
      getShedBehavior: () => sb,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
    };
    return buildInitialPlanDevices({
      context: buildContext([input]),
      state: createPlanEngineState(),
      shedSet: shed ? new Set([input.id]) : new Set(),
      shedReasons: shed ? new Map([[input.id, 'shed due to capacity']]) : new Map(),
      guardInShortfall: false,
      deps,
    })[0];
  };

  for (const c of cases) {
    it(`producer-resolved path matches legacy for: ${c.name}`, () => {
      const device = c.buildDevice();
      const withIntent = runWithIntent(device, c.shedBehavior, c.shed);
      const withoutIntent = runWithoutIntent(device, c.shedBehavior, c.shed);
      expect(withIntent.shedAction).toBe(withoutIntent.shedAction);
      expect(withIntent.shedTemperature).toBe(withoutIntent.shedTemperature);
      expect(withIntent.shedStepId).toBe(withoutIntent.shedStepId);
    });
  }
});
