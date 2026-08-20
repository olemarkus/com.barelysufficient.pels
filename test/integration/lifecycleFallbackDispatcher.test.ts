import { describe, expect, it, vi } from 'vitest';
import {
  LifecycleFallbackDispatcher as ExecutorLifecycleFallbackDispatcher,
  type LifecycleFallbackDevice,
  type LifecycleFallbackObservedState,
  type LifecycleFallbackRequest,
} from '../../lib/executor/lifecycleFallbackDispatcher';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  prunePendingTargetCommandsForPlan,
  recordPendingTargetCommandAttempt,
} from '../../lib/plan/planTargetControl';
import { buildPlanInputDevice } from '../helpers/buildPlanInputDevice';
import {
  applyDeferredBinaryCommand,
  type PlanExecutorBinaryContext,
} from '../../lib/executor/binaryExecutor';
import { runBinaryControl } from '../../lib/executor/binaryControlShared';
import type { PlanExecutorSteppedContext } from '../../lib/executor/steppedLoadExecutor';
import {
  applySteppedLoadCommand,
  applySteppedLoadShedOff,
} from '../../lib/executor/steppedLoadExecutor';
import { executeSteppedLoadRestoreBinary } from '../../lib/executor/steppedLoadExecutorRestore';
import type { ExecutableSteppedLoadDevice } from '../../lib/executor/executablePlan';
import { buildExecutableObservedDeviceState } from '../../lib/executor/executablePlanProjection';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { DeviceObservation } from '../../lib/device/deviceObservation';
import { dispatchTargetCommand } from '../../lib/executor/targetExecutor';
import type { PlanExecutorTargetContext } from '../../lib/executor/targetExecutorContext';
import { TARGET_COMMAND_RETRY_DELAYS_MS } from '../../lib/plan/planConstants';
import { createTargetCommandClaim } from '../../lib/executor/targetCommandClaim';
import { createSteppedCommandClaim } from '../../lib/executor/steppedCommandClaim';
import { createBinaryCommandClaim } from '../../lib/executor/binaryCommandClaim';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { resolveLifecycleFallbackRequest } from '../../setup/lifecycleFallbackRequest';
import type { ShedBehavior } from '../../lib/plan/planTypes';
import { projectLifecycleFallbackDevice } from '../../setup/lifecycleFallbackDeviceProjection';

/**
 * Unwraps the seam's per-device result for the cases under test that expect a
 * drivable device. `no_writable_axis` has its own dedicated test.
 */
const resolveRequest = (
  params: Parameters<typeof resolveLifecycleFallbackRequest>[0],
): LifecycleFallbackRequest => {
  const resolution = resolveLifecycleFallbackRequest(params);
  if (resolution.state !== 'resolved') {
    throw new Error(`expected a resolved lifecycle fallback request, got ${resolution.state}`);
  }
  return resolution.request;
};
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { DeviceCommand } from '../../lib/actuator/deviceCommand';
import { buildPlanMeta } from '../utils/planTestUtils';

type ExecutorDispatcherDeps = ConstructorParameters<typeof ExecutorLifecycleFallbackDispatcher>[0];
type LegacyLifecycleFallbackDevice = Omit<
LifecycleFallbackDevice,
'binaryAxis' | 'targetAxis' | 'stepAxis'
> & {
  binaryControl?: { on: boolean };
  currentOn?: boolean;
  targets?: DecoratedDeviceSnapshot['targets'];
  steppedLoadProfile?: DecoratedDeviceSnapshot['steppedLoadProfile'];
  binaryWritable?: boolean;
  targetWritable?: boolean;
  stepWritable?: boolean;
};
type TestDispatcherDeps = Omit<
ExecutorDispatcherDeps,
'buildSteppedExecutorContext' | 'capacityDryRun'
> & {
  capacityDryRun?: () => boolean;
  getDevice: () => LegacyLifecycleFallbackDevice;
  getObservedState: () => LifecycleFallbackObservedState;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  buildSteppedExecutorContext: () => Omit<
    PlanExecutorSteppedContext,
    'steppedCommandClaim' | 'steppedCommandOwner' | 'binaryCommandClaim' | 'binaryCommandOwner'
  > & Partial<Pick<
    PlanExecutorSteppedContext,
    'steppedCommandClaim' | 'steppedCommandOwner' | 'binaryCommandClaim' | 'binaryCommandOwner'
  >>;
};

const withLifecycleAxes = (candidate: LegacyLifecycleFallbackDevice): LifecycleFallbackDevice => {
  const targetDescriptor = candidate.targets?.[0];
  const {
    binaryControl: _binaryControl,
    currentOn: _currentOn,
    targets: _targets,
    steppedLoadProfile: _steppedLoadProfile,
    binaryWritable: _binaryWritable,
    targetWritable: _targetWritable,
    stepWritable: _stepWritable,
    ...device
  } = candidate;
  return {
    ...device,
    binaryAxis: candidate.binaryWritable !== false
      && typeof candidate.currentOn === 'boolean'
      ? { state: 'writable' }
      : { state: 'unavailable' },
    targetAxis: candidate.targetWritable !== false && targetDescriptor
      ? { state: 'writable', target: 'temperature' }
      : { state: 'unavailable' },
    stepAxis: candidate.stepWritable !== false && candidate.steppedLoadProfile
      ? { state: 'writable', profile: candidate.steppedLoadProfile }
      : { state: 'unavailable' },
  };
};

class LifecycleFallbackDispatcher {
  private readonly delegate: ExecutorLifecycleFallbackDispatcher;

  public constructor(private readonly deps: TestDispatcherDeps) {
    const steppedCommandClaim = createSteppedCommandClaim();
    const binaryCommandClaim = createBinaryCommandClaim();
    this.delegate = new ExecutorLifecycleFallbackDispatcher({
      ...deps,
      capacityDryRun: deps.capacityDryRun ?? (() => false),
      buildBinaryExecutorContext: () => ({
        ...deps.buildBinaryExecutorContext(),
        binaryCommandClaim,
        binaryCommandOwner: 'ordinary',
      }),
      buildSteppedExecutorContext: () => ({
        ...deps.buildSteppedExecutorContext(),
        steppedCommandClaim,
        steppedCommandOwner: 'ordinary',
        binaryCommandClaim,
        binaryCommandOwner: 'ordinary',
      }),
    });
  }

  public converge(request: { deviceId: string; objectiveKind: 'ev_soc' | 'temperature' }) {
    const candidate = this.deps.getDevice();
    const device = withLifecycleAxes(candidate);
    return this.delegate.converge(resolveRequest({
      device,
      observedState: this.deps.getObservedState(),
      configuredFallback: this.deps.getShedBehavior(request.deviceId),
    }));
  }

  public abandon(deviceId: string): void {
    this.delegate.abandon(deviceId);
  }

  public getOwnedTargetPending(deviceId: string) {
    return this.delegate.getOwnedTargetPending(deviceId);
  }

