import type Homey from 'homey';
import { PlanExecutor, type PlanExecutorDeps } from '../lib/plan/planExecutor';
import { TARGET_COMMAND_RETRY_DELAYS_MS } from '../lib/plan/planConstants';
import { createPlanEngineState } from '../lib/plan/planState';
import { DEVICE_LAST_CONTROLLED_MS } from '../lib/utils/settingsKeys';
import type {
  DevicePlan,
  DevicePlanDevice,
  PlanInputDevice,
} from '../lib/plan/planTypes';
import { buildLiveStatePlan, hasPlanExecutionDrift } from '../lib/plan/planReconcileState';
import { legacyDeviceReason } from './utils/deviceReasonTestUtils';

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
  const desiredSteppedTrigger = { trigger: vi.fn().mockResolvedValue(true) };
  const debugStructured = vi.fn();
  const deviceManager = {
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    setCapability: vi.fn().mockResolvedValue(undefined),
  };
  const deps: PlanExecutorDeps = {
    homey: {
      settings: { set: vi.fn() },
      flow: { getTriggerCard: vi.fn(() => desiredSteppedTrigger) },
    } as unknown as Homey.App['homey'],
    deviceManager: deviceManager as never,
    getCapacityGuard: () => undefined,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
    markSteppedLoadDesiredStepIssued: vi.fn(),
    logTargetRetryComparison: vi.fn(),
    structuredLog: { info: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
    debugStructured,
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  return { executor: new PlanExecutor(deps, state), deps, deviceManager, state, desiredSteppedTrigger, debugStructured };
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

  it('does not actuate a binary restore while meter settling keeps an off device in keep state', async () => {
    const { executor, deviceManager } = buildExecutor();

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
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 21,
          plannedTarget: 21,
          controllable: true,
          reason: legacyDeviceReason('meter settling (30s remaining)'),
        },
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
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
    expect(nextState.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('records an activation setback when reconcile has to reapply a fresh restore attempt', async () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.lastRestoreMs = now - 5_000;
    state.lastDeviceRestoreMs['dev-1'] = now - 5_000;
    state.activationAttemptByDevice['dev-1'] = {
      startedMs: now - 5_000,
      source: 'pels_restore',
    };
    const { executor, deviceManager, state: nextState } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan(), 'reconcile');

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(nextState.activationAttemptByDevice['dev-1']).toEqual({
      lastSetbackMs: expect.any(Number),
      penaltyLevel: 1,
    });
  });

  it('logs restore from shed temperature as explicit capacity work', async () => {
    const state = createPlanEngineState();
    const { executor, deps, deviceManager } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 16, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 16, stepId: null }),
    });

    await executor.applyPlanActions(buildTargetPlan(16, 23));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'target_temperature',
      targetValue: 23,
      previousValue: 16,
      mode: 'plan',
      attemptType: 'send',
      reasonCode: 'restore_from_shed',
      operatingMode: 'Home',
    }));
  });
});

