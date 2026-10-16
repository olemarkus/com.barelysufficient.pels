import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  LifecycleFallbackDispatcher as ExecutorLifecycleFallbackDispatcher,
  type LifecycleFallbackDevice,
  type LifecycleFallbackObservedState,
  type LifecycleFallbackRequest,
} from '../../lib/executor/lifecycleFallbackDispatcher';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { prunePendingTargetCommandsForPlan } from '../../lib/plan/planTargetControl';
import { recordTargetCommandAttempt } from '../../lib/executor/targetCommandRetry';
import { applyDeferredBinaryCommand } from '../../lib/executor/binaryExecutor';
import { runBinaryControl } from '../../lib/executor/binaryControlShared';
import {
  applySteppedLoadCommand,
  applySteppedLoadShedOff,
} from '../../lib/executor/steppedLoadExecutor';
import { executeSteppedLoadRestoreBinary } from '../../lib/executor/steppedLoadExecutorRestore';
import type { ExecutableSteppedLoadDevice } from '../../lib/executor/executablePlan';
import type { DesiredBinaryKind } from '../../lib/executor/executableDesiredState';
import { buildExecutableObservedDeviceState } from '../../lib/executor/executablePlanProjection';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { dispatchTargetCommand } from '../../lib/executor/targetExecutor';
import type { ExecutorCommandContext, LifecycleFallbackView } from '../../lib/executor/executorCommandContext';
import type { ExecutorDeviceRead } from '../../lib/executor/executorDeviceRead';
import { TARGET_COMMAND_RETRY_DELAYS_MS } from '../../lib/executor/commandRetrySchedule';
import { createTargetCommandClaim } from '../../lib/executor/targetCommandClaim';
import { createSteppedCommandClaim } from '../../lib/executor/steppedCommandClaim';
import { createBinaryCommandClaim } from '../../lib/executor/binaryCommandClaim';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { createTestExecutorCommandContext } from '../helpers/executorCommandContext';
import { noStorageTransport } from '../helpers/storageTransportStub';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { resolveLifecycleFallbackRequest } from '../../setup/lifecycleFallbackRequest';
import type { ShedBehavior } from '../../lib/plan/planTypes';
import { projectLifecycleFallbackDevice } from '../../lib/planInput/lifecycleFallbackDeviceProjection';
import type { PlanInputSnapshotDevice } from '../../lib/planInput/runtimeDeviceRead';

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
import type { ActuatorTransport, DeviceCommand } from '../../lib/actuator/deviceCommand';
import { buildPlanInputDevice, buildPlanMeta } from '../utils/planTestUtils';
import { captureLogger } from '../utils/loggerCapture';

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
type TestDispatcherDeps = {
  /** The ordinary lane's context; the dispatcher spreads it as its own lane. */
  ctx: ExecutorCommandContext;
  getDevice: () => LegacyLifecycleFallbackDevice;
  getObservedState: () => LifecycleFallbackObservedState;
  getShedBehavior: (deviceId: string) => ShedBehavior;
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
      ? { state: 'writable' }
      : { state: 'unavailable' },
    stepAxis: candidate.stepWritable !== false && candidate.steppedLoadProfile
      ? { state: 'writable', profile: candidate.steppedLoadProfile }
      : { state: 'unavailable' },
  };
};

class LifecycleFallbackDispatcher {
  private readonly delegate: ExecutorLifecycleFallbackDispatcher;

  public constructor(private readonly deps: TestDispatcherDeps) {
    this.delegate = new ExecutorLifecycleFallbackDispatcher(deps.ctx);
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
    canTurnOnDevice: () => true,
    resolveTemperatureTarget: (_deviceId, desired) => desired,
  };
};

/** An actuator that hands step writes to `requestSteppedLoadStep`, as transport does. */
const stepActuator = (
  requestSteppedLoadStep: ActuatorTransport['requestSteppedLoadStep'],
): Actuator => createDeviceActuator({
  canTurnOnDevice: () => true,
  resolveTemperatureTarget: (_deviceId, desired) => desired,
  requestBinaryControl: async () => undefined,
  requestTemperatureTarget: async (_deviceId, desired) => desired,
  requestSteppedLoadStep,
  ...noStorageTransport,
});

/** An observer that reports only the device's setpoint. */
const observedSetpoint = (
  value: () => number | undefined,
): ExecutorCommandContext['getObservedState'] => (deviceId) => ({
  id: deviceId,
  name: deviceId,
  available: true,
  targets: [{ id: 'target_temperature', value: value(), unit: 'C' }],
});

/**
 * The ordinary lane's view of a dispatcher built after its context: resolved
 * on each call, exactly as `PlanExecutor` wires it.
 */
const lifecycleView = (
  dispatcher: () => Pick<LifecycleFallbackDispatcher, 'getOwnedTargetPending' | 'isActive'>,
): LifecycleFallbackView => ({
  isActive: (deviceId) => dispatcher().isActive(deviceId),
  getOwnedTargetPending: (deviceId) => dispatcher().getOwnedTargetPending(deviceId),
});

/** The stepped device a lane commands this cycle, with no step materialized yet. */
const steppedAction = (
  intent: ExecutableSteppedLoadDevice['intent'] & DesiredBinaryKind,
  current: ExecutableSteppedLoadDevice['current'],
  stepNeedsAdjustment: boolean,
): ExecutableSteppedLoadDevice => ({
  intent,
  current,
  stepActuation: {
    kind: 'none',
    requestedStepId: undefined,
    materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
  },
  stepNeedsAdjustment,
});