  public isActive(deviceId: string): boolean {
    return this.delegate.isActive(deviceId);
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

const createTestActuator = (
  implementation: (command: DeviceCommand) => Promise<{ requested: boolean }> = async () => ({ requested: true }),
): Actuator & { apply: ReturnType<typeof vi.fn> } => {
  const apply = vi.fn(async (command: DeviceCommand) => {
    const result = await implementation(command);
    if (!result.requested) return { requested: false as const };
    if (command.kind === 'binary') {
      return {
        requested: true as const,
        kind: 'binary' as const,
      };
    }
    if (command.kind === 'target') {
      return {
        requested: true as const,
        kind: 'target' as const,
        requestedTargetValue: command.value,
      };
    }
    return {
      requested: true as const,
      kind: 'step' as const,
      steppedResult: { requested: true as const, transport: 'native_capability' as const },
    };
  });
  return {
    apply,
    resolveTemperatureTarget: (_deviceId, desired) => desired,
  };
};

const observedFromDevice = (
  device: ReturnType<typeof buildPlanInputDevice>,
): LifecycleFallbackObservedState => ({
  id: device.id,
  name: device.name,
  targets: device.targets,
  binaryControl: 'currentOn' in device && typeof device.currentOn === 'boolean'
    ? { on: device.currentOn }
    : undefined,
  available: device.available,
  ...('reportedStepId' in device && typeof device.reportedStepId === 'string'
    ? { reportedStepId: device.reportedStepId }
    : {}),
});

const buildDryRunRequests = (): { axis: string; request: LifecycleFallbackRequest }[] => {
  const binaryDevice = buildPlanInputDevice({
    id: 'device-1', name: 'Device', binaryControl: { on: true }, currentOn: true, targets: [],
  });
  const targetDevice = buildPlanInputDevice({
    id: 'device-1', name: 'Device', targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
  });
  const profile = {
    steps: [
      { id: 'low', planningPowerW: 1_000 },
      { id: 'high', planningPowerW: 2_000 },
    ],
  };
  const stepDevice = buildPlanInputDevice({
    id: 'device-1', name: 'Device', controlModel: 'stepped_load', targets: [],
    reportedStepId: 'high', selectedStepId: 'high', steppedLoadProfile: profile,
  });
  return [
    {
      axis: 'binary',
      request: { kind: 'binary_off', observed: buildExecutableObservedDeviceState(binaryDevice) },
    },
    {
      axis: 'target',
      request: {
        kind: 'target_fallback', observed: buildExecutableObservedDeviceState(targetDevice), desired: 5,
      },
    },
    {
      axis: 'step',
      request: {
        kind: 'step_fallback',
        observed: buildExecutableObservedDeviceState(stepDevice),
        targetStepId: 'low',
        steppedLoad: {
          id: stepDevice.id,
          name: stepDevice.name,
          purpose: 'shed',
          steppedLoadProfile: profile,
          desired: { on: true, stepId: 'low' },
          transition: null,
          matchingRestoreAttempt: null,
          matchingCommandAttempt: null,
          stepCommandRetryCount: 0,
        },
      },
    },
  ];
};

describe('LifecycleFallbackDispatcher', () => {
  it.each(buildDryRunRequests())(
    'fences $axis lifecycle fallback before authority, claim, or write in dry-run',
    ({ request }) => {
      const acquire = vi.fn(() => true);
      const buildBinaryExecutorContext = vi.fn();
      const buildTargetExecutorContext = vi.fn();
      const buildSteppedExecutorContext = vi.fn();
      const dispatcher = new ExecutorLifecycleFallbackDispatcher({
        capacityDryRun: () => true,
        targetCommandClaim: { acquire, ownerOf: vi.fn(), release: vi.fn() },
        buildBinaryExecutorContext,
        buildTargetExecutorContext,
        buildSteppedExecutorContext,
        recordReleaseShedActuation: vi.fn(),
      });

      expect(dispatcher.converge(request)).toEqual({ settled: false });
      expect(dispatcher.isActive('device-1')).toBe(false);
      expect(acquire).not.toHaveBeenCalled();
      expect(buildBinaryExecutorContext).not.toHaveBeenCalled();
      expect(buildTargetExecutorContext).not.toHaveBeenCalled();
      expect(buildSteppedExecutorContext).not.toHaveBeenCalled();
    },
  );

  it('projects target-only write authority without borrowing the binary permission', () => {
    const projected = projectLifecycleFallbackDevice({
      id: 'heater-1',
      name: 'Target-only heater',
      expectedPowerKw: 1,
      expectedPowerSource: 'default',
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
      available: true,
      canSetControl: false,
    } as DecoratedDeviceSnapshot);

    expect(projected).toMatchObject({
      binaryAxis: { state: 'unavailable' },
      targetAxis: { state: 'writable' },
      stepAxis: { state: 'unavailable' },
    });
    expect(resolveRequest({
      device: projected,
      observedState: {
        id: projected.id,
        name: projected.name,
        available: true,
        targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
      },
      configuredFallback: { action: 'set_temperature', temperature: 5 },
    })).toMatchObject({
      kind: 'target_fallback',
      desired: 5,
    });
  });

  it('projects stepped-only write authority without requiring a binary handle', () => {
    const projected = projectLifecycleFallbackDevice({
      id: 'heater-1',
      name: 'Stepped-only heater',
      expectedPowerKw: 2,
      expectedPowerSource: 'default',
      targets: [],
      available: true,
      canSetControl: false,
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1_000 },
          { id: 'high', planningPowerW: 2_000 },
        ],
      },
      selectedStepId: 'high',
    } as DecoratedDeviceSnapshot);

    expect(projected).toMatchObject({
      binaryAxis: { state: 'unavailable' },
      targetAxis: { state: 'unavailable' },
      stepAxis: { state: 'writable' },
    });
    expect(resolveRequest({
      device: projected,
      observedState: {
        id: projected.id,
        name: projected.name,
        available: true,
        targets: [],
        reportedStepId: 'high',
      },
      configuredFallback: { action: 'set_step' },
    })).toMatchObject({
      kind: 'step_fallback',
      targetStepId: 'low',
    });
  });