describe('PlanExecutor pending target commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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

    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] - 1);
    await executor.applyPlanActions(plan);
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
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
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      targetValue: 23,
      previousValue: 18,
      mode: 'plan',
      attemptType: 'retry',
      reasonCode: 'retry_pending_confirmation',
      operatingMode: 'Home',
    }));
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

  it('backs off failed target writes and marks the device temporarily unavailable', async () => {
    const state = createPlanEngineState();
    const failure = new Error('Device offline');
    const { executor, deps, deviceManager, state: nextState, debugStructured } = buildExecutor(state, [
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
    deviceManager.setCapability.mockRejectedValue(failure);
    const plan = buildTargetPlan();

    await executor.applyPlanActions(plan);
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 23,
      retryCount: 0,
      status: 'temporary_unavailable',
    });
    expect(deps.log).toHaveBeenCalledWith(
      'Failed to set target_temperature for Heater; treating device as temporarily unavailable for 30s before retry',
    );
    expect(deps.error).toHaveBeenCalledWith(
      'Failed to set target_temperature for Heater via DeviceManager',
      failure,
    );
    expect(deps.logDebug).toHaveBeenCalledWith(
      'Capacity: skip target_temperature for Heater, device temporarily unavailable for 30s before retry (plan)',
    );
    expect((deps.structuredLog as any).error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'target_temperature',
      desired: 23,
      skipContext: 'plan',
      actuationMode: 'plan',
    }));
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_skipped',
      reasonCode: 'temporarily_unavailable',
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      desired: 23,
      skipContext: 'plan',
      actuationMode: 'plan',
    }));
  });

  it('logs restore skips when the target snapshot is missing', async () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-1'] = Date.now() - 10_000;
    const { executor, debugStructured, deviceManager } = buildExecutor(state, []);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'missing_snapshot',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      logContext: 'capacity',
      actuationMode: 'plan',
    }));
  });

  it('falls back to turn_off shedding when a shed temperature write fails', async () => {
    const state = createPlanEngineState();
    const failure = new Error('Device offline');
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [
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
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15, stepId: null }),
    });
    deviceManager.setCapability.mockImplementation(async (_deviceId: string, capabilityId: string) => {
      if (capabilityId === 'target_temperature') throw failure;
    });

    await executor.applySheddingToDevice('dev-1', 'Heater');

    expect(deviceManager.setCapability).toHaveBeenNthCalledWith(1, 'dev-1', 'target_temperature', 15);
    expect(deviceManager.setCapability).toHaveBeenNthCalledWith(2, 'dev-1', 'onoff', false);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 15,
      status: 'temporary_unavailable',
    });
  });

  it('does not fall back to turn_off when shed temperature is already applied', async () => {
    const { executor, deviceManager } = buildExecutor(createPlanEngineState(), [
      {
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 15, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15, stepId: null }),
    });

    await expect(executor.applySheddingToDevice('dev-1', 'Heater')).resolves.toBe(false);

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
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
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      targetValue: 23,
      previousValue: 18,
      mode: 'reconcile',
      attemptType: 'send',
      reasonCode: 'reconcile',
      operatingMode: 'Home',
    }));
  });

  it('normalizes target writes to the device target step before tracking pending retries', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        name: 'Connected 300',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 40, unit: '°C', min: 35, max: 75, step: 5 }],
      },
    ]);

    await executor.applyPlanActions(buildTargetPlan(40, 46));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 45);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 45,
      retryCount: 0,
    });
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
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      targetValue: 15,
      previousValue: 22,
      mode: 'plan',
      attemptType: 'send',
      reasonCode: 'shedding',
    }));
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
      status: 'waiting_confirmation',
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
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      targetValue: 23,
      previousValue: 28,
      mode: 'reconcile',
      reasonCode: 'reconcile',
    }));
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
      status: 'waiting_confirmation',
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
    const syncLivePlanStateAfterTargetActuation = vi.fn(() => {
      snapshot[0].targets[0].value = 23;
      return true;
    });
    const { executor, deps, deviceManager, state: nextState } = buildExecutor(
      state,
      snapshot,
      { syncLivePlanStateAfterTargetActuation },
    );

    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] + 1);
    await executor.applyPlanActions(buildTargetPlan(25, 23));

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(syncLivePlanStateAfterTargetActuation).toHaveBeenCalledWith('realtime_capability');
    expect(nextState.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(deps.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Target mismatch still present for Heater'),
    );
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      targetValue: 23,
      previousValue: 25,
      mode: 'plan',
      attemptType: 'retry',
      reasonCode: 'retry_pending_confirmation',
    }));
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
      status: 'waiting_confirmation',
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

    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] + 1);
    await executor.applyPlanActions(buildTargetPlan(18, 23));

    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      desired: 23,
      retryCount: 1,
      lastObservedValue: 25,
    });
  });
});

