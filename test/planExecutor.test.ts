import type Homey from 'homey';
import { PlanExecutor, type PlanExecutorDeps } from '../lib/plan/planExecutor';
import { TARGET_COMMAND_RETRY_DELAYS_MS } from '../lib/plan/planConstants';
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

const buildTargetPlan = (currentTarget = 18, plannedTarget = 23): DevicePlan => ({
  meta: {
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4,
  },
  devices: [
    {
      id: 'dev-1',
      name: 'Heater',
      currentState: 'on',
      plannedState: 'keep',
      currentTarget,
      plannedTarget,
      controllable: true,
    },
  ],
});

const buildExecutor = (
  state = createPlanEngineState(),
  snapshot = [
    {
      id: 'dev-1',
      name: 'Heater',
      controlCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      currentOn: false,
    },
  ],
  overrides: Partial<PlanExecutorDeps> = {},
) => {
  const deviceManager = {
    getSnapshot: jest.fn().mockReturnValue(snapshot),
    setCapability: jest.fn().mockResolvedValue(undefined),
  };
  const deps: PlanExecutorDeps = {
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
    logTargetRetryComparison: jest.fn(),
    log: jest.fn(),
    logDebug: jest.fn(),
    error: jest.fn(),
    ...overrides,
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
    const { executor, deviceManager, deps, state: nextState } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan(), 'reconcile');

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deps.log).toHaveBeenCalledWith('Capacity: turning on Heater (reconcile after drift)');
    expect(nextState.lastRestoreMs).toBe(previousLastRestoreMs);
    expect(nextState.lastDeviceRestoreMs['dev-1']).toBe(previousDeviceRestoreMs);
    expect(nextState.activationAttemptStartedMsByDevice['dev-1']).toBeUndefined();
  });
});

describe('PlanExecutor pending target commands', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not resend the same target command until the retry deadline', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager, deps, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      },
    ]);
    const plan = buildTargetPlan();

    await executor.applyPlanActions(plan);
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 23,
      retryCount: 0,
    });

    jest.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] - 1);
    await executor.applyPlanActions(plan);
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(2);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 23,
      retryCount: 1,
    });
    expect(deps.log).toHaveBeenCalledWith(
      'Target mismatch still present for Heater; observed 18°C via unknown, retrying target_temperature to 23°C',
    );
    expect(deps.log).toHaveBeenCalledWith(
      'Set target_temperature for Heater from 18 to 23 (retry pending confirmation; mode: Home)',
    );
    expect(deps.logTargetRetryComparison).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      name: 'Heater',
      targetCap: 'target_temperature',
      desired: 23,
      observedValue: 18,
      observedSource: undefined,
      retryCount: 1,
      skipContext: 'plan',
    });
  });

  it('tags reconcile target updates in the user-visible log', async () => {
    const state = createPlanEngineState();
    const { executor, deps, deviceManager } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      },
    ]);

    await executor.applyPlanActions(buildTargetPlan(), 'reconcile');

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(deps.log).toHaveBeenCalledWith(
      'Set target_temperature for Heater from 18 to 23 (reconcile after drift; mode: Home)',
    );
  });

  it('logs shed-temperature target updates as shedding work instead of overshoot', async () => {
    const state = createPlanEngineState();
    const { executor, deps, deviceManager } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15 }),
    });

    await executor.applyPlanActions({
      meta: {
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4,
      },
      devices: [
        {
          id: 'dev-1',
          name: 'Heater',
          currentState: 'on',
          plannedState: 'shed',
          currentTarget: 22,
          plannedTarget: 15,
          controllable: true,
          shedAction: 'set_temperature',
        },
      ],
    });

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 15);
    expect(deps.log).toHaveBeenCalledWith(
      'Capacity: set target_temperature for Heater to 15°C (shedding)',
    );
    expect(deps.log).not.toHaveBeenCalledWith(
      'Capacity: set target_temperature for Heater to 15°C (overshoot)',
    );
  });

  it('bypasses pending target retry backoff for reconcile-driven drift correction', async () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + TARGET_COMMAND_RETRY_DELAYS_MS[0],
      lastObservedValue: 18,
      lastObservedSource: 'rebuild',
      lastObservedAtMs: Date.now() - 5_000,
    };
    const { executor, deps, deviceManager, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 28, unit: '°C' }],
      },
    ]);

    await executor.applyPlanActions(buildTargetPlan(28, 23), 'reconcile');

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(deps.log).toHaveBeenCalledWith(
      'Set target_temperature for Heater from 28 to 23 (reconcile after drift; mode: Home)',
    );
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      desired: 23,
      retryCount: 1,
    });
  });

  it('clears a pending target retry when the live snapshot is already confirmed after actuation', async () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + TARGET_COMMAND_RETRY_DELAYS_MS[0],
      lastObservedValue: 25,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 5_000,
    };
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 25, unit: '°C' }],
      },
    ];
    const syncLivePlanStateAfterTargetActuation = jest.fn(() => {
      snapshot[0].targets[0].value = 23;
      return true;
    });
    const { executor, deps, deviceManager, state: nextState } = buildExecutor(
      state,
      snapshot,
      { syncLivePlanStateAfterTargetActuation },
    );

    jest.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] + 1);
    await executor.applyPlanActions(buildTargetPlan(25, 23));

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(syncLivePlanStateAfterTargetActuation).toHaveBeenCalledWith('realtime_capability');
    expect(nextState.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(deps.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Target mismatch still present for Heater'),
    );
    expect(deps.log).toHaveBeenCalledWith(
      'Set target_temperature for Heater from 25 to 23 (retry pending confirmation; mode: Home)',
    );
    expect(deps.logDebug).toHaveBeenCalledWith(
      'Capacity: confirmed target_temperature for Heater at 23°C immediately after actuation',
    );
  });

  it('keeps retry observation metadata aligned with the live snapshot instead of a stale plan currentTarget', async () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + TARGET_COMMAND_RETRY_DELAYS_MS[0],
      lastObservedValue: 27,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 5_000,
    };
    const { executor, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 25, unit: '°C' }],
      },
    ]);

    jest.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] + 1);
    await executor.applyPlanActions(buildTargetPlan(18, 23));

    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      desired: 23,
      retryCount: 1,
      lastObservedValue: 25,
    });
  });
});
