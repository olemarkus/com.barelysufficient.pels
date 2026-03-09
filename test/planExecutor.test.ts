import type Homey from 'homey';
import { PlanExecutor } from '../lib/plan/planExecutor';
import { createPlanEngineState } from '../lib/plan/planState';
import type { DevicePlan } from '../lib/plan/planTypes';

const buildPlan = (): DevicePlan => ({
  meta: {
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4,
  },
  devices: [
    {
      id: 'dev-1',
      name: 'Heater',
      currentState: 'off',
      plannedState: 'keep',
      currentTarget: 21,
      plannedTarget: 21,
      controllable: true,
    },
  ],
});

const buildExecutor = (state = createPlanEngineState()) => {
  const deviceManager = {
    getSnapshot: jest.fn().mockReturnValue([
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ]),
    setCapability: jest.fn().mockResolvedValue(undefined),
  };
  const deps = {
    homey: {
      settings: { set: jest.fn() },
      flow: { getTriggerCard: jest.fn() },
    } as unknown as Homey.App['homey'],
    deviceManager: deviceManager as never,
    getCapacityGuard: () => undefined,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null }),
    updateLocalSnapshot: jest.fn(),
    log: jest.fn(),
    logDebug: jest.fn(),
    error: jest.fn(),
  };
  return { executor: new PlanExecutor(deps, state), deps, deviceManager, state };
};

describe('PlanExecutor restore logging', () => {
  it('logs restore from shed state when the device has not been restored since the last shed', async () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-1'] = Date.now() - 10_000;
    const { executor, deps, deviceManager } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deps.log).toHaveBeenCalledWith('Capacity: turning on Heater (restored from shed state)');
  });

  it('logs neutral restore text when matching the current plan after a later external off', async () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-1'] = Date.now() - 20_000;
    state.lastDeviceRestoreMs['dev-1'] = Date.now() - 5_000;
    const { executor, deps, deviceManager } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deps.log).toHaveBeenCalledWith('Capacity: turning on Heater (to match current plan)');
  });

  it('does not start a new restore cycle when reconcile turns a device back on', async () => {
    const state = createPlanEngineState();
    state.lastRestoreMs = Date.now() - 30_000;
    state.lastDeviceRestoreMs['dev-1'] = state.lastRestoreMs;
    const previousLastRestoreMs = state.lastRestoreMs;
    const previousDeviceRestoreMs = state.lastDeviceRestoreMs['dev-1'];
    const { executor, deviceManager, state: nextState } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan(), 'reconcile');

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(nextState.lastRestoreMs).toBe(previousLastRestoreMs);
    expect(nextState.lastDeviceRestoreMs['dev-1']).toBe(previousDeviceRestoreMs);
    expect(nextState.activationAttemptStartedMsByDevice['dev-1']).toBeUndefined();
  });
});