describe('PlanExecutor stepped loads', () => {
  const steppedProfile = {
    model: 'stepped_load' as const,
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  };

  const steppedPlan = (overrides: Record<string, unknown> = {}): DevicePlan => ({
    meta: {
      totalKw: 1,
      softLimitKw: 5,
      headroomKw: 4,
    },
    devices: [
      {
        id: 'dev-1',
        name: 'Tank',
        currentState: 'on',
        plannedState: 'keep',
        currentTarget: 68,
        plannedTarget: 68,
        controllable: true,
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        selectedStepId: 'low',
        desiredStepId: 'max',
        ...overrides,
      },
    ],
  });

  it('triggers desired stepped-load change and records the issued command', async () => {
    const { executor, deps, deviceManager, desiredSteppedTrigger, state } = buildExecutor();

    await expect(executor.applyPlanActions(steppedPlan())).resolves.toEqual({ deviceWriteCount: 0 });

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'max',
      planning_power_w: 3000,
      previous_step_id: 'low',
    }, {
      deviceId: 'dev-1',
    });
    expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: expect.any(Number),
      pendingWindowMs: expect.any(Number),
    });
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(state.lastRestoreMs).toEqual(expect.any(Number));
  });

  it('does not wait for stepped-load flow execution before completing apply', async () => {
    const { executor, desiredSteppedTrigger, deps, state } = buildExecutor();
    desiredSteppedTrigger.trigger.mockImplementation(() => new Promise<void>(() => {}));

    const outcome = await Promise.race([
      executor.applyPlanActions(steppedPlan()).then(() => 'resolved'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 0);
      }),
    ]);

    expect(outcome).toBe('resolved');
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'max',
      planning_power_w: 3000,
      previous_step_id: 'low',
    }, {
      deviceId: 'dev-1',
    });
    expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: expect.any(Number),
      pendingWindowMs: expect.any(Number),
    });
    expect(state.lastRestoreMs).toEqual(expect.any(Number));
  });

  it('does not re-trigger a stepped-load command while the same desired step is pending', async () => {
    const { executor, deps, desiredSteppedTrigger } = buildExecutor();

    await executor.applyPlanActions(steppedPlan({
      lastDesiredStepId: 'max',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  it('does not re-trigger a stale stepped-load command before its retry backoff elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));

    try {
      const now = Date.now();
      const { executor, deps, desiredSteppedTrigger } = buildExecutor();

      await executor.applyPlanActions(steppedPlan({
        lastDesiredStepId: 'max',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        lastStepCommandIssuedAt: now - 10_000,
        stepCommandRetryCount: 0,
        nextStepCommandRetryAtMs: now + 20_000,
      }));

      expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
      expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a stale stepped-load command after its retry backoff elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));

    try {
      const now = Date.now();
      const { executor, deps, desiredSteppedTrigger } = buildExecutor();

      await executor.applyPlanActions(steppedPlan({
        lastDesiredStepId: 'max',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        lastStepCommandIssuedAt: now - 40_000,
        stepCommandRetryCount: 0,
        nextStepCommandRetryAtMs: now - 1,
      }));

      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
        step_id: 'max',
        planning_power_w: 3000,
        previous_step_id: 'low',
      }, {
        deviceId: 'dev-1',
      });
      expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        desiredStepId: 'max',
        previousStepId: 'low',
        issuedAtMs: expect.any(Number),
        pendingWindowMs: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a stepped device to on when it has keep intent but currentOn is false', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager, deps } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'low', // no step change needed
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('turning on Tank'));
  });

  it('does not restore a stepped device when planned state is shed', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    // Raw snapshot has currentOn=false, so setBinaryControl skips both shed-off
    // and restore — no binary command issued
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not issue a step-UP command for a shed device with a non-zero desiredStepId', async () => {
    // Regression: applySteppedLoadCommand must never restore a shed device.
    // Poisoned state: shed device has desiredStepId='low' (stale from an interrupted
    // step-down sequence) while selectedStepId has already reached 'off'.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'low', // intentionally illegal: shed + upward step target
    }));

    // Step trigger must not fire — that would be a restore, not a shed
    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    // Binary restore must not be issued either
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('keep-invariant enforcement does not restore a shed stepped device even when desiredStepId is non-zero', async () => {
    // Regression: applySteppedLoadRestore checks plannedState === 'keep' and must
    // not fire for a shed device even if desiredStepId points to a non-off step.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const { executor, deviceManager } = buildExecutor(undefined, snapshot, { structuredLog });

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'low', // restore-related field; must not trigger invariant restore
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(structuredLog.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stepped_load_binary_transition_applied' }),
    );
  });

  it('does not restore a stepped device when it is already on', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'low',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not actuate stepped restore work while meter settling holds an off keep device', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      selectedStepId: 'off',
      desiredStepId: 'low',
      targetStepId: 'low',
      reason: legacyDeviceReason('meter settling (30s remaining)'),
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('distinguishes turn_off skip reasons when no control path exists', async () => {
    const noTargetsSnapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        available: true,
        currentOn: true,
      },
    ];
    const noTargetsDebugStructured = vi.fn();
    const noTargets = buildExecutor(undefined, noTargetsSnapshot, { debugStructured: noTargetsDebugStructured });
    await noTargets.executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(noTargetsDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'binary_command_skipped',
      reasonCode: 'missing_control_targets',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      desired: false,
      hasTargets: false,
      capabilityId: null,
      logContext: 'capacity',
      actuationMode: 'plan',
    }));

    const missingCapabilitySnapshot = [
      {
        id: 'dev-1',
        name: 'Heater',
        available: true,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      },
    ];
    const missingCapabilityDebugStructured = vi.fn();
    const missingCapability = buildExecutor(undefined, missingCapabilitySnapshot, { debugStructured: missingCapabilityDebugStructured });
    await missingCapability.executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(missingCapabilityDebugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'binary_command_skipped',
      reasonCode: 'missing_onoff_capability',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      desired: false,
      hasTargets: true,
      capabilityId: null,
      logContext: 'capacity',
      actuationMode: 'plan',
    }));
  });

  it('restores a stepped device at its off-step when keep intent requires onoff=true', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'low', // step change will be issued
    }));

    // The step command should be issued to move from off -> low
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    // Binary control should also be set because keep requires onoff=true
    // The device was at off-step with onoff=false, which violates keep invariant
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('requests the lowest restore step before turning on a stepped device that is off at a stale higher step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'max',
      desiredStepId: 'max',
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);

    const [stepCallOrder] = desiredSteppedTrigger.trigger.mock.invocationCallOrder;
    const [onoffCallOrder] = deviceManager.setCapability.mock.invocationCallOrder;
    expect(stepCallOrder).toBeLessThan(onoffCallOrder);
  });

  it('does not turn a stepped device on when the required pre-restore step command cannot be issued', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager, deps } = buildExecutor(undefined, snapshot, {
      homey: {
        settings: { set: vi.fn() },
        flow: { getTriggerCard: vi.fn(() => null) },
      } as unknown as Homey.App['homey'],
    });

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'max',
      desiredStepId: 'max',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deps.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('required pre-restore step command was not issued'),
    );
  });

  it('retries binary restore when the required pre-restore step command is already pending', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'max',
      desiredStepId: 'max',
      lastDesiredStepId: 'low',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('sets onoff=false for a shed stepped device at its off-step', async () => {
    // The plan sees currentState='off' (from decorated snapshot), but the raw
    // snapshot still has currentOn=true (the onoff capability hasn't been set
    // to false yet). setBinaryControl operates on raw snapshots, so it sees
    // the true value and issues the command.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, deviceManager, deps } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'binary_command_applied',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      desired: false,
      reasonCode: 'full_shed_to_off',
    }));
  });

  it('prepares a turn_off stepped shed at the lowest non-zero step before binary off', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager, deps, state } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      shedAction: 'turn_off',
      selectedStepId: 'max',
      desiredStepId: 'off',
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_command_requested',
      desiredStepId: 'low',
      plannedDesiredStepId: 'off',
      commandPurpose: 'step_preparation',
      stepPreparationPurpose: 'prepare_for_off',
      effectiveTransition: 'full_shed_to_off',
      binaryTarget: false,
    }));
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_binary_transition_applied',
      desiredBinaryState: false,
      effectiveTransition: 'full_shed_to_off',
      stepPreparationPurpose: 'prepare_for_off',
      transitionPhase: 'binary_transition',
    }));
    expect(state.lastDeviceShedMs['dev-1']).toEqual(expect.any(Number));
    expect(state.lastDeviceControlledMs['dev-1']).toEqual(expect.any(Number));
    expect((deps.homey.settings.set as any)).toHaveBeenCalledWith(
      DEVICE_LAST_CONTROLLED_MS,
      expect.objectContaining({ 'dev-1': expect.any(Number) }),
    );
  });

  it('records restore actuation when a plan-mode restore starts by moving from off-step to low', async () => {
    const state = createPlanEngineState();
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, deps } = buildExecutor(state, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'max',
    }));

    expect(state.lastDeviceRestoreMs['dev-1']).toEqual(expect.any(Number));
    expect(state.lastDeviceControlledMs['dev-1']).toEqual(expect.any(Number));
    expect((deps.homey.settings.set as any)).toHaveBeenCalledWith(
      DEVICE_LAST_CONTROLLED_MS,
      expect.objectContaining({ 'dev-1': expect.any(Number) }),
    );
    expect(state.activationAttemptByDevice['dev-1']).toEqual(expect.objectContaining({
      source: 'pels_restore',
      startedMs: expect.any(Number),
    }));
  });

  it('batches last-controlled persistence to one settings write per plan application', async () => {
    const state = createPlanEngineState();
    const snapshot = [
      {
        id: 'dev-restore',
        name: 'Restore Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
      {
        id: 'dev-shed',
        name: 'Shed Heater',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, deps } = buildExecutor(state, snapshot);

    await executor.applyPlanActions({
      meta: {
        totalKw: 2,
        softLimitKw: 5,
        headroomKw: 3,
      },
      devices: [
        {
          id: 'dev-restore',
          name: 'Restore Heater',
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 21,
          plannedTarget: 21,
          controllable: true,
        },
        {
          id: 'dev-shed',
          name: 'Shed Heater',
          currentState: 'on',
          plannedState: 'shed',
          currentTarget: 21,
          plannedTarget: 21,
          controllable: true,
        },
      ],
    });

    const settingsCalls = (deps.homey.settings.set as any).mock.calls
      .filter(([key]: [string]) => key === DEVICE_LAST_CONTROLLED_MS);
    expect(settingsCalls).toHaveLength(1);
    expect(settingsCalls[0][1]).toEqual(expect.objectContaining({
      'dev-restore': expect.any(Number),
      'dev-shed': expect.any(Number),
    }));
  });

  it('does not set onoff=false for a shed stepped device not at off-step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      selectedStepId: 'low',
      desiredStepId: 'low',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not set onoff=false for a keep stepped device at off-step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: true,
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'low',
    }));

    // setCapability should not be called with false — only step trigger fires
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('skips onoff=false when raw snapshot already shows device off', async () => {
    // When the raw onoff capability is already false, setBinaryControl detects
    // the device is already in the desired state and skips the command.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        currentOn: false,
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });
});