  it('dispatches and settles an EV objective through a producer-projected step-only axis', async () => {
    const state = createPlanEngineState();
    const requestSteppedLoadStep = vi.fn().mockResolvedValue({ requested: true, transport: 'capability' });
    let reportedStepId = 'high';
    const buildProjectedRequest = () => {
      const raw = {
        id: 'charger-1',
        name: 'Step-only charger',
        expectedPowerKw: 2,
        expectedPowerSource: 'default' as const,
        targets: [],
        available: true,
        canSetControl: false,
        controlModel: 'stepped_load' as const,
        steppedLoadProfile: {
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1_000 },
            { id: 'high', planningPowerW: 2_000 },
          ],
        },
        selectedStepId: reportedStepId,
        reportedStepId,
      } as DecoratedDeviceSnapshot;
      const device = projectLifecycleFallbackDevice(raw);
      return resolveRequest({
        device,
        observedState: {
          id: raw.id,
          name: raw.name,
          available: true,
          targets: [],
          reportedStepId,
        },
      configuredFallback: { action: 'set_step' },
      });
    };
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      targetCommandClaim: createTargetCommandClaim(),
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({
        state,
        observation: {} as DeviceObservation,
        buildBinaryControlTransport: () => ({} as never),
        requestSteppedLoadStep,
        markSteppedLoadDesiredStepIssued: vi.fn(),
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        getRestoreLogSource: () => 'current_plan',
        steppedCommandClaim: createSteppedCommandClaim(),
        steppedCommandOwner: 'ordinary',
        binaryCommandClaim: createBinaryCommandClaim(),
        binaryCommandOwner: 'ordinary',
      }),
      recordReleaseShedActuation: vi.fn(),
    });

    const request = buildProjectedRequest();
    expect(request).toMatchObject({
      kind: 'step_fallback',
      targetStepId: 'low',
    });
    expect(dispatcher.converge(request)).toEqual({ settled: false });
    await flush();
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'charger-1',
      desiredStepId: 'low',
    }));

    reportedStepId = 'low';
    const settledRequest = buildProjectedRequest();
    expect(dispatcher.converge(settledRequest!)).toEqual({ settled: true });
  });

  it('keeps a producer-projected binary EV objective on the binary release lane', () => {
    const projected = projectLifecycleFallbackDevice({
      id: 'charger-1',
      name: 'Binary charger',
      expectedPowerKw: 2,
      expectedPowerSource: 'default',
      targets: [],
      available: true,
      canSetControl: true,
      binaryControl: { on: true },
    } as DecoratedDeviceSnapshot);

    expect(resolveRequest({
      device: projected,
      observedState: {
        id: projected.id,
        name: projected.name,
        available: true,
        targets: [],
        binaryControl: { on: true },
      },
      configuredFallback: { action: 'turn_off' },
    })).toMatchObject({
      kind: 'binary_off',
    });
  });

  it('projects temperature policy as target denial only, leaving binary and step writable', () => {
    const projected = projectLifecycleFallbackDevice({
      id: 'heater-1',
      name: 'Hybrid heater',
      expectedPowerKw: 2,
      expectedPowerSource: 'default',
      targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      available: true,
      capabilities: ['onoff'],
      canSetControl: true,
      binaryControl: { on: true },
      temperatureControlDisabled: true,
      steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }] },
    } as DecoratedDeviceSnapshot);

    // The step axis is a different axis from the setpoint, so lifecycle
    // fallback can still trim this heater to a lower rung.
    expect(projected).toMatchObject({
      binaryAxis: { state: 'writable' },
      targetAxis: { state: 'unavailable' },
      stepAxis: { state: 'writable' },
    });
  });

  it('keeps target retry state across a plan prune and records lifecycle shed cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const planState = createPlanEngineState();
    const actuator = createTestActuator();
    const recordReleaseShedActuation = vi.fn();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({
        state: planState,
        targetCommandClaim: createTargetCommandClaim(),
        targetCommandOwner: 'ordinary',
        getObservedTemperatureValue: () => 21,
        actuator,
        operatingMode: 'Home',
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        recordActivationAttemptStarted: vi.fn(),
      }),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation,
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    expect(recordReleaseShedActuation).toHaveBeenCalledWith('heater-1', 'Heater', 1_000_000);
    const retryAtMs = dispatcher.getOwnedTargetPending(device.id)?.nextRetryAtMs;
    expect(retryAtMs).toBeTypeOf('number');

    // Ordinary planning owns and prunes a different target-pending map.
    prunePendingTargetCommandsForPlan({
      state: planState,
      plan: { devices: [], meta: buildPlanMeta({ totalKw: 0, softLimitKw: 10, headroomKw: 10}) },
    });
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    vi.setSystemTime((retryAtMs ?? 1_000_000) + 1);
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('clears settled target pending state so later drift starts a fresh attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let observedValue = 21;
    const actuator = createTestActuator();
    const buildDevice = () => buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({
        state: createPlanEngineState(),
        targetCommandClaim: createTargetCommandClaim(),
        targetCommandOwner: 'ordinary',
        getObservedTemperatureValue: () => observedValue,
        actuator,
        operatingMode: 'Home',
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        recordActivationAttemptStarted: vi.fn(),
      }),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    observedValue = 5;
    expect(dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' })).toEqual({ settled: true });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    observedValue = 21;
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('uses observer target drift instead of a stale settled transport snapshot', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: 5, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      }),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({
        state,
        targetCommandClaim: createTargetCommandClaim(),
        targetCommandOwner: 'ordinary',
        getObservedTemperatureValue: () => 21,
        actuator,
        operatingMode: 'Home',
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        recordActivationAttemptStarted: vi.fn(),
      }),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).toHaveBeenCalledOnce();
  });

  it('uses observer target settlement instead of issuing from a stale transport snapshot', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        targets: [{ id: 'target_temperature', value: 5, unit: 'C' }],
      }),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({ state, actuator } as never),
      buildBinaryExecutorContext: () => ({ actuator } as never),
      buildSteppedExecutorContext: () => ({ actuator } as never),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: true });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();
  });

  it('falls back to binary off when configured temperature control has no target capability', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      binaryControl: { on: true },
      currentOn: true,
      targets: [],
    });
    const observation = {
      getSnapshot: () => [device],
      getSnapshotByDeviceId: () => device,
    } as unknown as DeviceObservation;
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({
        state,
        targetCommandClaim: createTargetCommandClaim(),
        targetCommandOwner: 'ordinary',
        getObservedTemperatureValue: () => undefined,
        actuator,
        operatingMode: 'Home',
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        recordActivationAttemptStarted: vi.fn(),
      }),
      buildBinaryExecutorContext: () => ({
        state,
        observation,
        capacityDryRun: false,
        buildBinaryControlTransport: () => ({
          observation,
          pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
          actuator,
        }),
        getRestoreLogSource: () => 'current_plan',
        recordShedActuation: vi.fn(),
        recordReleaseShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        binaryCommandClaim: createBinaryCommandClaim(),
        binaryCommandOwner: 'ordinary',
      }),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'binary',
      deviceId: 'heater-1',
      desired: false,
    }));
  });

  it('dispatches a flow-backed binary fallback from observer ON despite stale transport OFF', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = {
      ...buildPlanInputDevice({
        id: 'charger-1',
        name: 'Charger',
        controllable: false,
        available: true,
        binaryControl: { on: false },
        currentOn: false,
        targets: [],
      }),
    };
    const observation = {
      getSnapshot: () => [device],
      getSnapshotByDeviceId: () => device,
    } as unknown as DeviceObservation;
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        binaryControl: { on: true },
      }),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'turn_off' }),
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({
        state,
        observation,
        capacityDryRun: false,
        buildBinaryControlTransport: () => ({
          observation,
          pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
          actuator,
        }),
        getRestoreLogSource: () => 'current_plan',
        recordShedActuation: vi.fn(),
        recordReleaseShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        binaryCommandClaim: createBinaryCommandClaim(),
        binaryCommandOwner: 'ordinary',
      }),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'ev_soc' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'binary',
      deviceId: 'charger-1',
      desired: false,
    }));
  });

  it('settles from observer OFF without dispatching against stale transport ON', async () => {
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'charger-1',
      name: 'Charger',
      controllable: false,
      available: true,
      binaryControl: { on: true },
      currentOn: true,
      targets: [],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        binaryControl: { on: false },
      }),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'turn_off' }),
      buildTargetExecutorContext: () => ({ actuator } as never),
      buildBinaryExecutorContext: () => ({ actuator } as never),
      buildSteppedExecutorContext: () => ({ actuator } as never),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'ev_soc' })).toEqual({ settled: true });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['temperature control loses its target capability', { action: 'set_temperature', temperature: 5 }],
    ['turn_off is configured for a stepped-only device', { action: 'turn_off' }],
  ] as const)('falls back to the preferred safe step when %s', async (_scenario, behavior) => {
    const state = createPlanEngineState();
    const requestSteppedLoadStep = vi.fn().mockResolvedValue({ requested: true, transport: 'capability' });
    let reportedStepId: string | undefined = undefined;
    const buildDevice = () => buildPlanInputDevice({
      id: 'heater-1',
      name: 'Stepped heater',
      controllable: false,
      available: true,
      controlModel: 'stepped_load',
      targets: [],
      reportedStepId,
      selectedStepId: 'high',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1_000 },
          { id: 'high', planningPowerW: 2_000 },
        ],
      },
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => behavior,
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({
        state,
        observation: {} as DeviceObservation,
        buildBinaryControlTransport: () => ({} as never),
        requestSteppedLoadStep,
        markSteppedLoadDesiredStepIssued: vi.fn(),
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        getRestoreLogSource: () => 'current_plan',
      }),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(requestSteppedLoadStep).not.toHaveBeenCalled();

    reportedStepId = 'high';
    expect(dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'heater-1',
      desiredStepId: 'low',
      previousStepId: 'high',
    }));
  });

  it('suppresses a second stepped fallback tick from decorated command pending while raw telemetry lags', async () => {
    const state = createPlanEngineState();
    let resolveStep: ((value: { requested: true; transport: 'native_capability' }) => void) | undefined;
    const requestSteppedLoadStep = vi.fn(() => new Promise<{
      requested: true; transport: 'native_capability';
    }>(
      (resolve) => { resolveStep = resolve; },
    ));
    let commandPending = false;
    const buildDevice = () => buildPlanInputDevice({
      id: 'heater-1',
      name: 'Stepped heater',
      controllable: false,
      controlModel: 'stepped_load',
      targets: [],
      reportedStepId: 'high',
      selectedStepId: 'high',
      desiredStepId: commandPending ? 'low' : undefined,
      previousStepId: 'high',
      stepCommandPending: commandPending,
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1_000 },
          { id: 'high', planningPowerW: 2_000 },
        ],
      },
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_step' }),
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({
        state,
        observation: {} as DeviceObservation,
        buildBinaryControlTransport: () => ({} as never),
        requestSteppedLoadStep,
        markSteppedLoadDesiredStepIssued: () => { commandPending = true; },
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        getRestoreLogSource: () => 'current_plan',
      }),
      recordReleaseShedActuation: vi.fn(),
    });

    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();

    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);
    resolveStep?.({ requested: true, transport: 'native_capability' });
    await flush();
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);
  });

  it('supersedes an opposing accepted step attempt with the reported step as command provenance', async () => {
    const state = createPlanEngineState();
    const marked = vi.fn();
    const requestSteppedLoadStep = vi.fn().mockResolvedValue({
      requested: true,
      transport: 'native_capability',
    });
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Stepped heater',
      controllable: false,
      controlModel: 'stepped_load',
      targets: [],
      reportedStepId: 'high',
      selectedStepId: 'high',
      desiredStepId: 'high',
      previousStepId: 'low',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
      stepCommandRetryCount: 2,
      nextStepCommandRetryAtMs: Date.now() + 60_000,
      steppedLoadProfile: {
        steps: [
          { id: 'low', planningPowerW: 1_000 },
          { id: 'high', planningPowerW: 2_000 },
        ],
      },
    });
    const request = resolveRequest({
      device: withLifecycleAxes(device),
      observedState: observedFromDevice(device),
      configuredFallback: { action: 'set_step' },
      nowMs: Date.now(),
    });
    expect(request).toMatchObject({
      kind: 'step_fallback',
      targetStepId: 'low',
      steppedLoad: {
        matchingCommandAttempt: null,
        stepCommandRetryCount: 2,
        nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
      },
    });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      targetCommandClaim: createTargetCommandClaim(),
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({} as never),
      buildSteppedExecutorContext: () => ({
        state,
        steppedCommandClaim: createSteppedCommandClaim(),
        steppedCommandOwner: 'ordinary',
        binaryCommandClaim: createBinaryCommandClaim(),
        binaryCommandOwner: 'ordinary',
        observation: {} as DeviceObservation,
        buildBinaryControlTransport: () => ({} as never),
        requestSteppedLoadStep,
        markSteppedLoadDesiredStepIssued: marked,
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        getRestoreLogSource: () => 'current_plan',
      }),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(request).not.toBeNull();
    expect(dispatcher.converge(request)).toEqual({ settled: false });
    await flush();

    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({
      desiredStepId: 'low',
      previousStepId: 'high',
    }));
    expect(marked).toHaveBeenCalledWith(expect.objectContaining({
      desiredStepId: 'low',
      previousStepId: 'high',
    }));
  });

  it.each([
    ['same', 'low'],
    ['opposing', 'off'],
  ] as const)('skips a %s ordinary step collision without replay', async (_kind, ordinaryStepId) => {
    const state = createPlanEngineState();
    const steppedCommandClaim = createSteppedCommandClaim();
    let resolveLifecycle: ((value: { requested: true; transport: 'capability' }) => void) | undefined;
    const requestSteppedLoadStep = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLifecycle = resolve; }))
      .mockResolvedValue({ requested: true, transport: 'capability' });
    const profile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1_000 },
        { id: 'high', planningPowerW: 2_000 },
      ],
    };
    const buildAction = (desiredStepId: string): ExecutableSteppedLoadDevice => ({
      id: 'heater-1',
      name: 'Stepped heater',
      purpose: 'shed',
      steppedLoadProfile: profile,
      plannedShedTarget: { kind: 'step', stepId: desiredStepId },
      current: { on: true, stepId: 'high', stepIsOffStep: false },
      desired: { on: true, stepId: desiredStepId },
      previousStepId: 'high',
      transition: null,
      stepActuation: {
        kind: 'none',
        requestedStepId: undefined,
        materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
      },
      commandStepActuation: {
        kind: 'none',
        requestedStepId: undefined,
        materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
      },
      matchingRestoreAttempt: null,
      matchingCommandAttempt: null,
      stepNeedsAdjustment: true,
      stepCommandRetryCount: 0,
    });
    const buildContext = (owner: 'lifecycle' | 'ordinary'): PlanExecutorSteppedContext => ({
      state,
      steppedCommandClaim,
      steppedCommandOwner: owner,
      binaryCommandClaim: createBinaryCommandClaim(),
      binaryCommandOwner: owner,
      observation: {} as DeviceObservation,
      buildBinaryControlTransport: () => ({} as never),
      requestSteppedLoadStep,
      markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
    });

    const lifecycle = applySteppedLoadCommand(buildContext('lifecycle'), buildAction('low'));
    expect(await applySteppedLoadCommand(
      buildContext('ordinary'),
      buildAction(ordinaryStepId),
    )).toBe(false);
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);

    resolveLifecycle?.({ requested: true, transport: 'capability' });
    await lifecycle;
    await flush();
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);

    expect(await applySteppedLoadCommand(
      buildContext('ordinary'),
      buildAction(ordinaryStepId),
    )).toBe(true);
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(2);
  });

  it('retains settled step authority until abandon permits an ordinary step', async () => {
    const state = createPlanEngineState();
    const profile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1_000 },
        { id: 'high', planningPowerW: 2_000 },
      ],
    };
    const device = buildPlanInputDevice({
      id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load',
      targets: [], reportedStepId: 'low', selectedStepId: 'low', steppedLoadProfile: profile,
    });
    const requestSteppedLoadStep = vi.fn().mockResolvedValue({ requested: true, transport: 'capability' });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_step' }),
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({
        state,
        observation: {} as DeviceObservation,
        buildBinaryControlTransport: () => ({} as never),
        requestSteppedLoadStep,
        markSteppedLoadDesiredStepIssued: vi.fn(),
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        getRestoreLogSource: () => 'current_plan',
      }),
      recordReleaseShedActuation: vi.fn(),
    });
    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: true });
    const ordinaryContext: PlanExecutorSteppedContext = {
      state,
      steppedCommandClaim: createSteppedCommandClaim(),
      steppedCommandOwner: 'ordinary',
      binaryCommandClaim: createBinaryCommandClaim(),
      binaryCommandOwner: 'ordinary',
      isLifecycleFallbackActive: (deviceId) => dispatcher.isActive(deviceId),
      observation: {} as DeviceObservation,
      buildBinaryControlTransport: () => ({} as never),
      requestSteppedLoadStep,
      markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
    };
    const action: ExecutableSteppedLoadDevice = {
      id: device.id, name: device.name, purpose: 'keep', steppedLoadProfile: profile,
      current: { on: true, stepId: 'low', stepIsOffStep: false },
      desired: { on: true, stepId: 'high' }, previousStepId: 'low', transition: null,
      stepActuation: { kind: 'none', requestedStepId: undefined, materialization: { kind: 'not_materialized', reason: 'no_requested_step' } },
      commandStepActuation: { kind: 'none', requestedStepId: undefined, materialization: { kind: 'not_materialized', reason: 'no_requested_step' } },
      matchingRestoreAttempt: null, matchingCommandAttempt: null, stepCommandRetryCount: 0,
      stepNeedsAdjustment: true,
    };
    expect(await applySteppedLoadCommand(ordinaryContext, action)).toBe(false);
    expect(requestSteppedLoadStep).not.toHaveBeenCalled();
    dispatcher.abandon(device.id);
    expect(await applySteppedLoadCommand(ordinaryContext, action)).toBe(true);
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);
  });

  // Two rows used to cover an "unsupported fallback" — a device with no writable
  // axis, which the resolver answered with `null` and the caller settled by
  // disarming the owner's task. That outcome is gone: such a device cannot reach
  // this seam, and the resolver now says so. See the assertion test below.
  // A third row covered a `set_temperature` carrying no temperature;
  // `ShedBehavior` is a discriminated union, so that state is not constructible.

  // A device with no writable axis cannot reach this seam: the lifecycle
  // emitter's device list is `planService.getPlanDevices()`. The resolver used
  // to answer `null` here, which the caller turned into `'unsupported'` and
  // answered by permanently disarming the owner's task, unlogged. It asserts
  // now, so the broken invariant surfaces instead of destroying configuration.
  // A device with no commandable axis is a real configuration — `getPlanDevices()`
  // filters on managed status, not on axis presence — so this must be a RESULT.
  // It may not throw: the caller loops over every task's diagnostic with no
  // per-device guard, so a throw would skip every later device in the tick. Nor
  // may it be a bare null, which is what used to become `'unsupported'` and
  // permanently disarmed the owner's task.
  it('reports a per-device result when the producer denies every write axis', () => {
    const device = {
      ...buildPlanInputDevice({
        id: 'heater-1',
        name: 'Heater',
        binaryControl: { on: true },
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      }),
      binaryWritable: false,
      targetWritable: false,
      stepWritable: false,
    };
    expect(resolveLifecycleFallbackRequest({
      device: withLifecycleAxes(device),
      observedState: observedFromDevice(device),
      configuredFallback: { action: 'set_temperature', temperature: 5 },
    })).toEqual({ state: 'no_writable_axis' });
  });

  it('reduces temperature-disabled fallback to the allowed binary axis', () => {
    const device = {
      ...buildPlanInputDevice({
        id: 'heater-1',
        name: 'Heater',
        binaryControl: { on: true },
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    expect(resolveRequest({
      device: withLifecycleAxes(device),
      observedState: observedFromDevice(device),
      configuredFallback: { action: 'set_temperature', temperature: 5 },
    })).toMatchObject({
      kind: 'binary_off',
    });
  });

  it('waits for a numeric target observation before dispatching fallback', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({
        state,
        targetCommandClaim: createTargetCommandClaim(),
        targetCommandOwner: 'ordinary',
        getObservedTemperatureValue: () => undefined,
        actuator,
        operatingMode: 'Home',
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        recordActivationAttemptStarted: vi.fn(),
      }),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();
  });

  it('claims the updated ordinary retry when the ordinary lane runs first at the due time', async () => {
    vi.useFakeTimers();
    const planState = createPlanEngineState();
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 5,
      nowMs: 1_000_000,
      observedValue: 21,
    });
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 5,
      nowMs: 1_030_001,
      observedValue: 21,
    });
    const dueAtMs = planState.pendingTargetCommands['heater-1']?.nextRetryAtMs ?? 0;
    vi.setSystemTime(dueAtMs);
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    function getLifecycleOwnedPendingTargetCommand(deviceId: string) {
      return dispatcher.getOwnedTargetPending(deviceId);
    }
    const targetCommandClaim = createTargetCommandClaim();
    const targetContext: PlanExecutorTargetContext = {
      state: planState,
        getObservedTemperatureValue: () => 21,
      getLifecycleOwnedPendingTargetCommand,
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => targetContext,
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });
    await dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      target: 'temperature',
      desired: 5,
      observedValue: 21,
      skipContext: 'plan',
    });
    expect(planState.pendingTargetCommands['heater-1']?.retryCount).toBe(2);
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();

    expect(actuator.apply).toHaveBeenCalledTimes(1);
    expect(planState.pendingTargetCommands['heater-1']).toBeUndefined();
    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[2] - 1);
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('blocks the ordinary lane when lifecycle claims the due retry first', async () => {
    vi.useFakeTimers();
    const planState = createPlanEngineState();
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 5,
      nowMs: 1_000_000,
      observedValue: 21,
    });
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 5,
      nowMs: 1_030_001,
      observedValue: 21,
    });
    const dueAtMs = planState.pendingTargetCommands['heater-1']?.nextRetryAtMs ?? 0;
    vi.setSystemTime(dueAtMs);
    const actuator = createTestActuator();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    function getLifecycleOwnedPendingTargetCommand(deviceId: string) {
      return dispatcher.getOwnedTargetPending(deviceId);
    }
    const targetCommandClaim = createTargetCommandClaim();
    const targetContext: PlanExecutorTargetContext = {
      state: planState,
        getObservedTemperatureValue: () => 21,
      getLifecycleOwnedPendingTargetCommand,
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => targetContext,
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      target: 'temperature',
      desired: 5,
      observedValue: 21,
      skipContext: 'plan',
    });
    await flush();

    expect(actuator.apply).toHaveBeenCalledTimes(1);
    expect(planState.pendingTargetCommands['heater-1']).toBeUndefined();
    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[2] - 1);
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('preserves an ordinary target retry across lifecycle handoff and plan pruning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const planState = createPlanEngineState();
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 5,
      nowMs: 1_000_000,
      observedValue: 21,
    });
    vi.setSystemTime(1_030_001);
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 5,
      nowMs: 1_030_001,
      observedValue: 21,
    });
    expect(planState.pendingTargetCommands['heater-1']?.retryCount).toBe(1);
    let observedValue = 21;
    const actuator = createTestActuator();
    const buildDevice = () => buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      targetCommandClaim: createTargetCommandClaim(),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ({
        state: planState,
        targetCommandClaim: createTargetCommandClaim(),
        targetCommandOwner: 'ordinary',
      getObservedTemperatureValue: () => observedValue,
        actuator,
        operatingMode: 'Home',
        recordShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        recordActivationAttemptStarted: vi.fn(),
      }),
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();

    prunePendingTargetCommandsForPlan({
      state: planState,
      plan: { devices: [], meta: buildPlanMeta({ totalKw: 0, softLimitKw: 10, headroomKw: 10}) },
    });
    vi.advanceTimersByTime(30_000);
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(90_001);
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    observedValue = 5;
    expect(dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' })).toEqual({ settled: true });
    observedValue = 21;
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('atomically claims an in-flight target write across lifecycle and ordinary clocks', async () => {
    const planState = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    let resolveActuator: ((value: { requested: true }) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((resolve) => { resolveActuator = resolve; }),
    );
    function getLifecycleOwnedPendingTargetCommand(deviceId: string) {
      return dispatcher.getOwnedTargetPending(deviceId);
    }
    const ordinaryContext: PlanExecutorTargetContext = {
      state: planState,
      getObservedTemperatureValue: () => 21,
      getLifecycleOwnedPendingTargetCommand,
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ordinaryContext,
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    const ordinaryResult = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      target: 'temperature',
      desired: 5,
      observedValue: 21,
      skipContext: 'plan',
    });

    expect(ordinaryResult).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    resolveActuator?.({ requested: true });
    await flush();
    expect(dispatcher.getOwnedTargetPending(device.id)).toMatchObject({
      target: 'temperature',
      desired: 5,
    });
    expect(planState.pendingTargetCommands[device.id]).toBeUndefined();
  });

  it('drops an opposing ordinary target until abandon permits a fresh decision', async () => {
    const planState = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    const device = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: 18, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    let resolveLifecycle: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveLifecycle = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    function getLifecycleOwnedPendingTargetCommand(deviceId: string) {
      return dispatcher.getOwnedTargetPending(deviceId);
    }
    const ordinaryContext: PlanExecutorTargetContext = {
      state: planState,
      getObservedTemperatureValue: () => 18,
      getLifecycleOwnedPendingTargetCommand,
      isLifecycleFallbackActive: (deviceId) => dispatcher.isActive(deviceId),
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      targetCommandClaim,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ordinaryContext,
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });

    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    const ordinary = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      target: 'temperature',
      desired: 21,
      observedValue: 18,
      skipContext: 'plan',
    });

    expect(ordinary).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    // A repeated lifecycle tick does not capture or displace the ordinary plan.
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    resolveLifecycle?.({ requested: true });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    const stillOwned = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      target: 'temperature',
      desired: 21,
      observedValue: 18,
      skipContext: 'plan',
    });
    expect(stillOwned).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    dispatcher.abandon(device.id);
    const freshOrdinary = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      target: 'temperature',
      desired: 21,
      observedValue: 18,
      skipContext: 'plan',
    });
    expect(freshOrdinary).toMatchObject({ applied: true });
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'target',
      value: 21,
    }));
  });

  it('retires opposing ordinary target pending before lifecycle handoff and abandon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const planState = createPlanEngineState();
    recordPendingTargetCommandAttempt({
      state: planState,
      deviceId: 'heater-1',
      target: 'temperature',
      desired: 20,
      nowMs: Date.now(),
      observedValue: 5,
    });
    let observedValue = 20;
    const actuator = createTestActuator();
    const targetCommandClaim = createTargetCommandClaim();
    function getLifecycleOwnedPendingTargetCommand(deviceId: string) {
      return dispatcher.getOwnedTargetPending(deviceId);
    }
    const targetContext: PlanExecutorTargetContext = {
      state: planState,
      getObservedTemperatureValue: () => observedValue,
      getLifecycleOwnedPendingTargetCommand,
      isLifecycleFallbackActive: (deviceId) => dispatcher.isActive(deviceId),
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const buildObserved = () => buildExecutableObservedDeviceState(buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    }));
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      targetCommandClaim,
      buildTargetExecutorContext: () => targetContext,
      buildBinaryExecutorContext: () => ({} as never),
      buildSteppedExecutorContext: () => ({} as never),
      recordReleaseShedActuation: vi.fn(),
      refreshObserved: buildObserved,
    });

    expect(dispatcher.converge({
      kind: 'target_fallback',
      observed: buildObserved(),
      desired: 5,
    })).toEqual({ settled: false });
    await flush();
    expect(planState.pendingTargetCommands['heater-1']).toBeUndefined();
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'target', value: 5 }));

    observedValue = 5;
    expect(dispatcher.converge({
      kind: 'target_fallback',
      observed: buildObserved(),
      desired: 5,
    })).toEqual({ settled: true });
    dispatcher.abandon('heater-1');

    expect(await dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      target: 'temperature',
      desired: 20,
      observedValue,
      skipContext: 'plan',
    })).toMatchObject({ applied: true, attemptType: 'send' });
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'target', value: 20 }));
    vi.useRealTimers();
  });

  it('retains settled target authority until abandon permits an ordinary command', async () => {
    const planState = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    const actuator = createTestActuator();
    let observedValue = 21;
    const buildDevice = () => buildPlanInputDevice({
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    function getLifecycleOwnedPendingTargetCommand(deviceId: string) {
      return dispatcher.getOwnedTargetPending(deviceId);
    }
    const ordinaryContext: PlanExecutorTargetContext = {
      state: planState,
      getObservedTemperatureValue: () => observedValue,
      getLifecycleOwnedPendingTargetCommand,
      isLifecycleFallbackActive: (deviceId) => dispatcher.isActive(deviceId),
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      getDevice: buildDevice,
      getObservedState: () => observedFromDevice(buildDevice()),
      targetCommandClaim,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
      buildTargetExecutorContext: () => ordinaryContext,
      buildBinaryExecutorContext: () => ({} as PlanExecutorBinaryContext),
      buildSteppedExecutorContext: () => ({} as PlanExecutorSteppedContext),
      recordReleaseShedActuation: vi.fn(),
    });
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    observedValue = 5;
    expect(dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' })).toEqual({ settled: true });
    const blocked = await dispatchTargetCommand(ordinaryContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      target: 'temperature',
      desired: 21,
      observedValue: 5,
      skipContext: 'plan',
    });
    expect(blocked).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    dispatcher.abandon('heater-1');
    expect(dispatcher.getOwnedTargetPending('heater-1')).toBeUndefined();
    const ordinaryResult = await dispatchTargetCommand(ordinaryContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      target: 'temperature',
      desired: 21,
      observedValue: 5,
      skipContext: 'plan',
    });

    expect(ordinaryResult).toMatchObject({ applied: true });
    expect(actuator.apply).toHaveBeenCalledTimes(2);
  });

  it('retains settled binary authority until explicit abandon releases an ordinary restore', async () => {
    const state = createPlanEngineState();
    state.markDeviceShed('charger-1', Date.now());
    const snapshot = {
      ...buildPlanInputDevice({
        id: 'charger-1',
        name: 'Charger',
        controllable: false,
        available: true,
        binaryControl: { on: false },
        currentOn: false,
        targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot],
      getSnapshotByDeviceId: () => snapshot,
    } as unknown as DeviceObservation;
    const actuator = createTestActuator();
    const binaryCommandClaim = createBinaryCommandClaim();
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      buildTargetExecutorContext: () => ({} as never),
      buildSteppedExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: buildBinaryContext,
      targetCommandClaim: createTargetCommandClaim(),
      recordReleaseShedActuation: vi.fn(),
    });
    function buildBinaryContext(): PlanExecutorBinaryContext {
      return {
      state,
      observation,
      capacityDryRun: false,
      buildBinaryControlTransport: () => ({
        observation,
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        actuator,
      }),
      getRestoreLogSource: () => 'shed_state',
      recordShedActuation: vi.fn(),
      recordReleaseShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      binaryCommandClaim,
      binaryCommandOwner: 'ordinary',
      isLifecycleFallbackActive: (deviceId) => dispatcher.isActive(deviceId),
      };
    }
    const request = resolveRequest({
      device: withLifecycleAxes(snapshot),
      observedState: { ...observedFromDevice(snapshot), binaryControl: { on: false } },
      configuredFallback: { action: 'turn_off' },
    });
    expect(request).not.toBeNull();
    expect(dispatcher.converge(request)).toEqual({ settled: true });
    expect(dispatcher.isActive(snapshot.id)).toBe(true);

    expect(await applyDeferredBinaryCommand(buildBinaryContext(), {
      kind: 'binary_restore', deviceId: snapshot.id, name: snapshot.name,
    }, request.observed)).toBe(false);
    expect(actuator.apply).not.toHaveBeenCalled();

    dispatcher.abandon(snapshot.id);
    expect(await applyDeferredBinaryCommand(buildBinaryContext(), {
      kind: 'binary_restore', deviceId: snapshot.id, name: snapshot.name,
    }, request.observed)).toBe(true);
    expect(actuator.apply).toHaveBeenCalledWith(expect.objectContaining({ desired: true }));
  });

  it.each([true, false])('skips a %s binary collision and never replays it', async (ordinaryDesired) => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildPlanInputDevice({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    } as unknown as DeviceObservation;
    let resolveWrite: ((value: { requested: true }) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((resolve) => { resolveWrite = resolve; }),
    );
    const binaryCommandClaim = createBinaryCommandClaim();
    const buildContext = (owner: 'lifecycle' | 'ordinary'): PlanExecutorBinaryContext => ({
      state,
      observation,
      capacityDryRun: false,
      buildBinaryControlTransport: () => ({
        observation,
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        actuator,
      }),
      getRestoreLogSource: () => 'current_plan',
      recordShedActuation: vi.fn(),
      recordReleaseShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      binaryCommandClaim,
      binaryCommandOwner: owner,
    });
    const lifecycle = runBinaryControl({
      ctx: buildContext('lifecycle'), deviceId: snapshot.id, name: snapshot.name,
      desired: false, snapshot, logContext: 'capacity', lifecycleRelease: true,
    });
    expect(await runBinaryControl({
      ctx: buildContext('ordinary'), deviceId: snapshot.id, name: snapshot.name,
      desired: ordinaryDesired, snapshot, logContext: 'capacity',
    })).toEqual({ applied: false });
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    resolveWrite?.({ requested: true });
    await lifecycle;
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);
  });

  it('supersedes an opposing binary pending entry when lifecycle takes authority', async () => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildPlanInputDevice({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    } as unknown as DeviceObservation;
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    store.record(snapshot.id, {
      desired: true, startedMs: Date.now(), pendingMs: 90_000,
    });
    const actuator = createTestActuator();
    const ctx: PlanExecutorBinaryContext = {
      state,
      observation,
      capacityDryRun: false,
      buildBinaryControlTransport: () => ({ observation, pendingBinaryCommandStore: store, actuator }),
      getRestoreLogSource: () => 'current_plan',
      recordShedActuation: vi.fn(),
      recordReleaseShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      binaryCommandClaim: createBinaryCommandClaim(),
      binaryCommandOwner: 'lifecycle',
    };
    expect(await runBinaryControl({
      ctx, deviceId: snapshot.id, name: snapshot.name, desired: false, snapshot,
      logContext: 'capacity', lifecycleRelease: true,
    })).toEqual({ applied: true });
    expect(store.peek(snapshot.id)).toMatchObject({ desired: false, lifecycleRelease: true });
  });

  it('drops binary pending bookkeeping when lifecycle authority ends during the write', async () => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildPlanInputDevice({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    } as unknown as DeviceObservation;
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    let current = true;
    let resolveWrite: ((value: { requested: true }) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((resolve) => { resolveWrite = resolve; }),
    );
    const ctx: PlanExecutorBinaryContext = {
      state,
      observation,
      capacityDryRun: false,
      buildBinaryControlTransport: () => ({ observation, pendingBinaryCommandStore: store, actuator }),
      getRestoreLogSource: () => 'current_plan',
      recordShedActuation: vi.fn(), recordReleaseShedActuation: vi.fn(), recordRestoreActuation: vi.fn(),
      binaryCommandClaim: createBinaryCommandClaim(), binaryCommandOwner: 'lifecycle',
      isBinaryCommandAuthorityCurrent: () => current,
    };
    const result = runBinaryControl({
      ctx, deviceId: snapshot.id, name: snapshot.name, desired: false, snapshot,
      logContext: 'capacity', lifecycleRelease: true,
    });
    expect(store.peek(snapshot.id)).toMatchObject({ desired: false });
    current = false;
    resolveWrite?.({ requested: true });
    expect(await result).toEqual({ applied: false });
    expect(store.peek(snapshot.id)).toBeUndefined();
  });

  // Same abandonment, but the write times out instead of resolving. An unknown
  // outcome normally keeps its pending record — except when authority is gone,
  // because the command that superseded this one owns the entry now. Accepting
  // here would flip a record we no longer own and fire its deferred confirm
  // against a stale desired value.
  it('drops binary pending bookkeeping when lifecycle authority ends and the write times out', async () => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildPlanInputDevice({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    } as unknown as DeviceObservation;
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    let current = true;
    let rejectWrite: ((reason: unknown) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((_resolve, reject) => { rejectWrite = reject; }),
    );
    const ctx: PlanExecutorBinaryContext = {
      state,
      observation,
      capacityDryRun: false,
      buildBinaryControlTransport: () => ({ observation, pendingBinaryCommandStore: store, actuator }),
      getRestoreLogSource: () => 'current_plan',
      recordShedActuation: vi.fn(), recordReleaseShedActuation: vi.fn(), recordRestoreActuation: vi.fn(),
      binaryCommandClaim: createBinaryCommandClaim(), binaryCommandOwner: 'lifecycle',
      isBinaryCommandAuthorityCurrent: () => current,
    };
    const result = runBinaryControl({
      ctx, deviceId: snapshot.id, name: snapshot.name, desired: false, snapshot,
      logContext: 'capacity', lifecycleRelease: true,
    });
    expect(store.peek(snapshot.id)).toMatchObject({ desired: false });
    current = false;
    rejectWrite?.(new HomeyRequestTimeoutError('PUT', '/api/manager/devices/device/heater-1/capability/onoff'));
    expect(await result).toEqual({ applied: false });
    expect(store.peek(snapshot.id)).toBeUndefined();
  });

  it.each([false, true])(
    'retries binary fallback immediately after an ordinary claim releases (abandon=%s)',
    async (abandon) => {
      const state = createPlanEngineState();
      let observedOn = false;
      const buildSnapshot = () => buildPlanInputDevice({
        id: 'heater-1', name: 'Heater', binaryControl: { on: observedOn }, currentOn: observedOn, targets: [],
      });
      const snapshot = buildSnapshot();
      const observation = {
        getSnapshot: () => [buildSnapshot()], getSnapshotByDeviceId: () => buildSnapshot(),
      } as unknown as DeviceObservation;
      let resolveOrdinary: ((value: { requested: true }) => void) | undefined;
      const actuatorImplementation = vi.fn()
        .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveOrdinary = resolve; }))
        .mockResolvedValue({ requested: true });
      const actuator = createTestActuator(actuatorImplementation);
      const binaryCommandClaim = createBinaryCommandClaim();
      let lastRefreshedObserved: ReturnType<typeof buildExecutableObservedDeviceState> | undefined;
      const buildBinaryContext = (): PlanExecutorBinaryContext => ({
        state,
        observation,
        capacityDryRun: false,
        buildBinaryControlTransport: () => ({
          observation,
          pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
          actuator,
        }),
        getRestoreLogSource: () => 'current_plan',
        recordShedActuation: vi.fn(),
        recordReleaseShedActuation: vi.fn(),
        recordRestoreActuation: vi.fn(),
        binaryCommandClaim,
        binaryCommandOwner: 'ordinary',
      });
      const dispatcher = new ExecutorLifecycleFallbackDispatcher({
        capacityDryRun: () => false,
        targetCommandClaim: createTargetCommandClaim(),
        buildTargetExecutorContext: () => ({} as never),
        buildSteppedExecutorContext: () => ({} as never),
        buildBinaryExecutorContext: buildBinaryContext,
        recordReleaseShedActuation: vi.fn(),
        refreshObserved: () => {
          lastRefreshedObserved = buildExecutableObservedDeviceState(buildSnapshot());
          return lastRefreshedObserved;
        },
      });
      const ordinary = runBinaryControl({
        ctx: buildBinaryContext(), deviceId: snapshot.id, name: snapshot.name,
        desired: true, snapshot, logContext: 'capacity',
      });
      const request = resolveRequest({
        device: withLifecycleAxes({ ...snapshot, binaryWritable: true }),
        observedState: { ...observedFromDevice(snapshot), binaryControl: { on: false } },
        configuredFallback: { action: 'turn_off' },
      });
      expect(dispatcher.converge(request)).toEqual({ settled: false });
      if (abandon) dispatcher.abandon(snapshot.id);
      expect(actuator.apply).toHaveBeenCalledTimes(1);

      resolveOrdinary?.({ requested: true });
      await ordinary;
      await flush();
      expect(actuator.apply).toHaveBeenCalledTimes(abandon ? 1 : 2);
      if (!abandon) {
        expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ desired: false }));
        expect(lastRefreshedObserved).toMatchObject({
          observedBinaryState: 'off',
          binaryControl: { on: false },
          snapshot: { binaryControl: { on: false } },
        });
        observedOn = true;
        expect(dispatcher.converge({ ...request, observed: buildExecutableObservedDeviceState(buildSnapshot()) }))
          .toEqual({ settled: false });
        observedOn = false;
        expect(dispatcher.converge({ ...request, observed: buildExecutableObservedDeviceState(buildSnapshot()) }))
          .toEqual({ settled: true });
      }
    },
  );

  it('corrects a laggy ordinary stepped binary restore when its shared claim releases', async () => {
    const state = createPlanEngineState();
    const profile = { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }] };
    const observedOn = false;
    const buildSnapshot = () => ({
      ...buildPlanInputDevice({
        id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load',
        binaryControl: { on: observedOn }, currentOn: observedOn, targets: [],
        reportedStepId: 'low', selectedStepId: 'low', steppedLoadProfile: profile,
      }),
      binaryWritable: true,
    });
    const observation = {
      getSnapshot: () => [buildSnapshot()], getSnapshotByDeviceId: () => buildSnapshot(),
    } as unknown as DeviceObservation;
    let resolveOrdinary: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveOrdinary = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    const binaryCommandClaim = createBinaryCommandClaim();
    const binaryContext: PlanExecutorBinaryContext = {
      state, observation, capacityDryRun: false,
      buildBinaryControlTransport: () => ({
        observation,
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        actuator,
      }),
      getRestoreLogSource: () => 'current_plan',
      recordShedActuation: vi.fn(), recordReleaseShedActuation: vi.fn(), recordRestoreActuation: vi.fn(),
      binaryCommandClaim, binaryCommandOwner: 'ordinary',
    };
    const steppedContext: PlanExecutorSteppedContext = {
      state, observation, binaryCommandClaim, binaryCommandOwner: 'ordinary',
      steppedCommandClaim: createSteppedCommandClaim(), steppedCommandOwner: 'ordinary',
      buildBinaryControlTransport: binaryContext.buildBinaryControlTransport,
      requestSteppedLoadStep: vi.fn(), markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(), recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
    };
    const action: ExecutableSteppedLoadDevice = {
      id: 'heater-1', name: 'Stepped heater', purpose: 'keep', steppedLoadProfile: profile,
      current: { on: false, stepId: 'low', stepIsOffStep: false },
      desired: { on: true, stepId: 'low' }, previousStepId: 'low', transition: null,
      stepActuation: { kind: 'none', requestedStepId: undefined, materialization: { kind: 'not_materialized', reason: 'no_requested_step' } },
      commandStepActuation: { kind: 'none', requestedStepId: undefined, materialization: { kind: 'not_materialized', reason: 'no_requested_step' } },
      matchingRestoreAttempt: null, matchingCommandAttempt: null, stepNeedsAdjustment: false,
      stepCommandRetryCount: 0,
    };
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      targetCommandClaim: createTargetCommandClaim(),
      buildTargetExecutorContext: () => ({} as never),
      buildSteppedExecutorContext: () => steppedContext,
      buildBinaryExecutorContext: () => binaryContext,
      recordReleaseShedActuation: vi.fn(),
      refreshObserved: () => buildExecutableObservedDeviceState(buildSnapshot()),
    });

    const ordinary = executeSteppedLoadRestoreBinary(steppedContext, {
      action, snapshot: buildSnapshot(), name: action.name,
    });
    const request: LifecycleFallbackRequest = {
      kind: 'binary_off', observed: buildExecutableObservedDeviceState(buildSnapshot()),
    };
    expect(dispatcher.converge(request)).toEqual({ settled: false });
    resolveOrdinary?.({ requested: true });
    await ordinary;
    await flush();

    expect(actuator.apply).toHaveBeenCalledTimes(2);
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'binary', desired: false }));
  });

  it('makes an ordinary stepped binary shed wait for a lifecycle binary claim', async () => {
    const state = createPlanEngineState();
    const profile = { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }] };
    let observedOn = false;
    const buildSnapshot = () => buildPlanInputDevice({
      id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load',
        binaryControl: { on: observedOn }, currentOn: observedOn, targets: [],
      reportedStepId: 'low', selectedStepId: 'low', steppedLoadProfile: profile,
    });
    const observation = {
      getSnapshot: () => [buildSnapshot()], getSnapshotByDeviceId: () => buildSnapshot(),
    } as unknown as DeviceObservation;
    let resolveLifecycle: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveLifecycle = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    const binaryCommandClaim = createBinaryCommandClaim();
    const transport = () => ({
      observation,
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      actuator,
    });
    const lifecycleWrite = runBinaryControl({
      ctx: { buildBinaryControlTransport: transport, binaryCommandClaim, binaryCommandOwner: 'lifecycle' },
      deviceId: 'heater-1', name: 'Stepped heater', desired: true,
      snapshot: buildSnapshot(), logContext: 'capacity', lifecycleRelease: true,
    });
    observedOn = true;
    const action: ExecutableSteppedLoadDevice = {
      id: 'heater-1', name: 'Stepped heater', purpose: 'shed', steppedLoadProfile: profile,
      plannedShedTarget: { kind: 'binary_off' }, current: { on: true, stepId: 'low', stepIsOffStep: false },
      desired: { on: false, stepId: 'off' }, previousStepId: 'low', transition: null,
      stepActuation: { kind: 'none', requestedStepId: undefined, materialization: { kind: 'not_materialized', reason: 'no_requested_step' } },
      commandStepActuation: { kind: 'none', requestedStepId: undefined, materialization: { kind: 'not_materialized', reason: 'no_requested_step' } },
      matchingRestoreAttempt: null, matchingCommandAttempt: null, stepNeedsAdjustment: false,
      stepCommandRetryCount: 0,
    };
    const steppedContext: PlanExecutorSteppedContext = {
      state, observation, binaryCommandClaim, binaryCommandOwner: 'ordinary',
      steppedCommandClaim: createSteppedCommandClaim(), steppedCommandOwner: 'ordinary',
      buildBinaryControlTransport: transport,
      requestSteppedLoadStep: vi.fn(), markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(), recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
    };

    expect(await applySteppedLoadShedOff(steppedContext, action, buildSnapshot())).toBe(false);
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    resolveLifecycle?.({ requested: true });
    await lifecycleWrite;
    expect(await applySteppedLoadShedOff(steppedContext, action, buildSnapshot())).toBe(true);
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'binary', desired: false }));
  });

  it('retries target fallback immediately after an opposing ordinary claim releases', async () => {
    const state = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    let observedValue = 5;
    let lifecyclePendingObservedValue: unknown;
    const buildDevice = () => buildPlanInputDevice({
      id: 'heater-1', name: 'Heater',
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C' }],
    });
    const device = buildDevice();
    let resolveOrdinary: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveOrdinary = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    const targetContext: PlanExecutorTargetContext = {
      state,
      getObservedTemperatureValue: () => observedValue,
      targetCommandClaim,
      targetCommandOwner: 'ordinary',
      actuator,
      operatingMode: 'Home',
      recordShedActuation: vi.fn(),
      recordRestoreActuation: vi.fn(),
      recordActivationAttemptStarted: vi.fn(),
    };
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      targetCommandClaim,
      buildTargetExecutorContext: () => targetContext,
      buildBinaryExecutorContext: () => ({} as never),
      buildSteppedExecutorContext: () => ({} as never),
      recordReleaseShedActuation: vi.fn(),
      refreshObserved: () => buildExecutableObservedDeviceState(buildDevice()),
    });
    targetContext.syncLivePlanStateAfterTargetActuation = () => {
      const pendingObservedValue = dispatcher.getOwnedTargetPending('heater-1')?.lastObservedValue;
      if (pendingObservedValue !== undefined) lifecyclePendingObservedValue = pendingObservedValue;
    };
    const ordinary = dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1', name: 'Heater', target: 'temperature',
      desired: 20, observedValue: 5, skipContext: 'plan',
    });
    expect(dispatcher.converge({
      kind: 'target_fallback', desired: 5,
      observed: buildExecutableObservedDeviceState(device),
    })).toEqual({ settled: false });
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    resolveOrdinary?.({ requested: true });
    await ordinary;
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'target', value: 5 }));
    expect(lifecyclePendingObservedValue).toBe(5);
    expect(buildExecutableObservedDeviceState(buildDevice()).target?.observedValue).toBe(5);
    observedValue = 20;
    expect(dispatcher.converge({
      kind: 'target_fallback', desired: 5,
      observed: buildExecutableObservedDeviceState(buildDevice()),
    })).toEqual({ settled: false });
    observedValue = 5;
    expect(dispatcher.converge({
      kind: 'target_fallback', desired: 5,
      observed: buildExecutableObservedDeviceState(buildDevice()),
    })).toEqual({ settled: true });
  });

  it('retries step fallback immediately after an opposing ordinary claim releases', async () => {
    const state = createPlanEngineState();
    const steppedCommandClaim = createSteppedCommandClaim();
    let resolveOrdinary: ((value: { requested: true; transport: 'capability' }) => void) | undefined;
    const requestSteppedLoadStep = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOrdinary = resolve; }))
      .mockResolvedValue({ requested: true, transport: 'capability' });
    const profile = {
      steps: [
        { id: 'low', planningPowerW: 1_000 },
        { id: 'high', planningPowerW: 2_000 },
      ],
    };
    const action: ExecutableSteppedLoadDevice = {
      id: 'heater-1', name: 'Heater', purpose: 'shed', steppedLoadProfile: profile,
      plannedShedTarget: { kind: 'step', stepId: 'high' },
      current: { on: true, stepId: 'low', stepIsOffStep: false },
      desired: { on: true, stepId: 'high' }, previousStepId: 'low', transition: null,
      stepActuation: {
        kind: 'none', requestedStepId: undefined,
        materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
      },
      commandStepActuation: {
        kind: 'none', requestedStepId: undefined,
        materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
      },
      matchingRestoreAttempt: null, matchingCommandAttempt: null,
      stepNeedsAdjustment: true, stepCommandRetryCount: 0,
    };
    let observedStepId = 'low';
    const buildObservedDevice = () => buildPlanInputDevice({
      id: 'heater-1', name: 'Heater', controlModel: 'stepped_load', targets: [],
      binaryControl: undefined,
      reportedStepId: observedStepId, selectedStepId: observedStepId, steppedLoadProfile: profile,
    });
    const observedDevice = buildObservedDevice();
    const steppedContext: PlanExecutorSteppedContext = {
      state,
      steppedCommandClaim,
      steppedCommandOwner: 'ordinary',
      binaryCommandClaim: createBinaryCommandClaim(),
      binaryCommandOwner: 'ordinary',
      observation: {} as DeviceObservation,
      buildBinaryControlTransport: () => ({} as never),
      requestSteppedLoadStep,
      markSteppedLoadDesiredStepIssued: vi.fn(),
      recordShedActuation: vi.fn(), recordRestoreActuation: vi.fn(),
      getRestoreLogSource: () => 'current_plan',
    };
    const dispatcher = new ExecutorLifecycleFallbackDispatcher({
      capacityDryRun: () => false,
      targetCommandClaim: createTargetCommandClaim(),
      buildTargetExecutorContext: () => ({} as never),
      buildBinaryExecutorContext: () => ({} as never),
      buildSteppedExecutorContext: () => steppedContext,
      recordReleaseShedActuation: vi.fn(),
      refreshObserved: () => buildExecutableObservedDeviceState(buildObservedDevice()),
    });
    const ordinary = applySteppedLoadCommand(steppedContext, action);
    expect(dispatcher.converge({
      kind: 'step_fallback', targetStepId: 'low',
      observed: buildExecutableObservedDeviceState(observedDevice),
      steppedLoad: {
        id: action.id,
        name: action.name,
        purpose: 'shed',
        steppedLoadProfile: profile,
        desired: { on: true, stepId: 'low' },
        transition: null,
        matchingRestoreAttempt: null,
        matchingCommandAttempt: null,
        stepCommandRetryCount: 0,
      },
    })).toEqual({ settled: false });
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(1);

    resolveOrdinary?.({ requested: true, transport: 'capability' });
    await ordinary;
    await flush();
    expect(requestSteppedLoadStep).toHaveBeenCalledTimes(2);
    expect(requestSteppedLoadStep).toHaveBeenLastCalledWith(expect.objectContaining({
      desiredStepId: 'low',
      previousStepId: 'low',
    }));
    expect(buildExecutableObservedDeviceState(buildObservedDevice()).steppedLoad).toMatchObject({
      stepId: 'low',
      reportedStepId: 'low',
    });
    observedStepId = 'high';
    expect(dispatcher.converge({
      kind: 'step_fallback', targetStepId: 'low',
      observed: buildExecutableObservedDeviceState(buildObservedDevice()),
      steppedLoad: {
        id: action.id, name: action.name, purpose: 'shed', steppedLoadProfile: profile,
        desired: { on: true, stepId: 'low' }, transition: null,
        matchingRestoreAttempt: null, matchingCommandAttempt: null, stepCommandRetryCount: 0,
      },
    })).toEqual({ settled: false });
    observedStepId = 'low';
    expect(dispatcher.converge({
      kind: 'step_fallback', targetStepId: 'low',
      observed: buildExecutableObservedDeviceState(buildObservedDevice()),
      steppedLoad: {
        id: action.id, name: action.name, purpose: 'shed', steppedLoadProfile: profile,
        desired: { on: true, stepId: 'low' }, transition: null,
        matchingRestoreAttempt: null, matchingCommandAttempt: null, stepCommandRetryCount: 0,
      },
    })).toEqual({ settled: true });
  });
});