/**
 * A device SNAPSHOT for the dispatcher, built from the shared plan-input fixture.
 *
 * `buildPlanInputDevice` emits what `toPlanDevice` emits — the producer-resolved
 * `currentOn`, with the RAW `binaryControl` stripped, because that axis stays
 * observer-internal on a plan device. Every seam in this suite
 * (`buildExecutableObservedDeviceState`, `readDevice`)
 * reads a snapshot, and a snapshot DOES carry the raw axis — so re-attach the one
 * the producer resolved rather than letting the fixture ship a plan device where a
 * snapshot belongs.
 *
 * A fixture with NO binary axis says so with `binaryControllable: false`; it then
 * carries neither `currentOn` nor `binaryControl`, exactly as the producer emits a
 * stepped-only or target-only device.
 */
const buildLifecycleSnapshot = (
  overrides: Parameters<typeof buildPlanInputDevice>[0],
): ReturnType<typeof buildPlanInputDevice> & { binaryControl?: { on: boolean } } => {
  const device = buildPlanInputDevice(overrides);
  const { currentOn } = device as { currentOn?: boolean };
  if (typeof currentOn !== 'boolean') return device;
  return { ...device, binaryControl: { on: currentOn } };
};

const observedFromDevice = (
  device: ReturnType<typeof buildLifecycleSnapshot>,
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
  const binaryDevice = buildLifecycleSnapshot({
    id: 'device-1', name: 'Device', binaryControl: { on: true }, currentOn: true, targets: [],
  });
  const targetDevice = buildLifecycleSnapshot({
    binaryControllable: false,
    id: 'device-1', name: 'Device', targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
  });
  const profile = {
    steps: [
      { id: 'low', planningPowerW: 1_000 },
      { id: 'high', planningPowerW: 2_000 },
    ],
  };
  const stepDevice = buildLifecycleSnapshot({
    binaryControllable: false,
    id: 'device-1', name: 'Device', controlModel: 'stepped_load', targets: [],
    reportedStepId: 'high', selectedStepId: 'high', steppedLoadProfile: profile,
  });
  return [
    {
      axis: 'binary',
      request: { kind: 'binary_off', observed: buildExecutableObservedDeviceState(binaryDevice, undefined) },
    },
    {
      axis: 'target',
      request: {
        kind: 'target_fallback', observed: buildExecutableObservedDeviceState(targetDevice, undefined), desired: 5,
      },
    },
    {
      axis: 'step',
      request: {
        kind: 'step_fallback',
        observed: buildExecutableObservedDeviceState(stepDevice, undefined),
        targetStepId: 'low',
        steppedLoad: {
          id: stepDevice.id,
          name: stepDevice.name,
          plannedShedTarget: { kind: 'step', stepId: 'low' },
          steppedLoadProfile: profile,
          desiredOn: true, desired: { stepId: 'low' }, stepDirection: 'any',
          transition: null,
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
      const actuator = createTestActuator();
      const dispatcher = new ExecutorLifecycleFallbackDispatcher(createTestExecutorCommandContext(
        createPlanEngineState(),
        {
          getCapacityDryRun: () => true,
          targetCommandClaim: { acquire, ownerOf: vi.fn(), release: vi.fn() },
          actuator,
        },
      ));

      expect(dispatcher.converge(request)).toEqual({ settled: false });
      expect(dispatcher.isActive('device-1')).toBe(false);
      expect(acquire).not.toHaveBeenCalled();
      expect(actuator.apply).not.toHaveBeenCalled();
    },
  );

  it('projects target-only write authority without borrowing the binary permission', () => {
    const projected = projectLifecycleFallbackDevice({
      id: 'heater-1',
      name: 'Target-only heater',
      expectedPowerKw: 1,
      expectedPowerSource: 'default',
      controlModel: 'temperature_target',
      binaryControllable: false,
      isEvCharger: false,
      isBatteryOrSolar: false,
      managed: true,
      starvationSupported: false,
      setpointShedFloorC: 10,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
      available: true,
      canSetControl: false,
    } as PlanInputSnapshotDevice);

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
      controlModel: 'stepped_load',
      binaryControllable: false,
      isEvCharger: false,
      isBatteryOrSolar: false,
      managed: true,
      starvationSupported: false,
      setpointShedFloorC: 10,
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
    } as PlanInputSnapshotDevice);

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
        binaryControllable: false,
        isEvCharger: true,
        isBatteryOrSolar: false,
        managed: true,
        starvationSupported: false,
        setpointShedFloorC: 10,
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
      } as PlanInputSnapshotDevice;
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
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(createTestExecutorCommandContext(state, {
      actuator: stepActuator(requestSteppedLoadStep),
    }));

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

  it('judges a claim-release retry by the same ladder as the first build', async () => {
    const state = createPlanEngineState();
    const steppedCommandClaim = createSteppedCommandClaim();
    const configured = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1_000 },
        { id: 'high', planningPowerW: 2_000 },
      ],
    };
    const request = resolveRequest({
      device: projectLifecycleFallbackDevice({
        id: 'heater-1',
        name: 'Stepped heater',
        expectedPowerKw: 2,
        expectedPowerSource: 'default',
        controlModel: 'stepped_load',
        binaryControllable: false,
        isEvCharger: false,
        isBatteryOrSolar: false,
        starvationSupported: false,
        setpointShedFloorC: 10,
        targets: [],
        available: true,
        managed: true,
        canSetControl: false,
        steppedLoadProfile: configured,
        selectedStepId: 'high',
      } as PlanInputSnapshotDevice),
      observedState: { id: 'heater-1', name: 'Stepped heater', available: true, targets: [] },
      configuredFallback: { action: 'set_step' },
    });
    // No report yet: the rung is the posture ladder's lowest active step.
    expect(request.observed.snapshot.steppedLoadProfile).toBe(configured);
    expect(request.observed.steppedLoad?.stepId).toBe('low');

    // The executor's own read carries a different ladder.
    const readDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load', targets: [],
      steppedLoadProfile: {
        steps: [
          { id: 'eco', planningPowerW: 500 },
          { id: 'high', planningPowerW: 2_000 },
        ],
      },
    });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(createTestExecutorCommandContext(state, {
      readDevice,
      steppedCommandClaim,
    }));
    steppedCommandClaim.acquire('heater-1', 'ordinary', 'high');
    expect(dispatcher.converge(request)).toEqual({ settled: false });
    const converge = vi.spyOn(dispatcher, 'converge');

    steppedCommandClaim.release('heater-1', 'ordinary', 'high', false);
    await flush();

    const retried = converge.mock.calls[0]?.[0];
    expect(retried?.observed.snapshot.steppedLoadProfile).toBe(configured);
    expect(retried?.observed.steppedLoad?.stepId).toBe('low');
  });

  it('issues no step write for a stepped device whose on/off is read-only', async () => {
    // The step posture says the on/off is not writable, not that it is absent.
    // As on the ordinary lane, only a device without an on/off handle takes the
    // step path, so this release writes nothing and says why.
    const logs = captureLogger('debug', ['plan']);
    onTestFinished(() => logs.restore());
    const state = createPlanEngineState();
    const requestSteppedLoadStep = vi.fn().mockResolvedValue({ requested: true, transport: 'capability' });
    const raw = {
      id: 'heater-1',
      name: 'Read-only switch heater',
      expectedPowerKw: 2,
      expectedPowerSource: 'default',
      controlModel: 'stepped_load',
      binaryControllable: true,
      isEvCharger: false,
      isBatteryOrSolar: false,
      starvationSupported: false,
      setpointShedFloorC: 10,
      targets: [],
      available: true,
      managed: true,
      canSetControl: false,
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1_000 },
          { id: 'high', planningPowerW: 2_000 },
        ],
      },
      selectedStepId: 'high',
      reportedStepId: 'high',
    } as PlanInputSnapshotDevice;
    const request = resolveRequest({
      device: projectLifecycleFallbackDevice(raw),
      observedState: {
        id: raw.id,
        name: raw.name,
        available: true,
        targets: [],
        binaryControl: { on: true },
        reportedStepId: 'high',
      },
      configuredFallback: { action: 'set_step' },
    });
    expect(request).toMatchObject({ kind: 'step_fallback', targetStepId: 'low' });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(createTestExecutorCommandContext(state, {
      actuator: stepActuator(requestSteppedLoadStep),
    }));

    expect(dispatcher.converge(request)).toEqual({ settled: false });
    await flush();
    expect(requestSteppedLoadStep).not.toHaveBeenCalled();
    expect(logs.findEvent('shed_release_skipped')).toMatchObject({
      reasonCode: 'binary_handle_not_writable',
      deviceId: 'heater-1',
    });
  });

  it('keeps a producer-projected binary EV objective on the binary release lane', () => {
    const projected = projectLifecycleFallbackDevice({
      id: 'charger-1',
      name: 'Binary charger',
      expectedPowerKw: 2,
      expectedPowerSource: 'default',
      controlModel: 'binary_power',
      binaryControllable: true,
      isEvCharger: true,
      isBatteryOrSolar: false,
      managed: true,
      starvationSupported: false,
      setpointShedFloorC: 10,
      targets: [],
      available: true,
      canSetControl: true,
      binaryControl: { on: true },
    } as PlanInputSnapshotDevice);

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
      controlModel: 'stepped_load',
      binaryControllable: true,
      isEvCharger: false,
      isBatteryOrSolar: false,
      managed: true,
      starvationSupported: false,
      setpointShedFloorC: 10,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      available: true,
      capabilities: ['onoff'],
      canSetControl: true,
      binaryControl: { on: true },
      temperatureControlDisabled: true,
      steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }] },
    } as PlanInputSnapshotDevice);

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
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(planState, {
        getObservedState: observedSetpoint(() => 21),
        actuator,
        recordReleaseShedActuation,
      }),
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    expect(recordReleaseShedActuation).toHaveBeenCalledWith('heater-1', 'Heater', 1_000_000);
    const retryAtMs = dispatcher.getOwnedTargetPending(device.id)?.nextRetryAtMs;
    expect(retryAtMs).toBeTypeOf('number');

    // Ordinary planning owns and prunes a different target-pending map.
    prunePendingTargetCommandsForPlan(
      planState,
      { devices: [], meta: buildPlanMeta({ totalKw: 0, softLimitKw: 10, headroomKw: 10}), storageReleases: [] },
    );
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
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(createPlanEngineState(), {
        getObservedState: observedSetpoint(() => observedValue),
        actuator,
      }),
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
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
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: 5, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(state, {
        getObservedState: observedSetpoint(() => 21),
        actuator,
      }),
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      }),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).toHaveBeenCalledOnce();
  });

  it('uses observer target settlement instead of issuing from a stale transport snapshot', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(state, { actuator }),
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        targets: [{ id: 'target_temperature', value: 5, unit: 'C' }],
      }),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: true });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();
  });

  it('falls back to binary off when configured temperature control has no target capability', async () => {
    const state = createPlanEngineState();
    const actuator = createTestActuator();
    const device = buildLifecycleSnapshot({
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
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(state, {
        readDevice: observation.getSnapshotByDeviceId,
        getObservedState: observation.getSnapshotByDeviceId,
        actuator,
      }),
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
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
      ...buildLifecycleSnapshot({
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
    };
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(state, {
        readDevice: observation.getSnapshotByDeviceId,
        getObservedState: observation.getSnapshotByDeviceId,
        actuator,
      }),
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        binaryControl: { on: true },
      }),
      getShedBehavior: () => ({ action: 'turn_off' }),
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
    const device = buildLifecycleSnapshot({
      id: 'charger-1',
      name: 'Charger',
      controllable: false,
      available: true,
      binaryControl: { on: true },
      currentOn: true,
      targets: [],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(createPlanEngineState(), { actuator }),
      getDevice: () => device,
      getObservedState: () => ({
        ...observedFromDevice(device),
        binaryControl: { on: false },
      }),
      getShedBehavior: () => ({ action: 'turn_off' }),
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
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
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
      ctx: createTestExecutorCommandContext(state, { actuator: stepActuator(requestSteppedLoadStep) }),
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      getShedBehavior: () => behavior,
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
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
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
      ctx: createTestExecutorCommandContext(state, {
        actuator: stepActuator(requestSteppedLoadStep),
        markSteppedLoadDesiredStepIssued: () => { commandPending = true; },
      }),
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      getShedBehavior: () => ({ action: 'set_step' }),
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
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
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
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(createTestExecutorCommandContext(state, {
      actuator: stepActuator(requestSteppedLoadStep),
      markSteppedLoadDesiredStepIssued: marked,
    }));

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
    const buildAction = (desiredStepId: string): ExecutableSteppedLoadDevice => steppedAction({
      id: 'heater-1',
      name: 'Stepped heater',
      steppedLoadProfile: profile,
      plannedShedTarget: { kind: 'step', stepId: desiredStepId },
      desiredOn: true, desired: { stepId: desiredStepId }, stepDirection: 'any',
      previousStepId: 'high',
      transition: null,
      matchingCommandAttempt: null,
      stepCommandRetryCount: 0,
    }, { on: true, stepId: 'high', stepIsOffStep: false }, true);
    const buildContext = (owner: 'lifecycle' | 'ordinary'): ExecutorCommandContext => (
      createTestExecutorCommandContext(state, {
        owner,
        steppedCommandClaim,
        actuator: stepActuator(requestSteppedLoadStep),
      })
    );

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
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load',
      targets: [], reportedStepId: 'low', selectedStepId: 'low', steppedLoadProfile: profile,
    });
    const requestSteppedLoadStep = vi.fn().mockResolvedValue({ requested: true, transport: 'capability' });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(state, { actuator: stepActuator(requestSteppedLoadStep) }),
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_step' }),
    });
    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: true });
    const ordinaryContext = createTestExecutorCommandContext(state, {
      lifecycleFallback: lifecycleView(() => dispatcher),
      actuator: stepActuator(requestSteppedLoadStep),
    });
    const action = steppedAction({
      id: device.id, name: device.name, steppedLoadProfile: profile,
      desiredOn: true, desired: { stepId: 'high' }, stepDirection: 'any', previousStepId: 'low', transition: null,
      matchingCommandAttempt: null, stepCommandRetryCount: 0,
    }, { on: true, stepId: 'low', stepIsOffStep: false }, true);
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
      ...buildLifecycleSnapshot({
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
      ...buildLifecycleSnapshot({
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
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(state, {
        getObservedState: observedSetpoint(() => undefined),
        actuator,
      }),
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    expect(dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' })).toEqual({ settled: false });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();
  });

  it('claims the updated ordinary retry when the ordinary lane runs first at the due time', async () => {
    vi.useFakeTimers();
    const planState = createPlanEngineState();
    recordTargetCommandAttempt(planState, 'heater-1', 5, 1_000_000, 'waiting_confirmation', 21);
    recordTargetCommandAttempt(planState, 'heater-1', 5, 1_030_001, 'waiting_confirmation', 21);
    const dueAtMs = planState.pendingTargetCommands['heater-1']?.nextRetryAtMs ?? 0;
    vi.setSystemTime(dueAtMs);
    const actuator = createTestActuator();
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const targetContext = createTestExecutorCommandContext(planState, {
      getObservedState: observedSetpoint(() => 21),
      lifecycleFallback: lifecycleView(() => dispatcher),
      actuator,
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: targetContext,
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });
    await dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      desired: 5,
      observedValue: 21,
    }, 'plan');
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
    recordTargetCommandAttempt(planState, 'heater-1', 5, 1_000_000, 'waiting_confirmation', 21);
    recordTargetCommandAttempt(planState, 'heater-1', 5, 1_030_001, 'waiting_confirmation', 21);
    const dueAtMs = planState.pendingTargetCommands['heater-1']?.nextRetryAtMs ?? 0;
    vi.setSystemTime(dueAtMs);
    const actuator = createTestActuator();
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const targetContext = createTestExecutorCommandContext(planState, {
      getObservedState: observedSetpoint(() => 21),
      lifecycleFallback: lifecycleView(() => dispatcher),
      actuator,
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: targetContext,
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });
    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    await dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      desired: 5,
      observedValue: 21,
    }, 'plan');
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
    recordTargetCommandAttempt(planState, 'heater-1', 5, 1_000_000, 'waiting_confirmation', 21);
    vi.setSystemTime(1_030_001);
    recordTargetCommandAttempt(planState, 'heater-1', 5, 1_030_001, 'waiting_confirmation', 21);
    expect(planState.pendingTargetCommands['heater-1']?.retryCount).toBe(1);
    let observedValue = 21;
    const actuator = createTestActuator();
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: createTestExecutorCommandContext(planState, {
        getObservedState: observedSetpoint(() => observedValue),
        actuator,
      }),
      getDevice: () => buildDevice(),
      getObservedState: () => observedFromDevice(buildDevice()),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).not.toHaveBeenCalled();

    prunePendingTargetCommandsForPlan(
      planState,
      { devices: [], meta: buildPlanMeta({ totalKw: 0, softLimitKw: 10, headroomKw: 10}), storageReleases: [] },
    );
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
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
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
    const ordinaryContext = createTestExecutorCommandContext(planState, {
      getObservedState: observedSetpoint(() => 21),
      lifecycleFallback: lifecycleView(() => dispatcher),
      targetCommandClaim,
      actuator,
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: ordinaryContext,
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    const ordinaryResult = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      desired: 5,
      observedValue: 21,
    }, 'plan');

    expect(ordinaryResult).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    resolveActuator?.({ requested: true });
    await flush();
    expect(dispatcher.getOwnedTargetPending(device.id)).toMatchObject({
      desired: 5,
    });
    expect(planState.pendingTargetCommands[device.id]).toBeUndefined();
  });

  it('drops an opposing ordinary target until abandon permits a fresh decision', async () => {
    const planState = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    const device = buildLifecycleSnapshot({
      binaryControllable: false,
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
    const ordinaryContext = createTestExecutorCommandContext(planState, {
      getObservedState: observedSetpoint(() => 18),
      lifecycleFallback: lifecycleView(() => dispatcher),
      targetCommandClaim,
      actuator,
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: ordinaryContext,
      getDevice: () => device,
      getObservedState: () => observedFromDevice(device),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });

    dispatcher.converge({ deviceId: device.id, objectiveKind: 'temperature' });
    const ordinary = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      desired: 21,
      observedValue: 18,
    }, 'plan');

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
      desired: 21,
      observedValue: 18,
    }, 'plan');
    expect(stillOwned).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    dispatcher.abandon(device.id);
    const freshOrdinary = await dispatchTargetCommand(ordinaryContext, {
      deviceId: device.id,
      name: device.name,
      desired: 21,
      observedValue: 18,
    }, 'plan');
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
    recordTargetCommandAttempt(planState, 'heater-1', 20, Date.now(), 'waiting_confirmation', 5);
    let observedValue = 20;
    const actuator = createTestActuator();
    const targetCommandClaim = createTargetCommandClaim();
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const buildObserved = () => buildExecutableObservedDeviceState(buildDevice(), undefined);
    const targetContext = createTestExecutorCommandContext(planState, {
      readDevice: buildDevice,
      getObservedState: observedSetpoint(() => observedValue),
      lifecycleFallback: lifecycleView(() => dispatcher),
      targetCommandClaim,
      actuator,
    });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(targetContext);

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
      desired: 20,
      observedValue,
    }, 'plan')).toMatchObject({ applied: true, attemptType: 'send' });
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'target', value: 20 }));
    vi.useRealTimers();
  });

  it('retains settled target authority until abandon permits an ordinary command', async () => {
    const planState = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    const actuator = createTestActuator();
    let observedValue = 21;
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1',
      name: 'Heater',
      controllable: false,
      available: true,
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C', min: 5, max: 30, step: 1 }],
    });
    const ordinaryContext = createTestExecutorCommandContext(planState, {
      getObservedState: observedSetpoint(() => observedValue),
      lifecycleFallback: lifecycleView(() => dispatcher),
      targetCommandClaim,
      actuator,
    });
    const dispatcher = new LifecycleFallbackDispatcher({
      ctx: ordinaryContext,
      getDevice: buildDevice,
      getObservedState: () => observedFromDevice(buildDevice()),
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 5 }),
    });
    dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' });
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    observedValue = 5;
    expect(dispatcher.converge({ deviceId: 'heater-1', objectiveKind: 'temperature' })).toEqual({ settled: true });
    const blocked = await dispatchTargetCommand(ordinaryContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      desired: 21,
      observedValue: 5,
    }, 'plan');
    expect(blocked).toEqual({ applied: false, reason: 'skipped' });
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    dispatcher.abandon('heater-1');
    expect(dispatcher.getOwnedTargetPending('heater-1')).toBeUndefined();
    const ordinaryResult = await dispatchTargetCommand(ordinaryContext, {
      deviceId: 'heater-1',
      name: 'Heater',
      desired: 21,
      observedValue: 5,
    }, 'plan');

    expect(ordinaryResult).toMatchObject({ applied: true });
    expect(actuator.apply).toHaveBeenCalledTimes(2);
  });

  it('retains settled binary authority until explicit abandon releases an ordinary restore', async () => {
    const state = createPlanEngineState();
    state.actuation.markShed('charger-1', Date.now());
    const snapshot = {
      ...buildLifecycleSnapshot({
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
    };
    const actuator = createTestActuator();
    const binaryContext = createTestExecutorCommandContext(state, {
      readDevice: observation.getSnapshotByDeviceId,
      getObservedState: observation.getSnapshotByDeviceId,
      lifecycleFallback: lifecycleView(() => dispatcher),
      actuator,
    });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(binaryContext);
    const request = resolveRequest({
      device: withLifecycleAxes(snapshot),
      observedState: { ...observedFromDevice(snapshot), binaryControl: { on: false } },
      configuredFallback: { action: 'turn_off' },
    });
    expect(request).not.toBeNull();
    expect(dispatcher.converge(request)).toEqual({ settled: true });
    expect(dispatcher.isActive(snapshot.id)).toBe(true);

    expect(await applyDeferredBinaryCommand(binaryContext, {
      kind: 'binary_restore', deviceId: snapshot.id, name: snapshot.name,
    }, request.observed)).toBe(false);
    expect(actuator.apply).not.toHaveBeenCalled();

    dispatcher.abandon(snapshot.id);
    expect(await applyDeferredBinaryCommand(binaryContext, {
      kind: 'binary_restore', deviceId: snapshot.id, name: snapshot.name,
    }, request.observed)).toBe(true);
    expect(actuator.apply).toHaveBeenCalledWith(expect.objectContaining({ desired: true }));
  });

  it.each([true, false])('skips a %s binary collision and never replays it', async (ordinaryDesired) => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildLifecycleSnapshot({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    };
    let resolveWrite: ((value: { requested: true }) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((resolve) => { resolveWrite = resolve; }),
    );
    const binaryCommandClaim = createBinaryCommandClaim();
    const buildContext = (owner: 'lifecycle' | 'ordinary'): ExecutorCommandContext => (
      createTestExecutorCommandContext(state, {
        owner,
        readDevice: observation.getSnapshotByDeviceId,
        getObservedState: observation.getSnapshotByDeviceId,
        binaryCommandClaim,
        actuator,
      })
    );
    const lifecycle = runBinaryControl(
      buildContext('lifecycle'),
      { deviceId: snapshot.id, name: snapshot.name, desired: false, logContext: 'capacity', lifecycleRelease: true },
      snapshot,
    );
    expect(await runBinaryControl(
      buildContext('ordinary'),
      { deviceId: snapshot.id, name: snapshot.name, desired: ordinaryDesired, logContext: 'capacity' },
      snapshot,
    )).toEqual({ applied: false });
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    resolveWrite?.({ requested: true });
    await lifecycle;
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(1);
  });

  it('supersedes an opposing binary pending entry when lifecycle takes authority', async () => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildLifecycleSnapshot({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    };
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    store.record(snapshot.id, {
      desired: true, startedMs: Date.now(),
    });
    const ctx = createTestExecutorCommandContext(state, {
      owner: 'lifecycle',
      readDevice: observation.getSnapshotByDeviceId,
      getObservedState: observation.getSnapshotByDeviceId,
      pendingBinaryCommandStore: store,
      actuator: createTestActuator(),
    });
    expect(await runBinaryControl(
      ctx,
      { deviceId: snapshot.id, name: snapshot.name, desired: false, logContext: 'capacity', lifecycleRelease: true },
      snapshot,
    )).toEqual({ applied: true });
    expect(store.peek(snapshot.id)).toMatchObject({ desired: false, lifecycleRelease: true });
  });

  it('drops binary pending bookkeeping when lifecycle authority ends during the write', async () => {
    const state = createPlanEngineState();
    const snapshot = {
      ...buildLifecycleSnapshot({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    };
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    let current = true;
    let resolveWrite: ((value: { requested: true }) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((resolve) => { resolveWrite = resolve; }),
    );
    const ctx = createTestExecutorCommandContext(state, {
      owner: 'lifecycle',
      readDevice: observation.getSnapshotByDeviceId,
      getObservedState: observation.getSnapshotByDeviceId,
      pendingBinaryCommandStore: store,
      actuator,
      isAuthorityCurrent: () => current,
    });
    const result = runBinaryControl(
      ctx,
      { deviceId: snapshot.id, name: snapshot.name, desired: false, logContext: 'capacity', lifecycleRelease: true },
      snapshot,
    );
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
      ...buildLifecycleSnapshot({
        id: 'heater-1', name: 'Heater', binaryControl: { on: true }, currentOn: true, targets: [],
      }),
      binaryWritable: true,
      targetWritable: false,
      stepWritable: false,
    };
    const observation = {
      getSnapshot: () => [snapshot], getSnapshotByDeviceId: () => snapshot,
    };
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    let current = true;
    let rejectWrite: ((reason: unknown) => void) | undefined;
    const actuator = createTestActuator(
      () => new Promise<{ requested: true }>((_resolve, reject) => { rejectWrite = reject; }),
    );
    const ctx = createTestExecutorCommandContext(state, {
      owner: 'lifecycle',
      readDevice: observation.getSnapshotByDeviceId,
      getObservedState: observation.getSnapshotByDeviceId,
      pendingBinaryCommandStore: store,
      actuator,
      isAuthorityCurrent: () => current,
    });
    const result = runBinaryControl(
      ctx,
      { deviceId: snapshot.id, name: snapshot.name, desired: false, logContext: 'capacity', lifecycleRelease: true },
      snapshot,
    );
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
      const buildSnapshot = () => buildLifecycleSnapshot({
        id: 'heater-1', name: 'Heater', binaryControl: { on: observedOn }, currentOn: observedOn, targets: [],
      });
      const snapshot = buildSnapshot();
      const observation = {
        getSnapshot: () => [buildSnapshot()], getSnapshotByDeviceId: () => buildSnapshot(),
      };
      let resolveOrdinary: ((value: { requested: true }) => void) | undefined;
      const actuatorImplementation = vi.fn()
        .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveOrdinary = resolve; }))
        .mockResolvedValue({ requested: true });
      const actuator = createTestActuator(actuatorImplementation);
      // The read the dispatcher re-projects before a claim-release retry.
      let lastRefreshedRead: ExecutorDeviceRead | undefined;
      const binaryContext = createTestExecutorCommandContext(state, {
        readDevice: () => {
          lastRefreshedRead = buildSnapshot();
          return lastRefreshedRead;
        },
        getObservedState: observation.getSnapshotByDeviceId,
        actuator,
      });
      const dispatcher = new ExecutorLifecycleFallbackDispatcher(binaryContext);
      const ordinary = runBinaryControl(
        binaryContext,
        { deviceId: snapshot.id, name: snapshot.name, desired: true, logContext: 'capacity' },
        snapshot,
      );
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
        expect(lastRefreshedRead && buildExecutableObservedDeviceState(lastRefreshedRead, undefined)).toMatchObject({
          observedBinaryAxis: 'off',
          observedEffectiveOn: false,
          binaryControl: { on: false },
          snapshot: { binaryControl: { on: false } },
        });
        observedOn = true;
        expect(dispatcher.converge({ ...request, observed: buildExecutableObservedDeviceState(buildSnapshot(), undefined) }))
          .toEqual({ settled: false });
        observedOn = false;
        expect(dispatcher.converge({ ...request, observed: buildExecutableObservedDeviceState(buildSnapshot(), undefined) }))
          .toEqual({ settled: true });
      }
    },
  );

  it('corrects a laggy ordinary stepped binary restore when its shared claim releases', async () => {
    const state = createPlanEngineState();
    const profile = { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }] };
    const observedOn = false;
    const buildSnapshot = () => ({
      ...buildLifecycleSnapshot({
        id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load',
        binaryControl: { on: observedOn }, currentOn: observedOn, targets: [],
        reportedStepId: 'low', selectedStepId: 'low', steppedLoadProfile: profile,
      }),
      binaryWritable: true,
    });
    const observation = {
      getSnapshot: () => [buildSnapshot()], getSnapshotByDeviceId: () => buildSnapshot(),
    };
    let resolveOrdinary: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveOrdinary = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    const ordinaryContext = createTestExecutorCommandContext(state, {
      readDevice: observation.getSnapshotByDeviceId,
      getObservedState: observation.getSnapshotByDeviceId,
      actuator,
    });
    const action = steppedAction({
      id: 'heater-1', name: 'Stepped heater', steppedLoadProfile: profile,
      desiredOn: true, desired: { stepId: 'low' }, stepDirection: 'any', previousStepId: 'low', transition: null,
      matchingCommandAttempt: null, stepCommandRetryCount: 0,
    }, { on: false, stepId: 'low', stepIsOffStep: false }, false);
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(ordinaryContext);

    const ordinary = executeSteppedLoadRestoreBinary(ordinaryContext, action.intent, buildSnapshot());
    const request: LifecycleFallbackRequest = {
      kind: 'binary_off', observed: buildExecutableObservedDeviceState(buildSnapshot(), undefined),
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
    const buildSnapshot = () => buildLifecycleSnapshot({
      id: 'heater-1', name: 'Stepped heater', controlModel: 'stepped_load',
        binaryControl: { on: observedOn }, currentOn: observedOn, targets: [],
      reportedStepId: 'low', selectedStepId: 'low', steppedLoadProfile: profile,
    });
    const observation = {
      getSnapshot: () => [buildSnapshot()], getSnapshotByDeviceId: () => buildSnapshot(),
    };
    let resolveLifecycle: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveLifecycle = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    const ordinaryContext = createTestExecutorCommandContext(state, {
      getObservedState: observation.getSnapshotByDeviceId,
      actuator,
    });
    const lifecycleWrite = runBinaryControl(
      { ...ordinaryContext, owner: 'lifecycle' },
      { deviceId: 'heater-1', name: 'Stepped heater', desired: true, logContext: 'capacity', lifecycleRelease: true },
      buildSnapshot(),
    );
    observedOn = true;
    const action = steppedAction({
      id: 'heater-1', name: 'Stepped heater', steppedLoadProfile: profile,
      plannedShedTarget: { kind: 'binary_off' },
      desiredOn: false, desired: { stepId: 'off' }, stepDirection: 'any', previousStepId: 'low', transition: null,
      matchingCommandAttempt: null, stepCommandRetryCount: 0,
    }, { on: true, stepId: 'low', stepIsOffStep: false }, false);

    expect(await applySteppedLoadShedOff(ordinaryContext, action, buildSnapshot())).toBe(false);
    expect(actuator.apply).toHaveBeenCalledTimes(1);
    resolveLifecycle?.({ requested: true });
    await lifecycleWrite;
    expect(await applySteppedLoadShedOff(ordinaryContext, action, buildSnapshot())).toBe(true);
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'binary', desired: false }));
  });

  it('retries target fallback immediately after an opposing ordinary claim releases', async () => {
    const state = createPlanEngineState();
    const targetCommandClaim = createTargetCommandClaim();
    let observedValue = 5;
    let lifecyclePendingObservedValue: unknown;
    const buildDevice = () => buildLifecycleSnapshot({
      binaryControllable: false,
      id: 'heater-1', name: 'Heater',
      targets: [{ id: 'target_temperature', value: observedValue, unit: 'C' }],
    });
    const device = buildDevice();
    let resolveOrdinary: ((value: { requested: true }) => void) | undefined;
    const actuatorImplementation = vi.fn()
      .mockImplementationOnce(() => new Promise<{ requested: true }>((resolve) => { resolveOrdinary = resolve; }))
      .mockResolvedValue({ requested: true });
    const actuator = createTestActuator(actuatorImplementation);
    const targetContext = createTestExecutorCommandContext(state, {
      readDevice: buildDevice,
      getObservedState: observedSetpoint(() => observedValue),
      targetCommandClaim,
      actuator,
      syncLivePlanStateAfterTargetActuation: () => {
        const pendingObservedValue = dispatcher.getOwnedTargetPending('heater-1')?.lastObservedValue;
        if (pendingObservedValue !== undefined) lifecyclePendingObservedValue = pendingObservedValue;
      },
    });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(targetContext);
    const ordinary = dispatchTargetCommand(targetContext, {
      deviceId: 'heater-1', name: 'Heater',
      desired: 20, observedValue: 5,
    }, 'plan');
    expect(dispatcher.converge({
      kind: 'target_fallback', desired: 5,
      observed: buildExecutableObservedDeviceState(device, undefined),
    })).toEqual({ settled: false });
    expect(actuator.apply).toHaveBeenCalledTimes(1);

    resolveOrdinary?.({ requested: true });
    await ordinary;
    await flush();
    expect(actuator.apply).toHaveBeenCalledTimes(2);
    expect(actuator.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'target', value: 5 }));
    expect(lifecyclePendingObservedValue).toBe(5);
    expect(buildExecutableObservedDeviceState(buildDevice(), undefined).target?.observedValue).toBe(5);
    observedValue = 20;
    expect(dispatcher.converge({
      kind: 'target_fallback', desired: 5,
      observed: buildExecutableObservedDeviceState(buildDevice(), undefined),
    })).toEqual({ settled: false });
    observedValue = 5;
    expect(dispatcher.converge({
      kind: 'target_fallback', desired: 5,
      observed: buildExecutableObservedDeviceState(buildDevice(), undefined),
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
    const action = steppedAction({
      id: 'heater-1', name: 'Heater', steppedLoadProfile: profile,
      plannedShedTarget: { kind: 'step', stepId: 'high' },
      desiredOn: true, desired: { stepId: 'high' }, stepDirection: 'any', previousStepId: 'low', transition: null,
      matchingCommandAttempt: null, stepCommandRetryCount: 0,
    }, { on: true, stepId: 'low', stepIsOffStep: false }, true);
    let observedStepId = 'low';
    const buildObservedDevice = () => buildLifecycleSnapshot({
      id: 'heater-1', name: 'Heater', controlModel: 'stepped_load', targets: [],
      binaryControllable: false,
      reportedStepId: observedStepId, selectedStepId: observedStepId, steppedLoadProfile: profile,
    });
    const observedDevice = buildObservedDevice();
    const steppedContext = createTestExecutorCommandContext(state, {
      readDevice: buildObservedDevice,
      steppedCommandClaim,
      actuator: stepActuator(requestSteppedLoadStep),
    });
    const dispatcher = new ExecutorLifecycleFallbackDispatcher(steppedContext);
    const ordinary = applySteppedLoadCommand(steppedContext, action);
    expect(dispatcher.converge({
      kind: 'step_fallback', targetStepId: 'low',
      observed: buildExecutableObservedDeviceState(observedDevice, undefined),
      steppedLoad: {
        id: action.intent.id,
        name: action.intent.name,
        plannedShedTarget: { kind: 'step', stepId: 'low' },
        steppedLoadProfile: profile,
        desiredOn: true, desired: { stepId: 'low' }, stepDirection: 'any',
        transition: null,
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
    expect(buildExecutableObservedDeviceState(buildObservedDevice(), undefined).steppedLoad).toMatchObject({
      stepId: 'low',
      reportedStepId: 'low',
    });
    observedStepId = 'high';
    expect(dispatcher.converge({
      kind: 'step_fallback', targetStepId: 'low',
      observed: buildExecutableObservedDeviceState(buildObservedDevice(), undefined),
      steppedLoad: {
        id: action.intent.id, name: action.intent.name, plannedShedTarget: { kind: 'step', stepId: 'low' }, steppedLoadProfile: profile,
        desiredOn: true, desired: { stepId: 'low' }, stepDirection: 'any', transition: null,
        matchingCommandAttempt: null, stepCommandRetryCount: 0,
      },
    })).toEqual({ settled: false });
    observedStepId = 'low';
    expect(dispatcher.converge({
      kind: 'step_fallback', targetStepId: 'low',
      observed: buildExecutableObservedDeviceState(buildObservedDevice(), undefined),
      steppedLoad: {
        id: action.intent.id, name: action.intent.name, plannedShedTarget: { kind: 'step', stepId: 'low' }, steppedLoadProfile: profile,
        desiredOn: true, desired: { stepId: 'low' }, stepDirection: 'any', transition: null,
        matchingCommandAttempt: null, stepCommandRetryCount: 0,
      },
    })).toEqual({ settled: true });
  });
});