describe('PlanExecutor stepped load reconciliation loop', () => {
  const steppedProfile = {
    model: 'stepped_load' as const,
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  };

  const steppedPlan = (overrides: Partial<DevicePlanDevice> = {}): DevicePlan => ({
    meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
    devices: [{
      id: 'dev-1',
      name: 'Tank',
      currentState: 'on',
      plannedState: 'keep',
      currentTarget: null,
      plannedTarget: null,
      controllable: true,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      desiredStepId: 'low',
      ...overrides,
    }],
  });

  const buildLiveDevices = (
    overrides: Partial<Pick<PlanInputDevice, 'currentOn' | 'selectedStepId'>> = {},
  ): PlanInputDevice[] => [{
    id: 'dev-1',
    name: 'Tank',
    targets: [],
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    hasBinaryControl: true,
    ...overrides,
  }];

  const buildSnapshot = (overrides: { currentOn: boolean } = { currentOn: false }) => [{
    id: 'dev-1',
    name: 'Tank',
    controlCapabilityId: 'onoff' as const,
    canSetControl: true,
    available: true,
    currentOn: false,
    ...overrides,
  }];

  it('detects onoff drift and restores a keep device turned off externally', async () => {
    const appliedPlan = steppedPlan({ currentState: 'on', selectedStepId: 'low', desiredStepId: 'low' });
    const liveDevices = buildLiveDevices({ currentOn: false, selectedStepId: 'low' });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices);
    expect(hasPlanExecutionDrift(appliedPlan, livePlan)).toBe(true);
    expect(livePlan.devices[0].currentState).toBe('off');

    const { executor, deviceManager } = buildExecutor(undefined, buildSnapshot({ currentOn: false }));
    await executor.applyPlanActions(livePlan, 'reconcile');

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('detects step drift and re-issues step command for a keep device at off-step', async () => {
    const appliedPlan = steppedPlan({ currentState: 'on', selectedStepId: 'low', desiredStepId: 'low' });
    const liveDevices = buildLiveDevices({ currentOn: false, selectedStepId: 'off' });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices);
    expect(hasPlanExecutionDrift(appliedPlan, livePlan)).toBe(true);

    const { executor, desiredSteppedTrigger, deps } = buildExecutor(undefined, buildSnapshot({ currentOn: false }));
    await executor.applyPlanActions(livePlan, 'reconcile');

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'dev-1',
      previousStepId: 'off',
      desiredStepId: 'low',
      plannedDesiredStepId: 'low',
      commandPurpose: 'step_preparation',
      stepPreparationPurpose: 'prepare_for_on',
      effectiveTransition: 'restore_from_off_at_low',
      binaryTarget: true,
      mode: 'reconcile',
    }));
  });

  it('does not count a stepped-load trigger request as a concrete device write', async () => {
    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'low',
    });
    const { executor, desiredSteppedTrigger, deviceManager, deps } = buildExecutor(
      undefined,
      buildSnapshot({ currentOn: true }),
    );

    await expect(executor.applyPlanActions(plan, 'reconcile')).resolves.toEqual({ deviceWriteCount: 0 });

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.not.objectContaining({
      actuationSuffix: expect.anything(),
    }));
  });

  it('re-issues step command when keep device has onoff=true but step is at off', async () => {
    // Raw snapshot has currentOn=true (onoff not violated), but selectedStepId='off'
    // with desiredStepId='low' — only stepViolated is true.
    // The decorated snapshot derives currentState='off' from the off-step, which
    // lets applySteppedLoadRestore enter.
    const snapshot = buildSnapshot({ currentOn: true });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan, 'reconcile');

    // Step command should be issued to move from off -> low
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    // setBinaryControl is called with desired=true, but raw snapshot already
    // has currentOn=true so it detects "already on" and skips the command.
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('fixes both onoff=false and step=off when keep intent is violated on both axes', async () => {
    // Both violations: raw snapshot has currentOn=false AND selectedStepId='off'
    // while desiredStepId='low'. Both onoffViolated and stepViolated should be true.
    const snapshot = buildSnapshot({ currentOn: false });
    const { executor, deviceManager, desiredSteppedTrigger, deps } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan, 'reconcile');

    // Step command should be issued
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    // Binary restore should be issued (onoff was false)
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    // Both violations should be logged
    expect(deps.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('violates keep invariant: onoff='),
    );
    expect(deps.logDebug).toHaveBeenCalledWith(
      expect.stringContaining('violates keep invariant: step=off (off-step)'),
    );
  });

  it('detects step drift and re-issues shed step when external actor raises step', async () => {
    const appliedPlan = steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'set_step',
      shedStepId: 'low',
      selectedStepId: 'low',
      desiredStepId: 'low',
    });
    const liveDevices = buildLiveDevices({ currentOn: true, selectedStepId: 'max' });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices);
    expect(hasPlanExecutionDrift(appliedPlan, livePlan)).toBe(true);

    const { executor, desiredSteppedTrigger, deps } = buildExecutor(undefined, buildSnapshot({ currentOn: true }));
    await executor.applyPlanActions(livePlan, 'reconcile');

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect((deps.structuredLog as any).info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'dev-1',
      previousStepId: 'max',
      desiredStepId: 'low',
      plannedDesiredStepId: 'low',
      commandPurpose: 'step_adjustment',
      stepPreparationPurpose: null,
      effectiveTransition: 'step_down_while_on',
      binaryTarget: null,
      mode: 'reconcile',
    }));
  });

  it('normalizes a shed-constrained keep restore to the lowest non-zero step before turning on', async () => {
    const snapshot = buildSnapshot({ currentOn: false });
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const plan: DevicePlan = {
      meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
      devices: [
        {
          id: 'shed-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
        },
        {
          id: 'dev-1',
          name: 'Tank',
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          controlModel: 'stepped_load' as const,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'max',
          desiredStepId: 'max',
        },
      ],
    };

    await executor.applyPlanActions(plan, 'reconcile');

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
  });

  it('allows keep-invariant restore when shed devices exist but desiredStepId is at lowestNonZeroStep', async () => {
    const snapshot = buildSnapshot({ currentOn: false });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    const plan: DevicePlan = {
      meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
      devices: [
        {
          id: 'shed-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
        },
        {
          id: 'dev-1',
          name: 'Tank',
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: null,
          plannedTarget: null,
          controllable: true,
          controlModel: 'stepped_load' as const,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'off',
          desiredStepId: 'low', // at lowestNonZeroStep — allowed
        },
      ],
    };

    await executor.applyPlanActions(plan, 'reconcile');

    // Binary restore IS allowed — desiredStepId is exactly lowestNonZeroStep
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('allows keep-invariant restore when no devices are shed', async () => {
    const snapshot = buildSnapshot({ currentOn: false });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({ currentState: 'off', selectedStepId: 'off', desiredStepId: 'max' });
    await executor.applyPlanActions(plan, 'reconcile');

    // No shed devices → restore allowed even though desiredStepId='max'
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('does not emit restore_keep_invariant_shed_blocked for a true off restore while devices remain shed', async () => {
    const snapshot = buildSnapshot({ currentOn: false });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const plan: DevicePlan = {
      meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
      devices: [
        {
          id: 'shed-1', name: 'Heater', currentState: 'off', plannedState: 'shed',
          currentTarget: null, plannedTarget: null, controllable: true,
        },
        {
          id: 'dev-1', name: 'Tank', currentState: 'off', plannedState: 'keep',
          currentTarget: null, plannedTarget: null, controllable: true,
          controlModel: 'stepped_load' as const,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'off',
          desiredStepId: 'max',
        },
      ],
    };

    await executor.applyPlanActions(plan, 'reconcile');
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
  });

  it('normalizes stale desired steps to the same lowest restore step while devices remain shed', async () => {
    // Custom profile with off/low/medium/max so we can test desiredStepId transitions
    const multiStepProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
        { id: 'medium', planningPowerW: 2000 },
        { id: 'max', planningPowerW: 3000 },
      ],
    };
    const snapshot = buildSnapshot({ currentOn: false });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const shedDevice = {
      id: 'shed-1', name: 'Heater', currentState: 'off' as const, plannedState: 'shed' as const,
      currentTarget: null, plannedTarget: null, controllable: true,
    };
    const steppedDevice = (desiredStepId: string) => ({
      id: 'dev-1', name: 'Tank', currentState: 'off' as const, plannedState: 'keep' as const,
      currentTarget: null, plannedTarget: null, controllable: true,
      controlModel: 'stepped_load' as const,
      steppedLoadProfile: multiStepProfile,
      selectedStepId: 'off',
      desiredStepId,
    });

    await executor.applyPlanActions(
      { meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 }, devices: [shedDevice, steppedDevice('medium')] },
      'reconcile',
    );
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));

    desiredSteppedTrigger.trigger.mockClear();
    deviceManager.setCapability.mockClear();
    await executor.applyPlanActions(
      { meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 }, devices: [shedDevice, steppedDevice('max')] },
      'reconcile',
    );
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('keeps shed-block dedupe state clear across admitted off restores', async () => {
    const snapshot = buildSnapshot({ currentOn: false });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, deviceManager } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const blockedPlan: DevicePlan = {
      meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
      devices: [
        {
          id: 'shed-1', name: 'Heater', currentState: 'off', plannedState: 'shed',
          currentTarget: null, plannedTarget: null, controllable: true,
        },
        {
          id: 'dev-1', name: 'Tank', currentState: 'off', plannedState: 'keep',
          currentTarget: null, plannedTarget: null, controllable: true,
          controlModel: 'stepped_load' as const,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'max',
          desiredStepId: 'max',
        },
      ],
    };
    const admittedPlan: DevicePlan = {
      meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
      devices: [
        {
          id: 'dev-1', name: 'Tank', currentState: 'off', plannedState: 'keep',
          currentTarget: null, plannedTarget: null, controllable: true,
          controlModel: 'stepped_load' as const,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'off',
          desiredStepId: 'max',
        },
      ],
    };

    await executor.applyPlanActions(blockedPlan, 'reconcile');
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));

    debugStructured.mockClear();
    deviceManager.setCapability.mockClear();
    await executor.applyPlanActions(admittedPlan, 'reconcile');
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);

    debugStructured.mockClear();
    await executor.applyPlanActions(blockedPlan, 'reconcile');
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
  });

  // -------------------------------------------------------------------------
  // Group 3: stepped-load turn_on (keep) actuation semantics
  // Tests marked it.fails() document desired behavior not yet implemented.
  // -------------------------------------------------------------------------

  describe('turn_on (keep) actuation semantics (Group 3)', () => {
    // Test 3.1: device has a non-zero step but onoff is false — only binary on needed,
    // no step change. The step is already non-zero so it must not be overwritten.
    it('sends onoff=true without changing step when step is already non-zero', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false,
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'low',
        desiredStepId: 'low', // non-zero, matches selected — no step change
      }));

      // Binary must be restored
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      // Step must not be changed — desired already equals selected
      expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    });

    // Test 3.2: desiredStepId has been pre-normalized to 'low' (lowest non-zero) before
    // the executor runs. With the correct desiredStepId in place, the executor must issue
    // BOTH the binary on AND the step-up command.
    // Note: this passes because desiredStepId is explicitly set to 'low' here.
    // The companion planDevices test (it.fails) covers the normalization gap.
    it('issues onoff=true and step command when desiredStepId is pre-normalized to lowest non-zero and step is at off-step', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false,
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: 'low', // pre-normalized to lowest non-zero
      }));

      // Binary restore
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      // Step command from off → low
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
    });

    // Test 3.3: selectedStepId is unknown while binary onoff is false.
    // Restore must re-enter at the lowest non-zero step rather than trusting a stale
    // desiredStepId, so the load becomes deterministic again.
    it('normalizes unknown-step restore to the lowest non-zero step before binary on', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false,
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: undefined as unknown as string, // unknown
        desiredStepId: 'max', // non-zero intended step
      }));

      // Step command must normalize to the lowest non-zero step.
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      expect(desiredSteppedTrigger.trigger.mock.invocationCallOrder[0])
        .toBeLessThan(deviceManager.setCapability.mock.invocationCallOrder[0]);
    });

    it('does not issue a forced normalization step when the current non-zero step is already known', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false,
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'low',
        desiredStepId: 'low',
      }));

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    });

    it('still sends the normalization step before a failing binary restore', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false,
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);
      deviceManager.setCapability.mockRejectedValueOnce(new Error('boom'));

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: undefined as unknown as string,
        desiredStepId: 'max',
      }));

      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    });

    // Test 3.4 / Regression 5.2 (executor layer): when both desiredStepId and selectedStepId
    // are the off-step, the executor must still issue a step command to the lowest non-zero
    // step — it must not leave the device at zero-step after turning binary on.
    // Current: only binary on is sent because desiredStepId='off'=selectedStepId, so
    // applySteppedLoadCommand sees no change and skips.
    it('issues step command to lowest non-zero step when both desiredStepId and selectedStepId are zero-usage', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false,
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      // Both desiredStepId and selectedStepId are off-step — un-normalized state
      // that planDevices currently produces for a restored device shed to off-step.
      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: 'off', // un-normalized: should still trigger step command to 'low'
      }));

      // Binary must be restored
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      // A step command to the lowest non-zero step must also be issued
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Group 2 executor + Regression 5.1: stepped-load turn_off actuation
  // -------------------------------------------------------------------------

  describe('turn_off shed actuation (Group 2 executor / Regression 5.1)', () => {
    it('uses raw snapshot state for binary shed-off when decorated currentState is stale', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: true,
        },
      ];
      const { executor, deviceManager } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions({
        meta: {
          totalKw: 1,
          softLimitKw: 5,
          headroomKw: 4,
        },
        devices: [
          {
            id: 'dev-1',
            name: 'Tank',
            currentState: 'off',
            plannedState: 'shed',
            currentTarget: 21,
            plannedTarget: 21,
            controllable: true,
          },
        ],
      });

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    });

    // Test 2.4: binary is already off; the executor must not re-enable it.
    it('does not re-enable binary when device is already off at a non-lowest step', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: false, // binary already off
        },
      ];
      const { executor, deviceManager } = buildExecutor(undefined, snapshot);

      // Device is shed with turn_off at a non-off step; binary is already off.
      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',  // off because binary is false
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'low', // not at off-step yet
        desiredStepId: 'off',  // intended lowest
      }));

      // Binary must NOT be re-enabled (no onoff=true)
      expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    });

    // Regression 5.1: turn_off shed must send onoff=false immediately, even before the
    // step has reached the off-step. Current: applySteppedLoadShedOff only fires once
    // selectedStepId is already the off-step — binary off is deferred too long.
    it('sends onoff=false immediately, without waiting to reach off-step (Regression 5.1)', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          controlCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          currentOn: true, // binary still on
        },
      ];
      const { executor, deviceManager } = buildExecutor(undefined, snapshot);

      // Device is planned to shed with turn_off. It is currently at a non-off step.
      // The contract says onoff=false must be sent as part of the turn_off action,
      // not only after the step has already stepped down to the off-step.
      await executor.applyPlanActions(steppedPlan({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'low', // NOT at off-step
        desiredStepId: 'off',  // intended lowest step (per contract)
      }));

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    });
  });
});
